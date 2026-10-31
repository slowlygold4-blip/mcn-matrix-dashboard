import {referenceCandidate,referenceHeadMatches,readReplicaText} from '@/lib/replica-reference.mjs';
import {readReplicaRequest} from '@/lib/replica-request.mjs';
import {replicaPartitionByteLimit,replicaBatchByteLimit,REPLICA_UPLOAD_MAX_BYTES} from '@/lib/replica-partition-budget.mjs';
import {auditPublishing} from '@/lib/replica-publishing.mjs';
import {creatorFile,creatorKind,creatorPartValid,auditCreatorPublication} from '@/lib/replica-creator.mjs';
import {foundationFile,foundationKind,foundationPartValid,auditFoundationPublication} from '@/lib/replica-foundation.mjs';
import { env } from "cloudflare:workers";
import {isReadOnlyFrontend,forwardReadOnlyFrontend} from '@/lib/standalone-readonly.mjs';
import {summaryDescriptors,summaryPartValid} from '@/lib/replica-summary.mjs';
import {auditDatePublication} from '@/lib/replica-date-audit.mjs';
import {replicaStorageFailure} from '@/lib/replica-storage-read.mjs';
import {auditDateChunk,requireDateAuditReceipts} from '@/lib/replica-date-audit-receipts.mjs';
import {DATE_AUDIT_CONTRACT} from '@/lib/replica-date-audit-plan.mjs';
export const dynamic = "force-dynamic";
const PATH = /^(catalog|topics|summary|date-summary-index|publishing)\.json$|^(daily|works|work-metrics)\/[0-9]{1,8}\.json$|^(summary|date-summary|publishing)\/[0-9]{6}\.json$|^creator\/(index|authors|insights|works-\d{3})\.json$|^foundation\/(index|authors|works|sources|observations|other-authors|other-works|pending-authors)\.json$/;
const SHA = /^[a-f0-9]{64}$/;
const json = (value: unknown, status = 200) => Response.json(value, {status, headers:{"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"}});
const runtime = () => {
  if (!env.DB || !env.BUCKET) throw new Error("storage unavailable");
  return { db: env.DB, bucket: env.BUCKET };
};
const validGeneration = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const bytesHash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2,"0")).join("");
function privateKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, v]) => /^(raw_json|rawJson|locator|cookie|cookies|password|token|accessToken|refreshToken|authorization|settings|metadata_json|sourceRepositoryCredential|sourceUrl)$/i.test(key) || privateKey(v));
}
export async function GET(request: Request) {
  if(isReadOnlyFrontend(env))return forwardReadOnlyFrontend(request);
  try {
    const {db,bucket}=runtime(); const url = new URL(request.url);
    const requested = url.searchParams.get("generation") || null;
    if (requested && !validGeneration(requested)) return json({error:"无效数据截面"},400);
    // A named generation is immutable once activated. Do not fetch the latest
    // publication first for every individual date shard.
    const part = url.searchParams.get("part");
    if(part&&!PATH.test(part))return json({error:"不支持的数据分区"},400);
    const baseQuery=requested?"SELECT generation,manifest,published_at FROM replica_generations WHERE generation=?":"SELECT generation,manifest,published_at FROM replica_generations ORDER BY generation DESC LIMIT 1";
    const query=part?`SELECT p.*,r.source_generation,r.source_checksum,r.source_bytes,r.trailing_newline FROM (${baseQuery}) p LEFT JOIN replica_file_references r ON r.generation=p.generation AND r.path=?`:baseQuery;
    const params=[...(requested?[requested]:[]),...(part?[part]:[])];
    const published=await db.prepare(query).bind(...params).first<{generation:string;manifest:string;published_at:string;source_generation?:string;source_checksum?:string;source_bytes?:number;trailing_newline?:number}>();
    if (!published) return requested ? json({error:"未发布的数据截面"},404) : json({error:"尚未同步可公开数据"},503);
    const generation = published.generation;
    const manifest = JSON.parse(published.manifest);
    if (!part) return json({manifest,publishedAt:published.published_at,readOnly:true,collectionRequiresLocalComputer:true});
    if (!PATH.test(part)) return json({error:"不支持的数据分区"},400);
    // Activation audited each file against replica_files. The sealed manifest
    // is authoritative for reads; querying that table again adds latency to
    // every shard without providing another independent content check.
    const file = manifest.files.find((f:{path:string})=>f.path===part);
    if (!file) return json({error:"分区不在已发布清单"},404);
    if (!SHA.test(file.sha256)) return json({error:"发布清单校验信息无效"},503);
    const headers={"Content-Type":"application/json; charset=utf-8","Cache-Control":"public,max-age=300,immutable","X-Content-Type-Options":"nosniff","X-Data-SHA256":file.sha256,"X-Data-Cutoff":generation};
    if(published.source_generation){
      const text=await readReplicaText(bucket,generation,file,published);if(text===undefined)return json({error:"数据暂不可用"},503);
      return new Response(text,{headers:{...headers,'X-Replica-Storage':'reference'}});
    }
    const body = await bucket.get(`${generation}/${file.sha256}`);
    if (!body) return json({error:"数据暂不可用"},503);
    return new Response(body.body,{headers});
  } catch { return json({error:"云端数据暂不可用，请稍后重试"},503); }
}
export async function POST(request: Request) {
  if(isReadOnlyFrontend(env))return forwardReadOnlyFrontend(request);
  // A producer-only endpoint. Anonymous readers can never upload or activate.
  const producer = (env as unknown as Record<string,unknown>).REPLICA_INGEST_SECRET;
  if (typeof producer !== "string" || producer.length < 48 || request.headers.get("Authorization") !== `Bearer ${producer}`) return json({error:"只读访问"},403);
  let activationPhase:string|null=null,activationStartedAt:number|null=null;
  try {
    const text=await readReplicaRequest(request,{maxBytes:REPLICA_UPLOAD_MAX_BYTES});
    const input=JSON.parse(text); const {db,bucket}=runtime();
    if(input.action==="upload"&&Array.isArray(input.files)&&new TextEncoder().encode(text).length>replicaBatchByteLimit(input.files))return json({error:"批次过大"},413);
    if(!validGeneration(input.asOf)||Date.parse(input.asOf)>Date.now())return json({error:"无效采样截止时间"},400);
    if(input.action==="upload") {
      if(!Array.isArray(input.files)||input.files.length<1||input.files.length>50)return json({error:"无效分区批次"},400);
      const activated=await db.prepare("SELECT manifest FROM replica_generations WHERE generation=?").bind(input.asOf).first<{manifest:string}>();
      const sealed=activated?new Map(JSON.parse(activated.manifest).files.map((f:{path:string;sha256:string})=>[f.path,f.sha256])):null;
      const prepared:{path:string;sha256:string;data:string;bytes:number}[]=[],paths=new Set<string>();
      for(const f of input.files) {
        if(typeof f.path!=="string"||!PATH.test(f.path)||!SHA.test(f.sha256)||typeof f.data!=="string"||new TextEncoder().encode(f.data).length>replicaPartitionByteLimit(f.path))return json({error:"无效分区"},400);
        if(paths.has(f.path))return json({error:"重复分区路径"},400);paths.add(f.path);
        const parsed=JSON.parse(f.data);
        if(parsed.asOf!==input.asOf || privateKey(parsed) || await bytesHash(f.data)!==f.sha256)return json({error:"分区审查或校验失败"},400);
        if(creatorFile(f)&&!creatorPartValid(parsed,{path:f.path,kind:creatorKind(f.path),count:f.path==='creator/index.json'?parsed.stats?.works:parsed.items?.length},input.asOf))return json({error:'作者作品分区字段或版本无效'},400);
        if(foundationFile(f)&&!foundationPartValid(parsed,{path:f.path,kind:foundationKind(f.path),count:f.path==='foundation/index.json'?(Array.isArray(parsed.files)?parsed.files.reduce((sum:number,p:{count:number})=>sum+p.count,0):undefined):parsed.items?.length},input.asOf))return json({error:'补充来源分区字段或版本无效'},400);
        if(f.path.startsWith('summary/')&&(f.data.length>1_000_000||!summaryPartValid(parsed,input.asOf)||parsed.items.length<1))return json({error:"历史分片字段或时间不一致"},400);
        if(f.path.startsWith('date-summary/')&&(f.data.length>1_000_000||!summaryPartValid(parsed,input.asOf)||parsed.items.length<1))return json({error:"日期分片字段或时间不一致"},400);
        if(f.path==='date-summary-index.json'&&f.data.length>1_000_000)return json({error:"日期索引过大"},400);
        if(f.path==='summary.json'&&!Array.isArray(parsed.items)&&f.data.length>1_000_000)return json({error:"历史索引过大"},400);
        if(sealed&&sealed.get(f.path)!==f.sha256)return json({error:"已发布数据截面不可新增或改写"},409);
        prepared.push({...f,bytes:new TextEncoder().encode(f.data).length});
      }
      // Validate the entire input before any write. Two bounded storage workers
      // drain on failure; the response never leaves orphan asynchronous work.
      // Metadata uses one transaction instead of 50 individual D1 write trips.
      const query="SELECT path,checksum FROM replica_files WHERE generation=? AND path IN ("+prepared.map(()=>'?').join(',')+")";
      const readMetadata=()=>db.prepare(query).bind(input.asOf,...prepared.map(f=>f.path)).all<{path:string;checksum:string}>();
      const expected=new Map(prepared.map(f=>[f.path,f.sha256]));
      const existing=await readMetadata();
      if(existing.results.some(f=>expected.get(f.path)!==f.checksum))return json({error:"已保存分区不可改写"},409);
      const reuse=input.reuseUnchanged===true,references=new Map<string,any>(),previousByPath=new Map<string,any>();
      let previousGeneration:string|null=null;
      if(reuse){
        const previous=await db.prepare("SELECT generation FROM replica_generations WHERE generation<? ORDER BY generation DESC LIMIT 1").bind(input.asOf).first<{generation:string}>();
        previousGeneration=previous?.generation??null;
        if(previousGeneration){const rows=await db.prepare("SELECT f.path,f.checksum,f.bytes,r.source_generation,r.source_checksum,r.source_bytes,r.trailing_newline FROM replica_files f LEFT JOIN replica_file_references r ON r.generation=f.generation AND r.path=f.path WHERE f.generation=? AND f.path IN ("+prepared.map(()=>'?').join(',')+")").bind(previousGeneration,...prepared.map(f=>f.path)).all<any>();for(const row of rows.results)previousByPath.set(row.path,row);}
      }
      let next=0,failed=false,stored=0;
      const store=async()=>{while(!failed&&next<prepared.length){const f=prepared[next++];try{
        const ref=reuse?referenceCandidate(f,previousByPath.get(f.path),previousGeneration,input.asOf):null;
        if(ref){
          const key=`${ref.source_generation}/${ref.source_checksum}`,head=await bucket.head(key);
          // Restore only bytes proven against the already sealed source SHA.
          if(!referenceHeadMatches(head,ref)){await bucket.put(key,ref.data,{httpMetadata:{contentType:"application/json"}});stored++;}
          references.set(f.path,ref);
        }else {await bucket.put(`${input.asOf}/${f.sha256}`,f.data,{httpMetadata:{contentType:"application/json"}});stored++;}
      }catch{failed=true;}}};
      await Promise.allSettled(Array.from({length:Math.min(reuse?6:2,prepared.length)},store));
      if(failed)return json({error:"分区保存未完成，尚未确认本批次"},503);
      const statements=[...prepared.map(f=>db.prepare("INSERT INTO replica_files(generation,path,checksum,bytes) VALUES(?,?,?,?) ON CONFLICT(generation,path) DO NOTHING").bind(input.asOf,f.path,f.sha256,f.bytes)),...prepared.map(f=>{
        const ref=references.get(f.path);
        return ref?db.prepare("INSERT INTO replica_file_references(generation,path,source_generation,source_checksum,source_bytes,trailing_newline) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM replica_files WHERE generation=? AND path=? AND checksum=?) ON CONFLICT(generation,path) DO UPDATE SET source_generation=excluded.source_generation,source_checksum=excluded.source_checksum,source_bytes=excluded.source_bytes,trailing_newline=excluded.trailing_newline").bind(input.asOf,f.path,ref.source_generation,ref.source_checksum,ref.source_bytes,ref.trailing_newline,input.asOf,f.path,f.sha256):db.prepare("DELETE FROM replica_file_references WHERE generation=? AND path=? AND EXISTS(SELECT 1 FROM replica_files WHERE generation=? AND path=? AND checksum=?)").bind(input.asOf,f.path,input.asOf,f.path,f.sha256);
      })];
      const writes=await db.batch(statements);
      if(writes.length!==statements.length||writes.some(result=>!result.success))return json({error:"批次索引保存未完成，尚未确认本批次"},503);
      // A competing immutable upload can win between the initial read and the
      // batch. Acknowledge only the exact hashes now bound in D1.
      const committed=await readMetadata();
      if(committed.results.length!==prepared.length||committed.results.some(f=>expected.get(f.path)!==f.checksum))return json({error:"已保存分区不可改写"},409);
      const response=json({accepted:input.files.length,asOf:input.asOf});
      if(reuse){response.headers.set('X-Replica-Reused',String(references.size));response.headers.set('X-Replica-Stored',String(stored));}return response;
    }
    if(!['activate','audit-date'].includes(input.action)||input.manifest?.asOf!==input.asOf||!Array.isArray(input.manifest.files)||privateKey(input.manifest))return json({error:"无效发布清单"},400);
    const files=input.manifest.files;
    activationStartedAt=Date.now();activationPhase='metadata';
    const filesByPath=new Map<string,any>(files.map((f:any)=>[f.path,f]));
    // Fixed diagnostic codes only. Do not log provider bodies, credentials or source rows.
    const activationRejected=(phase:string,error?:unknown,progress:Record<string,unknown>={})=>{
      const codes=new Set(['date-storage-read','date-source-missing','date-source-checksum','date-source-json','date-source-digest','date-source-extra-target']);
      const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
      console.warn(JSON.stringify({event:'replica-activation-rejected',phase,stage:progress.phase??null,
        verifiedDaily:progress.verifiedDaily??null,expectedDaily:progress.expectedDaily??null,
        requestAborted:request.signal.aborted,reason:codes.has(code)?code:'validation-failed',
        ...(code==='date-storage-read'?{storageFailure:replicaStorageFailure(error)}:{}),elapsedMs:Date.now()-(activationStartedAt??Date.now())}));
    };
    if(!files.some((f:{path:string})=>f.path==="catalog.json")||!files.some((f:{path:string})=>f.path==="summary.json")||!files.some((f:{path:string})=>f.path==="topics.json"))return json({error:"必需分区缺失"},400);
    const rows=await db.prepare("SELECT f.path,f.checksum,f.bytes,r.source_generation,r.source_checksum,r.source_bytes,r.trailing_newline FROM replica_files f LEFT JOIN replica_file_references r ON r.generation=f.generation AND r.path=f.path WHERE f.generation=?").bind(input.asOf).all<any>();
    const map=new Map(rows.results.map(x=>[x.path,x]));
    if(new Set(files.map((x:{path:string})=>x.path)).size!==files.length||files.length!==map.size||files.some((f:{path:string;sha256:string;bytes:number})=>!PATH.test(f.path)||!SHA.test(f.sha256)||map.get(f.path)?.checksum!==f.sha256||map.get(f.path)?.bytes!==f.bytes))return json({error:"分区清单不一致，未发布"},409);
    const readPartText=async(path:string)=>{
      const meta=filesByPath.get(path);if(!meta)throw Error('missing-meta');
      const text=await readReplicaText(bucket,input.asOf,meta,map.get(path),{signal:request.signal});
      if(text===undefined)throw Object.assign(Error('missing-storage'),{code:'replica-storage-repair'});return text;
    };
    if(input.action==='audit-date'){
      const receipt=await auditDateChunk({manifest:input.manifest,chunkIndex:input.chunkIndex,bucket,readText:readPartText,signal:request.signal});
      return json({audited:true,asOf:input.asOf,chunkIndex:receipt.chunkIndex,chunkCount:receipt.chunkCount,verifiedDaily:receipt.verifiedDaily});
    }
    if(input.dateAudit!==undefined&&input.dateAudit!==DATE_AUDIT_CONTRACT)return json({error:'日期审查协议无效'},400);
    activationPhase='summary';
    const summaryMeta=filesByPath.get('summary.json'),summaryText=await readPartText('summary.json');
    if(summaryText.length>6_000_000||await bytesHash(summaryText)!==summaryMeta.sha256)return json({error:"历史索引校验失败，未发布"},409);
    let descriptors;try {descriptors=summaryDescriptors(JSON.parse(summaryText),input.manifest);}catch{return json({error:"历史分片不一致，未发布"},409);}
    if(descriptors)for(const descriptor of descriptors){const body=await readPartText(descriptor.path),parsed=JSON.parse(body);if(!summaryPartValid(parsed,input.asOf)||parsed.items.length!==descriptor.count)return json({error:"历史分片记录数不一致，未发布"},409);}
    if(files.some((f:{kind:string;path:string})=>f.kind==='summaryDateIndex'||f.kind==='summaryDateShard'||f.path==='date-summary-index.json'||f.path.startsWith('date-summary/'))){
      activationPhase='date';let dateProgress:Record<string,unknown>={phase:'index',verifiedDaily:0};
      try{if(input.dateAudit===DATE_AUDIT_CONTRACT)await requireDateAuditReceipts({manifest:input.manifest,bucket,signal:request.signal});
        else await auditDatePublication({manifest:input.manifest,readText:readPartText,signal:request.signal,onProgress:(progress:Record<string,unknown>)=>{dateProgress=progress;}});}
      catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='replica-storage-repair')throw error;activationRejected('date',error,dateProgress);return json({error:"日期历史未通过全量来源核对，未发布"},409);}
    }
    activationPhase='publishing';
    try{await auditPublishing({manifest:input.manifest,readPart:async(path:string)=>JSON.parse(await readPartText(path))});}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='replica-storage-repair')throw error;activationRejected('publishing',error);return json({error:'每日发片索引核验失败'},409);}
    activationPhase='creator';
    try{await auditCreatorPublication({manifest:input.manifest,readPart:async(path:string)=>JSON.parse(await readPartText(path))});}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='replica-storage-repair')throw error;activationRejected('creator',error);return json({error:'作者作品与经营统计核验失败，未发布'},409);}
    activationPhase='foundation';
    try{await auditFoundationPublication({manifest:input.manifest,readPart:async(path:string)=>JSON.parse(await readPartText(path))});}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='replica-storage-repair')throw error;activationRejected('foundation',error);return json({error:'补充来源与统一名册核验失败，未发布'},409);}
    activationPhase='commit';
    const manifest=JSON.stringify(input.manifest);
    const existing=await db.prepare("SELECT manifest FROM replica_generations WHERE generation=?").bind(input.asOf).first<{manifest:string}>();
    if(existing&&existing.manifest!==manifest)return json({error:"历史发布不可改写"},409);
    await db.prepare("INSERT INTO replica_generations(generation,manifest,published_at) VALUES(?,?,?) ON CONFLICT(generation) DO NOTHING").bind(input.asOf,manifest,new Date().toISOString()).run();
    const committed=await db.prepare("SELECT manifest FROM replica_generations WHERE generation=?").bind(input.asOf).first<{manifest:string}>();
    if(committed?.manifest!==manifest)return json({error:"并发发布清单冲突，未确认本次发布"},409);
    return json({published:true,asOf:input.asOf,parts:files.length});
  } catch(error) {
    const bodyCode=error&&typeof error==='object'&&'code'in error?error.code:null;
    if(bodyCode==='date-audit-input')return json({error:'日期审查批次无效'},400);
    if(bodyCode==='date-audit-incomplete')return json({error:'日期来源尚未全部审查，未发布'},409);
    if(bodyCode==='replica-storage-repair')return json({error:'存储分片缺失或损坏，未发布'},409);
    if(bodyCode==='too-large')return json({error:'批次过大'},413);
    if(bodyCode==='unsupported-encoding')return json({error:'不支持的传输编码'},415);
    if(bodyCode==='invalid-body')return json({error:'请求内容无效'},400);
    if(activationPhase)console.warn(JSON.stringify({event:'replica-activation-failed',phase:activationPhase,
      requestAborted:request.signal.aborted,elapsedMs:Date.now()-(activationStartedAt??Date.now())}));
    return json({error:"同步未完成，现有已发布数据保持不变"},503);
  }
}
