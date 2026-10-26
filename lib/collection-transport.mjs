import https from 'node:https';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLIC_REPLICA_ORIGIN} from './public-replica-sync.mjs';
let agent;
export async function collectionTransport(url,options={}){
 if(new URL(url).origin==='http://127.0.0.1:4188')return fetch(url,options);
 if(new URL(url).origin!==PUBLIC_REPLICA_ORIGIN)throw Error('untrusted-control-destination');
 if(!agent){
  let proxyUrl=process.env.MCN_CONTROL_PROXY_URL;
  if(!proxyUrl)try{proxyUrl=JSON.parse(readFileSync(join(process.env.DATA_DIR||fileURLToPath(new URL('../data',import.meta.url)),'public-replica-publisher','network.json'),'utf8')).proxyUrl;}catch{}
  // Reuse the deployment's existing trusted outbound proxy only for this Site.
  // Sampler traffic and process-wide fetch configuration remain unchanged.
  agent=new https.Agent({keepAlive:true,maxSockets:2,...(proxyUrl?{proxyEnv:{HTTPS_PROXY:proxyUrl}}:{})});
 }
 return new Promise((resolve,reject)=>{
  const req=https.request(url,{agent,method:options.method||'GET',headers:options.headers,signal:options.signal,timeout:15000},res=>{
   let size=0;const parts=[];res.on('data',part=>{size+=part.length;if(size>256000){res.destroy(Error('control-response-too-large'));return;}parts.push(part);});
   res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v]))})));
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('control-request-timeout')));req.end(options.body);
 });
}
