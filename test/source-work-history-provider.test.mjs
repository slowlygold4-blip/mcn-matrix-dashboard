import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity } from '../lib/source-work-identity.mjs';
import { checksum } from '../lib/utils.mjs';
import { setTimeout as wait } from 'node:timers/promises';

const SEC = 'MS4wLjABAAAAsourceWorkHistoryProvider123456';
const UID = '101115710974', VIDEO = '7678272839845855921', ORIGINAL = '1380535635';

function fixture(t) {
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', label: 'Historical identity fixture', locator: SEC,
    metadata: { platform: 'douyin', douyinId: ORIGINAL, evidenceVideoId: VIDEO,
      importSource: { type: 'author-spreadsheet', fileName: 'Original.xlsx', sheetName: 'Roster', sourceRow: 560 } } });
  const base = Date.now() - 2 * 86400_000, at = offset => new Date(base + offset).toISOString();
  const raw = { capturedAt: at(1000), accountStatus: 'available', accountError: null, worksCoverage: 'unavailable', worksError: 'unavailable',
    profile: { user: { sec_uid: SEC, uid: UID, unique_id: 'WKGD', short_id: '0', nickname: 'Fixture',
      follower_count: 278, total_favorited: 4922, aweme_count: 5 } },
    works: { aweme_list: [] }, warnings: ['works unavailable'],
    provenance: { mode: 'guest-ttwid-unsigned-profile-a-bogus-posts', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const request = getSourceWorkIdentityRequest(database, target, raw);
  const originalRaw = { ...structuredClone(raw), sourceIdentityEvidence: { capturedAt: at(2000), requestedVideoId: VIDEO,
    response: { status_code: 0, aweme_detail: { aweme_id: VIDEO,
      author: { sec_uid: SEC, uid: UID, short_id: ORIGINAL }, statistics: { digg_count: 9999999 } } },
    provenance: { mode: 'guest-ttwid-a-bogus-video-detail', endpoint: 'https://www.douyin.com/aweme/v1/web/aweme/detail/',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } } };
  const proof = verifySourceWorkIdentity(database, target, originalRaw, { provider: 'public-web', operation: 'identity-work',
    requestedAccountId: SEC, requestedVideoId: VIDEO, sourceBindingChecksum: request.sourceBindingChecksum, observedAt: at(3000) });
  assert.ok(proof);
  const db = database.db, hash = checksum(originalRaw), text = JSON.stringify(originalRaw);
  db.prepare("INSERT INTO runs(id,trigger_type,target_id,started_at,finished_at,status,target_count) VALUES(491,'manual',?,?,?,'success',1)")
    .run(target.id, at(0), at(5000));
  db.prepare(`INSERT INTO snapshots(id,target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,source_checksum,raw_json)
    VALUES(21562,?,?,278,4922,5,'validated','available',?,?)`).run(target.id, at(1000), hash, text);
  db.prepare(`INSERT INTO audits(id,target_id,run_id,created_at,provider,status,source_checksum)
    VALUES(7911,?,491,?,'public-web','validated',?)`).run(target.id, at(4200), hash);
  db.prepare(`INSERT INTO account_events(id,target_id,run_id,event_type,event_key,observed_at,source_checksum,event_json,raw_json,created_at)
    VALUES(6,?,491,'identity',?,?,?,?,?,?)`).run(target.id, checksum([target.id, ORIGINAL, VIDEO, SEC, UID, proof.sourceMatchField]),
    proof.observedAt, hash, JSON.stringify(proof), text, at(4100));
  const originalEvent = db.prepare('SELECT * FROM account_events WHERE id=6').get();
  const calls = [], currentRaws = [];
  const provider = new PublicWebProvider({}, { database, accountBrowserFallback: false,
    execFileImpl: (_file, args, _options, callback) => {
      const operation = args[args.indexOf('--operation') + 1]; calls.push(operation);
      if (operation !== 'account') { callback(new Error('Fixture rejects extra identity-work requests')); return; }
      const current = structuredClone(raw); current.capturedAt = new Date().toISOString();
      Object.assign(current.profile.user, { follower_count: 999, total_favorited: 10000, aweme_count: 7 });
      currentRaws.push(current); callback(null, JSON.stringify({ ok: true, data: current }), '');
    }, fetchImpl: () => { throw new Error('No network in identity fixture'); } });
  return { database, db, target, calls, currentRaws, provider, originalEvent };
}

test('provider reuses original proof after exactly one fresh profile request and commits separate current evidence', async t => {
  const f = fixture(t), runId = f.database.beginRun('fixture', f.target.id, 1);
  const collection = await f.provider.collect(f.target);
  assert.deepEqual(f.calls, ['account']);
  const proof = collection.verifiedIdentity.sourceEvidenceEvent;
  assert.equal(proof.type, 'historical-source-id-verification');
  assert.equal(proof.historicalEvidence.eventId, 6);
  assert.equal(collection.snapshot.followers, 999);
  assert.equal(collection.snapshot.totalLikes, 10000);
  assert.equal(collection.snapshot.totalPosts, 7);
  assert.equal(collection.capturedAt, f.currentRaws[0].capturedAt);
  assert.equal(collection.posts.length, 0);
  assert.equal(collection.raw.sourceIdentityEvidence, undefined);
  assert.equal(collection.raw.worksCoverage, 'unavailable');
  assert.equal(proof.currentRawSha256, collection.sourceChecksum);
  assert.notEqual(proof.observedAt, proof.historicalEvidence.observedAt);
  f.database.saveCollection(f.target, runId, collection);
  assert.deepEqual(f.db.prepare('SELECT * FROM account_events WHERE id=6').get(), f.originalEvent);
  const events = f.db.prepare("SELECT * FROM account_events WHERE target_id=? AND event_type='identity' ORDER BY id").all(f.target.id);
  assert.equal(events.length, 2);
  const saved = JSON.parse(events[1].event_json);
  assert.equal(saved.type, 'historical-source-id-verification');
  assert.notEqual(events[1].event_key, f.originalEvent.event_key);
  assert.equal(events[1].run_id, runId);
  assert.equal(events[1].source_checksum, collection.sourceChecksum);
  assert.equal(checksum(JSON.parse(events[1].raw_json)), collection.sourceChecksum);
  assert.equal(events[1].event_key, checksum([f.target.id, proof.type, 6, proof.currentRawSha256]));
  assert.equal(events[1].observed_at, collection.raw.capturedAt);
  const snapshot = f.db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(f.target.id);
  assert.equal(snapshot.followers, 999);
  assert.equal(snapshot.total_likes, 10000);
  assert.equal(snapshot.total_posts, 7);
  assert.equal(snapshot.captured_at, collection.capturedAt);
  assert.equal(snapshot.source_checksum, checksum(collection.raw));
  assert.deepEqual(JSON.parse(snapshot.raw_json), f.currentRaws[0]);
  const audit = f.db.prepare('SELECT * FROM audits WHERE target_id=? AND run_id=?').get(f.target.id, runId);
  assert.equal(audit.source_checksum, snapshot.source_checksum);
  assert.ok(Date.parse(audit.created_at) >= Date.parse(snapshot.captured_at));
});

const mutations = {
  'pause after collection': f => f.db.prepare('UPDATE targets SET enabled=0 WHERE id=?').run(f.target.id),
  'source binding changed after collection': f => f.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({
    ...f.target.metadata, importSource: { ...f.target.metadata.importSource, sourceRow: 561 } }), f.target.id),
  'targetUpdate attempts to replace original source': (f, collection) => { collection.targetUpdate = { metadata: {
    ...f.target.metadata, importSource: { ...f.target.metadata.importSource, sourceRow: 561 } } }; },
  'targetUpdate attempts to pause target': (_f, collection) => { collection.targetUpdate = { enabled: false }; },
  'proof history tampered after collection': (_f, collection) => { collection.verifiedIdentity.sourceEvidenceEvent.historicalEvidence.eventId = 999; },
  'proof current time tampered after collection': (_f, collection) => { collection.verifiedIdentity.sourceEvidenceEvent.freshProfileObservedAt = '2026-01-01T00:00:00.000Z'; },
  'proof type changed to evade historical recheck': (_f, collection) => { collection.verifiedIdentity.sourceEvidenceEvent.type = 'source-id-verification'; },
  'normalized captured time no longer matches fresh raw': (_f, collection) => { collection.capturedAt = new Date(Date.now() + 3600000).toISOString(); },
  'snapshot counter changed from fresh raw': (_f, collection) => { collection.snapshot.followers = 999999; },
  'snapshot checksum changed from retained raw': (_f, collection) => { collection.sourceChecksum = 'a'.repeat(64); },
  'raw changed with matching caller-supplied hash': (_f, collection) => { collection.raw.profile.user.uid = '101115710975';
    collection.sourceChecksum = checksum(collection.raw); collection.verifiedIdentity.sourceEvidenceEvent.currentRawSha256 = collection.sourceChecksum; },
  'original event changed after collection': f => f.db.prepare("UPDATE account_events SET event_json='{}' WHERE id=6").run(),
};
for (const [name, mutate] of Object.entries(mutations)) test(`transaction rejects ${name} without persisting a new snapshot`, async t => {
  const f = fixture(t), runId = f.database.beginRun('fixture', f.target.id, 1), collection = await f.provider.collect(f.target);
  mutate(f, collection);
  const before = { snapshots: f.db.prepare('SELECT count(*) n FROM snapshots').get().n,
    events: f.db.prepare('SELECT count(*) n FROM account_events').get().n, audits: f.db.prepare('SELECT count(*) n FROM audits').get().n,
    target: f.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id),
    originalEvent: f.db.prepare('SELECT * FROM account_events WHERE id=6').get() };
  assert.throws(() => f.database.saveCollection(f.target, runId, collection));
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, before.snapshots);
  assert.equal(f.db.prepare('SELECT count(*) n FROM account_events').get().n, before.events);
  assert.equal(f.db.prepare('SELECT count(*) n FROM audits').get().n, before.audits);
  assert.deepEqual(f.db.prepare('SELECT * FROM targets WHERE id=?').get(f.target.id), before.target);
  assert.deepEqual(f.db.prepare('SELECT * FROM account_events WHERE id=6').get(), before.originalEvent);
});

test('scheduler-shaped name and identity metadata update commits while retaining the exact original source binding', async t => {
  const f = fixture(t), runId = f.database.beginRun('fixture', f.target.id, 1), collection = await f.provider.collect(f.target);
  const { aliasEvent: _alias, sourceEvidenceEvent: _source, ...identityVerification } = collection.verifiedIdentity;
  collection.targetUpdate = { label: identityVerification.nickname, metadata: { ...f.target.metadata, identityVerification,
    nameVerification: { status: 'corrected', submittedName: f.target.label, observedName: identityVerification.nickname,
      verifiedAt: identityVerification.verifiedAt, firstMismatchAt: identityVerification.verifiedAt } } };
  const schedulerTarget = { ...f.target, ...collection.targetUpdate };
  f.database.saveCollection(schedulerTarget, runId, collection);
  const saved = f.database.getTarget(f.target.id);
  assert.equal(saved.label, identityVerification.nickname);
  assert.equal(saved.metadata.nameVerification.status, 'corrected');
  assert.deepEqual(saved.metadata.importSource, f.target.metadata.importSource);
  assert.equal(saved.metadata.douyinId, ORIGINAL);
  assert.equal(saved.metadata.evidenceVideoId, VIDEO);
  assert.deepEqual(f.db.prepare('SELECT * FROM account_events WHERE id=6').get(), f.originalEvent);
  const snapshot = f.db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(f.target.id);
  assert.equal(snapshot.followers, 999);
  assert.equal(snapshot.total_likes, 10000);
  assert.equal(snapshot.total_posts, 7);
  assert.equal(snapshot.captured_at, collection.raw.capturedAt);
  assert.equal(snapshot.source_checksum, checksum(collection.raw));
  assert.deepEqual(JSON.parse(snapshot.raw_json), f.currentRaws[0]);
  const event = f.db.prepare('SELECT * FROM account_events WHERE target_id=? AND run_id=?').get(f.target.id, runId);
  assert.equal(JSON.parse(event.event_json).historicalEvidence.eventId, 6);
  assert.equal(event.source_checksum, snapshot.source_checksum);
  assert.equal(event.observed_at, snapshot.captured_at);
  assert.equal(checksum(JSON.parse(event.raw_json)), snapshot.source_checksum);
});

test('second reuse still cites the original proof; previous reuse events never become replacement roots', async t => {
  const f = fixture(t), firstRun = f.database.beginRun('fixture', f.target.id, 1);
  const first = await f.provider.collect(f.target);
  f.database.saveCollection(f.target, firstRun, first);
  f.db.prepare("UPDATE runs SET status='success',finished_at=? WHERE id=?").run(new Date().toISOString(), firstRun);
  await wait(3);
  const secondRun = f.database.beginRun('fixture', f.target.id, 1), second = await f.provider.collect(f.target);
  assert.deepEqual(f.calls, ['account', 'account']);
  assert.equal(second.verifiedIdentity.sourceEvidenceEvent.historicalEvidence.eventId, 6);
  f.database.saveCollection(f.target, secondRun, second);
  assert.equal(f.db.prepare("SELECT count(*) n FROM account_events WHERE event_type='identity'").get().n, 3);
  assert.deepEqual(f.db.prepare('SELECT * FROM account_events WHERE id=6').get(), f.originalEvent);
  f.db.prepare('DELETE FROM account_events WHERE id=6').run();
  await assert.rejects(f.provider.collect(f.target), /extra identity-work/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n, 3);
});
