import {withReplicaReadDeadline} from './replica-read-deadline.mjs';
const json=(error,status)=>Response.json({error},{status,headers:{'Cache-Control':'no-store'}});
export const isReadOnlyFrontend=value=>value?.MCN_STANDALONE_READONLY===true;
/** Server-only read bridge. The origin is operator configuration, never a URL
 * from the visitor. No cookies, auth headers, redirects, writes or retries. */
export async function forwardReadOnlyFrontend(request,{origin=process.env.MCN_READONLY_ORIGIN||'',fetcher=fetch,timeoutMs=20000,maxBytes=8_000_000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8_000_000)return json('只读请求预算无效',503);
 if(!['GET','HEAD'].includes(request.method))return json('本地开发副本只读；采集、上传和发布指令不会转发。',405);
 const incoming=new URL(request.url);
 if(!['/api/replica','/api/collection'].includes(incoming.pathname)||incoming.search.length>2048)return json('不支持的只读路径',400);
 if(!origin)return json('未配置只读数据源。请设置 MCN_READONLY_ORIGIN 后重启前端。',503);
 let base;
 try{base=new URL(origin);if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw Error();}
 catch{return json('只读数据源必须是 HTTPS 网站根地址，或本机 HTTP 根地址。',503);}
 const controller=new AbortController(),abort=()=>controller.abort(request.signal.reason);
 if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});
 try{return await withReplicaReadDeadline({controller,timeoutMs,operation:async()=>{
  controller.signal.throwIfAborted();
  const response=await fetcher(new URL(incoming.pathname+incoming.search,base),{method:request.method,headers:{Accept:'application/json'},redirect:'manual',signal:controller.signal});
  if(response.status>=300&&response.status<400){await response.body?.cancel();return json('只读数据源发生重定向，未自动跟随或登录。',502);}
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){await response.body?.cancel();return json('只读数据源未返回 JSON，请检查网络和地址。',502);}
  const headers=new Headers({'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','X-MCN-Mode':'standalone-readonly'});
  for(const name of ['X-Data-SHA256','X-Data-Cutoff','X-Replica-Storage'])if(response.headers.has(name))headers.set(name,response.headers.get(name));
  if(request.method==='HEAD'){await response.body?.cancel();return new Response(null,{status:response.status,headers});}
  const reader=response.body?.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),chunks=[];let bytes=0;
  if(reader)try{while(true){controller.signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes)throw Error('body-too-large');chunks.push(decoder.decode(value,{stream:true}));}chunks.push(decoder.decode());}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  controller.signal.throwIfAborted();return new Response(chunks.join(''),{status:response.status,headers});
 }}); }catch{return json('只读数据源读取失败或超时；未启动采集或重试。',502);}
 finally{request.signal.removeEventListener('abort',abort);}
}
