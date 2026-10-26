// Independent actual reader/immutable owner regression tests, fully offline.
// Clock ordering represents delayed persistence of an already observed page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as consoleModel from '../public/console-model.js';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { recordWorksOnlyObservation, readWorksOnlyAnchor } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows, loadWorksObservations } from '../lib/works-observation.mjs';
import { getAccountInsight, getProductInsights } from '../lib/product-insights.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { checksum } from '../lib/utils.mjs';

const SEC = 'MS4wLjABAAAAHistoryPhase74PeerAuthor1234', UID = '123456789012';
const ID = '7300000000000000001';
const ANCHOR = '2026-10-01T13:30:00.000Z', OLD_START = '2026-10-01T14:30:00.000Z';
const OLD_PAGE = '2026-10-01T14:30:01.000Z', OLD_END = '2026-10-01T14:30:02.000Z';
const NEW_START = '2026-10-01T16:30:00.000Z', NEW_PAGE = '2026-10-01T16:30:01.000Z', NEW_END = '2026-10-01T16:30:02.000Z';
const ASOF = '2026-10-01T15:30:00.000Z', NEW_ASOF = '2026-10-01T17:30:00.000Z';
const options = reference => ({ reference, period: 'day', timeZone: 'Asia/Shanghai', includeRecordedWindow: false });

function fixture(t, { old = true, hasMore = false, empty = false, failed = false, repeated = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC,
    label: '离线延迟作品观察', metadata: { platform: 'douyin' } });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 20 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred',
    works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid',
      cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const profileRun = database.beginRun('manual', target.id, 1);
  database.saveCollection(target, profileRun, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  database.finishRun(profileRun, { status: 'success', processedCount: 1, successCount: 1 });
  const anchor = readWorksOnlyAnchor(db, target.id, { now: Date.parse(OLD_START) });
  function append({ start, page, end, likes, caption, postId = ID, more = false, isEmpty = false, isFailed = false, repeat = false, finish = true }) {
    t.mock.timers.setTime(Date.parse(start)); const runId = database.beginRun('works-only', target.id, 1);
    const posts = isEmpty ? [] : [{ aweme_id: postId, author: { sec_uid: SEC, uid: UID },
      statistics: { digg_count: likes }, desc: caption, create_time: Date.parse(ANCHOR) / 1000 }];
    const input = { targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId, anchorChecksum: anchor.sourceChecksum,
      requestStartedAt: start, requestFinishedAt: end, requestedLimit: 30,
      result: isFailed ? { status: 'unavailable', posts: [], errorCode: 'blocked' } : {
        status: 'ok', posts, hasMore: more, maxCursor: more && !repeat ? 1749305973000 : 0,
        errorCode: more && !repeat ? 'collector_error' : null,
        pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: posts.length,
          stopReason: repeat ? 'cursor-not-progressing' : more ? 'page-timeout' : 'end-of-list',
          errorCode: more && !repeat ? 'collector_error' : null,
          pages: [{ requestCursor: 0, response: { has_more: more, max_cursor: more && !repeat ? 1749305973000 : 0 },
            rawCount: posts.length, acceptedCount: posts.length, filteredCount: 0, duplicateCount: 0,
            truncated: false, observedAt: page }] } } };
    t.mock.timers.setTime(Date.parse(end));
    const saved = recordWorksOnlyObservation(db, input, { now: Date.now() });
    if (finish) { t.mock.timers.setTime(Date.parse(end) + 1); database.finishRun(runId,
      { status: isFailed ? 'error' : more ? 'partial' : 'success', processedCount: 1,
        successCount: isFailed ? 0 : 1, errorCount: isFailed ? 1 : 0 }); }
    return { input, saved };
  }
  const newest = append({ start: NEW_START, page: NEW_PAGE, end: NEW_END, likes: 91, caption: 'FUTURE_TITLE_MUST_NOT_LEAK' });
  // Mutable latest metadata can differ; the old canonical source supplies URL.
  db.prepare('UPDATE posts SET url=? WHERE external_id=?').run('https://future.invalid/late-edited-url', ID);
  const historical = old ? append({ start: OLD_START, page: OLD_PAGE, end: OLD_END, likes: 7,
    caption: '旧观察中的原始标题', more: hasMore || repeated, isEmpty: empty, isFailed: failed, repeat: repeated }) : null;
  const inspect = (reference = ASOF) => getAccountInsight(database, target.id, options(reference));
  const overview = (reference = ASOF) => getProductInsights(database, options(reference));
  const history = (opts = {}) => getAccountHistory(database, target.id, { asOf: ASOF, ...opts });
  t.mock.timers.setTime(Date.parse(NEW_ASOF));
  return { database, db, target, anchor, newest, historical, inspect, overview, history, append };
}
function protectedState(db) {
  return JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'audits', 'posts', 'post_metrics', 'works_observations', 'runs']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
}
function readonly(f) { const before = protectedState(f.db); f.db.exec('PRAGMA query_only=ON'); return before; }
function assertOld(f) {
  const detail = f.inspect();
  assert.equal(detail.recentWorks.length, 1, 'a source-bound older metric is not gated by later first_seen');
  const work = detail.recentWorks[0];
  assert.equal(work.externalId, ID); assert.equal(work.likes, 7); assert.equal(work.caption, '旧观察中的原始标题');
  assert.equal(work.url, `https://www.douyin.com/video/${ID}`); assert.equal(work.publishedAt, ANCHOR);
  assert.equal(work.lastObservedAt, OLD_PAGE); assert.equal(work.plays, null);
  assert.doesNotMatch(JSON.stringify(detail.recentWorks), /FUTURE_TITLE_MUST_NOT_LEAK|future\.invalid|91/);
  return detail;
}
function appendOldSnapshot(f) {
  const raw = { capturedAt: OLD_PAGE, accountStatus: 'validated', worksCoverage: 'limited',
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 20 } },
    works: { aweme_list: [{ aweme_id: ID, author: { sec_uid: SEC, uid: UID }, desc: '旧观察中的原始标题',
      create_time: Date.parse(ANCHOR) / 1000, statistics: { digg_count: 7 } }] } };
  f.database.saveCollection(f.target, null, normalizeCollection(f.target, raw, { capturedAt: OLD_PAGE }));
  return Number(f.db.prepare('SELECT MAX(id) id FROM snapshots').get().id);
}

test('phase74 actual detail recovers older source-bound page while preserving all stored first/latest rows', t => {
  const f = fixture(t);
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF, f.target.id, { runId: f.historical.input.runId }).length, 1);
  assert.equal(f.db.prepare('SELECT first_seen_at,last_seen_at FROM posts').get().first_seen_at, NEW_PAGE);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 2);
  const before = readonly(f); assertOld(f); assert.equal(protectedState(f.db), before);
});
test('phase74 actual overview publication evidence includes the old observation, not future metadata', t => {
  const f = fixture(t); const before = readonly(f); const view = f.overview();
  assert.equal(view.summary.publishedSamples.value, 1);
  assert.equal(view.accounts[0].publishedSamples.value, 1);
  assert.equal(protectedState(f.db), before);
});
test('phase74 future and past detail remain distinct; recovered history does not rewrite latest work', t => {
  const f = fixture(t); const before = readonly(f); assertOld(f);
  const newer = f.inspect(NEW_ASOF).recentWorks[0];
  assert.equal(newer.likes, 91); assert.equal(newer.caption, 'FUTURE_TITLE_MUST_NOT_LEAK');
  assert.equal(newer.lastObservedAt, NEW_PAGE); assert.equal(protectedState(f.db), before);
});
test('phase74 partial page can retain actual old metrics, never become a full inventory or fresh profile', t => {
  const f = fixture(t, { hasMore: true }); const before = readonly(f); const detail = assertOld(f);
  assert.equal(detail.account.worksObservation.coverage, 'limited');
  assert.equal(detail.account.worksObservation.observedAt, OLD_PAGE);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 1);
  assert.equal(loadWorksObservations(f.database, ASOF, f.target.id).get(f.target.id).coverage, 'limited');
  assert.equal(protectedState(f.db), before);
});
test('phase74 a repeated next cursor retains the proven old page only and cannot claim full history', t => {
  const f = fixture(t, { repeated: true }); const before = readonly(f); const detail = assertOld(f);
  assert.equal(detail.account.worksObservation.coverage, 'limited');
  assert.equal(detail.account.worksObservation.stopReason, 'cursor-not-progressing');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM post_metrics').get().n, 2);
  assert.equal(protectedState(f.db), before);
});
for (const [name, opts] of [['core-only', { old: false }], ['empty page', { empty: true }], ['refusal', { failed: true }]]) {
  test(`phase74 ${name} cannot manufacture an old work or backdate the future one`, t => {
    const f = fixture(t, opts); const before = readonly(f);
    assert.deepEqual(f.inspect().recentWorks, []); assert.equal(f.overview().summary.publishedSamples.value, 0);
    assert.equal(protectedState(f.db), before);
  });
}

for (const [name, mutate] of [
  ['wrong author in retained directory', f => f.db.prepare('UPDATE posts SET author_id=?').run(`${SEC}Other`)],
  ['target identity changed', f => f.db.prepare('UPDATE targets SET locator=?').run(`${SEC}Other`)],
  ['metric/source value mismatch', f => f.db.prepare('UPDATE post_metrics SET likes=8 WHERE captured_at=?').run(OLD_PAGE)],
  ['source SHA tamper', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    f.db.prepare("UPDATE works_observations SET source_checksum='bad' WHERE run_id=?").run(f.historical.input.runId); }],
  ['anchor source corruption', f => f.db.exec("UPDATE snapshots SET raw_json='{}'")],
  ['anchor audit removed', f => f.db.exec('DELETE FROM audits')],
  ['unfinished source run', f => f.db.prepare("UPDATE runs SET status='running',finished_at=NULL WHERE id=?").run(f.historical.input.runId)],
  ['wrong run FK target', f => f.db.prepare('UPDATE runs SET target_id=NULL WHERE id=?').run(f.historical.input.runId)],
  ['future source finish', f => f.db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run(NEW_END, f.historical.input.runId)],
  ['unknown metric time', f => f.db.prepare("UPDATE post_metrics SET captured_at='not-a-time' WHERE captured_at=?").run(OLD_PAGE)],
  ['metric moved off exact page instant', f => f.db.prepare('UPDATE post_metrics SET captured_at=? WHERE captured_at=?')
    .run('2026-10-01T14:30:01.500Z', OLD_PAGE)],
  ['canonical UID rehash conflicting with anchor', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    const row = f.db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(f.historical.input.runId);
    const raw = JSON.parse(row.raw_json); raw.identity.uid = '999999'; raw.posts[0].author.uid = '999999';
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id); }],
  ['canonical foreign post rehash', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    const row = f.db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(f.historical.input.runId);
    const raw = JSON.parse(row.raw_json); raw.posts[0].author.sec_uid = `${SEC}Other`;
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id); }],
  ['nonzero first cursor forged and rehashed', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    const row = f.db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(f.historical.input.runId);
    const raw = JSON.parse(row.raw_json); raw.pagination.pages[0].requestCursor = 10;
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id); }],
  ['unaccounted source row forged and rehashed', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    const row = f.db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(f.historical.input.runId);
    const raw = JSON.parse(row.raw_json); raw.pagination.pages[0].rawCount = 2;
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id); }],
]) test(`phase74 late-known history rejects ${name} in real detail and overview readers`, t => {
  const f = fixture(t); mutate(f); const before = readonly(f);
  assert.deepEqual(f.inspect().recentWorks, []);
  assert.equal(f.overview().summary.publishedSamples.value, 0);
  assert.equal(protectedState(f.db), before);
});

test('phase74 source append idempotency and same-time conflicting metric still reject atomically', t => {
  const f = fixture(t); const before = protectedState(f.db);
  // A completed run is not reusable: ledger/runs are not reader-provided proof.
  assert.throws(() => recordWorksOnlyObservation(f.db, f.historical.input, { now: Date.parse(NEW_END) }), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.equal(protectedState(f.db), before);
  t.mock.timers.setTime(Date.parse(OLD_START));
  const conflict = structuredClone(f.historical.input); conflict.runId = f.database.beginRun('works-only', f.target.id, 1);
  conflict.requestFinishedAt = '2026-10-01T14:30:03.000Z'; conflict.result.posts[0].statistics.digg_count = 900;
  const reservedState = protectedState(f.db);
  assert.throws(() => recordWorksOnlyObservation(f.db, conflict, { now: Date.parse(NEW_END) }), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.equal(protectedState(f.db), reservedState, 'no new ledger or mutated post may survive the failed transaction');
});
test('phase74 actual active-run duplicate receipt is idempotent and conflicting source cannot overwrite it', t => {
  const f = fixture(t, { old: false });
  const r = f.append({ start: OLD_START, page: OLD_PAGE, end: OLD_END, likes: 7, caption: '原始标题', finish: false });
  const before = protectedState(f.db);
  assert.equal(recordWorksOnlyObservation(f.db, r.input, { now: Date.parse(OLD_END) }).duplicate, true);
  assert.equal(protectedState(f.db), before);
  const changed = structuredClone(r.input); changed.result.posts[0].statistics.digg_count = 8;
  assert.throws(() => recordWorksOnlyObservation(f.db, changed, { now: Date.parse(OLD_END) }), { code: 'WORKS_OBSERVATION_INVALID' });
  assert.equal(protectedState(f.db), before);
});

test('phase74 actual all-saved works history includes old proof, freezes record caps and reports no future observed date', t => {
  const f = fixture(t); const before = readonly(f);
  const result = f.history({ kind: 'works', pageSize: 1 });
  assert.equal(result.pagination.total, 1); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].caption, '旧观察中的原始标题'); assert.equal(result.items[0].likes, 7);
  assert.equal(result.items[0].url, `https://www.douyin.com/video/${ID}`);
  assert.equal(result.items[0].firstSeenAt, NEW_PAGE, 'retained original firstSeen must not be rewritten');
  assert.equal(result.items[0].lastObservedAt, OLD_PAGE);
  assert.equal(result.range.firstRecordedDate, '2026-10-01');
  assert.equal(result.range.lastRecordedDate, '2026-10-01');
  assert.equal(result.coverage.platformComplete, false); assert.equal(result.coverage.missingDatesFilled, false);
  const frozen = { ...result.revision, asOf: ASOF, kind: 'works', pageSize: 1 };
  assert.deepEqual(f.history(frozen), result);
  const page2 = f.history({ ...frozen, page: 2 }); assert.equal(page2.pagination.total, 1); assert.deepEqual(page2.items, []);
  const none = f.history({ ...frozen, snapshotMaxId: 0 });
  assert.equal(none.pagination.total, 0, 'a frozen cap cannot borrow the later anchor/source proof');
  const noMetric = f.history({ ...frozen, postMetricMaxId: 1 });
  assert.equal(noMetric.pagination.total, 0, 'cap excludes the old metric appended second');
  assert.equal(f.history({ ...frozen, postMaxId: 0 }).pagination.total, 0);
  assert.equal(protectedState(f.db), before);
});
test('phase74 actual all-saved work metrics history exposes the bound old metric only', t => {
  const f = fixture(t); const workId = Number(f.db.prepare('SELECT id FROM posts').get().id);
  const before = readonly(f);
  const result = f.history({ kind: 'workMetrics', workId, sort: 'capturedAt', order: 'asc' });
  assert.ok(result); assert.equal(result.pagination.total, 1);
  assert.equal(result.items[0].likes, 7); assert.equal(result.items[0].capturedAt, OLD_PAGE);
  assert.equal(result.items[0].plays, null); assert.equal(result.range.firstRecordedDate, '2026-10-01');
  assert.equal(result.coverage.platformComplete, false);
  const capped = f.history({ kind: 'workMetrics', workId, ...result.revision, postMetricMaxId: 1 });
  assert.equal(capped, null, 'an unproven late-known work is unavailable, not an empty known curve');
  assert.equal(f.history({ kind: 'workMetrics', workId, ...result.revision, snapshotMaxId: 0 }), null);
  assert.equal(f.history({ kind: 'workMetrics', workId, ...result.revision, postMaxId: 0 }), null);
  assert.equal(protectedState(f.db), before);
});
test('phase74 actual saved metrics returns true zero from exact matching source without filling unknown fields', t => {
  const f = fixture(t); f.db.exec('DROP TRIGGER works_observations_no_update');
  const row = f.db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(f.historical.input.runId);
  const raw = JSON.parse(row.raw_json); raw.posts[0].statistics.digg_count = 0;
  f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id);
  f.db.prepare('UPDATE post_metrics SET likes=0 WHERE captured_at=?').run(OLD_PAGE);
  const before = readonly(f); const workId = Number(f.db.prepare('SELECT id FROM posts').get().id);
  const result = f.history({ kind: 'workMetrics', workId });
  assert.ok(result); assert.equal(result.items.length, 1); assert.equal(result.items[0].likes, 0);
  assert.equal(result.items[0].plays, null); assert.equal(protectedState(f.db), before);
});
for (const [name, mutate] of [
  ['source hash missing', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    f.db.prepare("UPDATE works_observations SET source_checksum='bad' WHERE run_id=?").run(f.historical.input.runId); }],
  ['old metric unbound', f => f.db.prepare('UPDATE post_metrics SET likes=700 WHERE captured_at=?').run(OLD_PAGE)],
  ['wrong current author', f => f.db.prepare('UPDATE posts SET author_id=?').run(`${SEC}Other`)],
  ['unknown metric instant', f => f.db.prepare("UPDATE post_metrics SET captured_at='bad' WHERE captured_at=?").run(OLD_PAGE)],
]) test(`phase74 saved-history late-known records cannot borrow ${name}`, t => {
  const f = fixture(t); const workId = Number(f.db.prepare('SELECT id FROM posts').get().id); mutate(f);
  const before = readonly(f); assert.equal(f.history({ kind: 'works' }).pagination.total, 0);
  const metrics = f.history({ kind: 'workMetrics', workId });
  assert.equal(metrics, null);
  assert.equal(protectedState(f.db), before);
});

test('phase74 a bound latest old point cannot admit an unrelated earlier saved point for a late-known work', t => {
  const f = fixture(t); const workId = Number(f.db.prepare('SELECT id FROM posts').get().id);
  f.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES (?,?,?)')
    .run(workId, '2026-10-01T14:30:00.500Z', 777);
  const before = readonly(f);
  const result = f.history({ kind: 'workMetrics', workId, sort: 'capturedAt', order: 'asc' });
  assert.ok(result); assert.deepEqual(result.items.map(row => row.likes), [7]);
  assert.equal(result.coverage.independentlyVerified, false);
  assert.equal(result.coverage.metricsEvidence, 'saved-record-not-independently-verified');
  assert.equal(result.coverage.excludedCount, 1);
  assert.equal(result.coverage.platformComplete, false); assert.equal(result.coverage.missingDatesFilled, false);
  assert.equal(protectedState(f.db), before);
});

for (const damaged of [null, 'earlier', 'later']) test(`phase74 actual late-known curve proves each distinct instant separately: ${damaged || 'both genuine'}`, t => {
  const f = fixture(t); const workId = Number(f.db.prepare('SELECT id FROM posts').get().id);
  const earlier = f.append({ start: '2026-10-01T14:29:00.000Z', page: '2026-10-01T14:29:01.000Z',
    end: '2026-10-01T14:29:02.000Z', likes: 5, caption: '较早的真实作品标题' });
  if (damaged) {
    f.db.exec('DROP TRIGGER works_observations_no_update');
    f.db.prepare("UPDATE works_observations SET source_checksum='bad' WHERE run_id=?")
      .run(damaged === 'earlier' ? earlier.input.runId : f.historical.input.runId);
  }
  t.mock.timers.setTime(Date.parse(NEW_ASOF));
  const before = readonly(f), result = f.history({ kind: 'workMetrics', workId, sort: 'capturedAt', order: 'asc' });
  assert.ok(result); assert.deepEqual(result.items.map(row => row.likes), damaged === 'earlier' ? [7] : damaged === 'later' ? [5] : [5, 7]);
  assert.equal(result.coverage.excludedCount, damaged ? 1 : 0);
  assert.equal(result.coverage.independentlyVerified, false); assert.equal(result.coverage.platformComplete, false);
  assert.equal(result.coverage.missingDatesFilled, false); assert.equal(protectedState(f.db), before);
});

function actualCsvConsumer(f) {
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  const requests = [];
  const context = { ...consoleModel, fmt: consoleModel.formatNumber, URL, URLSearchParams, Date, Intl,
    AbortController, setTimeout, clearTimeout, Set, Map, location: new URL('http://127.0.0.1:4188/'), document: {}, window: {},
    fetch: async path => {
      const parsed = new URL(path, 'http://offline.fixture');
      assert.equal(parsed.pathname, `/api/rebuild/accounts/${f.target.id}/history`);
      const parameters = Object.fromEntries(parsed.searchParams); requests.push(parameters);
      const body = getAccountHistory(f.database, f.target.id, parameters);
      return { ok: true, status: 200, json: async () => body };
    } };
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}\nthis.subject={historyCsv,readAllHistoryPages};`, context);
  return { ...context.subject, requests };
}

test('phase74 actual UI all-pages export uses actual source-bound reader and three frozen caps', async t => {
  const f = fixture(t); const secondId = '7300000000000000002';
  f.append({ start: '2026-10-01T16:30:03.000Z', page: '2026-10-01T16:30:04.000Z', end: '2026-10-01T16:30:05.000Z', likes: 92,
    caption: 'SECOND_FUTURE_TITLE', postId: secondId });
  f.append({ start: '2026-10-01T14:30:03.000Z', page: '2026-10-01T14:30:04.000Z', end: '2026-10-01T14:30:05.000Z', likes: 8,
    caption: '第二条旧作品原始标题', postId: secondId });
  t.mock.timers.setTime(Date.parse(NEW_ASOF));
  const first = f.history({ kind: 'works', pageSize: 1, sort: 'likes', order: 'asc' });
  const before = readonly(f); const consumer = actualCsvConsumer(f);
  const exported = await consumer.readAllHistoryPages({ targetId: f.target.id, kind: 'works', asOf: ASOF,
    revision: first.revision, page: 1, pageSize: 1, sort: 'likes', order: 'asc', startDate: '', endDate: '' });
  assert.equal(exported.rows.length, 2); assert.deepEqual(Array.from(exported.rows, row => row.likes), [7, 8]);
  assert.equal(exported.data.pagination.total, 2); assert.equal(consumer.requests.length, 2);
  for (const [i, request] of consumer.requests.entries()) {
    assert.equal(request.asOf, ASOF); assert.equal(request.page, String(i + 1));
    for (const key of ['snapshotMaxId', 'postMaxId', 'postMetricMaxId']) assert.equal(request[key], String(first.revision[key]));
  }
  assert.match(exported.csv, /旧观察中的原始标题/); assert.match(exported.csv, /第二条旧作品原始标题/);
  assert.match(exported.csv, /播放来源值（未独立核验）/); assert.match(exported.csv, /保存的来源值，未逐条独立核验/);
  assert.match(exported.csv, /来源未提供/); assert.match(exported.csv, /2026-10-01T14:30:01\.000Z/);
  assert.doesNotMatch(exported.csv, /FUTURE_TITLE|future\.invalid|2026-10-01T16:30:01\.000Z/);
  assert.equal(protectedState(f.db), before);
});

test('phase74 actual saved source snapshot also recovers late-known metadata with a hard snapshot cap', t => {
  const f = fixture(t, { old: false }); const sourceId = appendOldSnapshot(f);
  assert.equal(sourceId, 2); const before = readonly(f); assertOld(f);
  const result = f.history({ kind: 'works' });
  assert.equal(result.items[0].likes, 7); assert.equal(result.items[0].caption, '旧观察中的原始标题');
  assert.equal(result.items[0].firstSeenAt, NEW_PAGE); assert.equal(result.range.firstRecordedDate, '2026-10-01');
  assert.equal(f.history({ kind: 'works', ...result.revision, snapshotMaxId: sourceId - 1 }).pagination.total, 0);
  const workId = Number(result.items[0].id);
  assert.equal(f.history({ kind: 'workMetrics', workId, ...result.revision, snapshotMaxId: sourceId - 1 }), null);
  assert.equal(protectedState(f.db), before);
});
for (const [name, modify] of [
  ['rehashed foreign profile', raw => { raw.profile.user.sec_uid = `${SEC}Other`; }],
  ['rehashed foreign work', raw => { raw.works.aweme_list[0].author.sec_uid = `${SEC}Other`; }],
  ['rehashed UID conflict', raw => { raw.works.aweme_list[0].author.uid = '999999'; }],
  ['rehashed future raw capture', raw => { raw.capturedAt = NEW_PAGE; }],
  ['rehashed future publication', raw => { raw.works.aweme_list[0].create_time = Date.parse(NEW_PAGE) / 1000; }],
  ['rehashed changed metric vector', raw => { raw.works.aweme_list[0].statistics.digg_count = 800; }],
]) test(`phase74 actual historical snapshot consumers reject ${name} without borrowing latest metadata`, t => {
  const f = fixture(t, { old: false }); const sourceId = appendOldSnapshot(f);
  const row = f.db.prepare('SELECT raw_json FROM snapshots WHERE id=?').get(sourceId);
  const raw = JSON.parse(row.raw_json); modify(raw);
  f.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), sourceId);
  const workId = Number(f.db.prepare('SELECT id FROM posts').get().id), before = readonly(f);
  assert.deepEqual(f.inspect().recentWorks, []); assert.equal(f.overview().summary.publishedSamples.value, 0);
  assert.equal(f.history({ kind: 'works' }).pagination.total, 0);
  assert.equal(f.history({ kind: 'workMetrics', workId }), null);
  assert.equal(protectedState(f.db), before);
});

test('phase74 actual late-known per-point proof is batched across twelve additional genuine observations', t => {
  const f = fixture(t); const workId = Number(f.db.prepare('SELECT id FROM posts').get().id), statements = [];
  const db = new Proxy(f.db, { get(native, key) {
    if (key !== 'prepare') { const value = Reflect.get(native, key, native); return typeof value === 'function' ? value.bind(native) : value; }
    return sql => { statements.push(sql); return native.prepare(sql); };
  } });
  const read = () => { statements.length = 0;
    const result = getAccountHistory({ db }, f.target.id, { kind: 'workMetrics', workId,
      asOf: ASOF, sort: 'capturedAt', order: 'asc', pageSize: 100 });
    return { result, queries: statements.length };
  };
  const small = read(); assert.equal(small.result.pagination.total, 1);
  for (let n = 0; n < 12; n++) {
    const start = Date.parse('2026-10-01T14:00:00.000Z') + n * 60_000;
    f.append({ start: new Date(start).toISOString(), page: new Date(start + 1000).toISOString(),
      end: new Date(start + 2000).toISOString(), likes: n, caption: `真实第${n}个旧时刻` });
  }
  t.mock.timers.setTime(Date.parse(NEW_ASOF)); const before = readonly(f), large = read();
  assert.equal(large.result.pagination.total, 13); assert.equal(large.result.items.length, 13);
  assert.deepEqual(large.result.items.map(row => row.likes), [...Array.from({ length: 12 }, (_, n) => n), 7]);
  assert.ok(large.queries <= small.queries + 2, `query count grew per old point: ${small.queries} -> ${large.queries}`);
  assert.ok(large.queries <= 20, `expected bounded batched proof queries, got ${large.queries}`);
  t.diagnostic(`actual source-proof queries: 1 point=${small.queries}, 13 points=${large.queries}`);
  assert.equal(large.result.coverage.platformComplete, false); assert.equal(protectedState(f.db), before);
});
