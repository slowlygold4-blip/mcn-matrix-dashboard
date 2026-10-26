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
 return boundedRead(signal,async innerSignal=>{
  const response=await fetcher(root+file.path,{cache:'no-store',signal:innerSignal});
  if(!response.ok)throw Error(`来源分区读取失败：${file.path}`);
  const bytes=await response.arrayBuffer();
  if(bytes.byteLength!==file.bytes)throw Error(`来源分区长度不符：${file.path}`);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const checksum=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  if(checksum!==file.sha256)throw Error(`来源分区校验失败：${file.path}`);
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error(`来源分区内容无法读取：${file.path}`);}
  if(body?.revision!==revision||!Array.isArray(body?.items)||body.items.length!==file.count)throw Error(`来源分区版本或行数不符：${file.path}`);
  return body.items;
 },timeoutMs);
}

/**
 * @param {string} url
 * @param {{signal?: AbortSignal, fetcher?: typeof fetch, timeoutMs?: number}} [options]
 */
export async function readSourceIndex(url,{signal,fetcher=fetch,timeoutMs=20000}={}) {
 if(typeof url!=='string'||!url.startsWith('/')||!safePart(url.slice(1)))throw Error('来源索引路径无效');
 if(typeof fetcher!=='function')throw Error('来源读取方法无效');
 return boundedRead(signal,async innerSignal=>{
  const response=await fetcher(url,{cache:'no-store',signal:innerSignal});
  if(!response.ok)throw Error('来源索引暂不可读，请重试。');
  try{return await response.json();}catch(error){
   if(error?.name==='AbortError'||error?.name==='TimeoutError')throw error;
   throw Error('来源索引内容无法读取，请重试。');
  }
 },timeoutMs);
}
