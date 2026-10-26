import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { checksum } from '../lib/utils.mjs';
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity, verifyHistoricalSourceWorkIdentity } from '../lib/source-work-identity.mjs';
import { getDouyinLifecycleEvidence } from '../lib/account-lifecycle.mjs';

const SEC = 'MS4wLjABAAAAsourceWorkHistoryCanonical123456';
const UID = '101115710974', VIDEO = '7678272839845855921', ORIGINAL = '1380535635';
const opts = { requestStartedAt: '2026-09-29T02:09:55.000Z', reference: '2026-09-29T02:10:02.000Z' };

function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', label: 'Fixture', locator: SEC,
    metadata: { platform: 'douyin', douyinId: ORIGINAL, evidenceVideoId: VIDEO,
      importSource: { type: 'author-spreadsheet', fileName: 'Original.xlsx', sheetName: 'Roster', sourceRow: 560 } } });
  const raw = { capturedAt: '2026-09-13T12:00:00.000Z', accountStatus: 'available', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, unique_id: 'WKGD', short_id: '0', follower_count: 278, total_favorited: 4922, aweme_count: 5 } },
    works: { aweme_list: [] }, provenance: { mode: 'guest-ttwid-unsigned-profile-a-bogus-posts',
      profileMode: 'guest-ttwid-unsigned-profile', profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const request = getSourceWorkIdentityRequest(database, target, raw);
  const historicalRaw = { ...structuredClone(raw), sourceIdentityEvidence: {
    capturedAt: '2026-09-13T12:00:01.000Z', requestedVideoId: VIDEO,
    response: { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: UID, short_id: ORIGINAL }, statistics: { digg_count: 999999 } } },
    provenance: { mode: 'guest-ttwid-a-bogus-video-detail', endpoint: 'https://www.douyin.com/aweme/v1/web/aweme/detail/',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } } };
  const proof = verifySourceWorkIdentity(database, target, historicalRaw, { provider: 'public-web', operation: 'identity-work',
    requestedVideoId: VIDEO, requestedAccountId: SEC, sourceBindingChecksum: request.sourceBindingChecksum,
    observedAt: '2026-09-13T12:00:02.000Z' });
  assert.ok(proof, 'original fixture proof');
  const db = database.db, hash = checksum(historicalRaw), rawText = JSON.stringify(historicalRaw);
  db.prepare("INSERT INTO runs(id,trigger_type,target_id,started_at,finished_at,status,target_count) VALUES(491,'manual',?,?,?,'success',1)")
    .run(target.id, '2026-09-13T11:59:58.000Z', '2026-09-13T12:00:03.000Z');
  db.prepare(`INSERT INTO snapshots(id,target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,source_checksum,raw_json)
    VALUES(21562,?,?,278,4922,5,'validated','available',?,?)`).run(target.id, raw.capturedAt, hash, rawText);
  db.prepare(`INSERT INTO audits(id,target_id,run_id,created_at,provider,status,source_checksum)
    VALUES(7911,?,491,'2026-09-13T12:00:02.200Z','public-web','validated',?)`).run(target.id, hash);
  db.prepare(`INSERT INTO account_events(id,target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
    VALUES(6,?,491,'identity',?,?,?,?,?,'2026-09-13T12:00:02.100Z')`).run(target.id,
    checksum([target.id, ORIGINAL, VIDEO, SEC, UID, proof.sourceMatchField]), proof.observedAt, hash, JSON.stringify(proof), rawText);
  const fresh = structuredClone(raw); fresh.capturedAt = '2026-09-29T02:10:00.000Z';
  fresh.profile.user.follower_count = 999; fresh.profile.user.total_favorited = 10000;
  return { database, db, target, historicalRaw, proof, fresh, options: { ...opts } };
}
const verify = f => verifyHistoricalSourceWorkIdentity(f.database, f.target, f.fresh, f.options);
const updateProof = (f, mutate) => { const proof = structuredClone(f.proof); mutate(proof); f.db.prepare('UPDATE account_events SET event_json=? WHERE id=6').run(JSON.stringify(proof)); };

test('historical source-work identity keeps old evidence and fresh profile time distinct, copies no metrics, and is read-only', t => {
  const f = fixture(t), before = JSON.stringify(f.fresh), changes = f.db.prepare('SELECT total_changes() n').get().n;
  const result = verify(f);
  assert.equal(result.type, 'historical-source-id-verification');
  assert.equal(result.sourceAccountId, ORIGINAL);
  assert.equal(result.currentRawSha256, checksum(f.fresh));
  assert.equal(result.observedAt, f.fresh.capturedAt);
  assert.equal(result.freshProfileObservedAt, f.fresh.capturedAt);
  assert.equal(result.profileRequestStartedAt, opts.requestStartedAt);
  assert.equal(result.historicalEvidence.observedAt, f.proof.observedAt);
  assert.equal(result.historicalEvidence.snapshotId, 21562);
  assert.equal(result.historicalEvidence.auditId, 7911);
  assert.equal(result.historicalEvidence.runId, 491);
  assert.equal(result.identityOnly, true);
  assert.doesNotMatch(JSON.stringify(result), /follower_count|total_favorited|aweme_list|999999|10000/);
  assert.equal(JSON.stringify(f.fresh), before);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('identity history does not acquire an invented calendar TTL; original valid proof remains usable with a fresh request', t => {
  const f = fixture(t); f.fresh.capturedAt = '2027-09-29T02:10:00.000Z';
  f.options = { requestStartedAt: '2027-09-29T02:09:55.000Z', reference: '2027-09-29T02:10:02.000Z' };
  assert.ok(verify(f));
});

test('strict actual deferred envelope can reuse identity without claiming any works coverage', t => {
  const f = fixture(t);
  Object.assign(f.fresh, { accountStatus: 'validated', worksCoverage: 'unavailable', worksErrorCode: 'deferred',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } } });
  f.fresh.provenance.mode = f.fresh.provenance.profileMode;
  const result = verify(f);
  assert.ok(result);
  assert.equal(f.fresh.worksCoverage, 'unavailable');
  assert.equal(Object.hasOwn(result, 'worksCoverage'), false);
});

const freshNegatives = {
  'missing request start': f => { delete f.options.requestStartedAt; },
  'old raw replay': f => { f.fresh.capturedAt = '2026-09-13T12:00:00.000Z'; },
  'future raw': f => { f.fresh.capturedAt = '2026-09-29T02:10:03.000Z'; },
  'expired current request': f => { f.options.requestStartedAt = '2026-09-29T01:59:59.000Z'; },
  'future current request': f => { f.options.requestStartedAt = '2026-09-29T02:10:03.000Z'; },
  'invalid calendar date': f => { f.options.reference = '2026-02-30T00:00:00.000Z'; },
  'different canonical id': f => { f.fresh.profile.user.sec_uid += 'other'; },
  'different uid': f => { f.fresh.profile.user.uid = '101115710975'; },
  'numeric uid precision': f => { f.fresh.profile.user.uid = Number(UID); },
  'missing uid': f => { delete f.fresh.profile.user.uid; },
  'deleted current profile': f => { f.fresh.profile.user.user_deleted = true; },
  'deleted envelope': f => { f.fresh.accountStatus = 'deleted'; },
  'current account error': f => { f.fresh.accountError = 'failed'; },
  'unofficial endpoint': f => { f.fresh.provenance.profileEndpoint = 'https://example.invalid/'; },
  'unofficial envelope mode': f => { f.fresh.provenance.mode = 'imported'; },
  'wrong platform': f => { f.fresh.provenance.platform = 'bilibili'; },
  'self asserted old proof': f => { f.fresh.sourceIdentityEvidence = f.historicalRaw.sourceIdentityEvidence; },
  'self asserted reused proof': f => { f.fresh.historicalSourceIdentityEvidence = {}; },
  'captcha response': f => { f.fresh.captcha_required = true; },
  'raw status failure': f => { f.fresh.status_code = 4; },
  'snapshot injection': f => { f.fresh.snapshot = {}; },
  'paid source': f => { f.fresh.provenance.paidAPI = true; },
  'AI source': f => { f.fresh.provenance.runtimeAI = true; },
  'contradicting original response': f => { f.fresh.profileResponse = { status_code: 0, user: { sec_uid: SEC, uid: '42' } }; },
  'login in original response': f => { f.fresh.profileResponse = { status_code: 0, user: { ...f.fresh.profile.user }, need_login: true }; },
};
for (const [name, mutate] of Object.entries(freshNegatives)) test(`history rejects ${name}`, t => { const f = fixture(t); mutate(f); assert.equal(verify(f), null); });

const historicalNegatives = {
  'paused target': f => f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id),
  'changed original source binding': f => f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({ ...f.target.metadata, importSource: { ...f.target.metadata.importSource, sourceRow: 561 } }), f.target.id),
  'changed original submitted id': f => f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({ ...f.target.metadata, douyinId: 'different' }), f.target.id),
  'changed original video': f => f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({ ...f.target.metadata, evidenceVideoId: '7678272839845855922' }), f.target.id),
  'event raw tampered': f => f.db.prepare("UPDATE account_events SET raw_json='{}' WHERE id=6").run(),
  'event hash tampered': f => f.db.prepare("UPDATE account_events SET source_checksum=? WHERE id=6").run('a'.repeat(64)),
  'event proof tampered': f => updateProof(f, p => { p.uid = '42'; }),
  'event target proof mismatch': f => updateProof(f, p => { p.targetId += 1; }),
  'recursive reused proof': f => updateProof(f, p => { p.type = 'historical-source-id-verification'; }),
  'event key tampered': f => f.db.prepare("UPDATE account_events SET event_key='changed' WHERE id=6").run(),
  'missing original run': f => f.db.prepare('UPDATE account_events SET run_id=NULL WHERE id=6').run(),
  'run unfinished': f => f.db.prepare("UPDATE runs SET status='running',finished_at=NULL WHERE id=491").run(),
  'run later than current request': f => f.db.prepare("UPDATE runs SET finished_at='2026-09-29T02:10:01.000Z' WHERE id=491").run(),
  'run starts after original profile': f => f.db.prepare("UPDATE runs SET started_at='2026-09-13T12:00:00.001Z' WHERE id=491").run(),
  'missing original audit': f => f.db.prepare('DELETE FROM audits WHERE id=7911').run(),
  'audit provider mismatch': f => f.db.prepare("UPDATE audits SET provider='manual' WHERE id=7911").run(),
  'audit source mismatch': f => f.db.prepare("UPDATE audits SET source_checksum='different' WHERE id=7911").run(),
  'audit rejected': f => f.db.prepare("UPDATE audits SET status='rejected' WHERE id=7911").run(),
  'ambiguous duplicate audit': f => f.db.prepare(`INSERT INTO audits(target_id,run_id,created_at,provider,status,source_checksum)
    SELECT target_id,run_id,created_at,provider,status,source_checksum FROM audits WHERE id=7911`).run(),
  'audit predates original evidence': f => f.db.prepare("UPDATE audits SET created_at='2026-09-13T11:59:59.000Z' WHERE id=7911").run(),
  'audit outlives run': f => f.db.prepare("UPDATE audits SET created_at='2026-09-13T12:00:04.000Z' WHERE id=7911").run(),
  'snapshot raw mismatch': f => f.db.prepare("UPDATE snapshots SET raw_json='{}' WHERE id=21562").run(),
  'snapshot source mismatch': f => f.db.prepare("UPDATE snapshots SET source_checksum='different' WHERE id=21562").run(),
  'snapshot rejected': f => f.db.prepare("UPDATE snapshots SET quality_status='rejected' WHERE id=21562").run(),
  'snapshot unavailable': f => f.db.prepare("UPDATE snapshots SET account_status='unknown' WHERE id=21562").run(),
  'snapshot time mismatched': f => f.db.prepare("UPDATE snapshots SET captured_at='2026-09-13T12:00:00.001Z' WHERE id=21562").run(),
  'future identity ledger': f => f.db.prepare("UPDATE account_events SET observed_at='2026-09-30T00:00:00.000Z' WHERE id=6").run(),
  'identity evidence creation before verification': f => f.db.prepare("UPDATE account_events SET created_at='2026-09-13T12:00:01.000Z' WHERE id=6").run(),
  'identity queue conflict': f => f.db.prepare(`INSERT INTO author_resolution_queue(identity_key,douyin_id,status,resolved_target_id,suspended_target_enabled,next_attempt_at,created_at,updated_at)
    VALUES('fixture','1380535635','rejected',?,1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')`).run(f.target.id),
};
for (const [name, mutate] of Object.entries(historicalNegatives)) test(`history rejects ${name}`, t => { const f = fixture(t); mutate(f); assert.equal(verify(f), null); });

function addLifecycles(f) {
  for (const [state, date] of [['deleted', '2026-09-14T00:00:00.000Z'], ['active', '2026-09-15T00:00:00.000Z']]) {
    const raw = structuredClone(f.fresh); raw.capturedAt = date;
    let evidence;
    if (state === 'deleted') {
      raw.profile = { user: { uid: UID } };
      raw.profileResponse = { status_code: 0, user: { uid: UID, user_deleted: true,
        special_state_info: { special_state: 1, title: '账号已经注销', content: '用户已将自己账号注销，所属内容已无法查看' } } };
      evidence = getDouyinLifecycleEvidence(f.target, raw, { provider: 'public-web', operation: 'account', requestedAccountId: SEC, observedAt: date });
      assert.ok(evidence);
    } else evidence = { state, observedAt: date, requestedAccountId: SEC, source: 'official-public-profile',
      sourceChecksum: checksum(raw), identityVerified: true };
    f.db.prepare(`INSERT INTO account_events(target_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
      VALUES(?,'lifecycle',?,?,?,?,?,?)`).run(f.target.id, state, date, checksum(raw), JSON.stringify(evidence), JSON.stringify(raw), date);
  }
}

test('deleted lifecycle after original proof revokes it, including after a later active event', t => {
  const f = fixture(t); addLifecycles(f);
  assert.equal(verify(f), null);
});

test('tampering deleted lifecycle state to active cannot hide revocation in the retained raw response', t => {
  const f = fixture(t); addLifecycles(f);
  const row = f.db.prepare("SELECT id,event_json FROM account_events WHERE event_key='deleted'").get();
  const evidence = JSON.parse(row.event_json); evidence.state = 'active'; evidence.identityVerified = true;
  f.db.prepare('UPDATE account_events SET event_json=? WHERE id=?').run(JSON.stringify(evidence), row.id);
  assert.equal(verify(f), null);
});

test('final database reread rejects a pause occurring after historical evidence queries', t => {
  const f = fixture(t), base = f.db.prepare.bind(f.db); let hits = 0;
  f.database.db = { prepare(sql) { const statement = base(sql); if (!sql.startsWith('SELECT t.*, EXISTS(')) return statement;
    return { get(...args) { hits++; if (hits === 3) base('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id); return statement.get(...args); } }; } };
  assert.equal(verify(f), null);
  f.database.db = f.db;
});
