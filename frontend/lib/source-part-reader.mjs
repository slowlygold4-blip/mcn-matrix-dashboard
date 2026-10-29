import {withReplicaReadDeadline} from './replica-read-deadline.mjs';

const safeSegment = value => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const safePart = value => typeof value === 'string' && value.endsWith('.json')
 && value.split('/').every(safeSegment);

function validateRoot(root) {
 if(typeof root!=='string'||!root.startsWith('/')||!root.endsWith('/')||!root.slice(1,-1).split('/').every(safeSegment))throw Error('来源分区目录无效');
 return root;
}
function validateRevision(revision) {
 if(typeof revision!=='string'||!revision.trim())throw Error('来源修订标识无效');
 return revision;
}
function validateFile(file) {
 if(!file||!safePart(file.path)||!Number.isSafeInteger(file.count)||file.count<0
  ||!Number.isSafeInteger(file.bytes)||file.bytes<1||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('来源分区路径或校验信息无效');
 return file;
}

/** A source revision may retain its label after corrected values or account links change. */
export function sourcePartsIdentity(files,revision,root='/creator-source/') {
 validateRoot(root);validateRevision(revision);
 if(!Array.isArray(files))throw Error('来源分区清单无效');
 const paths=new Set();
 const parts=files.map(file=>{
  validateFile(file);
  if(paths.has(file.path))throw Error('来源分区路径重复');
  paths.add(file.path);
  return [file.path,file.count,file.bytes,file.sha256];
 }).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 return JSON.stringify([root,revision,parts]);
}

/** Own the deadline controller so timeout remains visible to the caller's error UI. */
async function boundedRead(signal,operation,timeoutMs) {
 if(signal!=null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw Error('来源读取取消信号无效');
 const controller=new AbortController();
 const cancel=()=>controller.abort(Object.assign(new Error('来源数据读取已取消。'),{name:'AbortError'}));
 if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
 try{return await withReplicaReadDeadline({controller,timeoutMs,operation:()=>operation(controller.signal)});}
 finally{signal?.removeEventListener('abort',cancel);}
}

export async function readSourcePart(file,revision,signal,root='/creator-source/',options={}) {
 validateRoot(root);validateRevision(revision);validateFile(file);
 const {fetcher=fetch,timeoutMs=20000}=options;
 if(typeof fetcher!=='function')throw Error('来源读取方法无效');
 const generation=file.generation;
 const liveRoot=root==='/creator-source/'?'creator/':root==='/table-foundation/'?'foundation/':null;
 const livePart=root==='/creator-source/'?/^((authors|insights)|works-\d{3})\.json$/:/^(authors|works|sources|observations|other-authors|other-works|pending-authors)\.json$/;
 if(generation!==undefined&&(!liveRoot||typeof generation!=='string'||!Number.isFinite(Date.parse(generation))||new Date(generation).toISOString()!==generation||!livePart.test(file.path)))throw Error('来源分区截面无效');
 return boundedRead(signal,async innerSignal=>{
  const path=generation?'/api/replica?'+new URLSearchParams({generation,part:liveRoot+file.path}):root+file.path;
  const response=await fetcher(path,{cache:'no-store',signal:innerSignal});
  if(!response.ok)throw Error(`来源分区读取失败：${file.path}`);
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength!==file.bytes)throw Error(`来源分区长度不符：${file.path}`);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const checksum=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  if(checksum!==file.sha256)throw Error(`来源分区校验失败：${file.path}`);
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error(`来源分区内容无法读取：${file.path}`);}
  if(body?.revision!==revision||!Array.isArray(body?.items)||body.items.length!==file.count)throw Error(`来源分区版本或行数不符：${file.path}`);
  if(generation&&(body.version!==1||body.asOf!==generation||body.timeZone!=='Asia/Shanghai'))throw Error('来源分区截面不一致');
  return body.items;
 },timeoutMs);
}

/**
 * @param {string} url
 * @param {{signal?: AbortSignal, fetcher?: typeof fetch, timeoutMs?: number, preferReplica?: boolean, manifest?: {asOf: string, files: any[]}}} [options]
 */
export async function readSourceIndex(url,{signal,fetcher=fetch,timeoutMs=20000,preferReplica=false,manifest:knownManifest}={}) {
 if(typeof url!=='string'||!url.startsWith('/')||!safePart(url.slice(1)))throw Error('来源索引路径无效');
 if(typeof fetcher!=='function')throw Error('来源读取方法无效');
 return boundedRead(signal,async innerSignal=>{
  const live=url==='/creator-source/index.json'?{path:'creator/index.json',kind:'creatorIndex',label:'作者作品'}:url==='/table-foundation/index.json'?{path:'foundation/index.json',kind:'foundationIndex',label:'补充来源'}:null;
  if(preferReplica&&live){
   let manifest=knownManifest;
   if(!manifest){
    const manifestResponse=await fetcher('/api/replica',{cache:'no-store',signal:innerSignal});
    if(!manifestResponse.ok)throw Error('最新'+live.label+'数据暂不可读，请重试。');
    manifest=(await manifestResponse.json()).manifest;
   }
   if(!manifest||typeof manifest.asOf!=='string'||!Number.isFinite(Date.parse(manifest.asOf))||new Date(manifest.asOf).toISOString()!==manifest.asOf||!Array.isArray(manifest.files))throw Error(live.label+'发布清单无效');
   const meta=manifest.files.find(file=>file.path===live.path);
   if(meta){
    if(meta.kind!==live.kind||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||!/^[a-f0-9]{64}$/.test(meta.sha256))throw Error(live.label+'索引校验信息无效');
    const r=await fetcher('/api/replica?'+new URLSearchParams({generation:manifest.asOf,part:meta.path}),{cache:'no-store',signal:innerSignal});
    if(!r.ok)throw Error('最新'+live.label+'索引暂不可读，请重试。');
    const bytes=await r.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
    if(bytes.byteLength!==meta.bytes||[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')!==meta.sha256)throw Error(live.label+'索引校验不一致');
    const index=JSON.parse(new TextDecoder().decode(bytes));
    if(index.version!==1||index.asOf!==manifest.asOf||index.timeZone!=='Asia/Shanghai'||!Array.isArray(index.files)||index.files.some(f=>f.generation!==manifest.asOf))throw Error(live.label+'版本不一致');
    return index;
   }
   // Old already-published generations have no creator corpus. Only this
   // explicit absence permits the unchanged static fallback during rollout.
  }
  const response=await fetcher(url,{cache:'no-store',signal:innerSignal});
  if(!response.ok)throw Error('来源索引暂不可读，请重试。');
  try{return await response.json();}catch(error){
   if(error?.name==='AbortError'||error?.name==='TimeoutError')throw error;
   throw Error('来源索引内容无法读取，请重试。');
  }
 },timeoutMs);
}
