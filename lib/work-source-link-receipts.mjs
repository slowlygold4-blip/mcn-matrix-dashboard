/** Anonymous short-link redirects prove a work reference, never author ownership or metric dates. */
import {createHash} from 'node:crypto';
import {recoveredWorkSourceRows} from './work-source-row-projection.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const exists=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_source_link_receipts'").get();
const redirects=new Set([301,302,303,307,308]);
const errors=new Set(['no_redirect','invalid_redirect','network_error','timeout','http_401','http_403','http_429','http_error']);
const clock=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;

export function shortWorkLink(value){
  try{
    if(typeof value!=='string'||value.length>1000)return null;
    const u=new URL(value);
    if(u.origin!=='https://v.douyin.com'||u.username||u.password||u.port||u.search||u.hash
      ||!/^\/[A-Za-z0-9_-]{1,100}\/?$/.test(u.pathname))return null;
    return 'https://v.douyin.com'+u.pathname.replace(/\/$/,'')+'/';
  }catch{return null;}
}

function destination(value){
  try{
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port
      ||!['www.douyin.com','douyin.com','www.iesdouyin.com','iesdouyin.com'].includes(u.hostname))return null;
    const id=u.pathname.match(/^\/(?:share\/)?(?:video|note)\/([1-9]\d{14,24})\/?$/)?.[1];
    if(!id)return null;
    for(const key of ['modal_id','aweme_id','item_id'])if(u.searchParams.getAll(key).some(v=>v!==id))return null;
    return {contentId:id,redirectUrl:u.origin+u.pathname};
  }catch{return null;}
}

function validate(row){
  if(row?.version!==1||!shortWorkLink(row.requestedUrl)||row.requestedUrl!==shortWorkLink(row.requestedUrl)
    ||!Number.isSafeInteger(row.sourceVersionId)||row.sourceVersionId<1||!/^[a-f0-9]{64}$/.test(row.sourceFactSha256||'')
    ||!clock(row.observedAt)||row.anonymous!==true||row.bodyRead!==false||row.modelCalls!==0
    ||!(row.httpStatus===null||Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599))throw Error('invalid-work-link-receipt');
  const target=destination(row.redirectUrl);
  if(row.status==='resolved'){
    if(!redirects.has(row.httpStatus)||!target||target.contentId!==row.contentId
      ||target.redirectUrl!==row.redirectUrl||!/^[a-f0-9]{64}$/.test(row.locationSha256||''))throw Error('invalid-work-link-proof');
  }else if(!errors.has(row.status)||row.contentId!==null||row.redirectUrl!==null||row.locationSha256!==null)
    throw Error('invalid-work-link-failure');
  return row;
}

export async function resolveWorkSourceLink({url,sourceVersionId,sourceFactSha256,fetchImpl=fetch,
  now=Date.now,signal}={}){
  const requestedUrl=shortWorkLink(url);if(!requestedUrl)throw Error('invalid-short-work-link');
  const row={version:1,sourceVersionId,sourceFactSha256,requestedUrl,observedAt:new Date(now()).toISOString(),
    anonymous:true,bodyRead:false,modelCalls:0,status:'network_error',httpStatus:null,
    contentId:null,redirectUrl:null,locationSha256:null};
  validate(row);
  try{
    const response=await fetchImpl(requestedUrl,{method:'GET',redirect:'manual',credentials:'omit',
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
      headers:{accept:'text/html','user-agent':'MCN-Matrix-Source-Link-Resolver/1.0'}});
    row.httpStatus=response.status;
    const location=response.headers.get('location');
    await response.body?.cancel().catch(()=>{});
    if(signal?.aborted)throw Error('aborted');
    let target=null;
    try{if(location&&location.length<=4096)target=destination(new URL(location,requestedUrl).href);}catch{}
    if(redirects.has(response.status)&&target)Object.assign(row,{status:'resolved',...target,locationSha256:sha(location)});
    else row.status=[401,403,429].includes(response.status)?`http_${response.status}`
      :redirects.has(response.status)?'invalid_redirect':response.status===200?'no_redirect':'http_error';
  }catch(error){
    if(signal?.aborted)throw Error('work-link-cancelled');
    row.status=error?.name==='TimeoutError'?'timeout':'network_error';
  }
  row.observedAt=new Date(now()).toISOString();return validate(row);
}

/** Caller verifies a recent consistent backup once before admitting any batch. */
export function commitWorkLinkReceipt(db,receipt,{backupValidated=false,now=Date.now}={}){
  if(backupValidated!==true)throw Error('work-link-verified-backup-required');
  if(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys)!==1)throw Error('work-link-foreign-keys-required');
  validate(receipt);const committedAt=new Date(now()).toISOString();
  if(receipt.observedAt>committedAt)throw Error('work-link-future-observation');
  let recovery=null;
  let origin=db.prepare(`SELECT b.fact_json,v.committed_at FROM work_source_version_facts m
    JOIN work_source_fact_blobs b ON b.sha256=m.fact_sha256 JOIN work_source_versions v ON v.id=m.version_id
    WHERE m.version_id=? AND m.fact_sha256=?`).get(receipt.sourceVersionId,receipt.sourceFactSha256);
  if(!origin){
    recovery=recoveredWorkSourceRows(db,receipt.sourceVersionId,{forceVerify:true}).find(row=>row.sha256===receipt.sourceFactSha256);
    if(recovery)origin={fact_json:recovery.json,committed_at:db.prepare('SELECT committed_at FROM work_source_versions WHERE id=?').get(receipt.sourceVersionId).committed_at};
  }
  if(!origin||origin.committed_at>receipt.observedAt||sha(origin.fact_json)!==receipt.sourceFactSha256)
    throw Error('work-link-source-proof-missing');
  const fact=JSON.parse(origin.fact_json);
  if(![fact.url,...(fact.evidenceUrls||[])].some(url=>shortWorkLink(url)===receipt.requestedUrl))throw Error('work-link-source-url-mismatch');
  const json=JSON.stringify(receipt),digest=sha(json);let started=false;
  try{
    db.exec('BEGIN IMMEDIATE');started=true;
    ensureWorkLinkReceiptSchema(db);
    if(recovery){
      const workKey=fact.contentId||`url:${sha(JSON.stringify([...fact.evidenceUrls].sort()))}`;
      db.prepare('INSERT OR IGNORE INTO work_source_fact_blobs VALUES(?,?,?,?,?)')
        .run(recovery.sha256,recovery.json,fact.contentId,fact.sheet,workKey);
      if(db.prepare('SELECT fact_json FROM work_source_fact_blobs WHERE sha256=?').get(recovery.sha256)?.fact_json!==recovery.json)
        throw Error('work-link-source-blob-conflict');
    }
    db.prepare('INSERT OR IGNORE INTO work_source_link_receipts VALUES(?,?,?,?,?,?,?,?)')
      .run(digest,json,receipt.requestedUrl,receipt.contentId,receipt.observedAt,committedAt,receipt.sourceFactSha256,receipt.sourceVersionId);
    if(db.prepare('SELECT receipt_json FROM work_source_link_receipts WHERE sha256=?').get(digest)?.receipt_json!==json)
      throw Error('work-link-receipt-hash-conflict');
    db.exec('COMMIT');started=false;return {sha256:digest,status:receipt.status,committedAt};
  }catch(error){if(started)db.exec('ROLLBACK');throw error;}
}

export function ensureWorkLinkReceiptSchema(db){
  db.exec(`CREATE TABLE IF NOT EXISTS work_source_link_receipts(
    sha256 TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,source_url TEXT NOT NULL,content_id TEXT,
    observed_at TEXT NOT NULL,committed_at TEXT NOT NULL,
    source_fact_sha256 TEXT NOT NULL REFERENCES work_source_fact_blobs(sha256),
    source_version_id INTEGER NOT NULL REFERENCES work_source_versions(id));
    CREATE INDEX IF NOT EXISTS idx_work_link_source ON work_source_link_receipts(source_url,committed_at);`);
}

export function readWorkLinkReceipts(db,{asOf=new Date().toISOString()}={}){
  if(!clock(asOf)&&!(typeof asOf==='string'&&clock(asOf.replace(/Z$/,'.000Z'))))throw Error('invalid-work-link-cutoff');
  const cutoff=new Date(asOf).toISOString();
  if(!exists(db))return [];
  return db.prepare(`SELECT * FROM work_source_link_receipts WHERE committed_at<=? AND observed_at<=?
    ORDER BY committed_at,sha256`).all(cutoff,cutoff).map(r=>{
    if(sha(r.receipt_json)!==r.sha256)throw Error('stored-work-link-receipt-corrupt');
    const value=validate(JSON.parse(r.receipt_json));
    if(value.requestedUrl!==r.source_url||value.contentId!==r.content_id||value.observedAt!==r.observed_at
      ||value.sourceFactSha256!==r.source_fact_sha256||value.sourceVersionId!==r.source_version_id)
      throw Error('stored-work-link-index-corrupt');
    return {...value,sha256:r.sha256,committedAt:r.committed_at};
  });
}

export function bindWorkFactsToRedirects(facts,receipts){
  const index=new Map();
  for(const r of receipts){
    validate(r);if(r.status!=='resolved')continue;
    if(!index.has(r.requestedUrl))index.set(r.requestedUrl,[]);index.get(r.requestedUrl).push(r);
  }
  let bound=0,conflicts=0;
  const result=facts.map(f=>{
    const hits=[f.url,...(f.evidenceUrls||[])].flatMap(url=>index.get(shortWorkLink(url))||[]);
    const ids=new Set(hits.map(r=>r.contentId));
    if(f.bindingIssues?.length)return f;
    if(ids.size>1||f.contentId&&ids.size===1&&!ids.has(f.contentId)){
      conflicts++;return {...f,bindingIssues:['official-redirect-work-id-conflict']};
    }
    if(f.contentId||ids.size!==1)return f;
    bound++;return {...f,contentId:hits[0].contentId,authorIdentityVerified:false,
      contentIdEvidence:{kind:'anonymous-official-short-link-redirect',receiptSha256:hits[0].sha256,
        observedAt:hits[0].observedAt,sourceVersionId:hits[0].sourceVersionId,sourceFactSha256:hits[0].sourceFactSha256}};
  });
  return {facts:result,summary:{boundWorkReferences:bound,conflicts,unresolvedLinks:result.filter(f=>!f.contentId).length}};
}
