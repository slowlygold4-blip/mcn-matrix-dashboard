import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),prefix=join(root,'data/maintenance-journal/2026-10-02-phase91-');
const sha=b=>createHash('sha256').update(b).digest('hex');
const mainPid=22870;
assert.equal(execFileSync('/bin/ps',['-p',String(mainPid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
assert.equal(execFileSync('/bin/ps',['-p',String(mainPid),'-o','command='],{encoding:'utf8'}).trim(),'/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node '+join(root,'server.mjs'));
const h=await fetch('http://127.0.0.1:4188/api/health',{signal:AbortSignal.timeout(10000)});assert.equal(h.status,200);
const r=await fetch('http://127.0.0.1:4188/api/settings',{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const settings=await r.json();
assert.deepEqual(settings,{publicPostsPerAccount:'30',publicWorksPageMode:'legacy',publicWorksPageHardLimit:'100',publicWorksRequestThreshold:'30'});
const s=await fetch('http://127.0.0.1:4188/api/monitoring-status',{signal:AbortSignal.timeout(10000)});assert.equal(s.status,200);const monitor=await s.json();
assert.deepEqual(monitor.scheduler.slotTimes,['02:00','10:00','18:00']);assert.equal(monitor.scheduler.scheduleIntervalHours,8);assert.equal(monitor.scheduler.timeZone,'Asia/Shanghai');
assert.ok(Date.parse(monitor.scheduler.lastTickAt)>=Date.parse('2026-10-02T01:13:39.170Z'));
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let legacy;
try{db.exec('PRAGMA query_only=ON');legacy={...db.prepare("SELECT key,value,updated_at FROM settings WHERE key='publicPostsPerAccount'").get()};assert.deepEqual(legacy,{key:'publicPostsPerAccount',value:'30',updated_at:'2026-09-04T07:53:16.606Z'});assert.equal(db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'publicWorks%'").get().n,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,0);}finally{db.close();}
const sourceBytes=await readFile(join(root,'data/source-poll/manifest.json'));assert.equal(sha(sourceBytes),'184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
for(const pid of [26001,92296])assert.equal(execFileSync('/bin/ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8'}).trim(),'1');
const ux=JSON.parse(await readFile(join(root,'data/maintenance-journal/phase91ux/live-echo.json')));assert.equal(ux.passed,true);
const publicUrl='https://mcn-matrix-observatory.slowlygold4.chatgpt.site/';
const publicResponse=await fetch(publicUrl,{signal:AbortSignal.timeout(20000)});const html=await publicResponse.text();
// A browser site may deny a server fetch. Preserve that403 independently;
// never reinterpret it as200 or use it to erase the verified local readback.
const result={checkedAt:new Date().toISOString(),serviceReady:true,mainPid,settingsReadback:true,settings,legacyUnchanged:true,legacy,configurationNotActivated:true,sourceManifestUnchanged:true,sourceLastFinishedAt:JSON.parse(sourceBytes).lastFinishedAt,sourceAndPublisherPidsUnchanged:[26001,92296],ordinarySchedule:{slotTimes:monitor.scheduler.slotTimes,timeZone:monitor.scheduler.timeZone,intervalHours:monitor.scheduler.scheduleIntervalHours,lastTickAt:monitor.scheduler.lastTickAt},actualProductionChromePassed:true,publicUrl,publicHttpStatus:publicResponse.status,publicServerFetchSucceeded:publicResponse.status===200,publicHtmlBytes:Buffer.byteLength(html),publicReadCheckOnly:true,noAllNetworkGuarantee:true,macOffNewCollectionNotProven:true,noManualCollection:true,noNewTimer:true};
await writeFile(prefix+'runtime-final.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
