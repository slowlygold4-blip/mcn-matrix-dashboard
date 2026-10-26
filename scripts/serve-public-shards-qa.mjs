// Loopback-only, time-bounded acceptance replay of already-saved, scrubbed bytes.
// No production database, platform request, credentials, or cloud write.
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const dir=join(process.cwd(),'data/public-replica-staging/2026-10-01T01-31-30-128Z');
const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
const files=[];for(const f of manifest.files)files.push({...f,content:await readFile(join(dir,f.path),'utf8')});
const publication=await preparePublicReplicaPublication({manifest,files},{dateIndex:process.argv.includes('--date-index')});const parts=new Map(publication.files.map(f=>[f.path,f]));
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://127.0.0.1:4192');if(req.method!=='GET'){res.writeHead(405);return res.end();}
 if(url.pathname==='/api/replica'){const part=url.searchParams.get('part');res.setHeader('Content-Type','application/json');if(!part)return res.end(JSON.stringify({manifest:publication.manifest,publishedAt:publication.manifest.asOf,readOnly:true,collectionRequiresLocalComputer:true}));const f=parts.get(part);if(!f){res.writeHead(404);return res.end('{}');}res.setHeader('X-Data-Cutoff',manifest.asOf);res.setHeader('X-Data-SHA256',f.sha256);return res.end(f.content);}
 const upstream=await fetch('http://127.0.0.1:4191'+url.pathname+url.search,{headers:{accept:req.headers.accept||'*/*'},signal:AbortSignal.timeout(30000)});res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([k])=>!['content-length','content-encoding','transfer-encoding','set-cookie'].includes(k))));res.end(Buffer.from(await upstream.arrayBuffer()));
 }catch{res.writeHead(503);res.end('本地验收暂不可用');}});
let stopped=false;function stop(){if(stopped)return;stopped=true;server.closeAllConnections();server.close(()=>process.exit(0));}
process.once('SIGINT',stop);process.once('SIGTERM',stop);setTimeout(stop,8*60_000).unref();
server.listen(4192,'127.0.0.1',()=>console.log(JSON.stringify({testOnly:true,replay:'real saved data, not deployed',url:'http://127.0.0.1:4192',asOf:manifest.asOf,shards:publication.files.filter(f=>f.kind==='summaryShard').length})));
