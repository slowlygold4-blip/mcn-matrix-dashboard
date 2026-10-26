import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const out={startedAt:new Date().toISOString(),scope:'bounded production read-only observations; not guaranteed cold or browser CWV',samples:[]};
assert.ok(Date.now()<Date.parse('2026-10-02T05:54:05Z'));
const base='http://127.0.0.1:4188';
async function read(label,path,signal=AbortSignal.timeout(20000)){
 const at=performance.now(),res=await fetch(base+path,{signal}),body=await res.text();
 assert.equal(res.status,200,label);
 const item={label,path,http:res.status,ms:Number((performance.now()-at).toFixed(2)),bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')};
 const value=res.headers.get('content-type')?.includes('json')?JSON.parse(body):null;
 if(label==='health'){assert.equal(value.status,'ready');assert.equal(value.runtimeAI,false);item.health=value;}
 if(value?.summary){item.rosterAccounts=value.summary.accountCount;item.enabledAccounts=value.summary.enabledCount;assert.ok(item.enabledAccounts<=item.rosterAccounts);}
 out.samples.push(item); return value;
}
await read('health','/api/health');
for(const [period,start] of [['week','2026-09-26'],['month','2026-10-01']])await read(period,`/api/rebuild/insights?theme=tuantuan&classification=slice&period=custom&startDate=${start}&endDate=2026-10-02`);
await read('account','/api/rebuild/accounts/273/insights?period=custom&startDate=2026-10-01&endDate=2026-10-02');
await read('history','/api/rebuild/accounts/273/history?kind=works&page=1&pageSize=20');
for(const path of ['/','/rebuild.css','/rebuild.js'])await read(path,path);
const query='/api/rebuild/insights?period=custom&startDate=2026-09-15&endDate=2026-10-02&theme=tuantuan&classification=slice';
const controller=new AbortController();
const abandoned=fetch(base+query,{signal:controller.signal}).then(async res=>({http:res.status,bytes:(await res.arrayBuffer()).byteLength})).catch(error=>({error:error.name}));
const surviving=read('shared-query-surviving-reader',query);
const timer=setTimeout(()=>controller.abort(),50);
const [first,second]=await Promise.all([abandoned,surviving]); clearTimeout(timer);
assert.equal(first.error,'AbortError');assert.ok(second.summary);
out.sharedHttp={first,secondStatus:200,meaning:'one actual HTTP reader abandoned while the other completed; internal worker ownership proved separately by independent tests'};
out.finishedAt=new Date().toISOString();out.noCollection=true;out.noSignals=true;
await writeFile(new URL('../data/maintenance-journal/2026-10-02-phase102-http-readback.json',import.meta.url),JSON.stringify(out,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(out,null,2));
