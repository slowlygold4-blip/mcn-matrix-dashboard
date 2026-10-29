import {replicaPartitionByteLimit,replicaBatchByteLimit,REPLICA_UPLOAD_MAX_BYTES} from '@/lib/replica-partition-budget.mjs';
import {auditPublishing} from '@/lib/replica-publishing.mjs';
import {creatorFile,creatorKind,creatorPartValid,auditCreatorPublication} from '@/lib/replica-creator.mjs';
import { env } from "cloudflare:workers";
import {summaryDescriptors,summaryPartValid} from '@/lib/replica-summary.mjs';
import {auditDatePublication} from '@/lib/replica-date-audit.mjs';
export const dynamic = "force-dynamic";
const PATH = /^(catalog|topics|summary|date-summary-index|publishing)\.json$|^(daily|works|work-metrics)\/[0-9]{1,8}\.json$|^(summary|date-summary|publishing)\/[0-9]{6}\.json$|^creator\/(index|authors|insights|works-\d{3})\.json$/;
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
  try {
    const {db,bucket}=runtime(); const url = new URL(request.url);
    const requested = url.searchParams.get("generation") || null;
    if (requested && !validGeneration(requested)) return json({error:"无效数据截面"},400);
    // A named generation is immutable once activated. Do not fetch the latest
    // publication first for every individual date shard.
    const published = requested
      ? await db.prepare("SELECT generation,manifest,published_at FROM replica_generations WHERE generation=?").bind(requested).first<{generation:string;manifest:string;published_at:string}>()
      : await db.prepare("SELECT generation,manifest,published_at FROM replica_generations ORDER BY generation DESC LIMIT 1").first<{generation:string;manifest:string;published_at:string}>();
    if (!published) return requested ? json({error:"未发布的数据截面"},404) : json({error:"尚未同步可公开数据"},503);
    const generation = published.generation;
    const manifest = JSON.parse(published.manifest);
    const part = url.searchParams.get("part");
    if (!part) return json({manifest,publishedAt:published.published_at,readOnly:true,collectionRequiresLocalComputer:true});
    if (!PATH.test(part)) return json({error:"不支持的数据分区"},400);
    // Activation audited each file against replica_files. The sealed manifest
    // is authoritative for reads; querying that table again adds latency to
    // every shard without providing another independent content check.
    const file = manifest.files.find((f:{path:string})=>f.path===part);
    if (!file) return json({error:"分区不在已发布清单"},404);
    if (!SHA.test(file.sha256)) return json({error:"发布清单校验信息无效"},503);
    const body = await bucket.get(`${generation}/${file.sha256}`);
    if (!body) return json({error:"数据暂不可用"},503);
    return new Response(body.body,{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public,max-age=300,immutable","X-Content-Type-Options":"nosniff","X-Data-SHA256":file.sha256,"X-Data-Cutoff":generation}});
  } catch { return json({error:"云端数据暂不可用，请稍后重试"},503); }
}
export async function POST(request: Request) {
  // A producer-only endpoint. Anonymous readers can never upload or activate.
  const producer = (env as unknown as Record<string,unknown>).REPLICA_INGEST_SECRET;
  if (typeof producer !== "string" || producer.length < 48 || request.headers.get("Authorization") !== `Bearer ${producer}`) return json({error:"只读访问"},403);
  try {
    const text=await request.text(); if(new TextEncoder().encode(text).length>REPLICA_UPLOAD_MAX_BYTES) return json({error:"批次过大"},413);
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
      let next=0,failed=false;
      const store=async()=>{while(!failed&&next<prepared.length){const f=prepared[next++];try{
        await bucket.put(`${input.asOf}/${f.sha256}`,f.data,{httpMetadata:{contentType:"application/json"}});
      }catch{failed=true;}}};
      await Promise.allSettled(Array.from({length:Math.min(2,prepared.length)},store));
      if(failed)return json({error:"分区保存未完成，尚未确认本批次"},503);
      const writes=await db.batch(prepared.map(f=>db.prepare("INSERT INTO replica_files(generation,path,checksum,bytes) VALUES(?,?,?,?) ON CONFLICT(generation,path) DO NOTHING").bind(input.asOf,f.path,f.sha256,f.bytes)));
      if(writes.length!==prepared.length||writes.some(result=>!result.success))return json({error:"批次索引保存未完成，尚未确认本批次"},503);
      // A competing immutable upload can win between the initial read and the
      // batch. Acknowledge only the exact hashes now bound in D1.
      const committed=await readMetadata();
      if(committed.results.length!==prepared.length||committed.results.some(f=>expected.get(f.path)!==f.checksum))return json({error:"已保存分区不可改写"},409);
      return json({accepted:input.files.length,asOf:input.asOf});
    }
    if(input.action!=="activate"||input.manifest?.asOf!==input.asOf||!Array.isArray(input.manifest.files)||privateKey(input.manifest))return json({error:"无效发布清单"},400);
    const files=input.manifest.files;
    if(!files.some((f:{path:string})=>f.path==="catalog.json")||!files.some((f:{path:string})=>f.path==="summary.json")||!files.some((f:{path:string})=>f.path==="topics.json"))return json({error:"必需分区缺失"},400);
    const rows=await db.prepare("SELECT path,checksum,bytes FROM replica_files WHERE generation=?").bind(input.asOf).all<{path:string;checksum:string;bytes:number}>();
    const map=new Map(rows.results.map(x=>[x.path,x]));
    if(new Set(files.map((x:{path:string})=>x.path)).size!==files.length||files.length!==map.size||files.some((f:{path:string;sha256:string;bytes:number})=>!PATH.test(f.path)||!SHA.test(f.sha256)||map.get(f.path)?.checksum!==f.sha256||map.get(f.path)?.bytes!==f.bytes))return json({error:"分区清单不一致，未发布"},409);
    const summaryMeta=files.find((f:{path:string})=>f.path==='summary.json');
    const summaryObject=await bucket.get(`${input.asOf}/${summaryMeta.sha256}`);
    if(!summaryObject)return json({error:"历史索引缺失，未发布"},409);
    const summaryText=await summaryObject.text();
    if(summaryText.length>6_000_000||await bytesHash(summaryText)!==summaryMeta.sha256)return json({error:"历史索引校验失败，未发布"},409);
    let descriptors;try {descriptors=summaryDescriptors(JSON.parse(summaryText),input.manifest);}catch{return json({error:"历史分片不一致，未发布"},409);}
    if(descriptors)for(const s of descriptors){const object=await bucket.get(`${input.asOf}/${s.sha256}`);if(!object)return json({error:"历史分片缺失，未发布"},409);const body=await object.text();if(body.length>1_000_000||await bytesHash(body)!==s.sha256)return json({error:"历史分片校验失败，未发布"},409);const parsed=JSON.parse(body);if(!summaryPartValid(parsed,input.asOf)||parsed.items.length!==s.count)return json({error:"历史分片记录数不一致，未发布"},409);}
    if(files.some((f:{kind:string;path:string})=>f.kind==='summaryDateIndex'||f.kind==='summaryDateShard'||f.path==='date-summary-index.json'||f.path.startsWith('date-summary/'))){
      try{await auditDatePublication({manifest:input.manifest,readText:async(path:string)=>{const meta=files.find((f:{path:string})=>f.path===path);if(!meta)throw Error('missing-date-meta');const object=await bucket.get(`${input.asOf}/${meta.sha256}`);if(!object)throw Error('missing-date-source');return object.text();},signal:request.signal});}
      catch{return json({error:"日期历史未通过全量来源核对，未发布"},409);}
    }
    try{await auditPublishing({manifest:input.manifest,readPart:async(path:string)=>{const m=files.find((f:{path:string})=>f.path===path);if(!m)throw Error('missing');const obj=await bucket.get(`${input.asOf}/${m.sha256}`);if(!obj)throw Error('missing');const body=await obj.text();if(await bytesHash(body)!==m.sha256)throw Error('checksum');return JSON.parse(body);}});}catch{return json({error:'每日发片索引核验失败'},409);}
    try{await auditCreatorPublication({manifest:input.manifest,readPart:async(path:string)=>{const m=files.find((f:{path:string})=>f.path===path);if(!m)throw Error('missing');const obj=await bucket.get(`${input.asOf}/${m.sha256}`);if(!obj)throw Error('missing');const body=await obj.text();if(new TextEncoder().encode(body).length!==m.bytes||await bytesHash(body)!==m.sha256)throw Error('checksum');return JSON.parse(body);}});}catch{return json({error:'作者作品与经营统计核验失败，未发布'},409);}
    const manifest=JSON.stringify(input.manifest);
    const existing=await db.prepare("SELECT manifest FROM replica_generations WHERE generation=?").bind(input.asOf).first<{manifest:string}>();
    if(existing&&existing.manifest!==manifest)return json({error:"历史发布不可改写"},409);
    await db.prepare("INSERT INTO replica_generations(generation,manifest,published_at) VALUES(?,?,?) ON CONFLICT(generation) DO NOTHING").bind(input.asOf,manifest,new Date().toISOString()).run();
    const committed=await db.prepare("SELECT manifest FROM replica_generations WHERE generation=?").bind(input.asOf).first<{manifest:string}>();
    if(committed?.manifest!==manifest)return json({error:"并发发布清单冲突，未确认本次发布"},409);
    return json({published:true,asOf:input.asOf,parts:files.length});
  } catch {return json({error:"同步未完成，现有已发布数据保持不变"},503);}
}
