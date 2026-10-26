// Root-owned, turn-bounded preview: actual Site code, sealed public data only.
// No platform requests, production writes, credential reads or browser control.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const directory=new URL('../data/public-replica-staging/publisher-2026-10-02T01-45-02-024Z/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',directory)));
const publication=await preparePublicReplicaPublication({manifest,files:manifest.files.map(f=>({...f,content:readFileSync(new URL(f.path,directory),'utf8')}))},{dateIndex:true});
const files=new Map(publication.files.map(f=>[f.path,f]));
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:4337');
 if(req.method!=='GET'){res.writeHead(405);res.end('readonly preview');return;}
 if(url.pathname==='/api/replica'){
  const generation=url.searchParams.get('generation'),part=url.searchParams.get('part');
  if(generation&&generation!==manifest.asOf){res.writeHead(404);res.end('{}');return;}
  const file=part&&files.get(part);
  if(part&&!file){res.writeHead(404);res.end('{}');return;}
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store',...(file?{'X-Data-SHA256':file.sha256,'X-Data-Cutoff':manifest.asOf}:{})});
  res.end(file?file.content:JSON.stringify({manifest:publication.manifest,publishedAt:manifest.asOf,readOnly:true,collectionRequiresLocalComputer:true}));return;
 }
 const upstream=http.request({host:'127.0.0.1',port:4336,path:req.url,method:'GET',headers:{...req.headers,host:'127.0.0.1:4336'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
 upstream.on('error',()=>{res.writeHead(502);res.end('preview unavailable');});upstream.end();
});
server.listen(4337,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:4337/',generation:manifest.asOf,sealedPublicData:true,actualSiteCode:true,liveCollection:false})));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
