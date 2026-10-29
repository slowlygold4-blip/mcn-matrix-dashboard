import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildFullRosterMonitoringAudit, readFullRosterMonitoringAudit } from '../lib/full-roster-monitoring-audit.mjs';
import { parseAuditArguments, resolveRosterBuilderPath, saveMonitoringAudit, runAuditCli } from '../scripts/audit-full-roster-monitoring.mjs';
const reference = '2026-10-29T23:00:00.000Z';
const repo = new URL('../',import.meta.url).pathname;
const builderPath = resolveRosterBuilderPath(repo);
const { buildTuantuanRoster } = await import(pathToFileURL(builderPath));
const target=(id,enabled=true)=>({id,enabled,label:'fixture '+id});
const source=(id,accounts=[],extra={})=>({key:'source:'+id,source:{douyinId:id,name:'fixture',targetIds:accounts.map(a=>a.id),...extra},accounts});
const q=(id,douyin_id,status,extra={})=>({id,douyin_id,status,resolved_target_id:null,suspended_target_enabled:null,...extra});
const audit=(rows,targets=[],queue=[])=>buildFullRosterMonitoringAudit({roster:{rows,counts:{all:rows.length}},targets,queue,reference});
function temp(t){const p=mkdtempSync(join(tmpdir(),'mcn-roster-audit-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}

test('enabled, intentionally paused, conflicting and ID-only authors remain distinct and exhaustive',()=>{
 const a=target(1),b=target(2,false),c=target(3,false),d=target(4);
 const rows=[source('enabled',[a]),source('paused',[b]),source('held',[c]),source('invalid_active_hold',[d]),
   source('queued'),source('resolved'),source('rejected'),source('id_only'),source('中文昵称')];
 const result=audit(rows,[a,b,c,d],[q(1,'paused','pending'),q(2,'other_handle','rejected',{resolved_target_id:3,suspended_target_enabled:1}),
  q(3,'invalid_active_hold','resolved',{resolved_target_id:4,suspended_target_enabled:1}),q(4,'queued','retry'),q(5,'resolved','resolved'),q(6,'rejected','rejected')]);
 assert.deepEqual(result.items.map(r=>r.state),['monitoring','paused','identity_conflict_paused','identity_conflict_active',
  'resolving','source_binding_needed','previous_resolution_failed','identity_search_needed','identifier_repair_needed']);
 assert.equal(Object.values(result.counts).reduce((a,b)=>a+b,0),9);
 assert.equal(result.authorCount,9);assert.equal(result.queue.itemCount,6);
 assert.deepEqual(result.items[2].queueIds,[2]); // Hold tracked by target, not guessed handle.
 assert.deepEqual(result.items[3].anomalies,['enabled_target_has_identity_hold']);
 assert.equal(result.samplingCoverageEvaluated,false);
 assert.ok(result.items.every(r=>r.samplingStatus==='not-evaluated'));
});

test('queue rows and alias matches do not multiply authors or discard malformed identifiers',()=>{
 const rows=[source('User.ID',[],{douyinIds:['@user.id','user.id']}),source('中文错列')];
 const r=audit(rows,[],[q(1,'user.id','pending'),q(2,'USER.ID','rejected')]);
 assert.equal(r.authorCount,2);assert.deepEqual(r.items[0].queueIds,[1,2]);assert.deepEqual(r.items[0].handles,['user.id']);
 assert.equal(r.queue.itemCount,2);assert.equal(r.queue.matchedItemCount,2);assert.equal(r.items[1].state,'identifier_repair_needed');
 assert.equal(r.items[1].name,'fixture');
});

test('account-only rows and invalid raw source IDs with valid target bindings remain enrolled',()=>{
 const a=target(1),b=target(2);const r=audit([{key:'account:1',source:null,accounts:[a]},source('错列',[b])],[a,b]);
 assert.deepEqual(r.items.map(row=>row.state),['monitoring','monitoring']);assert.equal(r.items[0].name,a.label);
});

test('error receipts redact secrets, URLs and local paths without modifying original queue rows',()=>{
 const queue=[q(1,'user','rejected',{last_error:'token=SECRET https://private.feishu.cn/sheets/secret /Users/fixture/secret'})];
 const r=audit([source('user')],[],queue);const text=JSON.stringify(r);
 for(const secret of ['SECRET','private.feishu.cn','/Users/fixture']) assert.ok(!text.includes(secret));
 assert.ok(queue[0].last_error.includes('SECRET'));
});

test('duplicate roster keys or target IDs fail instead of inflating totals',()=>{
 assert.throws(()=>audit([source('a'),source('a')]),/invalid-monitoring-roster-row/);
 assert.throws(()=>audit([],[target(1),target(1)]),/duplicate-monitoring-target/);
});

function dbFixture(t,path=':memory:'){
 const database=new MonitorDatabase(path);t.after(()=>{if(database.db.isOpen)database.close();});const db=database.db;
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,sheet_name TEXT,row_count INTEGER,restricted INTEGER,headers_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 db.prepare('INSERT INTO creator_source_imports VALUES(?,?,?,?,?,?,?,?)').run(1,'a'.repeat(64),'https://private.feishu.cn/sheets/secret','current-db-v1','2026-10-25T00:00:00Z','2026-10-25T00:00:00Z','{}',3);
 const row=(number,id)=>db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('08',number,JSON.stringify(['fixture',id,null,null,null,null,0,0,0,0,0,null,null,null,null]));
 row(2,'source_a');
 const monitored=database.createTarget({type:'account',label:'fixture monitored',locator:'MS4wLjABAAAAFullRosterAuditFixture',provider:'public-web',metadata:{platform:'douyin'}});
 database.assignTargetsToBoard([monitored.id],'一条小团团切片矩阵');
 return {database,db,row};
}

test('reader sees newly committed source rows without static files and leaves source/targets unchanged',t=>{
 const {database,db,row}=dbFixture(t);
 const read=()=>readFullRosterMonitoringAudit(database,{buildRoster:buildTuantuanRoster,reference});
 const first=read();assert.equal(first.authorCount,2);assert.equal(first.counts.monitoring,1);
 row(3,'source_new');const changes=db.prepare('SELECT total_changes() n').get().n;
 const second=read();assert.equal(second.authorCount,3);assert.equal(second.counts.identity_search_needed,2);
 assert.equal(second.source.creatorRevision,'current-db-v1');assert.equal(second.source.sourceMode,'live-database-projections');
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(db.isTransaction,false);
 assert.equal(second.databaseWrites,0);assert.equal(second.networkRequests,0);assert.equal(second.modelCalls,0);
});

test('reader preserves a caller transaction, including after a builder failure',t=>{
 const {db}=dbFixture(t);db.exec('BEGIN');
 assert.throws(()=>readFullRosterMonitoringAudit(db,{reference,buildRoster:()=>{throw Error('fixture');}}),/fixture/);
 assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 assert.throws(()=>readFullRosterMonitoringAudit(db,{reference,buildRoster:()=>{throw Error('fixture');}}),/fixture/);
 assert.equal(db.isTransaction,false);
});

test('builder resolves public checkout, private sibling or explicit site; invalid explicit path never falls back',t=>{
 const root=temp(t),site=join(root,'frontend/lib/tuantuan-roster.mjs');mkdirSync(dirname(site),{recursive:true});writeFileSync(site,'fixture');
 assert.equal(resolveRosterBuilderPath(root,{}),site);
 assert.throws(()=>resolveRosterBuilderPath(root,{MCN_SITE_ROOT:join(root,'missing')}),/invalid_site_root/);
 assert.throws(()=>resolveRosterBuilderPath(root,{MCN_SITE_ROOT:''}),/invalid_site_root/);
 const other=join(root,'explicit/lib/tuantuan-roster.mjs');mkdirSync(dirname(other),{recursive:true});writeFileSync(other,'fixture');
 assert.equal(resolveRosterBuilderPath(root,{MCN_SITE_ROOT:join(root,'explicit')}),other);
});

test('Beijing-dated owner-only report never overwrites a prior report',t=>{
 const root=temp(t),r=audit([source('secret_author')]);const path=saveMonitoringAudit(r,undefined,{root});
 assert.ok(path.includes('2026-10-30-full-roster-monitoring-070000000.json'));
 assert.equal(statSync(path).mode&0o777,0o600);const original=readFileSync(path,'utf8');
 assert.throws(()=>saveMonitoringAudit(r,undefined,{root}),{code:'EEXIST'});
 assert.equal(readFileSync(path,'utf8'),original);
});

test('CLI reads an explicit read-only DB and prints summary rather than internal author IDs',async t=>{
 const root=temp(t),path=join(root,'fixture.sqlite');const {database}=dbFixture(t,path);database.close();let stdout='';
 const result=await runAuditCli(['--database',path],{root,env:{MCN_SITE_ROOT:dirname(dirname(builderPath))},reference,stdout:{write:s=>stdout+=s}});
 assert.equal(result.report.authorCount,2);assert.ok(existsSync(result.path));
 assert.ok(!stdout.includes('source_a'));const summary=JSON.parse(stdout);assert.equal(summary.samplingCoverageEvaluated,false);
 assert.equal(summary.sourceMode,'live-database-projections');
 assert.ok(!existsSync(join(root,'public')));
});

test('CLI argument parsing rejects ambiguity and preserves the original positional output convention',()=>{
 assert.deepEqual(parseAuditArguments(['out.json']),{out:'out.json'});
 assert.deepEqual(parseAuditArguments(['--database','db.sqlite','--out','out.json']),{database:'db.sqlite',out:'out.json'});
 for(const args of [['--out'],['--database','--out'],['--out','a','--out','b'],['--unknown'],['a','b']])
  assert.throws(()=>parseAuditArguments(args),/invalid_arguments/);
});
