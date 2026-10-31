import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {auditProductState} from '../scripts/audit-product-state.mjs';
import {sourcePollKey} from '../lib/source-poller-status.mjs';

const now='2026-10-31T02:25:00.000Z';
async function fixture(t){
 const dataDirectory=await mkdtemp(join(tmpdir(),'mcn-product-audit-'));
 t.after(()=>rm(dataDirectory,{recursive:true,force:true}));
 const path=join(dataDirectory,'douyin-monitor.sqlite'),db=new DatabaseSync(path);
 db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,label TEXT,enabled INTEGER,provider TEXT,locator TEXT);
 CREATE TABLE runs(id INTEGER,trigger_type TEXT,started_at TEXT,finished_at TEXT,status TEXT,target_count INTEGER,processed_count INTEGER,success_count INTEGER,error_count INTEGER,warning_count INTEGER,skipped_count INTEGER,heartbeat_at TEXT,current_target_id INTEGER,details_json TEXT);
 CREATE TABLE author_resolution_queue(status TEXT);
 CREATE TABLE posts(id INTEGER,target_id INTEGER,external_id TEXT,first_seen_at TEXT);
 CREATE TABLE post_metrics(id INTEGER);
 CREATE TABLE creator_source_rows(id INTEGER);
 CREATE TABLE snapshots(target_id INTEGER,captured_at TEXT,quality_status TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER);`);
 db.close();
 return {dataDirectory,path};
}

test('current source registration, durable inventory and manifest-only receipts have separate counts',async t=>{
 const f=await fixture(t),sourcePoll=join(f.dataDirectory,'source-poll');await mkdir(sourcePoll);
 const sources=['active','unchecked'].map(name=>({sourceType:'lark-sheet',sourceUrl:`https://example.test/${name}`,defaultBoard:'fixture'}));
 const historical=['legacy-a','legacy-b'].map(name=>({sourceType:'lark-sheet',sourceUrl:`https://example.test/${name}`,defaultBoard:'fixture'}));
 const receipts=[sources[0],...historical];
 await writeFile(join(sourcePoll,'registry.json'),JSON.stringify({version:2,sources}));
 await writeFile(join(sourcePoll,'manifest.json'),JSON.stringify({lastFinishedAt:now,sources:Object.fromEntries(receipts.map(source=>[sourcePollKey(source),{...source,lastStatus:'changed',lastCheckedAt:now}]))}));
 const before=await readFile(f.path),report=await auditProductState({...f,now});
 assert.equal(report.sources.registered,2);
 assert.equal(report.sources.manifestEntries,3);
 assert.equal(report.sources.inventoryCount,4);
 assert.equal(report.sources.manifestOnlyCount,2);
 assert.ok((await readFile(f.path)).equals(before),'the audit must not rewrite the database');
});

test('the seven-day stored-record audit compares actual instants and excludes future or too-old offsets',async t=>{
 const f=await fixture(t),db=new DatabaseSync(f.path);
 const insert=db.prepare("INSERT INTO snapshots VALUES(? ,?,'validated',0,0,0)");
 insert.run(1,'2026-10-24T10:25:00+08:00');
 insert.run(2,'2026-10-24T10:24:59+08:00');
 insert.run(1,'2026-10-31T10:20:00+08:00');
 insert.run(3,'2026-10-31T02:26:00.000Z');db.close();
 const report=await auditProductState({...f,now});
 assert.deepEqual(report.dailyStoredRecords.map(row=>[row.date,row.records]),[['2026-10-24',1],['2026-10-31',1]]);
 assert.equal(report.invariants.futureSnapshots,1,'a bad future record remains reported rather than being erased');
});

test('the command shows missing independent daily metrics and labels structural exit success explicitly',async t=>{
 const f=await fixture(t);
 const report=JSON.parse(execFileSync(process.execPath,['scripts/audit-product-state.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,DATA_DIR:f.dataDirectory},encoding:'utf8'}));
 assert.equal(report.readOnly,true);assert.equal(report.runtimeAI,false);
 assert.equal(report.dailyProfiles,null);assert.equal(report.dailyWorkLikes,null);
 assert.equal(report.sources.registered,null,'a missing registry is unknown, not a successful zero-source check');
 assert.equal(report.exitCodeBasis,'structural-invariants-only-not-daily-monitoring-completion');
});
