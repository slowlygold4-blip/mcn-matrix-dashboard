/** Cross-part bookkeeping audit. No network, database writes or model calls.
 * This reconciles saved records, not the platform's unknown full inventory. */
import {auditPublishing} from './replica-publishing.mjs';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {replicaPartitionByteLimit} from './replica-partition-budget.mjs';
import {savedPublicationDateValid} from './publication-date-basis.mjs';
const count=value=>Number.isSafeInteger(value)&&value>=0;
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const fail=()=>{throw Object.assign(new Error('invalid-publication-audit-input'),{code:'invalid-publication-audit-input'});};
const identity=(platform,id)=>{
  if(typeof id!=='string'||!(platform==='douyin'?/^\d{1,25}$/:platform==='bilibili'?/^BV[0-9A-Za-z]{10}$/:/$a/).test(id))fail();
  return platform+':'+id;
};
function publicationDay(row,asOf){
  if(!savedPublicationDateValid(row,asOf,{allowLegacy:true}))fail();
  if(row.publishedAt!=null){
    const at=Date.parse(row.publishedAt);
    if(!Number.isFinite(at))fail();
    return new Date(at+8*3600000).toISOString().slice(0,10);
  }
  if(row.publishedOn!=null&&!day(row.publishedOn))fail();
  return row.publishedOn||'';
}

/** readPart returns original, hash-checked partition JSON. The adapter owns
 * filesystem/path/hash checks; this function compares independent layers. */
export async function auditPublicationCoverage({manifest,readPart,startDate='2026-09-12'}={}){
  if(!day(startDate)||!manifest||manifest.version!==1||manifest.timeZone!=='Asia/Shanghai'
    ||typeof manifest.asOf!=='string'||!Number.isFinite(Date.parse(manifest.asOf))||new Date(manifest.asOf).toISOString()!==manifest.asOf
    ||!Array.isArray(manifest.files)||typeof readPart!=='function')fail();
  const metas=new Map(manifest.files.map(meta=>[meta.path,meta]));
  if(metas.size!==manifest.files.length)fail();
  const catalogMeta=manifest.files.find(m=>m.kind==='catalog');
  if(!catalogMeta||!manifest.files.some(m=>m.kind==='publishing'))fail();
  const read=async meta=>{
    const part=await readPart(meta);
    if(!part||part.version!==1||part.asOf!==manifest.asOf||part.timeZone!=='Asia/Shanghai')fail();
    return part;
  };
  // Reuse the ledger's complete existing internal checks. A healthy shard set
  // whose day index omits a shard must not be called present in the UI.
  await auditPublishing({manifest,readPart:async path=>{const meta=metas.get(path);if(!meta)fail();return read(meta);}});
  const catalog=await read(catalogMeta);
  if(!Array.isArray(catalog.accounts))fail();
  const accounts=new Map(catalog.accounts.map(a=>[a.id,a]));
  if(accounts.size!==catalog.accounts.length||catalog.accounts.some(a=>!count(a.id)||a.id===0))fail();
  const native=new Map(),source=new Map(),ledger=new Map(),duplicates=[];
  let nativeRows=0,sourceRows=0,unsupportedNativeRows=0;
  for(const meta of manifest.files){
    if(!['works','creatorWorks','foundationWorks','publishingShard'].includes(meta.kind))continue;
    const part=await read(meta);
    if(!Array.isArray(part.items)||part.items.length!==meta.count)fail();
    for(const row of part.items){
      if(meta.kind==='works'){
        const account=accounts.get(meta.targetId);if(!account||row.targetId!==account.id)fail();
        if(!['douyin','bilibili'].includes(account.platform)){unsupportedNativeRows++;continue;}
        const key=identity(account.platform,row.externalId),entry=native.get(key)??{owners:new Set(),rows:0,dates:new Set(),platformDates:new Set()};
        const date=publicationDay(row,manifest.asOf);
        if(entry.owners.has(account.id))duplicates.push({kind:'native-duplicate',identity:key});
        entry.owners.add(account.id);entry.rows++;entry.dates.add(date);
        // Only a genuine native timestamp outranks an imported day. A source
        // day or first-seen date must never be invented into a platform time.
        if(row.source!=='creator-source'&&row.publishedAt!=null)entry.platformDates.add(date);
        native.set(key,entry);nativeRows++;
      }else if(meta.kind==='publishingShard'){
        const key=identity(row.platform??'douyin',row.contentId);
        if(row.date!==''&&!day(row.date))fail();
        if(ledger.has(key))duplicates.push({kind:'ledger-duplicate',identity:key});
        ledger.set(key,row.date);
      }else{
        const key=identity('douyin',row.contentId),date=row.publishDate??row.publishedOn??'';
        if(date!==''&&!day(date))fail();
        const dates=source.get(key)??new Set();dates.add(date);source.set(key,dates);sourceRows++;
      }
    }
  }
  const expected=new Map(),excluded=new Set(),ambiguous=new Set(),unresolved=new Set();
  let sourceDateSupersededBeforeStart=0;
  const keys=new Set([...native.keys(),...source.keys()]);
  for(const key of keys){
    const n=native.get(key),s=source.get(key);
    if(n?.owners.size>1){ambiguous.add(key);if(!s)continue;}
    const platformDates=n?.owners.size===1?n.platformDates:new Set();
    let candidates;
    if(platformDates.size)candidates=platformDates;
    else if(s)candidates=new Set([...s].filter(Boolean));
    else candidates=n?.dates??new Set();
    if(candidates.size>1){unresolved.add(key);continue;}
    const date=[...candidates][0]??'';
    if(date&&date<startDate){
      excluded.add(key);
      if(s&&platformDates.size===1&&[...s].some(value=>!value||value>=startDate))sourceDateSupersededBeforeStart++;
      continue;
    }
    expected.set(key,date);
  }
  const mismatches=[...duplicates];
  for(const [key,date]of expected){
    if(!ledger.has(key))mismatches.push({kind:'missing-from-ledger',identity:key,expectedDate:date});
    else if(ledger.get(key)!==date)mismatches.push({kind:'publication-day-mismatch',identity:key,expectedDate:date,ledgerDate:ledger.get(key)});
  }
  for(const [key,date]of ledger)if(!expected.has(key)&&!unresolved.has(key))mismatches.push({kind:'untraceable-ledger-row',identity:key,ledgerDate:date});
  const byKind={};for(const item of mismatches)byKind[item.kind]=(byKind[item.kind]??0)+1;
  const result={version:1,asOf:manifest.asOf,startDate,runtimeAI:false,readOnly:true,
    status:mismatches.length?'failed':unresolved.size||unsupportedNativeRows||ambiguous.size?'incomplete':'passed',
    savedNativeRows:nativeRows,savedNativeWorks:native.size,savedSourceRows:sourceRows,savedSourceWorks:source.size,
    overlappingSavedWorks:[...source.keys()].filter(key=>native.has(key)).length,uniqueSavedWorks:keys.size,
    expectedLedgerWorks:expected.size,ledgerWorks:ledger.size,excludedBeforeStart:excluded.size,
    sourceDateSupersededBeforeStart,ambiguousNativeOwnership:ambiguous.size,unsupportedNativeRows,
    unresolvedDateConflicts:unresolved.size,mismatchCount:mismatches.length,mismatchKinds:byKind,
    mismatches:mismatches.slice(0,50),unresolvedIdentities:[...unresolved].slice(0,50),
    limits:['Saved-record identity and publication-day reconciliation only; not complete platform inventory or daily collection coverage.',
      'Does not authenticate source ownership or replay metric adoption; those require the existing separate validators.',
      'Unresolved date conflicts remain incomplete, never silently treated as passed.']};
  if(!Object.values(result).filter(value=>typeof value==='number').every(count))fail();
  return result;
}

const ioFailure=code=>{throw Object.assign(new Error(code),{code});};
export async function auditPublishedCoverageDirectory(directory,options={}){
  const root=resolve(directory);
  const readBytes=async(path,meta)=>{
    if(typeof path!=='string'||path.split('/').some(v=>!v||v==='..'||v==='.')||path.startsWith('/'))ioFailure('invalid-audit-partition-path');
    const parts=path.split('/');
    for(let i=0;i<parts.length;i++){
      const stat=await lstat(join(root,...parts.slice(0,i)));
      if(!stat.isDirectory()||stat.isSymbolicLink())ioFailure('unsafe-audit-partition-path');
    }
    const fd=await open(join(root,path),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await fd.stat(),limit=meta?replicaPartitionByteLimit(path):4*1024*1024;
      if(!stat.isFile()||stat.size>limit||meta&&stat.size!==meta.bytes)ioFailure('invalid-audit-partition-size');
      const bytes=await fd.readFile();
      if(meta&&(bytes.length!==meta.bytes||createHash('sha256').update(bytes).digest('hex')!==meta.sha256))ioFailure('invalid-audit-partition-hash');
      return bytes;
    }finally{await fd.close();}
  };
  const manifest=JSON.parse(await readBytes('manifest.json'));
  const report=await auditPublicationCoverage({manifest,startDate:options.startDate,
    readPart:async meta=>JSON.parse(await readBytes(meta.path,meta))});
  return {...report,sourceManifestSha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
}
