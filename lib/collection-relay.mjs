import {collectionTransport} from './collection-transport.mjs';
import {PUBLIC_REPLICA_ORIGIN} from './public-replica-sync.mjs';
// Ordinary HTTP + local scheduler. Never invokes a model or a second collector.
export function startCollectionRelay({getCredential,loadState,saveState,fetchImpl=collectionTransport,onError=()=>{}}){
 let busy=false,stopped=false,failures=0,next=0,cookie="",csrf="";
 const abort=new AbortController();
 const request=async(url,options={})=>{
  const local=url.startsWith('http://127.0.0.1:4188/');
  const r=await fetchImpl(url,{...options,headers:{...options.headers,...(local&&cookie?{Cookie:cookie}:{}),...(local&&csrf&&options.method==='POST'?{'X-CSRF-Token':csrf}:{})},redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
  if(local&&r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  if(!r.ok)throw Object.assign(Error('collection-relay-http'),{status:r.status});return r.json();
 };
 async function tick(){
  if(stopped||busy||Date.now()<next)return;busy=true;
  try{
   let state=await loadState()??{};
   if(!csrf){const auth=await request('http://127.0.0.1:4188/api/auth/session');csrf=auth.csrfToken;if(!csrf)throw Error('local-session-unavailable');}
   const status=await request('http://127.0.0.1:4188/api/collection-progress');
   let ack=null;
   if(state.commandId&&state.jobId){
    const result=await request('http://127.0.0.1:4188/api/refresh-collection?jobId='+encodeURIComponent(state.jobId));
    if(result.job)ack={id:state.commandId,jobId:result.job.id,status:result.job.status,runId:result.job.runId};
   }
   const exchange=await request(PUBLIC_REPLICA_ORIGIN+'/api/collection',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await getCredential()},body:JSON.stringify({action:'heartbeat',status,ack})});
   const command=exchange.command;
   if(command&&(!state.jobId||state.commandId!==command.id)){
    state={commandId:command.id,jobId:command.receipt?.jobId??null};await saveState(state);
    if(!state.jobId){
     const result=await request('http://127.0.0.1:4188/api/refresh-collection',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:4188'},body:JSON.stringify({requestId:command.id})});
     if(!result.job?.id)throw Error('invalid-job-receipt');
     state.jobId=result.job.id;await saveState(state);
    }
   }
   if(!command&&state.commandId){await saveState({});}
   failures=0;next=0;
  }catch(error){if(!stopped){failures++;next=Date.now()+Math.min(60000,failures*15000);onError({code:'collection-relay-unavailable',httpStatus:error.status??null});}}
  finally{busy=false;}
 }
 const timer=setInterval(()=>void tick(),15000);void tick();
 return {tick,stop(){stopped=true;clearInterval(timer);abort.abort();}};
}
