import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { validateTopicSnapshot } from '../lib/topic-snapshot-integrity.mjs';
import { businessDateKey, checksum, shiftCalendarDate } from '../lib/utils.mjs';

const TOPIC = '离线话题观察';
const CID = '7684603502';

// Run the real helper with only its I/O replaced. No browser, session, signer
// or platform request is used; source envelopes come from the actual writer.
function pythonDetail(participants = 0, views = 0) {
  const program = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("collector",sys.argv[1])\nc=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)\np=json.loads(sys.argv[2])\nc.register_guest=lambda:"offline-placeholder"\nc.a_bogus_signed_url=lambda endpoint,_:endpoint\nc.request_json=lambda *_a,**_k:{"status_code":0,"ch_info":{"cid":p["cid"],"cha_name":p["topic"],"user_count":p["participants"],"view_count":p["views"]}}\nprint(json.dumps(c.collect_hashtag_detail(p["cid"],p["topic"]),ensure_ascii=False))`;
  const child = spawnSync('/usr/bin/python3', ['-B', '-c', program,
    fileURLToPath(new URL('../scripts/douyin_public_collector.py', import.meta.url)), JSON.stringify({ cid: CID, topic: TOPIC, participants, views })],
  { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stdout, /offline-placeholder/);
  return JSON.parse(child.stdout);
}

function fixture(t, { participants = 0, views = 0, legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'topic-time-contract-'));
  const database = new MonitorDatabase(join(dir, 'fixture.sqlite'));
  t.after(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  const target = database.createTarget({ type: 'hashtag', provider: 'public-web', locator: TOPIC, label: TOPIC });
  const runId = database.beginRun('scheduled', null, 1);
  const collection = pythonDetail(participants, views);
  // Project the real writer envelope to the exact original contract: only the
  // two newly introduced raw fields are absent, never a fabricated raw time.
  if (legacy) { delete collection.raw.capturedAt; delete collection.raw.topicTimeContractVersion; }
  database.saveCollection(target, runId, collection);
  database.finishRun(runId, { status: 'success', successCount: 1, targetCount: 1, processedCount: 1, errorCount: 0 });
  const row = database.db.prepare(`SELECT s.*,a.id audit_id,a.target_id audit_target_id,a.provider audit_provider,
    a.status audit_status,a.source_checksum audit_checksum,a.created_at audit_created_at,a.run_id,
    r.target_id run_target_id,r.status run_status,r.started_at,r.finished_at
    FROM snapshots s JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum
    JOIN runs r ON r.id=a.run_id WHERE s.target_id=? ORDER BY s.id DESC,a.id DESC LIMIT 1`).get(target.id);
  return { database, target, row, collection, day: businessDateKey(new Date(collection.capturedAt), 'Asia/Shanghai') };
}

function mutateRaw(row, mutate, { rehash = true } = {}) {
  const changed = { ...row }, raw = JSON.parse(row.raw_json);
  mutate(raw);
  changed.raw_json = JSON.stringify(raw);
  if (rehash) changed.source_checksum = changed.audit_checksum = checksum(raw);
  return changed;
}

function rejected(row, target, reason, options) {
  assert.deepEqual(validateTopicSnapshot(row, target, options),
    { valid: false, reason, participants: null, views: null });
}

const sourceRows = database => ['targets', 'snapshots', 'audits', 'runs']
  .map(table => database.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());

test('real Python helper embeds one versioned observation timestamp in top-level and raw payload', () => {
  const result = pythonDetail(0, 0);
  assert.equal(result.raw.topicTimeContractVersion, 1);
  assert.equal(result.raw.capturedAt, result.capturedAt);
});

test('legacy official detail from the actual helper remains verifiable through its original ledger/audit contract', t => {
  const f = fixture(t, { legacy: true });
  const result = validateTopicSnapshot(f.row, f.target);
  assert.equal(result.valid, true); assert.equal(result.timeBinding, 'ledger-audit-legacy');
  assert.equal(result.participants, 0); assert.equal(result.views, 0);
  assert.equal(checksum(JSON.parse(f.row.raw_json)), f.row.source_checksum);
  const history = f.database.listTopicHistory({ startDate: f.day, endDate: f.day });
  assert.equal(history.topics[0].points[0].sourceVerified, true);
  assert.equal(history.topics[0].points[0].participants, 0);
});

test('versioned actual Python writer survives saveCollection and the page history read model without source changes', t => {
  const f = fixture(t, { participants: 0, views: 91 }), before = sourceRows(f.database);
  assert.equal(f.row.captured_at, f.collection.raw.capturedAt);
  assert.deepEqual(validateTopicSnapshot(f.row, f.target), { valid: true, reason: null,
    participants: 0, views: 91, timeBinding: 'payload-observation-time' });
  const history = f.database.listTopicHistory({ startDate: f.day, endDate: f.day });
  const point = history.topics[0].points[0];
  assert.equal(point.sourceVerified, true); assert.equal(point.sourceVerificationReason, null);
  assert.equal(point.capturedAt, f.collection.capturedAt); assert.equal(point.sourceChecksum, checksum(f.collection.raw));
  assert.equal(point.participants, 0); assert.equal(point.views, 91);
  assert.deepEqual(sourceRows(f.database), before, 'reader must not repair or rewrite original envelopes');
});

for (const [participants, views] of [[0, null], [null, 0]]) {
  test(`actual Python null counter remains independent from a measured zero (${participants}, ${views})`, t => {
    const f = fixture(t, { participants, views, legacy: true });
    assert.equal(f.collection.qualityStatus, 'warning');
    assert.deepEqual(validateTopicSnapshot(f.row, f.target), { valid: true, reason: null,
      participants, views, timeBinding: 'ledger-audit-legacy' });
    const topic = f.database.listTopicHistory({ startDate: f.day, endDate: f.day }).topics[0];
    assert.equal(topic.points[0].participants, participants); assert.equal(topic.points[0].views, views);
    assert.equal(topic.participantsObservedCount, participants === null ? 0 : 1);
    assert.equal(topic.viewsObservedCount, views === null ? 0 : 1);
    rejected({ ...f.row, quality_status: 'validated', audit_status: 'validated' }, f.target, 'partial-quality');
  });
}

test('actual Python both-null and unsafe upstream counters cannot become verified daily measurements', t => {
  const f = fixture(t, { participants: -1, views: Number.MAX_SAFE_INTEGER + 1 });
  assert.equal(f.collection.snapshot.hashtagParticipants, null); assert.equal(f.collection.snapshot.hashtagViews, null);
  rejected(f.row, f.target, 'counter');
  const topic = f.database.listTopicHistory({ startDate: f.day, endDate: f.day }).topics[0];
  assert.equal(topic.observedCount, 0); assert.equal(topic.sampledCount, 1);
  assert.equal(topic.points[0].sourceVerificationReason, 'counter');
  assert.equal(topic.points[0].participants, null); assert.equal(topic.points[0].views, null);
});

test('legacy time recognition returns only requested calendar days and keeps missing days null', t => {
  const f = fixture(t, { legacy: true, participants: 0, views: null }), before = sourceRows(f.database);
  const startDate = shiftCalendarDate(f.day, -1), endDate = shiftCalendarDate(f.day, 1);
  const history = f.database.listTopicHistory({ startDate, endDate }), topic = history.topics[0];
  assert.equal(history.days, 3);
  assert.deepEqual(topic.points.map(point => point.date), [startDate, f.day, endDate]);
  assert.deepEqual(topic.points.map(point => point.participants), [null, 0, null]);
  assert.deepEqual(topic.points.map(point => point.views), [null, null, null]);
  assert.equal(topic.observedCount, 1); assert.equal(topic.participantsObservedCount, 1); assert.equal(topic.viewsObservedCount, 0);
  assert.equal(topic.missingCount, 2); assert.equal(topic.participantsMissingCount, 2); assert.equal(topic.viewsMissingCount, 3);
  assert.equal(topic.latestKnown.participants.date, f.day); assert.equal(topic.latestKnown.views, null);
  assert.deepEqual(topic.points.map(point => point.participantsDelta), [null, null, null]);
  assert.deepEqual(sourceRows(f.database), before);
});

for (const [label, mutation, reason] of [
  ['explicit null time', raw => { raw.capturedAt = null; }, 'time-binding'],
  ['explicit undefined string time', raw => { raw.capturedAt = 'undefined'; }, 'time-binding'],
  ['noncanonical time', raw => { raw.capturedAt = '2026-10-05T00:00:00+00:00'; }, 'time-binding'],
  ['invalid calendar time', raw => { raw.capturedAt = '2026-02-30T00:00:00.000Z'; }, 'time-binding'],
  ['mismatched payload time', raw => { raw.capturedAt = '2026-01-01T00:00:00.000Z'; }, 'time-binding'],
  ['version one without time', raw => { raw.topicTimeContractVersion = 1; }, 'time-binding'],
  ['null version', raw => { raw.topicTimeContractVersion = null; }, 'time-contract-version'],
  ['unknown version', raw => { raw.topicTimeContractVersion = 2; }, 'time-contract-version'],
  ['string version', raw => { raw.topicTimeContractVersion = '1'; }, 'time-contract-version'],
  ['nonlegacy public search without time', raw => { raw.provenance.mode = 'douyin-public-hashtag-search-and-detail'; }, 'time-binding'],
]) test(`legacy recognition rejects ${label}, even with a matching new full checksum`, t => {
  const f = fixture(t, { legacy: true });
  rejected(mutateRaw(f.row, mutation), f.target, reason);
});

test('literal undefined is invalid persisted JSON and cannot masquerade as an absent legacy property', t => {
  const f = fixture(t, { legacy: true });
  rejected({ ...f.row, raw_json: f.row.raw_json.replace(/}$/, ',"capturedAt":undefined}') }, f.target, 'raw-payload');
});

for (const [label, mutation, rehash, reason] of [
  ['full raw changed', raw => { raw.extra = 'unbound-change'; }, false, 'source-payload'],
  ['raw vector changed', raw => { raw.views = 1; }, true, 'source-payload'],
  ['official name changed', raw => { raw.officialName = '其他话题'; }, true, 'source-identity'],
  ['label changed', raw => { raw.label = '其他话题'; }, true, 'source-identity'],
  ['invalid challenge ID', raw => { raw.challengeId = 'invalid'; }, true, 'source-identity'],
  ['foreign endpoint', raw => { raw.provenance.endpoint = 'https://example.invalid/'; }, true, 'source-payload'],
  ['foreign scope', raw => { raw.scope = 'another-source'; }, true, 'source-payload'],
  ['nonzero business status', raw => { raw.businessStatusCode = 403; }, true, 'source-payload'],
  ['wrong authenticated flag', raw => { raw.provenance.authenticated = true; }, true, 'source-provenance'],
  ['missing safety provenance', raw => { delete raw.provenance.paidAPI; }, true, 'source-identity'],
]) test(`legacy recognition keeps ${label} rejection intact`, t => {
  const f = fixture(t, { legacy: true });
  rejected(mutateRaw(f.row, mutation, { rehash }), f.target, reason);
});

test('legacy recognition keeps target, run, audit, checksum, quality, and chronological bindings intact', t => {
  const f = fixture(t, { legacy: true });
  const afterCapture = new Date(Date.parse(f.row.captured_at) + 1000).toISOString();
  const beforeCapture = new Date(Date.parse(f.row.captured_at) - 1000).toISOString();
  for (const [change, reason] of [
    [{ target_id: f.target.id + 1 }, 'target-audit-binding'],
    [{ audit_target_id: f.target.id + 1 }, 'target-audit-binding'],
    [{ audit_provider: 'manual' }, 'target-audit-binding'],
    [{ run_target_id: f.target.id + 1 }, 'run-binding'],
    [{ run_id: 0 }, 'run-binding'],
    [{ run_status: 'running' }, 'run-state'],
    [{ run_status: 'unknown' }, 'run-state'],
    [{ audit_status: 'rejected' }, 'quality'],
    [{ audit_checksum: 'f'.repeat(64) }, 'checksum-binding'],
    [{ source_checksum: 'unbound' }, 'checksum-binding'],
    [{ started_at: afterCapture }, 'time'],
    [{ audit_created_at: beforeCapture }, 'time'],
    [{ finished_at: beforeCapture }, 'time'],
    [{ captured_at: '2026-02-30T00:00:00.000Z' }, 'time'],
    [{ hashtag_views: 1 }, 'source-payload'],
    [{ hashtag_views: -1 }, 'counter'],
  ]) rejected({ ...f.row, ...change }, f.target, reason);
  rejected(f.row, { ...f.target, provider: 'manual' }, 'provider');
  rejected(f.row, f.target, 'time', { asOf: Date.parse(beforeCapture) });
});

test('browser evidence still requires its own observation instant and its dedicated source checksum', t => {
  const f = fixture(t, { participants: 8, views: 90 });
  const raw = { challengeId: f.collection.raw.challengeId, officialName: f.collection.raw.officialName,
    hashtag: TOPIC, searchKeyword: `#${TOPIC}`, capturedAt: f.collection.capturedAt,
    provenance: { mode: 'douyin-authenticated-browser-search-and-detail', authenticated: true, paidAPI: false, runtimeAI: false } };
  const digest = checksum({ tag: raw.hashtag, snapshot: { followers: null, totalLikes: null, totalPosts: null,
    hashtagParticipants: 8, hashtagViews: 90, hashtagPosts: null, authorCount: null },
    raw: { challengeId: raw.challengeId, officialName: raw.officialName, searchKeyword: raw.searchKeyword } });
  const row = { ...f.row, raw_json: JSON.stringify(raw), source_checksum: digest, audit_checksum: digest };
  assert.equal(validateTopicSnapshot(row, f.target).timeBinding, 'payload-observation-time');
  rejected(mutateRaw(row, value => { delete value.capturedAt; }, { rehash: false }), f.target, 'time-binding');
  rejected(mutateRaw(row, value => { value.capturedAt = null; }, { rehash: false }), f.target, 'time-binding');
  rejected(mutateRaw(row, value => { value.officialName = '其他话题'; }, { rehash: false }), f.target, 'source-identity');
  rejected({ ...row, hashtag_views: 91 }, f.target, 'source-checksum');
});
