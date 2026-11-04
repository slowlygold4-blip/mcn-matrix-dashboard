// Optional, finite HTTP evaluation within the existing collector's mutex.
// Never creates a process, interval, browser session or model request.
import {readFileSync,statSync} from 'node:fs';
import {ensureRemoteWorkAttempts,reserveRemoteWorkAttempt,finishRemoteWorkAttempt} from './remote-work-evaluation.mjs';
import {fetchRemoteAuthorPosts} from './providers/remote-author-posts-http.mjs';
import {recordRemoteWorkPage} from './remote-work-observation.mjs';

export function readRemoteWorkTaskConfig(path){
 let text;try{
  if(statSync(path).size>4096)throw Error('invalid remote work configuration');
  text=readFileSync(path,'utf8');
 }catch(error){if(error.code==='ENOENT')return null;throw Error('invalid remote work configuration');}
 let config;try{config=JSON.parse(text);}catch{throw Error('invalid remote work configuration');}
 if(config?.enabled===false)return null;
 if(!config||typeof config!=='object'||Array.isArray(config)||config.enabled!==true
  ||Object.keys(config).some(k=>!['enabled','targetId','sourceOrigin','startsOn','endsOn'].includes(k))
  ||!Number.isSafeInteger(config.targetId)||config.targetId<1||config.sourceOrigin!=='https://demo.douyin.wtf')throw Error('invalid remote work configuration');
 for(const k of ['startsOn','endsOn'])if(typeof config[k]!=='string'||!/^\d{4}-\d\d-\d\d$/.test(config[k])
  ||!Number.isFinite(Date.parse(config[k]))||new Date(config[k]).toISOString().slice(0,10)!==config[k])throw Error('invalid remote work configuration');
 const days=(Date.parse(config.endsOn)-Date.parse(config.startsOn))/86400000;
 if(days<0||days>6)throw Error('invalid remote work configuration');
 return Object.freeze(config);
}

export function createRemoteWorkTask(db,config,{signal,fetchPage=fetchRemoteAuthorPosts,now=Date.now,onCommitted=()=>{}}={}){
 if(!config)return null;
 ensureRemoteWorkAttempts(db);
 return {
  reserve(at=new Date()){
   if(signal?.aborted)return null;
   const attempt=reserveRemoteWorkAttempt(db,{...config,now:at.getTime()});
   if(!attempt)return null;
   return async()=>{
    let requestCount=0;
    try{
     signal?.throwIfAborted();
     const result=await fetchPage({sourceOrigin:config.sourceOrigin,secUid:attempt.anchor.secUid,
      authMode:'demo',signal,now});
     requestCount=result.transport.totalRequests;
     signal?.throwIfAborted();
     const admitted=recordRemoteWorkPage(db,{targetId:config.targetId,receipt:result.receipt},
      {now:now(),sourceOrigin:config.sourceOrigin,attemptId:attempt.id,requestCount});
     // Admission is committed before invalidation. A notification failure
     // must not relabel a successful durable observation as failed.
     try{await onCommitted(admitted);}catch{ /* Next version marker still invalidates published data. */ }
     return {status:'success',postCount:admitted.postCount,coverage:'limited',runtimeAI:false};
    }catch(error){
     const code=typeof error.code==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(error.code)?error.code:'REMOTE_WORK_FAILED';
     const reported=error.transport?.totalRequests;
     if(Number.isSafeInteger(reported)&&reported>=0&&reported<=4)requestCount=reported;
     const stopped=[401,403,429].includes(error.httpStatus)||/LOGIN|BLOCK|RATE_LIMIT|CIRCUIT|AUTH|FORBIDDEN/i.test(code+' '+(error.upstreamCode||''));
     finishRemoteWorkAttempt(db,attempt.id,{status:stopped?'stopped':'failed',errorCode:code,
      postCount:0,requestCount,eventKey:null,now:now()});
     return {status:stopped?'stopped':'failed',errorCode:code,postCount:0,runtimeAI:false};
    }
   };
  },
  state(){
   const row=db.prepare('SELECT day,started_at,finished_at,status,error_code,post_count,request_count FROM remote_work_attempts WHERE source=? AND target_id=? ORDER BY started_at DESC LIMIT 1')
    .get(config.sourceOrigin,config.targetId);
   return {mode:'finite-http-evaluation',startsOn:config.startsOn,endsOn:config.endsOn,runtimeAI:false,
    maximumTargets:1,maximumBusinessRequestsPerDay:1,lastAttempt:row?{...row}:null};
  },
 };
}
