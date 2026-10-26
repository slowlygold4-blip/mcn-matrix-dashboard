import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { recordWorksOnlyObservation, validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { checksum } from '../lib/utils.mjs';
import * as publicWorks from '../lib/works-observation.mjs';

const lib = new URL('../lib/', import.meta.url);
const COUNTERS = Symbol.for('works-anchor-read-reuse-independent-counts');
const BASE = Date.parse('2026-09-28T02:00:00.000Z');
const ASOF = '2026-09-28T15:59:59.999Z';
const SEC = 'MS4wLjABAAAAAnchorReadReuseIndependent12345';
const UID = '123456789';
const iso = value => new Date(value).toISOString();
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

function resetCounts() {
  return globalThis[COUNTERS] = { parses: [], hashes: [], verifies: [], objects: new WeakSet() };
}
resetCounts();

// Instrument only the current source in memory. No production database or
// backup is read. Rejection cases assert independent expected outcomes;
// public-loader equality below is an additional scoped/unscoped contract check.
// Tag actual parsed anchor objects so ledger checksums are never miscounted.
const utilsUrl = new URL('utils.mjs', lib).href;
const measuredUtils = moduleUrl(`
  import { checksum as originalChecksum } from '${utilsUrl}';
  export * from '${utilsUrl}';
  export function checksum(value) {
    const metric = globalThis[Symbol.for('works-anchor-read-reuse-independent-counts')];
    if (metric.objects.has(value)) metric.hashes.push(value.capturedAt);
    return originalChecksum(value);
  }
`);
let source = readFileSync(new URL('works-observation.mjs', lib), 'utf8');
const parseExpression = 'JSON.parse(row.anchor_raw)';
assert.equal(source.split(parseExpression).length - 1, 1, 'anchor parse instrumentation must match exactly once');
source = source.replace(parseExpression, '__parseAnchorForTest(row)');
const validationExpression = 'const evidence = validateWorksOnlyEvidence(raw, { now });';
assert.equal(source.split(validationExpression).length - 1, 1, 'ledger validation instrumentation must match exactly once');
source = source.replace(validationExpression,
  `globalThis[Symbol.for('works-anchor-read-reuse-independent-counts')].verifies.push(row.run_id);\n      ${validationExpression}`);
source += `
  function __parseAnchorForTest(row) {
    const value = JSON.parse(row.anchor_raw);
    const metric = globalThis[Symbol.for('works-anchor-read-reuse-independent-counts')];
    metric.parses.push(row.anchor_snapshot_id);
    metric.objects.add(value);
    return value;
  }
`;
const absoluteImports = (text, replacements = new Map()) => text.replace(/from (["'])(\.\.?\/[^"']+)\1/g,
  (_match, quote, path) => `from ${quote}${replacements.get(path) ?? new URL(path, lib).href}${quote}`);
const worksUrl = moduleUrl(absoluteImports(source, new Map([['./utils.mjs', measuredUtils]]))
  + '\n//# sourceURL=works-anchor-read-instrumented.mjs');
const works = await import(worksUrl);
const product = await import(moduleUrl(absoluteImports(readFileSync(new URL('product-insights.mjs', lib), 'utf8'),
  new Map([['./works-observation.mjs', worksUrl]])) + '\n//# sourceURL=works-anchor-product-instrumented.mjs'));

function fixture(t, { uid = UID, enableClock = true } = {}) {
  if (enableClock) t.mock.timers.enable({ apis: ['Date'], now: BASE });
  else t.mock.timers.setTime(BASE);
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC,
    label: '独立锚点复用回归', metadata: { platform: 'douyin' } });
  const anchorRaw = {
    capturedAt: iso(BASE), accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid, follower_count: 12, total_favorited: 33, aweme_count: 3 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false },
  };
  const profileRun = database.beginRun('manual', target.id, 1);
  database.saveCollection(target, profileRun, normalizeCollection(target, anchorRaw, { capturedAt: iso(BASE) }));
  database.finishRun(profileRun, { status: 'success', successCount: 1 });
  const anchor = db.prepare('SELECT * FROM snapshots WHERE target_id=?').get(target.id);
  const runs = [];
  const append = (at = BASE + (runs.length + 1) * 60_000) => {
    const start = iso(at), page = iso(at + 1000), end = iso(at + 2000);
    t.mock.timers.setTime(at);
    const runId = database.beginRun('works-only', target.id, 1);
    const index = runs.length + 1;
    const post = { aweme_id: String(7200000000000000000n + BigInt(index)),
      author: { sec_uid: SEC, uid }, desc: `真实入库来源 ${index}`, create_time: BASE / 1000,
      statistics: { digg_count: index + 10, comment_count: 2, share_count: 3, collect_count: 4 } };
    t.mock.timers.setTime(at + 2000);
    const saved = recordWorksOnlyObservation(db, {
      runId, targetId: target.id, anchorSnapshotId: anchor.id, anchorChecksum: anchor.source_checksum,
      requestStartedAt: start, requestFinishedAt: end,
      result: { status: 'ok', posts: [post], hasMore: false, maxCursor: 0,
        pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1,
          stopReason: 'end-of-list', errorCode: null,
          pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1,
            acceptedCount: 1, duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: page }] } },
    }, { now: at + 2000 });
    t.mock.timers.setTime(at + 2001);
    database.finishRun(runId, { status: 'success', successCount: 1 });
    runs.push(runId);
    assert.equal(saved.status, 'accepted', 'fixture starts from the genuine ingestion contract');
    return runId;
  };
  return { database, db, target, anchor, runs, append };
}

const state = f => Object.fromEntries(['snapshots', 'works_observations', 'runs', 'audits', 'targets', 'posts', 'post_metrics']
  .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
const changes = f => f.db.prepare('SELECT total_changes() n').get().n;
const scope = (f, callback, asOf = ASOF) => works.withWorksObservationRead(f.database, asOf, callback);
const selected = (reader, runId) => reader.loadVerified(null, { runIds: [runId] });

function mutateLedger(f, runId, mutate) {
  f.db.exec('DROP TRIGGER IF EXISTS works_observations_no_update');
  const row = f.db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(runId);
  const raw = JSON.parse(row.raw_json);
  mutate(raw, row);
  // These deliberately altered rows still satisfy the canonical payload
  // contract; tests therefore exercise DB/anchor binding, not malformed JSON.
  assert.deepEqual(validateWorksOnlyEvidence(raw, { now: Date.parse(ASOF) }), raw);
  f.db.prepare(`UPDATE works_observations SET raw_json=?,source_checksum=?,request_started_at=?,
    request_finished_at=?,observed_at=?,created_at=? WHERE id=?`).run(JSON.stringify(raw), checksum(raw),
    raw.requestStartedAt, raw.requestFinishedAt, raw.observedAt, row.created_at, row.id);
}

test('anchor reuse: three genuine runs share one anchor parse/hash without sharing ledger validation', t => {
  const f = fixture(t); f.append(); f.append(); f.append();
  const before = state(f), beforeChanges = changes(f);
  const expected = publicWorks.loadVerifiedWorksOnlyRows(f.db, ASOF, null, { runIds: f.runs });
  assert.equal(expected.length, 3);
  f.db.exec('PRAGMA query_only=ON');
  const metric = resetCounts();
  let escaped;
  scope(f, reader => {
    escaped = reader;
    const history = reader.loadVerified(null, { runIds: f.runs });
    assert.deepEqual(history, expected);
    assert.deepEqual(history.map(row => row.run_id), f.runs.toReversed());
    assert.deepEqual(reader.loadVerified().map(row => row.run_id), f.runs.slice(1).reverse());
    assert.equal(reader.loadObservations().get(f.target.id).sampleCount, 1);
    assert.equal(metric.parses.length, 1);
    assert.equal(metric.hashes.length, 1);
    assert.deepEqual(metric.verifies, f.runs.toReversed());
    assert.throws(() => { history[0].raw.identity.uid = '999999'; }, TypeError);
  });
  assert.throws(() => escaped.loadVerified(), /作用域已结束/);
  scope(f, reader => assert.deepEqual(reader.loadVerified(null, { runIds: f.runs }), expected));
  assert.equal(metric.parses.length, 2, 'a new scope parses the source again');
  assert.equal(metric.hashes.length, 2, 'a new scope hashes the source again');
  assert.deepEqual(state(f), before);
  assert.equal(changes(f), beforeChanges);
});

test('anchor reuse: a warm source cannot share a later audit with an earlier request', t => {
  const f = fixture(t), early = f.append(), late = f.append();
  f.db.prepare('UPDATE audits SET created_at=? WHERE source_checksum=?').run(iso(BASE + 90_000), f.anchor.source_checksum);
  const before = state(f), countBefore = changes(f);
  f.db.exec('PRAGMA query_only=ON');
  for (const reverse of [false, true]) {
    const metric = resetCounts();
    scope(f, reader => {
      if (reverse) assert.deepEqual(selected(reader, early), []);
      assert.equal(selected(reader, late)[0]?.run_id, late);
      assert.deepEqual(selected(reader, early), [], 'audit must precede this specific works request');
      assert.equal(selected(reader, late).length, 1);
    });
    assert.equal(metric.parses.length, reverse ? 2 : 1, 'failed observations cannot populate the shared success cache');
  }
  assert.deepEqual(state(f), before);
  assert.equal(changes(f), countBefore);
});

test('anchor reuse: a rehashed wrong UID cannot borrow the valid sibling identity', t => {
  const f = fixture(t), wrong = f.append(), good = f.append();
  mutateLedger(f, wrong, raw => {
    raw.identity.uid = '999999999';
    for (const post of raw.posts) post.author.uid = raw.identity.uid;
  });
  const before = state(f), countBefore = changes(f);
  f.db.exec('PRAGMA query_only=ON');
  for (const reverse of [false, true]) {
    resetCounts();
    scope(f, reader => {
      if (reverse) assert.deepEqual(selected(reader, wrong), []);
      assert.equal(selected(reader, good)[0]?.raw.identity.uid, UID);
      assert.deepEqual(selected(reader, wrong), []);
    });
  }
  assert.deepEqual(state(f), before);
  assert.equal(changes(f), countBefore);
});

test('anchor reuse: exactly eight hours remains valid and one millisecond later remains stale', t => {
  const f = fixture(t), boundary = BASE + 8 * 3600_000;
  const good = f.append(boundary), stale = f.append(boundary - 10_000);
  mutateLedger(f, stale, (raw, row) => {
    const delta = 10_001;
    for (const field of ['requestStartedAt', 'requestFinishedAt', 'observedAt']) raw[field] = iso(Date.parse(raw[field]) + delta);
    for (const page of raw.pagination.pages) page.observedAt = iso(Date.parse(page.observedAt) + delta);
    row.created_at = iso(Date.parse(row.created_at) + delta);
    const run = f.db.prepare('SELECT started_at,finished_at FROM runs WHERE id=?').get(stale);
    f.db.prepare('UPDATE runs SET started_at=?,finished_at=? WHERE id=?')
      .run(iso(Date.parse(run.started_at) + delta), iso(Date.parse(run.finished_at) + delta), stale);
  });
  const before = state(f), countBefore = changes(f);
  f.db.exec('PRAGMA query_only=ON');
  for (const reverse of [false, true]) {
    const metric = resetCounts();
    scope(f, reader => {
      if (reverse) assert.deepEqual(selected(reader, stale), []);
      assert.equal(selected(reader, good)[0]?.run_id, good);
      assert.deepEqual(selected(reader, stale), [], 'source reuse cannot waive this request’s anchor age');
    });
    assert.equal(metric.parses.length, reverse ? 2 : 1);
  }
  assert.deepEqual(state(f), before);
  assert.equal(changes(f), countBefore);
});

test('anchor reuse: identical row IDs in two databases retain independent identities and source receipts', t => {
  const first = fixture(t); first.append();
  const second = fixture(t, { uid: '987654321', enableClock: false }); second.append();
  assert.equal(first.anchor.id, second.anchor.id);
  assert.equal(first.runs[0], second.runs[0]);
  assert.notEqual(first.anchor.source_checksum, second.anchor.source_checksum);
  first.db.exec('PRAGMA query_only=ON'); second.db.exec('PRAGMA query_only=ON');
  const metric = resetCounts();
  scope(first, reader => {
    assert.equal(selected(reader, first.runs[0])[0]?.raw.identity.uid, UID);
    scope(second, otherReader => assert.equal(selected(otherReader, second.runs[0])[0]?.raw.identity.uid, '987654321'));
    assert.equal(selected(reader, first.runs[0])[0]?.raw.identity.uid, UID);
  });
  assert.equal(metric.parses.length, 2);
  assert.equal(metric.hashes.length, 2);
});

test('anchor reuse: distinct asOf cutoffs and equal-cutoff A/B responses get fresh source receipts', t => {
  const f = fixture(t); f.append(); f.append();
  f.db.exec('PRAGMA query_only=ON');
  const early = iso(BASE + 60_001), metric = resetCounts();
  scope(f, reader => assert.deepEqual(reader.loadVerified(), []), early);
  scope(f, reader => assert.equal(reader.loadVerified().length, 2));
  scope(f, reader => assert.deepEqual(reader.loadVerified(), []), early);
  assert.equal(metric.parses.length, 1, 'future-finished rows never become a source receipt at the earlier cutoff');
  resetCounts();
  const options = { period: 'custom', timeZone: 'Asia/Shanghai', startDate: '2026-09-28', endDate: '2026-09-28',
    reference: new Date('2026-09-30T12:00:00.000Z'), includeRecordedWindow: false,
    comparisonStartDate: '2026-09-28', comparisonEndDate: '2026-09-28' };
  const result = product.getProductInsights(f.database, options);
  assert.deepEqual(result.summary, result.comparison.summary);
  assert.equal(result.summary.collectionCoverage.works.limited, 1);
  assert.equal(globalThis[COUNTERS].parses.length, 2, 'A and B remain separate source validation scopes');
  assert.equal(globalThis[COUNTERS].hashes.length, 2);
});

test('anchor reuse: a same-connection anchor mutation and rollback invalidates the warmed scope', t => {
  const f = fixture(t); f.append(); f.append();
  const before = state(f);
  resetCounts();
  let escaped;
  assert.throws(() => scope(f, reader => {
    escaped = reader;
    assert.equal(selected(reader, f.runs[0]).length, 1);
    f.db.exec('SAVEPOINT anchor_mutation_probe');
    f.db.prepare('UPDATE snapshots SET raw_json=? WHERE id=?').run('{}', f.anchor.id);
    f.db.exec('ROLLBACK TO anchor_mutation_probe; RELEASE anchor_mutation_probe');
    assert.throws(() => selected(reader, f.runs[1]), /数据库已变更/);
  }), /数据库已变更/);
  assert.deepEqual(state(f), before);
  assert.throws(() => escaped.loadObservations(), /作用域已结束/);
  const metric = resetCounts();
  scope(f, reader => assert.equal(reader.loadVerified().length, 2));
  assert.equal(metric.parses.length, 1);
  assert.equal(metric.hashes.length, 1);
});

test('anchor reuse: a later request rechecks tampered source JSON instead of trusting its unchanged stored hash', t => {
  const f = fixture(t); f.append(); f.append();
  const original = state(f), metric = resetCounts();
  scope(f, reader => assert.equal(reader.loadVerified().length, 2));
  const altered = JSON.parse(f.anchor.raw_json);
  altered.profile.user.follower_count += 1;
  f.db.prepare('UPDATE snapshots SET raw_json=? WHERE id=?').run(JSON.stringify(altered), f.anchor.id);
  const tampered = state(f), tamperedChanges = changes(f);
  scope(f, reader => {
    assert.deepEqual(selected(reader, f.runs[0]), []);
    assert.deepEqual(selected(reader, f.runs[1]), []);
  });
  assert.equal(metric.parses.length, 3, 'both failed rows reparse; failed checksum results are not success receipts');
  assert.equal(metric.hashes.length, 3);
  assert.deepEqual(state(f), tampered);
  assert.equal(changes(f), tamperedChanges);
  f.db.prepare('UPDATE snapshots SET raw_json=? WHERE id=?').run(f.anchor.raw_json, f.anchor.id);
  scope(f, reader => assert.equal(reader.loadVerified().length, 2));
  assert.equal(metric.parses.length, 4, 'restored source is verified again in its own request');
  assert.equal(metric.hashes.length, 4);
  assert.deepEqual(state(f), original);
});
