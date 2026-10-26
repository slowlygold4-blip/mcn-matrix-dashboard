import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorDatabase } from '../lib/database.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { MonitorScheduler } from '../lib/scheduler.mjs';
import { getAccountInsight } from '../lib/product-insights.mjs';
import { checksum, localDateKey } from '../lib/utils.mjs';

const SEC_UID = 'MS4wLjABAAAAintegrationKnownCanonicalId12345';
const UID = '222523170759696';
const ORIGINAL_ID = 'Original_Account';
const ORIGINAL_NAME = '原表作者';

function fixture(t, metadata = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'account-events-integration-'));
  const database = new MonitorDatabase(join(directory, 'test.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = database.createTarget({
    type: 'account', provider: 'public-web', locator: SEC_UID, label: ORIGINAL_NAME,
    metadata: {
      platform: 'douyin', douyinId: ORIGINAL_ID, submittedName: ORIGINAL_NAME,
      importSource: { authorName: ORIGINAL_NAME, sourceRow: 37, fileName: '隔离测试来源.xlsx' },
      ...metadata,
    },
  });
  return { database, target };
}

function profile({
  publicId = ORIGINAL_ID, nickname = ORIGINAL_NAME,
  capturedAt = new Date().toISOString(), followers = 15234, likes = 25987, posts = 31,
} = {}) {
  const author = { sec_uid: SEC_UID, uid: UID, unique_id: publicId, short_id: '0', nickname };
  return {
    capturedAt,
    profile: { user: { ...author, follower_count: followers, total_favorited: likes, aweme_count: posts } },
    profileResponse: { status_code: 0, user: { ...author, follower_count: followers, total_favorited: likes, aweme_count: posts } },
    works: { aweme_list: [{
      aweme_id: '7771234567890123456', author, desc: '隔离测试作品', create_time: 1789200000,
      statistics: { digg_count: 123, comment_count: 5, share_count: 2, collect_count: 1 },
    }], has_more: 0 },
    provenance: {
      mode: 'guest-ttwid-unsigned-profile-a-bogus-posts', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', runtimeAI: false, paidAPI: false, cookiePersisted: false,
    },
  };
}

function deletedProfile() {
  const raw = profile({ followers: 0, likes: 0, posts: 0 });
  raw.accountStatus = 'unavailable';
  raw.worksCoverage = 'not-applicable';
  raw.profile = { user: { uid: UID, nickname: '', follower_count: 0, total_favorited: 0, aweme_count: 0 } };
  raw.profileResponse = { status_code: 0, user: {
    uid: UID, nickname: '', user_deleted: true,
    special_state_info: { special_state: 1, title: '账号已经注销', content: '用户已将自己账号注销，所属内容已无法查看' },
  } };
  raw.provenance.mode = 'guest-ttwid-unsigned-profile-lifecycle';
  // Even if an envelope contains leftover works, the lifecycle branch must not normalize them.
  return raw;
}

function mockedTransport(raw, beforeReply) {
  const calls = [];
  return {
    calls,
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args: [...args] });
      assert.equal(args[args.indexOf('--operation') + 1], 'account');
      assert.equal(args[args.indexOf('--locator') + 1], SEC_UID);
      beforeReply?.();
      callback(null, JSON.stringify({ ok: true, data: raw }), '');
    },
    fetchImpl() { throw new Error('Unexpected network access in isolated integration test'); },
    cooldownMs: 0,
  };
}

async function collect(database, target, raw) {
  const transport = mockedTransport(raw);
  const provider = new PublicWebProvider(database.getSettings(), { ...transport, database });
  const result = await provider.collect(target);
  assert.equal(transport.calls.length, 1, 'exactly one mocked collector call, no browser fallback');
  return result;
}

async function seedHistory(database, target) {
  const raw = profile({ capturedAt: new Date(Date.now() - 86_400_000).toISOString() });
  const collection = await collect(database, target, raw);
  const runId = database.beginRun('fixture', target.id, 1);
  database.saveCollection(target, runId, collection);
  database.finishRun(runId, { status: 'success', successCount: 1, processedCount: 1 });
  return raw;
}

function storedData(database) {
  return Object.fromEntries(['snapshots', 'posts', 'post_metrics', 'account_events']
    .map((table) => [table, database.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function transactionState(database) {
  return {
    ...storedData(database),
    targets: database.db.prepare('SELECT * FROM targets ORDER BY id').all(),
    audits: database.db.prepare('SELECT * FROM audits ORDER BY id').all(),
  };
}

function rejectEvents(database) {
  database.db.exec(`CREATE TRIGGER reject_fixture_event BEFORE INSERT ON account_events
    BEGIN SELECT RAISE(ABORT, 'fixture-event-write-failure'); END`);
}

test('public lifecycle pipeline records exact raw evidence without snapshots, works, metrics or enablement changes', async (t) => {
  const { database, target } = fixture(t);
  await seedHistory(database, target);
  const previous = storedData(database);
  const metadata = database.db.prepare('SELECT metadata_json FROM targets WHERE id=?').get(target.id).metadata_json;
  const raw = deletedProfile();
  const collection = await collect(database, database.getTarget(target.id), raw);
  assert.equal(collection.lifecycle.state, 'deleted');
  assert.equal(collection.snapshot, undefined);
  assert.equal(collection.verifiedIdentity, undefined);
  assert.deepEqual(collection.posts, []);
  assert.equal(collection.sourceChecksum, checksum(raw));
  const runId = database.beginRun('fixture', target.id, 1);
  database.recordAccountLifecycle(target, runId, collection.lifecycle, collection.raw);
  const saved = storedData(database);
  for (const table of ['snapshots', 'posts', 'post_metrics']) assert.deepEqual(saved[table], previous[table]);
  assert.equal(saved.account_events.length, 1);
  const event = saved.account_events[0];
  assert.equal(event.target_id, target.id);
  assert.equal(event.run_id, runId);
  assert.equal(event.event_type, 'lifecycle');
  assert.equal(event.source_checksum, checksum(raw));
  assert.deepEqual(JSON.parse(event.raw_json), raw);
  assert.deepEqual(JSON.parse(event.event_json), collection.lifecycle);
  assert.equal(event.observed_at, collection.lifecycle.observedAt);
  assert.equal(database.getTarget(target.id).enabled, true);
  assert.equal(database.db.prepare('SELECT metadata_json FROM targets WHERE id=?').get(target.id).metadata_json, metadata);
  const audit = database.db.prepare('SELECT * FROM audits WHERE run_id=?').get(runId);
  assert.equal(audit.source_checksum, event.source_checksum);
  assert.equal(audit.normalized_post_count, 0);
  assert.match(audit.message, /已注销/);
});

test('scheduler treats official deletion as inactive, preserves old data and does not retry it again that day', async (t) => {
  const { database, target } = fixture(t);
  await seedHistory(database, target);
  const previous = storedData(database);
  const transport = mockedTransport(deletedProfile());
  const scheduler = new MonitorScheduler(database, { providerOptions: transport });
  const result = await scheduler.runAll({ triggerType: 'scheduled' });
  assert.equal(transport.calls.length, 1);
  assert.equal(result.errorCount, 0);
  assert.equal(result.successCount, 0, 'an inactive account is not a successful metrics collection');
  assert.equal(result.skippedCount, 1);
  assert.equal(result.details[0].status, 'inactive');
  const saved = storedData(database);
  for (const table of ['snapshots', 'posts', 'post_metrics']) assert.deepEqual(saved[table], previous[table]);
  assert.equal(saved.account_events.length, 1);
  const plan = scheduler.scheduledPlanSummary(localDateKey());
  assert.equal(plan.inactiveCount, 1);
  assert.equal(plan.pendingCount, 0);
  assert.equal(plan.manualCount, 0);
  assert.equal(plan.completedCount, 0);
  assert.deepEqual(scheduler.scheduledDueTargetIds(localDateKey(), new Date(Date.now() + 60_000)), []);
  const tomorrow = new Date(Date.now() + 86_400_000);
  assert.deepEqual(scheduler.scheduledDueTargetIds(localDateKey(tomorrow), tomorrow), [target.id]);
  assert.equal(database.getTarget(target.id).enabled, true);
});

test('a subsequent verified public profile reactivates the account while retaining the deletion event and original identity', async (t) => {
  const { database, target } = fixture(t);
  await seedHistory(database, target);
  const originalMetadata = structuredClone(database.getTarget(target.id).metadata);
  const deletedScheduler = new MonitorScheduler(database, { providerOptions: mockedTransport(deletedProfile()) });
  await deletedScheduler.runAll({ triggerType: 'scheduled' });
  const oldEvent = database.db.prepare('SELECT * FROM account_events').get();
  const raw = profile({ followers: 15280, likes: 26030 });
  const scheduler = new MonitorScheduler(database, { providerOptions: mockedTransport(raw) });
  const result = await scheduler.runAll({ targetId: target.id });
  assert.equal(result.successCount, 1);
  assert.equal(result.errorCount, 0);
  const events = database.db.prepare('SELECT * FROM account_events ORDER BY id').all();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], oldEvent);
  assert.equal(JSON.parse(events[1].event_json).state, 'active');
  assert.equal(JSON.parse(events[1].event_json).identityVerified, true);
  assert.equal(events[1].source_checksum, checksum(raw));
  assert.deepEqual(JSON.parse(events[1].raw_json), raw);
  const snapshots = database.db.prepare('SELECT * FROM snapshots ORDER BY id').all();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].followers, 15234);
  assert.equal(snapshots[1].followers, 15280);
  const current = database.getTarget(target.id);
  assert.equal(current.enabled, true);
  assert.equal(current.metadata.douyinId, originalMetadata.douyinId);
  assert.equal(current.metadata.submittedName, originalMetadata.submittedName);
  assert.deepEqual(current.metadata.importSource, originalMetadata.importSource);
  const detail = getAccountInsight(database, target.id);
  assert.equal(detail.account.lifecycle.state, 'active');
  assert.notEqual(detail.account.status.key, 'deleted');
});

test('verified alias event persists the complete old and new proof without overwriting original metadata', async (t) => {
  const { database, target } = fixture(t);
  const oldRaw = await seedHistory(database, target);
  const original = database.db.prepare('SELECT metadata_json FROM targets WHERE id=?').get(target.id).metadata_json;
  const raw = profile({ publicId: 'New_public_id', nickname: '公开新昵称' });
  const collection = await collect(database, database.getTarget(target.id), raw);
  const alias = collection.verifiedIdentity.aliasEvent;
  assert.equal(alias.submittedAccountId, ORIGINAL_ID);
  assert.equal(alias.currentPublicAccountId, 'New_public_id');
  assert.equal(alias.priorSourceChecksum, checksum(oldRaw));
  assert.equal(alias.currentRawSha256, checksum(raw));
  const runId = database.beginRun('fixture', target.id, 1);
  database.saveCollection(target, runId, collection);
  const event = database.db.prepare("SELECT * FROM account_events WHERE event_type='alias'").get();
  assert.equal(event.target_id, target.id);
  assert.equal(event.run_id, runId);
  assert.deepEqual(JSON.parse(event.event_json), alias);
  assert.deepEqual(JSON.parse(event.raw_json), raw);
  assert.equal(event.source_checksum, checksum(raw));
  assert.equal(database.db.prepare('SELECT metadata_json FROM targets WHERE id=?').get(target.id).metadata_json, original);
  assert.equal(database.getTarget(target.id).locator, SEC_UID);
  assert.equal(database.getTarget(target.id).enabled, true);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 2);
});

test('mutable metadata cannot forge lifecycle state or alias history in the provider or product response', async (t) => {
  const forged = { state: 'deleted', observedAt: new Date().toISOString(), sourceChecksum: 'fabricated' };
  const { database, target } = fixture(t, {
    lifecycle: forged, accountLifecycle: forged,
    identityAliases: [{ type: 'douyin-account-alias-change', currentPublicAccountId: 'fake-new-id' }],
  });
  const raw = profile();
  const scheduler = new MonitorScheduler(database, { providerOptions: mockedTransport(raw) });
  const result = await scheduler.runAll({ targetId: target.id });
  assert.equal(result.successCount, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM account_events').get().n, 0);
  const detail = getAccountInsight(database, target.id);
  assert.equal(detail.account.lifecycle, null);
  assert.deepEqual(detail.account.identityAliases, []);
  assert.notEqual(detail.account.status.key, 'deleted');
  assert.equal(detail.account.metrics.followers.value, 15234);
  const incomplete = deletedProfile();
  delete incomplete.profileResponse;
  await assert.rejects(collect(database, database.getTarget(target.id), incomplete), /未回显|校验/);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM account_events').get().n, 0);
});

test('pausing inflight discards both metric and deletion results without changing the prior data or status', async (t) => {
  for (const state of ['available', 'deleted']) await t.test(state, async (subtest) => {
    const { database, target } = fixture(subtest);
    await seedHistory(database, target);
    const previous = storedData(database);
    const auditCount = database.db.prepare('SELECT COUNT(*) AS n FROM audits').get().n;
    let paused;
    const transport = mockedTransport(state === 'deleted' ? deletedProfile() : profile(), () => {
      database.updateTarget(target.id, { enabled: false });
      paused = database.getTarget(target.id);
    });
    const scheduler = new MonitorScheduler(database, { providerOptions: transport });
    const result = await scheduler.runAll({ targetId: target.id });
    assert.equal(result.skippedCount, 1);
    assert.equal(result.errorCount, 0);
    assert.deepEqual(storedData(database), previous);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM audits').get().n, auditCount);
    const current = database.getTarget(target.id);
    assert.equal(current.enabled, false);
    assert.equal(current.last_checked_at, paused.last_checked_at);
    assert.equal(current.last_status, paused.last_status);
    assert.deepEqual(current.metadata, paused.metadata);
  });
});

test('database refuses a lifecycle result paused before persistence and rejects a tampered raw checksum', async (t) => {
  const { database, target } = fixture(t);
  const collection = await collect(database, target, deletedProfile());
  const runId = database.beginRun('fixture', target.id, 1);
  database.updateTarget(target.id, { enabled: false });
  const paused = transactionState(database);
  assert.throws(() => database.recordAccountLifecycle(target, runId, collection.lifecycle, collection.raw), /已暂停/);
  assert.deepEqual(transactionState(database), paused);
  database.updateTarget(target.id, { enabled: true });
  const enabled = transactionState(database);
  assert.throws(() => database.recordAccountLifecycle(target, runId, collection.lifecycle,
    { ...collection.raw, injected: 'tampered' }), /证据校验失败/);
  assert.deepEqual(transactionState(database), enabled);
});

test('event insert failures roll back lifecycle and alias transactions including target identity updates', async (t) => {
  for (const kind of ['lifecycle', 'alias']) await t.test(kind, async (subtest) => {
    const { database, target } = fixture(subtest);
    await seedHistory(database, target);
    const collection = await collect(database, database.getTarget(target.id),
      kind === 'lifecycle' ? deletedProfile() : profile({ publicId: 'New_public_id', nickname: '新名字' }));
    if (kind === 'alias') collection.targetUpdate = {
      label: '新名字', metadata: { ...database.getTarget(target.id).metadata, identityVerification: collection.verifiedIdentity },
    };
    const runId = database.beginRun('fixture', target.id, 1);
    rejectEvents(database);
    const previous = transactionState(database);
    assert.throws(() => kind === 'lifecycle'
      ? database.recordAccountLifecycle(target, runId, collection.lifecycle, collection.raw)
      : database.saveCollection(target, runId, collection), /fixture-event-write-failure/);
    assert.deepEqual(transactionState(database), previous);
  });
});

test('scheduler event failure cannot leak a renamed target or new identity, snapshot or work metrics', async (t) => {
  const { database, target } = fixture(t);
  await seedHistory(database, target);
  const previous = storedData(database);
  const original = database.getTarget(target.id);
  rejectEvents(database);
  const scheduler = new MonitorScheduler(database, {
    providerOptions: mockedTransport(profile({ publicId: 'New_public_id', nickname: '不得残留的新名字' })),
  });
  const result = await scheduler.runAll({ targetId: target.id });
  assert.equal(result.errorCount, 1);
  assert.equal(result.successCount, 0);
  assert.match(result.details[0].message, /fixture-event-write-failure/);
  assert.deepEqual(storedData(database), previous);
  const current = database.getTarget(target.id);
  assert.equal(current.label, original.label);
  assert.equal(current.enabled, original.enabled);
  assert.equal(current.locator, original.locator);
  assert.deepEqual(current.metadata, original.metadata);
  const failure = database.db.prepare('SELECT * FROM audits ORDER BY id DESC LIMIT 1').get();
  assert.equal(failure.status, 'rejected');
  assert.match(failure.message, /fixture-event-write-failure/);
});
