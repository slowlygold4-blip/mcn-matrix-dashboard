import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection, normalizePost } from '../lib/providers/normalize.mjs';
import { recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { persistPosts } from '../lib/post-persistence.mjs';

const root = new URL('../', import.meta.url);
const lib = new URL('lib/', root);
const SEC = 'MS4wLjABAAAAWorksReadReuseCounts123456789', UID = '123456789';
const ANCHOR = '2026-09-28T02:50:00.000Z', ASOF = '2026-09-28T15:59:59.999Z';
const options = { period: 'custom', timeZone: 'Asia/Shanghai', startDate: '2026-09-28',
  endDate: '2026-09-28', reference: new Date('2026-09-30T12:00:00.000Z'), includeRecordedWindow: false };
const counts = new Map();
globalThis[Symbol.for('works-read-reuse-test-counts')] = counts;

function absoluteImports(source, replacements = new Map()) {
  return source.replace(/from (["'])(\.\.?\/[^"']+)\1/g, (match, quote, path) =>
    `from ${quote}${replacements.get(path) ?? new URL(path, lib).href}${quote}`);
}
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

async function implementation(directory, key, { uncached = false } = {}) {
  let source = readFileSync(new URL('works-observation.mjs', directory), 'utf8');
  const parseExpression = 'JSON.parse(row.raw_json)';
  assert.equal(source.split(parseExpression).length - 1, 1, 'expected one ledger parsing site');
  source = source.replace(parseExpression,
    `(globalThis[Symbol.for('works-read-reuse-test-counts')].get('${key}').parses.push(row.run_id), ${parseExpression})`);
  source = source.replace('const evidence = validateWorksOnlyEvidence(raw, { now });',
    `globalThis[Symbol.for('works-read-reuse-test-counts')].get('${key}').verifies.push(row.run_id);
      const evidence = validateWorksOnlyEvidence(raw, { now });`);
  // Compare the same public implementation with source reuse disabled. A clean
  // checkout must not require a private historical backup or freeze unrelated
  // report fields at an older schema. Source validation still runs each time.
  if (uncached) {
    const shared = 'return loadVerifiedWorksOnlyRowsInRead(db, asOf, targetId, options, receipt);';
    assert.equal(source.split(shared).length - 1, 1, 'expected one scoped reader');
    source = source.replace(shared, 'return loadVerifiedWorksOnlyRowsInRead(db, asOf, targetId, options, null);');
  }
  const worksUrl = moduleUrl(absoluteImports(source));
  const works = await import(worksUrl);
  const productSource = absoluteImports(readFileSync(new URL('product-insights.mjs', directory), 'utf8'),
    new Map([['./works-observation.mjs', worksUrl]]));
  const product = await import(moduleUrl(productSource));
  return { works, product, key };
}

const original = await implementation(lib, 'original', { uncached: true });
const candidate = await implementation(lib, 'candidate');

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC,
    label: '隔离作品验证计数', boards: ['隔离板块'], metadata: { platform: 'douyin' } });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 3 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
      accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const profileRun = database.beginRun('manual', target.id, 1);
  database.saveCollection(target, profileRun, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  database.finishRun(profileRun, { status: 'success', successCount: 1 });
  const anchor = database.db.prepare('SELECT * FROM snapshots WHERE target_id=?').get(target.id);
  const runs = [], posts = [];
  for (let index = 0; index < 3; index++) {
    const start = `2026-09-28T03:0${index}:01.000Z`, page = `2026-09-28T03:0${index}:02.000Z`, end = `2026-09-28T03:0${index}:03.000Z`;
    const post = { aweme_id: String(7200000000000000001n + BigInt(index)), author: { sec_uid: SEC, uid: UID },
      desc: `当时标题 ${index}`, create_time: Date.parse('2026-09-28T02:00:00.000Z') / 1000,
      statistics: { digg_count: index + 10, comment_count: 2, share_count: 3, collect_count: 4, play_count: 100 } };
    t.mock.timers.setTime(Date.parse(start));
    const runId = database.beginRun('works-only', target.id, 1);
    t.mock.timers.setTime(Date.parse(end));
    recordWorksOnlyObservation(database.db, { runId, targetId: target.id, anchorSnapshotId: anchor.id,
      anchorChecksum: anchor.source_checksum, requestStartedAt: start, requestFinishedAt: end,
      result: { status: 'ok', posts: [post], hasMore: false, maxCursor: 0,
        pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
          pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
            duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: page }] } } }, { now: Date.now() });
    t.mock.timers.setTime(Date.parse(end) + 1);
    database.finishRun(runId, { status: 'success', successCount: 1 });
    runs.push(runId); posts.push(normalizePost(post));
  }
  persistPosts(database.db, { target, posts: posts.map(post => ({ ...post, caption: '之后标题', likes: 99 })),
    capturedAt: '2026-09-29T03:00:00.000Z' });
  return { database, target, runs };
}

function measured(impl, database, read) {
  const metric = { parses: [], verifies: [], selections: [] };
  counts.set(impl.key, metric);
  const native = database.db;
  const wrapped = new Proxy(native, { get(db, name) {
    if (name !== 'prepare') return typeof db[name] === 'function' ? db[name].bind(db) : db[name];
    return sql => {
      const statement = native.prepare(sql);
      return new Proxy(statement, { get(value, method) {
        if (method !== 'all') return typeof value[method] === 'function' ? value[method].bind(value) : value[method];
        return (...args) => {
          const rows = statement.all(...args);
          if (sql.includes('anchor_audited')) metric.selections.push(rows.filter(row => row.selected_row).map(row => row.run_id));
          return rows;
        };
      } });
    };
  } });
  const facade = new Proxy(database, { get(value, name) { return name === 'db' ? wrapped : Reflect.get(value, name); } });
  return { result: read(facade), metric };
}

test('uncached same-version reader repeats exact historical source parsing and validation', t => {
  const { database, runs } = fixture(t);
  const { result, metric } = measured(original, database, db => original.product.getProductInsights(db, options));
  assert.deepEqual(metric.selections, [runs.slice().reverse(), runs.slice(1).reverse()]);
  assert.deepEqual(metric.parses, [...runs.slice().reverse(), ...runs.slice(1).reverse()]);
  assert.deepEqual(metric.verifies, metric.parses);
  assert.equal(result.summary.publishedSamples.value, 3);
});

test('loadData shares real receipts within one snapshot and matches same-version uncached output', t => {
  const { database, runs } = fixture(t);
  const before = database.db.prepare('SELECT total_changes() AS n').get().n;
  database.db.exec('PRAGMA query_only=ON');
  const expected = measured(original, database, db => original.product.getProductInsights(db, options));
  const actual = measured(candidate, database, db => candidate.product.getProductInsights(db, options));
  assert.deepEqual(actual.result, expected.result);
  assert.deepEqual(actual.metric.selections, expected.metric.selections, 'both SQL selections retain their exact window semantics');
  assert.deepEqual(actual.metric.parses, runs.slice().reverse());
  assert.deepEqual(actual.metric.verifies, actual.metric.parses);
  assert.equal(expected.metric.verifies.length, 5);
  assert.equal(actual.metric.verifies.length, 3);
  const again = measured(candidate, database, db => candidate.product.getProductInsights(db, options));
  assert.deepEqual(again.result, expected.result);
  assert.deepEqual(again.metric.verifies, actual.metric.verifies, 'a new request revalidates every source');
  assert.equal(database.db.prepare('SELECT total_changes() AS n').get().n, before);
});

test('A/B comparison creates independent receipts even when both periods have the same cutoff', t => {
  const { database, runs } = fixture(t);
  const comparisonOptions = { ...options, comparisonStartDate: '2026-09-28', comparisonEndDate: '2026-09-28' };
  const expected = measured(original, database, db => original.product.getProductInsights(db, comparisonOptions));
  const actual = measured(candidate, database, db => candidate.product.getProductInsights(db, comparisonOptions));
  assert.deepEqual(actual.result, expected.result);
  assert.equal(actual.metric.selections.length, 4);
  assert.deepEqual(actual.metric.verifies, [...runs.slice().reverse(), ...runs.slice().reverse()]);
  assert.equal(expected.metric.verifies.length, 10);
});

test('scope reader closures expire, reject async, and reject same-connection writes even after rollback', t => {
  const { database, target, runs } = fixture(t);
  let retained;
  assert.throws(() => measured(candidate, database, db => candidate.works.withWorksObservationRead(db, ASOF, readers => {
    retained = readers;
    const first = readers.loadVerified(target.id, { runIds: [runs[2]] });
    assert.equal(first.length, 1);
    assert.throws(() => { first[0].raw.identity.secUid = `${SEC}Forged`; }, TypeError);
    database.db.exec('SAVEPOINT rollback_probe');
    database.db.prepare('UPDATE targets SET locator=? WHERE id=?').run(`${SEC}Changed`, target.id);
    assert.throws(() => readers.loadVerified(target.id, { runIds: [runs[2]] }), /数据库已变更/);
    database.db.exec('ROLLBACK TO rollback_probe; RELEASE rollback_probe');
    assert.throws(() => readers.loadVerified(target.id, { runIds: [runs[2]] }), /数据库已变更/);
  })), /数据库已变更/);
  assert.throws(() => retained.loadVerified(), /读取作用域已结束/);
  assert.throws(() => retained.loadObservations(), /读取作用域已结束/);
  assert.throws(() => candidate.works.withWorksObservationRead(database, ASOF, () => ({ then() {} })), /只支持同步/);
  assert.doesNotThrow(() => database.db.exec('SAVEPOINT scope_cleanup_probe; RELEASE scope_cleanup_probe'));
});

test('external postsAsOf keeps its original shape and behavior without accepting trusted rows', t => {
  const { database, target } = fixture(t);
  const rows = database.db.prepare(`SELECT p.*,pm.captured_at metric_at,pm.likes,pm.comments,pm.shares,pm.collects,pm.plays
    FROM posts p JOIN post_metrics pm ON pm.post_id=p.id WHERE pm.captured_at<'2026-09-29' ORDER BY p.id`).all();
  const expected = measured(original, database, db => original.product.postsAsOf(db, rows, ASOF, [target]));
  const actual = measured(candidate, database, db => candidate.product.postsAsOf(db, rows, ASOF, [target],
    { verified: true, trustedRows: [], forceRecovery: false }));
  assert.deepEqual(actual.result, expected.result);
  assert.deepEqual(actual.metric.verifies, expected.metric.verifies);
  assert.equal(actual.result[0].caption, '当时标题 0');
  const unchanged = [];
  assert.strictEqual(candidate.product.postsAsOf(database, unchanged, ASOF, [target]), unchanged);
});
