// Explicit HTTP acceptance against a synthetic, loopback-only upstream.
// Requires npm run build. No browser, production data or platform requests.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readReplicaPart} from '../lib/replica-reader.mjs';
import {loadReplicaView} from '../lib/replica-view.mjs';
import {rowsFor} from '../lib/replica-model.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),asOf='2026-10-23T12:00:00.000Z';
const hash=text=>createHash('sha256').update(text).digest('hex'),parts=new Map();
const seal=(path,value,extra={})=>{const text=JSON.stringify(value)+'\n';parts.set(path,text);return {path,...extra,bytes:Buffer.byteLength(text),sha256:hash(text)};};
const point=(targetId,date,value)=>{const at=date+'T03:00:00.000Z';return {targetId,date,capturedAt:at,followers:value,followersAt:at,likes:value*2,likesAt:at,posts:1,postsAt:at};};
const points=[point(1,'2026-09-12',100),point(2,'2026-09-12',200),point(1,'2026-10-23',90),point(2,'2026-10-23',210)];
const common={version:1,asOf,timeZone:'Asia/Shanghai'};
const accounts=[1,2].map(id=>({id,enabled:true,platform:'douyin',label:'Synthetic author '+id,boardKeys:['matrix'],classification:{theme:{key:'tuantuan',label:'团团'},labels:[]},latest:{followers:{value:id===1?90:210,date:'2026-10-23',observedAt:'2026-10-23T03:00:00.000Z'}}}));
const catalog=seal('catalog.json',{...common,accounts,boards:[{key:'matrix',name:'Synthetic matrix'}]},{kind:'catalog',count:2});
const topics=seal('topics.json',{...common,topics:[],items:[]},{kind:'topics',count:0});
const daily=accounts.map(a=>seal(`daily/${a.id}.json`,{...common,items:points.filter(p=>p.targetId===a.id)},{kind:'daily',targetId:a.id,count:2}));
const base={...common,counts:{accounts:2,daily:4},files:[catalog,topics,...daily]};
const shard=seal('date-summary/000001.json',{...common,items:points},{kind:'summaryDateShard',count:4});
const {kind,...shardMeta}=shard;
const index={...common,format:'date-shards-v1',sourceManifestSha256:hash(JSON.stringify(base)),sourceDaily:daily.map(({kind,...p})=>p),count:4,firstDate:'2026-09-12',lastDate:'2026-10-23',shards:[{...shardMeta,firstDate:'2026-09-12',lastDate:'2026-10-23'}]};
const rootMeta=seal('date-summary-index.json',index,{kind:'summaryDateIndex',count:4});
const manifest={...base,files:[...base.files,rootMeta,shard]};let upstreamWrites=0,forwardedCredentials=0;
const upstream=createServer((request,response)=>{
 if(request.method!=='GET'){upstreamWrites++;response.writeHead(405).end();return;}
 if(request.headers.cookie||request.headers.authorization)forwardedCredentials++;
 const url=new URL(request.url,'http://localhost');response.setHeader('Content-Type','application/json');
 if(url.pathname==='/api/collection'){response.end(JSON.stringify({role:'viewer',runtimeAI:false}));return;}
 const part=url.searchParams.get('part');if(!part){response.end(JSON.stringify({manifest,publishedAt:asOf,readOnly:true}));return;}
 const meta=manifest.files.find(f=>f.path===part);if(!meta){response.writeHead(404).end('{}');return;}
 response.setHeader('X-Data-SHA256',meta.sha256);response.setHeader('X-Data-Cutoff',asOf);response.end(parts.get(part));
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const upstreamOrigin='http://127.0.0.1:'+upstream.address().port;
const freePort=async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fetchLocal=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(5000)});
const results=[];
try{
 for(const mode of ['dev','production']){
  const port=await freePort(),origin='http://127.0.0.1:'+port;
  const command=mode==='dev'?['scripts/run-framework.mjs','dev','--hostname','127.0.0.1','--port',String(port)]:['scripts/start-frontend.mjs','--port',String(port)];
  const child=spawn(process.execPath,command,{cwd:root,env:{...process.env,MCN_FRONTEND_RUNTIME:'standalone',MCN_READONLY_ORIGIN:upstreamOrigin},stdio:['ignore','pipe','pipe']});
  const alive=()=>child.exitCode===null&&child.signalCode===null;
  let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log=(log+String(chunk)).slice(-12000);});
  try{
   const deadline=Date.now()+30000;let home;
   while(Date.now()<deadline){if(!alive())throw Error('standalone-server-exited');try{home=await fetchLocal(origin+'/');if(home.ok)break;}catch{}await pause(200);}
   if(!home?.ok)throw Error('standalone-home-not-ready');
   const html=await home.text();if(!/矩阵|MCN/.test(html))throw Error('standalone-html-unexpected');
   const metaResponse=await fetchLocal(origin+'/api/replica',{headers:{Cookie:'SYNTHETIC_PRIVATE',Authorization:'Bearer SYNTHETIC_PRIVATE'}});
   if(metaResponse.status!==200)throw Error('standalone-meta-'+metaResponse.status);
   const meta=await metaResponse.json();
   const view=await loadReplicaView({manifest:meta.manifest,readPart:part=>readReplicaPart({generation:asOf,part,meta:manifest.files.find(f=>f.path===part),fetcher:(path,options)=>fetchLocal(new URL(path,origin),options)})});
   if(!view.summaryLoaded||!view.receipt?.complete||view.points.length!==4)throw Error('standalone-history-contract');
   const rows=rowsFor(view.accounts,view.points,'2026-09-12','2026-10-23');
   if(rows[0].metrics.followers.delta!==-10||rows[1].metrics.followers.delta!==10)throw Error('standalone-metric-contract');
   for(const path of ['/api/replica','/api/collection'])if((await fetchLocal(origin+path,{method:'POST',body:'{}'})).status!==405)throw Error('standalone-write-not-denied');
   results.push({mode,home:home.status,metadata:metaResponse.status,points:view.points.length,followersDeltas:rows.map(r=>r.metrics.followers.delta),writesDenied:true});
  }catch(error){console.error(JSON.stringify({mode,code:error.message,serverLog:log.replace(/https?:\/\/\S+/g,'[local-server]').replace(/\/Users\/\S+/g,'[workspace]')}));throw error;}
  finally{
   if(alive()){child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(5000)]);if(alive()){child.kill('SIGKILL');await once(child,'exit');}}
  }
 }
 if(upstreamWrites||forwardedCredentials)throw Error('readonly-upstream-boundary-failed');
 console.log(JSON.stringify({results,upstreamWrites,forwardedCredentials,syntheticOnly:true,browserUsed:false,platformRequests:0,modelCalls:0}));
}finally{await new Promise(resolve=>upstream.close(resolve));}
