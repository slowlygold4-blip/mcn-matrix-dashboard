// One-time Root handoff after full regression and exact source review.
// Existing KeepAlive replaces only the old idle publisher. Main remains busy.
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdir,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=fileURLToPath(new URL('../',import.meta.url)),home=join(root,'data/public-replica-publisher');
const sha=b=>createHash('sha256').update(b).digest('hex'),startedAt=new Date().toISOString();
assert.ok(Date.now()<Date.parse('2026-10-02T04:17:49Z'),'phase98 release window expired');
const approval=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase98-root-approved-source.json'),'utf8'));
assert.equal(approval.productionApproved,true);assert.equal(approval.candidateScope,'committed-topic-dual-metric');
const full=await readFile(join(root,'data/maintenance-journal/2026-10-02-phase98-main-full-release.log'),'utf8');
const tests=Number(/(?:ℹ|#) tests (\d+)\b/.exec(full)?.[1]),passed=Number(/(?:ℹ|#) pass (\d+)\b/.exec(full)?.[1]);
assert.ok(tests>=4090);assert.equal(tests,passed);
for(const key of ['fail','cancelled','skipped'])assert.match(full,new RegExp('(?:ℹ|#) '+key+' 0\\b'));
for(const row of approval.files)assert.equal(sha(await readFile(join(root,row.path))),row.sha256,'approved production file drift: '+row.path);
const baseline=JSON.parse(await readFile(join(root,'docs/phase95-profile-first-manifest.json'),'utf8'));
for(const row of baseline)assert.equal(sha(await readFile(join(root,row.file))),row.main,'busy Main source drift: '+row.file);
const observations=[];
const privateJSON=async file=>{const path=join(home,file),s=await lstat(path);
  assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o777,0o600);assert.equal(s.nlink,1);
  return JSON.parse(await readFile(path,'utf8'));};
async function idle(){
  const lock=await privateJSON('lock.json'),state=await privateJSON('state.json'),checkpoint=await privateJSON('checkpoint.json');
  assert.equal(lock.pid,63200);assert.equal(lock.instance,'07a96e77-3ca5-4bf4-99d4-81b53fd124e1');
  assert.equal(state.active,null);assert.equal(state.status,'success');assert.equal(state.sync.status,'success');
  assert.equal(checkpoint.activated,true);assert.equal(checkpoint.asOf,state.publishedAsOf);assert.equal(checkpoint.manifestSha256,state.sync.manifestSha256);
  const command=execFileSync('/bin/ps',['-p',String(lock.pid),'-o','pid=,ppid=,uid=,command='],{encoding:'utf8'}).trim();
  assert.match(command,new RegExp('^63200\\s+1\\s+'+process.getuid()+'\\s+'));assert.ok(command.endsWith(join(root,'scripts/public-replica-publisher.mjs')));
  const children=execFileSync('/bin/ps',['-ax','-o','ppid=,command='],{encoding:'utf8'}).split('\n').filter(line=>/^\s*63200\s/.test(line));assert.equal(children.length,0);
  const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let run;
  try{db.exec('PRAGMA query_only=ON;BEGIN');run=db.prepare('SELECT id,status,trigger_type FROM runs WHERE id=2578').get();assert.equal(run.status,'running');assert.equal(run.trigger_type,'scheduled');assert.equal(db.prepare('SELECT total_changes() n').get().n,0);}
  finally{try{db.exec('ROLLBACK');}catch{}db.close();}
  for(const pid of [22870,26001])process.kill(pid,0);
  observations.push({at:new Date().toISOString(),pid:lock.pid,instance:lock.instance,active:null,publishedAsOf:state.publishedAsOf,checkpointActivated:true,busyMainRun:run.id});
}
await idle();await delay(500);await idle();
const preserved=join(root,'data/code-candidates/phase98/publisher-before-reload');await mkdir(preserved,{recursive:true,mode:0o700});
const priorFiles=[];
for(const file of ['state.json','checkpoint.json','lock.json']){const src=join(home,file),dst=join(preserved,file);await copyFile(src,dst,1);
  const s=await lstat(dst);assert.equal(s.mode&0o777,0o600);priorFiles.push({file,sha256:sha(await readFile(dst))});}
for(const row of approval.files)assert.equal(sha(await readFile(join(root,row.path))),row.sha256);
process.kill(63200,'SIGTERM');
let oldExited=false,replacement;
for(let attempt=0;attempt<80;attempt++){
  await delay(500);
  try{process.kill(63200,0);}catch(error){if(error.code!=='ESRCH')throw error;oldExited=true;}
  if(!oldExited)continue;
  const lock=await privateJSON('lock.json');if(lock.pid===63200)continue;
  assert.notEqual(lock.instance,observations[0].instance);
  const command=execFileSync('/bin/ps',['-p',String(lock.pid),'-o','pid=,ppid=,uid=,command='],{encoding:'utf8'}).trim();
  assert.match(command,new RegExp('^'+lock.pid+'\\s+1\\s+'+process.getuid()+'\\s+'));assert.ok(command.endsWith(join(root,'scripts/public-replica-publisher.mjs')));
  const state=await privateJSON('state.json');replacement={pid:lock.pid,instance:lock.instance,startedAt:lock.startedAt,status:state.status,
    priorPublishedAsOf:observations[0].publishedAsOf,currentPublishedAsOf:state.publishedAsOf,activeAsOf:state.active?.asOf??null,publicationContract:state.active?.publicationContract??state.publicationContract??null};break;
}
assert.ok(oldExited&&replacement,'existing KeepAlive replacement not verified; do not spawn another writer');
for(const row of priorFiles)assert.equal(sha(await readFile(join(preserved,row.file))),row.sha256);
for(const pid of [22870,26001])process.kill(pid,0);
const result={startedAt,finishedAt:new Date().toISOString(),observations,oldOwnerExited:true,replacement,tests,priorFiles,
  mainAndSourceUntouched:true,noManualCollectionOrSync:true,noNewTimer:true,readCredential:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase98-publisher-reload.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
