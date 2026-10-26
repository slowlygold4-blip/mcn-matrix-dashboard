import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const [base,directory,mode='upload']=process.argv.slice(2);
if(!['https://mcn-matrix-observatory.opal-squid-1544.chatgpt.site','https://mcn-matrix-observatory.slowlygold4.chatgpt.site'].includes(base)||!directory?.startsWith('/'))throw Error('Exact approved origin and absolute export directory required');
const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
const hash=text=>createHash('sha256').update(text).digest('hex');
// Derive only a compact, source-bound numeric index; full evidence stays in its partitions.
const items=[];
for(const f of manifest.files.filter(f=>f.kind==='daily')){
 const text=await readFile(join(directory,f.path),'utf8');if(hash(text)!==f.sha256)throw Error('Local partition checksum mismatch');
 const part=JSON.parse(text);for(const p of part.items)items.push(Object.fromEntries(['targetId','date','capturedAt','followers','followersAt','likes','likesAt','posts','postsAt'].map(k=>[k,p[k]??null])));
}
const summary=JSON.stringify({version:1,asOf:manifest.asOf,timeZone:'Asia/Shanghai',items})+'\n';
const summaryFile={path:'summary.json',kind:'summary',count:items.length,bytes:Buffer.byteLength(summary),sha256:hash(summary)};
await writeFile(join(directory,'summary.json'),summary,{flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST'||await readFile(join(directory,'summary.json'),'utf8')!==summary)throw e;});
const publication={...manifest,files:[...manifest.files,summaryFile]};
if(mode==='prepare'){process.stdout.write(JSON.stringify({asOf:manifest.asOf,parts:publication.files.length,summaryBytes:summaryFile.bytes})+'\n');process.exit(0);}
process.stdout.write('Ready for producer credential on hidden stdin.\n');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const secret=await new Promise(resolve=>{let text='';process.stdin.on('data',function receive(chunk){text+=chunk.toString();const end=text.indexOf('\n');if(end!==-1){process.stdin.off('data',receive);resolve(text.slice(0,end).trim());}});});
if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();
if(!/^[a-f0-9]{64}$/.test(secret))throw Error('Invalid producer credential');
async function send(input){const r=await fetch(base+'/api/replica',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+secret},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});const text=await r.text();if(!r.ok)throw Error('Sync rejected HTTP '+r.status+' '+text.slice(0,180));return JSON.parse(text);}
const batches=[];let batch=[],bytes=0;
for(const f of publication.files){const data=await readFile(join(directory,f.path),'utf8');if(hash(data)!==f.sha256||Buffer.byteLength(data)!==f.bytes)throw Error('Partition changed before upload');if(batch.length>=35||bytes+data.length>4_000_000){batches.push(batch);batch=[];bytes=0;}batch.push({path:f.path,sha256:f.sha256,data});bytes+=data.length;}
if(batch.length)batches.push(batch);
let cursor=0,completed=0;
await Promise.all(Array.from({length:4},async()=>{while(cursor<batches.length){const next=cursor++;await send({action:'upload',asOf:manifest.asOf,files:batches[next]});completed++;process.stdout.write(JSON.stringify({batchesCompleted:completed,batchesTotal:batches.length})+'\n');}}));
const result=await send({action:'activate',asOf:manifest.asOf,manifest:publication});
await writeFile(join(directory,'publication-receipt.json'),JSON.stringify({result,origin:base,asOf:manifest.asOf,publishedAt:new Date().toISOString(),parts:publication.files.length})+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({published:result.published,asOf:manifest.asOf,parts:publication.files.length})+'\n');
