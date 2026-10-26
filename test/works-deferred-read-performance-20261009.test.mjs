import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { loadDeferredWorksSnapshotRead, DEFERRED_SNAPSHOT_LOOKBACK, MAX_DEFERRED_READ_BYTES } from '../lib/works-deferred-read.mjs';
import { isVerifiedDeferredWorksSnapshot, MAX_DEFERRED_SOURCE_BYTES } from '../lib/works-deferred-snapshot.mjs';

const AT='2026-10-09T09:00:00.000Z', ASOF='2026-10-09T10:00:00.000Z';
const iso=ms=>new Date(ms).toISOString();
function fixture(t,count=4,history=20,padding=0){
  t.mock.timers.enable({apis:['Date'],now:Date.parse(AT)});
  const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
  const targets=[];
  for(let i=0;i<count;i++){
    const target=database.createTarget({type:'account',provider:'public-web',label:`test${i}`,locator:`MS4wLjABAAAAperformance_fixture_0123456789_${i}`,metadata:{platform:'douyin'}});
    targets.push(target);
    for(let j=0;j<history;j++){
      const at=iso(Date.parse(AT)+j*1000),mode='guest-ttwid-unsigned-profile';t.mock.timers.setTime(Date.parse(at));
      const raw={capturedAt:at,accountStatus:'validated',accountError:null,
        profile:{user:{sec_uid:target.locator,uid:'1234567890123',follower_count:100,total_favorited:200,aweme_count:1}},
        worksCoverage:'unavailable',worksErrorCode:'deferred',works:{stopReason:'request-deferred',pagination:{requestCount:0,pages:[]}},
        provenance:{mode,profileMode:mode,profileEndpoint:'https://www.douyin.com/aweme/v1/web/user/profile/other/',accountLocator:'sec_uid',cookiePersisted:false,runtimeAI:false,paidAPI:false},
        worksRequestPolicy:{version:1,endpoint:'douyin.author_posts',scope:'endpoint-transport',anonymous:{transport:'anonymous-http',attempted:false,deferred:true,errorCode:'blocked'},browser:{transport:'authorised-browser',attempted:false,deferred:false,errorCode:null}},
        worksFallbackDeferred:{version:1,reason:'scheduled-profile-priority',mode:'works-only'}};
      if(padding)raw.padding='x'.repeat(padding);
      const run=database.beginRun('scheduled',target.id,1);
      database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:at}));database.finishRun(run,{status:'success',successCount:1});
    }
  }
  return {db:database.db,targets};
}

// Independent eager oracle: obtain per-target windows, merge them in fair
// rank order, and verify the exact source/audit bytes. Only used on temp data.
function referenceRead(db,asOf,targetId=null,cutoffs=new Map()){
  const rows=[];
  for(const target of db.prepare("SELECT * FROM targets WHERE type='account' AND (? IS NULL OR id=?) ORDER BY id").all(targetId,targetId)){
    const selected=db.prepare(`SELECT * FROM snapshots WHERE target_id=? AND quality_status!='rejected'
      AND julianday(COALESCE(works_observed_at,captured_at))<=julianday(?)
      ORDER BY julianday(COALESCE(works_observed_at,captured_at)) DESC,id DESC LIMIT ?`).all(target.id,asOf,DEFERRED_SNAPSHOT_LOOKBACK);
    selected.forEach((row,rank)=>rows.push({row,target,rank}));
  }
  rows.sort((a,b)=>a.rank-b.rank||a.target.id-b.target.id);
  const ignoredIds=new Set(),budgetLimitedSnapshotIds=new Set(),stopped=new Set();let bytes=0;
  for(const {row,target} of rows){
    if(stopped.has(target.id))continue;
    const cutoff=Date.parse(cutoffs.get(target.id));
    if(Number.isFinite(cutoff)&&cutoff<=Date.parse(asOf)&&Date.parse(row.works_observed_at??row.captured_at)<=cutoff){stopped.add(target.id);continue;}
    let candidate=null;
    try{const raw=JSON.parse(row.raw_json);if(row.works_coverage==='unavailable'&&[...row.raw_json].length<=MAX_DEFERRED_SOURCE_BYTES&&raw.worksErrorCode==='deferred'&&raw.works?.pagination?.requestCount===0)candidate=row.raw_json;}catch{}
    const size=typeof candidate==='string'?Buffer.byteLength(candidate):0;
    if(bytes+size>MAX_DEFERRED_READ_BYTES){budgetLimitedSnapshotIds.add(row.id);stopped.add(target.id);continue;}bytes+=size;
    const proof=db.prepare(`SELECT a.id AS auditId,a.run_id AS runId,a.target_id AS targetId,a.provider,a.status,a.source_checksum AS sourceChecksum,
      a.created_at AS auditAt,r.started_at AS runStartedAt,r.finished_at AS runFinishedAt FROM audits a JOIN runs r ON r.id=a.run_id
      WHERE a.target_id=? AND a.source_checksum=? AND a.provider='public-web' AND a.status IN ('validated','warning')
      AND (r.target_id IS NULL OR r.target_id=?) AND julianday(r.started_at)<=julianday(?) AND julianday(?)<=julianday(a.created_at)
      AND julianday(a.created_at)<=julianday(?) AND (r.finished_at IS NULL OR (julianday(a.created_at)<=julianday(r.finished_at) AND julianday(r.finished_at)<=julianday(?)))
      ORDER BY julianday(a.created_at) DESC,a.id DESC LIMIT 1`).get(target.id,row.source_checksum,target.id,row.captured_at,row.captured_at,asOf,asOf);
    if(isVerifiedDeferredWorksSnapshot({...row,raw_json:candidate,collectionEvidence:proof??{}},target,{nowMs:Date.parse(asOf)}))ignoredIds.add(row.id);
    else stopped.add(target.id);
  }
  return {ignoredIds,budgetLimitedSnapshotIds};
}

function watchReads(db){
  const seen={rankSql:'',rawRows:0,rawBytes:0};
  const observe=row=>{if(typeof row?.raw_json==='string'){seen.rawRows++;seen.rawBytes+=Buffer.byteLength(row.raw_json);}return row;};
  const wrapped=new Proxy(db,{get(target,key){if(key!=='prepare')return typeof target[key]==='function'?target[key].bind(target):target[key];return sql=>{
    if(sql.includes('WITH selected_targets'))seen.rankSql=sql;
    const statement=target.prepare(sql);return new Proxy(statement,{get(stmt,method){
      if(method==='get')return(...args)=>observe(stmt.get(...args));
      if(method==='all')return(...args)=>stmt.all(...args).map(observe);
      if(method==='iterate')return function*(...args){for(const row of stmt.iterate(...args))yield observe(row);};
      return typeof stmt[method]==='function'?stmt[method].bind(stmt):stmt[method];
    }});
  };}});
  return {wrapped,seen};
}

test('ranking only sorts narrow identity/time columns rather than raw payloads or audits',t=>{
  const {db}=fixture(t),{wrapped,seen}=watchReads(db);loadDeferredWorksSnapshotRead(wrapped,ASOF);
  assert.doesNotMatch(seen.rankSql,/raw_json|JOIN audits|target_metadata_json/);
});

test('known ledger cutoff avoids transferring any older raw payload into JavaScript',t=>{
  const {db,targets}=fixture(t),cutoffs=new Map(targets.map(target=>[target.id,iso(Date.parse(AT)+18000)]));
  const {wrapped,seen}=watchReads(db),actual=loadDeferredWorksSnapshotRead(wrapped,ASOF,null,cutoffs);
  assert.deepEqual(actual,referenceRead(db,ASOF,null,cutoffs));assert.equal(actual.ignoredIds.size,4);
  assert.equal(seen.rawRows,4);
});

for(const kind of ['baseline','real-failure','hash-corrupt','bad-audit','future-finish','wrong-run-target','equal-times','offset-time','past-asof','cutoff','future-cutoff'])test(`lazy read exactly matches independent bounded eager oracle: ${kind}`,t=>{
  const {db,targets}=fixture(t);let asOf=ASOF;const cutoffs=new Map();
  const latest=db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(targets[1].id);
  if(kind==='real-failure')db.prepare("UPDATE snapshots SET raw_json=replace(raw_json,'\"deferred\"','\"blocked\"') WHERE id=?").run(latest.id);
  if(kind==='hash-corrupt')db.prepare("UPDATE snapshots SET source_checksum='changed' WHERE id=?").run(latest.id);
  if(kind==='bad-audit')db.prepare("UPDATE audits SET provider='manual' WHERE source_checksum=?").run(latest.source_checksum);
  if(kind==='future-finish')db.prepare("UPDATE runs SET finished_at='2026-10-09T10:00:00.001Z' WHERE id=(SELECT run_id FROM audits WHERE source_checksum=?)").run(latest.source_checksum);
  if(kind==='wrong-run-target')db.prepare('UPDATE runs SET target_id=? WHERE id=(SELECT run_id FROM audits WHERE source_checksum=?)').run(targets[0].id,latest.source_checksum);
  if(kind==='equal-times')db.prepare('UPDATE snapshots SET works_observed_at=? WHERE target_id=?').run(AT,targets[1].id);
  if(kind==='offset-time')db.prepare("UPDATE snapshots SET works_observed_at='2026-10-09T17:00:19+08:00' WHERE id=?").run(latest.id);
  if(kind==='past-asof')asOf=iso(Date.parse(AT)+12500);
  if(kind==='cutoff')cutoffs.set(targets[0].id,iso(Date.parse(AT)+15500));
  if(kind==='future-cutoff')cutoffs.set(targets[0].id,'2026-10-10T00:00:00.000Z');
  const changes=db.prepare('SELECT total_changes() n').get().n;db.exec('PRAGMA query_only=ON');
  for(const id of [null,...targets.map(target=>target.id)])assert.deepEqual(loadDeferredWorksSnapshotRead(db,asOf,id,cutoffs),referenceRead(db,asOf,id,cutoffs));
  assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
});

test('lazy payload loading preserves exact fair-budget exhaustion IDs and does not cross any failure barrier',t=>{
  const {db,targets}=fixture(t,8,16,120000);
  const latest=db.prepare('SELECT id FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(targets[3].id);
  db.prepare("UPDATE snapshots SET raw_json=replace(raw_json,'\"deferred\"','\"blocked\"') WHERE id=?").run(latest.id);
  const expected=referenceRead(db,ASOF),actual=loadDeferredWorksSnapshotRead(db,ASOF);
  assert.ok(expected.budgetLimitedSnapshotIds.size>0);assert.deepEqual(actual,expected);
  assert.equal(actual.ignoredIds.has(latest.id),false);assert.equal(actual.budgetLimitedSnapshotIds.has(latest.id),false);
  for(const target of targets)assert.deepEqual(loadDeferredWorksSnapshotRead(db,ASOF,target.id),referenceRead(db,ASOF,target.id));
});

test('ranking stays payload-free for oversized and malformed candidates without weakening their barrier',t=>{
  const {db,targets}=fixture(t,2,3,150000),latest=db.prepare('SELECT id FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(targets[1].id);
  db.prepare("UPDATE snapshots SET raw_json='{invalid' WHERE id=?").run(latest.id);
  const {wrapped,seen}=watchReads(db),actual=loadDeferredWorksSnapshotRead(wrapped,ASOF);
  assert.deepEqual(actual,referenceRead(db,ASOF));assert.equal(actual.ignoredIds.size,0);assert.equal(seen.rawBytes,0);
});
