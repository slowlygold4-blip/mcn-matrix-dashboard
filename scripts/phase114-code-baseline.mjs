import assert from 'node:assert/strict';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T10:36:29Z'));
const entries=[];
async function scan(dir){for(const item of await readdir(join(root,dir),{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())await scan(file);else if(item.isFile()&&/\.(mjs|js|json|html|css|ts|tsx)$/.test(file)){const b=await readFile(join(root,file));entries.push({file,sha256:sha(b),bytes:b.length});}}}
for(const dir of ['public','lib','test','scripts'])await scan(dir);
for(const file of ['server.mjs','package.json','package-lock.json']){const b=await readFile(join(root,file));entries.push({file,sha256:sha(b),bytes:b.length});}
const site=join(root,'../mcn-public-site');
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const siteOriginal=JSON.parse(await readFile('/var/folders/bf/j1_z4gd95szd7by48xbzql5r0000gn/T/phase114-site-RN6uek/phase114-originals.json'));
const siteRows=[];
for(const row of siteOriginal.rows){const b=await readFile(join(site,row.file));assert.equal(sha(b),row.sha256);const destination=join(root,'data/code-candidates/phase114/site-preimage',row.file);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,b,{flag:'wx',mode:0o400});siteRows.push({...row,destination});}
const response=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);
const health=await response.json();assert.equal(health.status,'ready');assert.equal(health.runtimeAI,false);
const result={createdAt:new Date().toISOString(),entries:entries.sort((a,b)=>a.file.localeCompare(b.file)),siteRows,siteHead:siteOriginal.head,health,permittedMainProductChanges:[],preserveOldTests:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase114-code-baseline.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({createdAt:result.createdAt,mainFiles:entries.length,mainOldTests:entries.filter(x=>x.file.startsWith('test/')).length,sitePreimages:siteRows.length,siteHead:result.siteHead}));
