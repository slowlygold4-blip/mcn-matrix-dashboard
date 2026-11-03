import {withReplicaReadDeadline} from './replica-read-deadline.mjs';

/**
 * One bounded HTTP request, including JSON decoding. Writes are never retried here.
 * @param {{input?:Record<string,unknown>,controller?:AbortController,fetcher?:typeof fetch,timeoutMs?:number}} options
 */
export function requestCollection({input,controller=new AbortController(),fetcher=fetch,timeoutMs=12000}={}) {
 return withReplicaReadDeadline({controller,timeoutMs,operation:async signal=>{
  const response=await fetcher('/api/collection',{
   cache:'no-store',signal,
   ...(input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),
  });
  const body=await response.json();
  if(!response.ok)throw Error(typeof body?.error==='string'?body.error:'采集服务请求失败，请重试');
  if(!body||typeof body!=='object'||Array.isArray(body))throw Error('采集状态格式无效');
  return body;
 }});
}

/** Polls share one read; a command refresh supersedes it and ignores late responses. */
export function createCollectionStatusReader({onData,onError,fetcher=fetch,timeoutMs=12000}) {
 let current=null,disposed=false;
 return {
  refresh({replace=false}={}) {
   if(disposed)return Promise.resolve();
   if(current&&!replace)return current.promise;
   current?.controller.abort();
   const job={controller:new AbortController(),promise:null};
   current=job;
   job.promise=requestCollection({controller:job.controller,fetcher,timeoutMs})
    .then(data=>{if(!disposed&&current===job){
     if(typeof data.online!=='boolean'||typeof data.canControl!=='boolean')throw Error('采集状态格式无效');
     onData(data);
    }})
    .catch(error=>{if(!disposed&&current===job)onError(error);})
    .finally(()=>{if(current===job)current=null;});
   return job.promise;
  },
  dispose(){disposed=true;current?.controller.abort();current=null;},
 };
}

/** Display 100% only when the reported denominator is actually reached. */
export function collectionPercent(done,total) {
 if(!Number.isFinite(done)||!Number.isFinite(total)||done<0||total<=0)return null;
 const value=Math.min(100,done/total*100);
 return {value,label:value<100?Math.min(99.9,Number(value.toFixed(1))).toFixed(1):'100.0'};
}
