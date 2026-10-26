import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const startedAt=new Date().toISOString(),out={startedAt,scope:'bounded read-only HTTP first observations; not guaranteed cold or browser CWV',samples:[]};
const endpoints=[['health','/api/health'],['day-first','/api/rebuild/insights?period=day&board=&theme=all&classification=all&startDate=2026-10-02&endDate=2026-10-02'],['day-repeat','/api/rebuild/insights?period=day&board=&theme=all&classification=all&startDate=2026-10-02&endDate=2026-10-02'],['week-first','/api/rebuild/insights?period=custom&board=&theme=all&classification=all&startDate=2026-09-26&endDate=2026-10-02'],['week-repeat','/api/rebuild/insights?period=custom&board=&theme=all&classification=all&startDate=2026-09-26&endDate=2026-10-02'],['root','/'],['css','/rebuild.css'],['js','/rebuild.js']];
for(const[label,path]of endpoints){
 const start=performance.now(),response=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(30000)}),text=await response.text();
 assert.equal(response.status,200,label);
 const item={label,path,http:response.status,ms:Number((performance.now()-start).toFixed(2)),bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),contentType:response.headers.get('content-type'),finishedAt:new Date().toISOString()};
 if(label==='health'){const health=JSON.parse(text);assert.equal(health.runtimeAI,false);assert.equal(health.status,'ready');item.health=health;}
 if(label.startsWith('day')||label.startsWith('week')){const value=JSON.parse(text);item.accounts=value.accounts?.length;item.rosterAccounts=value.summary?.accountCount;item.enabledAccounts=value.summary?.enabledCount;assert.ok(item.enabledAccounts<=item.rosterAccounts);item.generatedAt=value.generatedAt;item.timeZone=value.timeZone;}
 if(label==='root'){assert.match(text,/rebuild\.css/);assert.match(text,/rebuild\.js/);item.currentMainEntry=true;}
 out.samples.push(item);
}
out.finishedAt=new Date().toISOString();out.noCollection=true;out.noSignals=true;
await writeFile(new URL('../data/maintenance-journal/2026-10-02-phase101-http-readback-v2.json',import.meta.url),JSON.stringify(out,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(out,null,2));
