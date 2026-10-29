// Offline scale audit. Synthetic index metadata only; no DB, HTTP, browser or models.
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const site=process.env.MCN_SITE_ROOT||[resolve(root,'frontend'),resolve(root,'../mcn-public-site')].find(p=>existsSync(resolve(p,'lib/replica-date-range.mjs')));
if(!site)throw Error('Set MCN_SITE_ROOT to the frontend checkout');
const {loadSummaryRange,dateDescriptors}=await import(pathToFileURL(resolve(site,'lib/replica-date-range.mjs')));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const asOf='2026-11-01T00:00:00.000Z',accounts=4081,days=50,total=accounts*days;
const date=i=>new Date(Date.parse('2026-09-12T00:00:00Z')+i*86400000).toISOString().slice(0,10);
const daily=Array.from({length:accounts},(_,i)=>({path:`daily/${i+1}.json`,kind:'daily',targetId:i+1,count:days,bytes:13000,sha256:'a'.repeat(64)}));
const base={version:1,asOf,timeZone:'Asia/Shanghai',counts:{daily:total},files:daily};
const shards=Array.from({length:Math.ceil(total/2000)},(_,i)=>{const count=Math.min(2000,total-i*2000);return{path:`date-summary/${String(i+1).padStart(6,'0')}.json`,count,bytes:count*250,sha256:'b'.repeat(64),firstDate:date(Math.floor(i*2000/accounts)),lastDate:date(Math.floor((i*2000+count-1)/accounts))};});
const index={version:1,asOf,timeZone:'Asia/Shanghai',format:'date-shards-v1',sourceManifestSha256:hash(base),sourceDaily:daily.map(({kind,...v})=>v),count:total,firstDate:date(0),lastDate:date(days-1),shards};
const manifest={...base,files:[...daily,{path:'date-summary-index.json',kind:'summaryDateIndex',count:total,bytes:Buffer.byteLength(JSON.stringify(index)),sha256:hash(index)},...shards.map(({firstDate,lastDate,...v})=>({...v,kind:'summaryDateShard'}))]};
await dateDescriptors(index,manifest);
const result={synthetic:true,accounts,days,totalPoints:total,selectedBytes:shards.reduce((n,x)=>n+x.bytes,0),descriptorContractValid:true,sourceRowsRead:0,modelCalls:0,productionWrites:0};
let calls=0;
try{await loadSummaryRange({manifest,request:{ranges:[{start:date(0),end:date(days-1)}]},readPart:async path=>{if(path==='date-summary-index.json')return index;calls++;throw Error('row-read-reached');}});result.rejected=false;}catch(e){result.rejected=true;result.error=e.message;}
result.selectedShardReadCalls=calls;
try{await loadSummaryRange({manifest,request:{ranges:[{start:date(0),end:date(0)}]},readPart:async path=>{if(path==='date-summary-index.json')return index;throw Error('narrow-request-passed-guard');}});}catch(e){result.narrowRequestPassesBudget=e.message==='narrow-request-passed-guard';}
if(!result.rejected||calls!==0||!result.narrowRequestPassesBudget)throw Error('Unexpected reproduction result');
await writeFile(new URL('./long-range-limit.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
