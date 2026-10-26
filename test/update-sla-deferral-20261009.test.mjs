import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { buildUpdateSla, inspectUpdateSla } from '../lib/update-sla.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { initializeWorksOnlyObservations, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';

const NOW = '2026-10-09T10:20:00.000Z', BEFORE = '2026-10-09T09:59:40.000Z', AFTER = '2026-10-09T10:07:00.000Z';
const SEC = 'MS4wLjABAAAAdeferred_sla_fixture_0123456789';
const target = { id: 1, type: 'account', provider: 'public-web', enabled: 1, locator: SEC, metadata: { platform: 'douyin' } };
function deferredRaw(at = AFTER) {
  const mode = 'guest-ttwid-unsigned-profile';
  return { capturedAt: at, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: '1234567890123', follower_count: 100, total_favorited: 200, aweme_count: 3 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode, profileMode: mode, profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false },
    worksRequestPolicy: { version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport',
      anonymous: { transport: 'anonymous-http', attempted: false, deferred: true, errorCode: 'blocked' },
      browser: { transport: 'authorised-browser', attempted: false, deferred: false, errorCode: null } },
    worksFallbackDeferred: { version: 1, reason: 'scheduled-profile-priority', mode: 'works-only' } };
}
function row(id, at, coverage, raw = null) {
  const sha = raw ? checksum(raw) : `legacy-sha-${id}`;
  return { id, target_id: 1, captured_at: at, works_observed_at: null,
    followers: 100, total_likes: 200, total_posts: 3, quality_status: 'warning', account_status: 'available',
    works_coverage: coverage, source_checksum: sha, raw_json: raw ? JSON.stringify(raw) : null,
    collectionEvidence: { auditId: id, runId: 1, targetId: 1, provider: 'public-web', status: 'warning', sourceChecksum: sha,
      runStartedAt: '2026-10-08T00:00:00.000Z', runFinishedAt: null, auditAt: at } };
}
const older = (at = BEFORE, coverage = 'limited') => row(1, at, coverage);
const deferred = (raw = deferredRaw()) => row(2, raw.capturedAt, 'unavailable', raw);
const build = (snapshots, changes = {}) => buildUpdateSla({ targets: [target], snapshots, now: NOW, ...changes });

test('zero-request profile-only update does not displace an actual in-window works sample', () => {
  for (const coverage of ['complete', 'limited']) {
    const rows = [older(BEFORE, coverage), deferred()], before = JSON.stringify(rows);
    const result = build(rows);
    assert.equal(result.works.daily.targets[0].state, coverage);
    assert.equal(result.works.daily.targets[0].capturedAt, BEFORE);
    assert.equal(result.works.daily.targets[0].snapshotId, 1);
    assert.equal(result.coreAccounts.targets[0].snapshotId, 2);
    assert.equal(result.works.daily.deferrals.targets, 1);
    assert.equal(result.works.daily.targets[0].lastDeferredAt, AFTER);
    assert.equal(JSON.stringify(rows), before);
  }
});

test('a deferral alone stays missing; it cannot refresh works across the 8-hour or Beijing-day boundary', () => {
  const empty = build([deferred()]);
  assert.equal(empty.works.daily.counts.missing, 1);
  assert.equal(empty.works.daily.targets[0].capturedAt, null);
  const expired = build([older('2026-10-09T02:19:59.999Z', 'complete'), deferred()]);
  assert.equal(expired.works.daily.complete, 1);
  assert.equal(expired.works.fresh8h.counts.missing, 1);
  assert.equal(expired.works.fresh8h.deferrals.targets, 1);
  const previousDay = build([older('2026-10-08T15:59:59.999Z', 'complete'), deferred()]);
  assert.equal(previousDay.works.daily.counts.missing, 1);
});

test('actual new failure still wins; an older deferral is not the latest activity after a new attempt', () => {
  const failed = row(3, '2026-10-09T10:08:00.000Z', 'retry');
  const result = build([older(), deferred(), failed]);
  assert.equal(result.works.daily.counts.unavailable, 1);
  assert.equal(result.works.daily.targets[0].snapshotId, 3);
  assert.equal(result.works.daily.deferrals.targets, 0);
});

const rawMutations = [
  ['real anonymous attempt', raw => { raw.worksRequestPolicy.anonymous.attempted = true; }],
  ['real browser attempt', raw => { raw.worksRequestPolicy.browser.attempted = true; }],
  ['missing browser evidence', raw => { delete raw.worksRequestPolicy.browser; }],
  ['wrong transport', raw => { raw.worksRequestPolicy.browser.transport = 'other'; }],
  ['wrong policy endpoint', raw => { raw.worksRequestPolicy.endpoint = 'other'; }],
  ['nonzero request count', raw => { raw.works.pagination.requestCount = 1; }],
  ['unexpected page', raw => { raw.works.pagination.pages.push({}); }],
  ['unexpected works list', raw => { raw.works.aweme_list = []; }],
  ['real failure code', raw => { raw.worksErrorCode = 'blocked'; }],
  ['no deferred lane', raw => { raw.worksRequestPolicy.anonymous.deferred = false; }],
  ['unexpected source wrapper', raw => { raw.codexObservation = { source: 'manual-import' }; }],
  ['foreign identity', raw => { raw.profile.user.sec_uid += 'different'; }],
  ['coerced UID', raw => { raw.profile.user.uid = 1234567890123; }],
  ['mismatched profile metrics', raw => { raw.profile.user.aweme_count = 5; }],
  ['unknown profile mode', raw => { raw.provenance.mode = 'unknown'; }],
  ['contradictory top-level challenge', raw => { raw.captcha_required = true; }],
  ['recorded browser observation', raw => { raw.works.observedAt = AFTER; }],
  ['recorded browser failure', raw => { raw.worksFallbackErrorCode = 'collector_error'; }],
  ['oversized source', raw => { raw.padding = 'x'.repeat(131073); }],
];
for (const [name, change] of rawMutations) test(`ambiguous or contradictory deferred source does not hide latest unavailable: ${name}`, () => {
  const raw = deferredRaw(); change(raw);
  const result = build([older(), deferred(raw)]);
  assert.equal(result.works.daily.counts.unavailable, 1);
  assert.equal(result.works.daily.targets[0].snapshotId, 2);
});

test('wrong hash, raw time, metric columns, platform or explicit works timestamp cannot qualify', () => {
  for (const mutate of [
    value => { value.source_checksum = 'f'.repeat(64); value.collectionEvidence.sourceChecksum = value.source_checksum; },
    value => { const raw = JSON.parse(value.raw_json); raw.capturedAt = BEFORE; value.raw_json = JSON.stringify(raw); value.source_checksum = checksum(raw); value.collectionEvidence.sourceChecksum = value.source_checksum; },
    value => { value.total_posts = 4; },
    value => { value.works_observed_at = AFTER; },
  ]) { const value = deferred(); mutate(value); assert.equal(build([older(), value]).works.daily.counts.unavailable, 1); }
  assert.equal(build([older(), deferred()], { targets: [{ ...target, metadata: { platform: 'bilibili' } }] }).works.daily.counts.unavailable, 1);
});

function fixtureDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT,enabled INTEGER,locator TEXT,metadata_json TEXT);
    CREATE TABLE snapshots(id INTEGER,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,
      hashtag_participants INTEGER,hashtag_views INTEGER,quality_status TEXT,account_status TEXT,works_coverage TEXT,source_checksum TEXT,works_observed_at TEXT,raw_json TEXT);
    CREATE TABLE audits(id INTEGER,target_id INTEGER,created_at TEXT,status TEXT,provider TEXT,run_id INTEGER,source_checksum TEXT);
    CREATE TABLE runs(id INTEGER,started_at TEXT,finished_at TEXT);
    INSERT INTO runs VALUES(1,'2026-10-08T00:00:00.000Z',NULL);`);
  db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(target.id,target.type,target.provider,1,SEC,JSON.stringify(target.metadata));
  for (const item of rows) {
    db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(item.id,1,item.captured_at,item.followers,item.total_likes,item.total_posts,
      null,null,item.quality_status,item.account_status,item.works_coverage,item.source_checksum,item.works_observed_at,item.raw_json);
    db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run(item.id,1,item.collectionEvidence.auditAt,'warning','public-web',1,item.source_checksum);
  }
  return db;
}

test('bounded SQLite projection validates raw deferral rather than trusting stored labels or SQL-only flags', () => {
  for (const broken of [false, true]) {
    const value = deferred(); if (broken) value.raw_json = value.raw_json.replace('1234567890123','1234567890124');
    const rows = [older(BEFORE,'complete'),value], db = fixtureDb(rows);
    try {
      const before = db.prepare('SELECT total_changes() n').get().n;
      db.exec('PRAGMA query_only=ON');
      const result = inspectUpdateSla(db,{now:NOW,includeTargets:true});
      assert.equal(result.works.daily.targets[0].state,broken ? 'unavailable' : 'complete');
      assert.equal(result.works.daily.deferrals.targets,broken ? 0 : 1);
      assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
    } finally { db.close(); }
  }
});

test('SQLite passes only small zero-request candidate payloads and rejects malformed metadata', () => {
  const giant = deferredRaw(); giant.padding = 'x'.repeat(200000);
  const value = deferred(giant), db = fixtureDb([older(BEFORE,'complete'),value]);
  const captures = [];
  const tracked = { exec: (...args) => db.exec(...args), prepare(sql) {
    const statement = db.prepare(sql);
    if (!sql.includes('WITH evidence_audits')) return statement;
    return { all(...args) { const rows = statement.all(...args); captures.push(...rows.map(item => ({ id:item.id,bytes:item.raw_json?.length ?? 0 }))); return rows; } };
  } };
  try {
    assert.equal(inspectUpdateSla(tracked,{now:NOW}).works.daily.counts.unavailable,1);
    assert.ok(captures.length >= 2);
    assert.ok(captures.every(item => item.bytes === 0),'large account blobs never cross the SQLite projection boundary');
    const regular = deferred();
    db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=2').run(regular.raw_json,regular.source_checksum);
    db.prepare('UPDATE audits SET source_checksum=? WHERE id=2').run(regular.source_checksum);
    for (const invalid of ['{bad','null','[]','"douyin"','{"platform":"bilibili"}']) {
      db.prepare('UPDATE targets SET metadata_json=?').run(invalid);
      assert.equal(inspectUpdateSla(db,{now:NOW}).works.daily.counts.unavailable,1,invalid);
    }
  } finally { db.close(); }
});

for (const failure of [false,true]) test(`real immutable ledger remains authoritative through a zero-request profile update; newer failure=${failure}`, t => {
  const anchorAt='2026-10-09T09:50:00.000Z', start='2026-10-09T09:59:39.000Z', end='2026-10-09T09:59:41.000Z';
  t.mock.timers.enable({apis:['Date'],now:Date.parse(anchorAt)});
  const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
  const storedTarget=database.createTarget({type:'account',provider:'public-web',label:'offline',locator:SEC,metadata:{platform:'douyin'}});
  const saveProfile=at=>{
    t.mock.timers.setTime(Date.parse(at));const run=database.beginRun('scheduled',storedTarget.id,1),raw=deferredRaw(at);
    database.saveCollection(storedTarget,run,normalizeCollection(storedTarget,raw,{capturedAt:at}));
    database.finishRun(run,{status:'success',successCount:1});
    return database.db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
  };
  const anchor=saveProfile(anchorAt);initializeWorksOnlyObservations(database.db);
  t.mock.timers.setTime(Date.parse(start));const runId=database.beginRun('works-only',storedTarget.id,1);
  const posts=Array.from({length:3},(_,i)=>({aweme_id:`720000000000000000${i+1}`,author:{sec_uid:SEC,uid:'1234567890123'},statistics:{digg_count:1}}));
  t.mock.timers.setTime(Date.parse(end));
  recordWorksOnlyObservation(database.db,{targetId:storedTarget.id,runId,anchorSnapshotId:anchor.id,anchorChecksum:anchor.source_checksum,
    requestStartedAt:start,requestFinishedAt:end,result:{status:'ok',posts,hasMore:false,maxCursor:0,pagination:{version:1,maxPages:3,requestCount:1,collectedCount:3,
      stopReason:'end-of-list',errorCode:null,pages:[{requestCursor:0,response:{max_cursor:0,has_more:false},rawCount:3,acceptedCount:3,duplicateCount:0,filteredCount:0,truncated:false,observedAt:BEFORE}]}}});
  database.finishRun(runId,{status:'success',successCount:1});
  const newer=saveProfile(AFTER);
  if(failure){
    const failedStart='2026-10-09T10:08:00.000Z',failedEnd='2026-10-09T10:08:02.000Z';
    t.mock.timers.setTime(Date.parse(failedStart));const failedRun=database.beginRun('works-only',storedTarget.id,1);
    t.mock.timers.setTime(Date.parse(failedEnd));
    recordWorksOnlyObservation(database.db,{targetId:storedTarget.id,runId:failedRun,anchorSnapshotId:newer.id,anchorChecksum:newer.source_checksum,
      requestStartedAt:failedStart,requestFinishedAt:failedEnd,result:{status:'unavailable',posts:[],errorCode:'blocked',failureDiagnostics:{version:1,stopReason:'http-rejection',httpStatuses:[403]}}});
    database.finishRun(failedRun,{status:'error',errorCount:1});
  }
  const before=database.db.prepare('SELECT total_changes() n').get().n;database.db.exec('PRAGMA query_only=ON');
  const result=inspectUpdateSla(database.db,{now:NOW,includeTargets:true});
  assert.equal(result.works.daily.targets[0].state,failure?'unavailable':'complete');
  assert.equal(result.coreAccounts.targets[0].capturedAt,AFTER);
  assert.equal(result.works.daily.deferrals.targets,failure?0:1);
  if(failure)assert.equal(result.works.daily.latestAttemptDiagnostics.reasons.http403,1);
  else assert.equal(result.works.daily.targets[0].capturedAt,BEFORE);
  assert.equal(database.db.prepare('SELECT total_changes() n').get().n,before);
});
