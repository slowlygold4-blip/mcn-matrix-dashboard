// Load only the verified logging correction through the existing KeepAlive.
// No manual sync, collection, service installation or schedule mutation.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=fileURLToPath(new URL('../',import.meta.url)),home=join(root,'data/public-replica-publisher');
const sha=b=>createHash('sha256').update(b).digest('hex'),startedAt=new Date().toISOString();
const tests=await readFile(join(root,'data/maintenance-journal/2026-10-02-phase86-main-frozen.txt'),'utf8');
const count=Number(/ℹ tests (\d+)\b/.exec(tests)?.[1]),pass=Number(/ℹ pass (\d+)\b/.exec(tests)?.[1]);
assert.ok(count>=3937);assert.equal(count,pass);
for(const key of ['fail','cancelled','skipped'])assert.match(tests,new RegExp('ℹ '+key+' 0\\b'));
const disk=await readFile(join(root,'scripts/public-replica-publisher.mjs'));
assert.equal(sha(await readFile('/private/tmp/mcn-phase86-code-joHTM6/public-replica-publisher.mjs')),'e542bb0987fde9cbf4d0b7b95c70134fd8615d2204d8bf6c9ab74925b1231a75');
const original=(await readFile('/private/tmp/mcn-phase86-code-joHTM6/public-replica-publisher.mjs','utf8'));
assert.equal(disk.toString(),original.replace('state.publishedAsOf??state.active?.asOf','state.active?.asOf??state.publishedAsOf'));
const checks=[];
async function idle(){
 const lock=JSON.parse(await readFile(join(home,'lock.json'))),state=JSON.parse(await readFile(join(home,'state.json'))),cp=JSON.parse(await readFile(join(home,'checkpoint.json')));
 assert.equal(lock.pid,72426);assert.equal(lock.instance,'8acde152-828e-42c5-ad73-bc79fb60bc8a');assert.equal(state.status,'success');assert.equal(state.active,null);assert.equal(state.sync.status,'success');assert.equal(cp.activated,true);assert.equal(cp.completedBatches.length,66);
 assert.ok(Date.now()-Date.parse(state.publishedAsOf)<28*60_000,'avoid the next normal publication window');
 const line=execFileSync('/bin/ps',['-p',String(lock.pid),'-o','pid=,ppid=,uid=,command='],{encoding:'utf8'}).trim();
 assert.match(line,new RegExp('^72426\\s+1\\s+'+process.getuid()+'\\s+'));assert.ok(line.endsWith(join(root,'scripts/public-replica-publisher.mjs')));
 const children=execFileSync('/bin/ps',['-ax','-o','ppid=,command='],{encoding:'utf8'}).split('\n').filter(x=>/^\s*72426\s/.test(x));assert.equal(children.length,0);
 const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});try{db.exec('PRAGMA query_only=ON');assert.equal(db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,0);}finally{db.close();}
 checks.push({at:new Date().toISOString(),pid:lock.pid,ppid:1,activeGeneration:null,publishedAsOf:state.publishedAsOf,checkpointBatches:66,activeRuns:0,children:0});
}
await idle();await delay(750);await idle();
assert.equal(sha(await readFile(join(root,'scripts/public-replica-publisher.mjs'))),sha(disk));
process.kill(72426,'SIGTERM');
let replacement;
for(let i=0;i<60;i++){
 await delay(500);
 let lock;try{lock=JSON.parse(await readFile(join(home,'lock.json')));}catch(error){if(error.code==='ENOENT')continue;throw error;}
 if(lock.pid===72426)continue;
 const line=execFileSync('/bin/ps',['-p',String(lock.pid),'-o','pid=,ppid=,command='],{encoding:'utf8'}).trim();
 assert.match(line,new RegExp('^'+lock.pid+'\\s+1\\s+'));assert.ok(line.endsWith(join(root,'scripts/public-replica-publisher.mjs')));
 const state=JSON.parse(await readFile(join(home,'state.json')));assert.equal(state.active,null);assert.equal(state.publishedAsOf,checks[0].publishedAsOf);
 replacement={pid:lock.pid,ppid:1,startedAt:lock.startedAt,instance:lock.instance,status:state.status,publishedAsOf:state.publishedAsOf};break;
}
assert.ok(replacement,'existing KeepAlive replacement not verified');
const result={startedAt,finishedAt:new Date().toISOString(),checks,replacement,codeSha256:sha(disk),fullTests:count,originalMainAndSourceUntouched:true,noManualCollectionOrSync:true,noNewTimer:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase86-publisher-reload.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
