// Two genuine, separated idle observations; terminate only the exact already
// installed publisher. Its existing KeepAlive service owns resumption.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {withPublisherRecoveryLock} from './public-replica-publisher.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),home=join(root,'data/public-replica-publisher');
const sha=value=>createHash('sha256').update(value).digest('hex');
async function observe(){
 const lockText=await readFile(join(home,'lock.json'),'utf8'),stateText=await readFile(join(home,'state.json'),'utf8');
 const lock=JSON.parse(lockText),state=JSON.parse(stateText);
 assert.equal(lock.pid,56509);assert.equal(lock.instance,'49644972-5263-4764-877c-e8aea0d565a9');assert.equal(state.active,null);assert.equal(state.status,'success');assert.equal(state.sync.status,'success');
 const command=execFileSync('/bin/ps',['-p','56509','-o','command='],{encoding:'utf8'}).trim();
 assert.equal(command,'/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node --use-env-proxy '+join(root,'scripts/public-replica-publisher.mjs'));
 let children=[];try{children=execFileSync('/usr/bin/pgrep',['-P','56509'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);}catch(error){if(error.status!==1)throw error;}
 assert.deepEqual(children,[]);
 return {checkedAt:new Date().toISOString(),pid:lock.pid,instance:lock.instance,lockSha256:sha(lockText),stateSha256:sha(stateText),active:null,status:state.status,children:0,publishedAsOf:state.publishedAsOf,codeSha256:sha(await readFile(join(root,'lib/public-replica-sync.mjs')))};
}
const evidencePath=join(root,'data/maintenance-journal/2026-10-02-phase80-publisher-idle.json');
if(process.argv.includes('--first')){
 const first=await observe();await writeFile(evidencePath,JSON.stringify(first,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(first));
}else if(process.argv.includes('--handoff')){
 const first=JSON.parse(await readFile(evidencePath,'utf8'));assert.ok(Date.now()-Date.parse(first.checkedAt)>=30000);assert.ok(Date.now()-Date.parse(first.checkedAt)<120000);
 await withPublisherRecoveryLock(join(home,'lock.json'),async()=>{
  const second=await observe();for(const key of ['pid','instance','lockSha256','stateSha256','codeSha256'])assert.equal(second[key],first[key]);
  process.kill(second.pid,'SIGTERM');
  const evidence={first,second,exactOldPublisherSignalled:true,existingKeepAliveOwnsResume:true,newTimer:false,mainOrSourceServiceSignalled:false,manualCollection:false};
  await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase80-publisher-handoff.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(evidence));
 });
}else throw Error('Select --first or --handoff');
