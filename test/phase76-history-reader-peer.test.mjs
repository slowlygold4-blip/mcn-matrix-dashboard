// Real ConsoleReader worker + real SQLite owners, isolated from user data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { ConsoleReader } from '../lib/console-reader.mjs';
import { MonitorDatabase, normalizeBoardKey } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { getAccountHistory } from '../lib/account-history.mjs';
import { getAccountInsight } from '../lib/product-insights.mjs';
import { exportPublicReplica } from '../lib/public-replica-export.mjs';
import { checksum } from '../lib/utils.mjs';
import * as consoleModel from '../public/console-model.js';

const SEC = 'MS4wLjABAAAAPhase76RealWorkerAuthor1234', UID = '123456789012';
const OLD = '2026-09-30T14:00:00.000Z', NEW = '2026-09-30T18:00:00.000Z';
const ASOF = '2026-09-30T15:00:00.000Z';
const EXTERNAL = ['7300000000000000076', '7300000000000000077'];
function state(db) {
  return JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'audits', 'posts', 'post_metrics', 'works_observations', 'runs']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
}
function fixture(t, { damageOldSource = false, mutate = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phase76-history-reader-'));
  const path = join(dir, 'fixture.sqlite');
  const writer = new MonitorDatabase(path);
  const target = writer.createTarget({ type: 'account', provider: 'public-web', locator: SEC,
    label: 'Phase76 isolated worker fixture', metadata: { platform: 'douyin' } });
  const save = (capturedAt, followers, likes, posts, works = []) => {
    const raw = { capturedAt, profile: { user: { sec_uid: SEC, uid: UID,
      follower_count: followers, total_favorited: likes, aweme_count: posts } }, worksCoverage: 'limited',
      works: { aweme_list: works.map((work, index) => ({ aweme_id: EXTERNAL[index],
        author: { sec_uid: SEC, uid: UID }, desc: work.caption,
        create_time: Date.parse('2026-09-30T10:00:00.000Z') / 1000,
        statistics: { digg_count: work.likes }, share_url: `https://www.douyin.com/video/${EXTERNAL[index]}` })) } };
    writer.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
  };
  save('2026-09-28T02:00:00.000Z', 10, 30, 5);
  save('2026-09-29T02:00:00.000Z', 0, 20, 3);
  save(NEW, 20, 40, 5, [{ caption: 'FUTURE_TITLE_A', likes: 91 }, { caption: 'FUTURE_TITLE_B', likes: 92 }]);
  save(OLD, 15, 35, 4, [{ caption: '原始旧观察A', likes: 7 }, { caption: '原始旧观察B', likes: 0 }]);
  if (damageOldSource) writer.db.prepare("UPDATE snapshots SET source_checksum='broken-source' WHERE captured_at=?").run(OLD);
  mutate?.(writer, target, save);
  writer.close();
  const db = new DatabaseSync(path, { readOnly: true });
  db.function('normalize_board_key', { deterministic: true }, normalizeBoardKey);
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
  const before = state(db);
  // Deliberately omit workerFactory: production Node Worker and entry module run.
  const reader = new ConsoleReader({ databasePath: path, timeoutMs: 5000, cacheTtlMs: 0 });
  t.after(async () => {
    await reader.close();
    assert.equal(state(db), before, 'actual worker reads cannot mutate fixture originals');
    db.close();
    rmSync(dir, { recursive: true });
  });
  const history = options => reader.history(target.id, { asOf: ASOF, ...options });
  return { reader, db, target, history, path };
}

const EARLIER = '2026-09-30T13:00:00.000Z';
function publicMetricRows(f, options = {}) {
  const replica = exportPublicReplica(f.db, { asOf: ASOF, ...options });
  const workId = f.db.prepare('SELECT id FROM posts WHERE external_id=?').get(EXTERNAL[0]).id;
  const part = replica.partitions.find(row => row.kind === 'workMetrics' && row.targetId === f.target.id);
  return { replica, workId, items: (part?.items ?? []).filter(row => row.workId === workId) };
}

for (const field of ['likes', 'comments', 'shares', 'collects', 'plays']) {
  test(`phase76 public exporter late-known ${field} point must bind its own exact source vector`, t => {
    const f = fixture(t, { mutate(writer, target, save) {
      save(EARLIER, 12, 34, 4, [{ caption: '真正较早观察', likes: 5 }]);
      writer.db.prepare(`UPDATE post_metrics SET ${field}=? WHERE captured_at=?`).run(field === 'likes' ? 777 : 1, EARLIER);
    } });
    const result = publicMetricRows(f);
    const local = getAccountHistory({ db: f.db }, f.target.id, { kind: 'workMetrics', workId: result.workId,
      asOf: ASOF, order: 'asc', pageSize: 100 });
    assert.deepEqual(local.items.map(row => row.likes), [7]);
    assert.equal(local.coverage.excludedCount, 1);
    assert.deepEqual(result.items.map(row => row.capturedAt), [OLD], 'public export cannot re-admit a point the late-source reader excludes');
  });
}

for (const damage of ['time', 'identity', 'checksum']) {
  test(`phase76 public exporter late-known point rejects its own ${damage} failure`, t => {
    const f = fixture(t, { mutate(writer, target, save) {
      save(EARLIER, 12, 34, 4, [{ caption: '真正较早观察', likes: 5 }]);
      if (damage === 'time') writer.db.prepare('UPDATE post_metrics SET captured_at=? WHERE captured_at=?')
        .run('2026-09-30T13:00:01.000Z', EARLIER);
      else if (damage === 'checksum') writer.db.prepare("UPDATE snapshots SET source_checksum='damaged' WHERE captured_at=?").run(EARLIER);
      else {
        const row = writer.db.prepare('SELECT id,raw_json FROM snapshots WHERE captured_at=?').get(EARLIER);
        const raw = JSON.parse(row.raw_json);
        raw.works.aweme_list[0].author.sec_uid = `${SEC}Foreign`;
        writer.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id);
      }
    } });
    const result = publicMetricRows(f);
    assert.deepEqual(result.items.map(row => row.capturedAt), [OLD]);
    assert.deepEqual(result.items.map(row => row.likes), [7]);
  });
}

test('phase76 public exporter retains genuine late points separately without future metrics or invented reach', t => {
  const f = fixture(t, { mutate(writer, target, save) {
    save(EARLIER, 12, 34, 4, [{ caption: '真正较早观察', likes: 5 }]);
  } });
  const result = publicMetricRows(f);
  assert.deepEqual(result.items.map(row => row.likes), [5, 7]);
  assert.ok(result.items.every(row => row.plays === null && row.playsEvidence.actualCountVerified === false));
  assert.ok(result.items.every(row => Date.parse(row.capturedAt) <= Date.parse(ASOF)));
  assert.equal(result.replica.policy.platformComplete, false);
  const account = result.replica.catalog.accounts.find(account => account.id === f.target.id);
  const capped = getAccountHistory({ db: f.db }, f.target.id, { kind: 'workMetrics', workId: result.workId,
    asOf: ASOF, order: 'asc', ...account.historyRevision, snapshotMaxId: account.historyRevision.snapshotMaxId - 1 });
  assert.deepEqual(capped.items.map(row => row.likes), [7], 'newer exact source cannot enter a previously frozen source cap');
});

test('phase76 public exporter leaves ordinary known legacy metrics unverified rather than deleting them', t => {
  const f = fixture(t, { mutate(writer) {
    writer.db.prepare('UPDATE posts SET first_seen_at=? WHERE external_id=?').run('2026-09-30T12:00:00.000Z', EXTERNAL[0]);
    const workId = writer.db.prepare('SELECT id FROM posts WHERE external_id=?').get(EXTERNAL[0]).id;
    writer.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)').run(workId, EARLIER, 777);
  } });
  const result = publicMetricRows(f);
  assert.deepEqual(result.items.map(row => row.likes), [777, 7]);
  assert.ok(result.items.every(row => row.playsEvidence.actualCountVerified === false));
});

test('phase76 public exporter does not add a source-proof query per late-known point', t => {
  function counted(extra) {
    const f = fixture(t, { mutate(writer, target, save) {
      for (let index = 0; index < extra; index++) save(new Date(Date.parse(EARLIER) + index * 60000).toISOString(),
        12, 34, 4, [{ caption: `真正旧观察${index}`, likes: index }]);
    } });
    let queries = 0;
    const db = new Proxy(f.db, { get(native, key) {
      if (key === 'prepare') return sql => { queries++; return native.prepare(sql); };
      const value = Reflect.get(native, key, native); return typeof value === 'function' ? value.bind(native) : value;
    } });
    const replica = exportPublicReplica(db, { asOf: ASOF });
    const items = replica.partitions.find(row => row.kind === 'workMetrics' && row.targetId === f.target.id).items;
    assert.equal(items.length, extra + 2);
    return queries;
  }
  const one = counted(1), many = counted(13);
  assert.ok(many <= one + 2, `late proof query count grows per point: ${one} -> ${many}`);
  t.diagnostic(`actual exporter SQLite prepare count: 1 extra=${one}, 13 extra=${many}`);
});

test('phase76 default real Worker recovers late-known snapshot metadata without leaking latest fields', async t => {
  const f = fixture(t), first = await f.history({ kind: 'works', sort: 'likes', order: 'asc', pageSize: 100 });
  assert.ok(f.reader.worker.threadId > 0);
  assert.equal(f.db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.deepEqual(first, getAccountHistory({ db: f.db }, f.target.id, { kind: 'works', asOf: ASOF,
    sort: 'likes', order: 'asc', pageSize: 100, ...first.revision }));
  assert.deepEqual(first.items.map(row => row.likes), [0, 7]);
  assert.deepEqual(first.items.map(row => row.caption), ['原始旧观察B', '原始旧观察A']);
  assert.ok(first.items.every(row => row.firstSeenAt === NEW && row.lastObservedAt === OLD && row.plays === null));
  assert.equal(first.range.firstRecordedDate, '2026-09-30');
  assert.equal(first.range.lastRecordedDate, '2026-09-30');
  assert.doesNotMatch(JSON.stringify(first.items), /FUTURE_TITLE/);
  assert.equal(first.coverage.platformComplete, false);
  assert.equal(first.coverage.independentlyVerified, false);
});

test('phase76 default Worker detail and overview both consume actual late-source reader', async t => {
  const f = fixture(t), options = { reference: ASOF, period: 'day', timeZone: 'Asia/Shanghai', includeRecordedWindow: false };
  const detail = await f.reader.account(f.target.id, options);
  const direct = getAccountInsight({ db: f.db }, f.target.id, options);
  assert.deepEqual(detail.recentWorks, direct.recentWorks);
  assert.equal(detail.recentWorks.length, 2);
  assert.ok(detail.recentWorks.every(row => row.lastObservedAt === OLD));
  assert.doesNotMatch(JSON.stringify(detail.recentWorks), /FUTURE_TITLE/);
  const overview = await f.reader.overview(options);
  assert.equal(overview.summary.publishedSamples.value, 2);
  assert.match(overview.methodology.posts, /晚到记录须以独立来源证明此前真实观察/);
  assert.equal(overview.summary.publishedSamples.asOfBasis, 'first_seen_at_or_verified_observation_at');
  assert.equal(detail.account.publishedSamples.asOfBasis, 'first_seen_at_or_verified_observation_at');
  assert.equal(overview.accounts[0].publishedSamples, undefined, 'list payload intentionally delegates per-account detail to its endpoint');
});

test('phase76 actual worker caps block the needed source, work, or metric without borrowing another revision', async t => {
  const f = fixture(t), first = await f.history({ kind: 'works' }), workId = first.items[0].id;
  for (const key of ['snapshotMaxId', 'postMaxId', 'postMetricMaxId']) {
    const caps = { ...first.revision, [key]: 0 };
    const works = await f.history({ kind: 'works', ...caps });
    assert.equal(works.pagination.total, 0, key);
    const metrics = await f.history({ kind: 'workMetrics', workId, ...caps });
    assert.equal(metrics, null, key);
  }
});

test('phase76 actual worker single-work metric history retains only its old source-bound observation', async t => {
  const f = fixture(t), works = await f.history({ kind: 'works', sort: 'likes', order: 'desc' });
  const options = { kind: 'workMetrics', workId: works.items[0].id, ...works.revision,
    sort: 'capturedAt', order: 'asc', pageSize: 100 };
  const metrics = await f.history(options);
  assert.deepEqual(metrics, getAccountHistory({ db: f.db }, f.target.id, { asOf: ASOF, ...options }));
  assert.equal(metrics.pagination.total, 1);
  assert.equal(metrics.items[0].capturedAt, OLD);
  assert.equal(metrics.items[0].likes, 7);
  assert.equal(metrics.items[0].plays, null);
  assert.equal(metrics.items[0].playsEvidence.basis, 'missing');
  assert.equal(metrics.coverage.platformComplete, false);
  assert.equal(metrics.coverage.independentlyVerified, false);
});

test('phase76 actual worker daily values retain true zero, negative deltas, metric source dates, and absent-day gaps', async t => {
  const f = fixture(t), result = await f.history({ kind: 'daily', sort: 'date', order: 'asc', pageSize: 100 });
  assert.deepEqual(result, getAccountHistory({ db: f.db }, f.target.id,
    { kind: 'daily', asOf: ASOF, sort: 'date', order: 'asc', pageSize: 100, ...result.revision }));
  assert.deepEqual(result.items.map(row => row.date), ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.equal(result.items[0].followersDelta, null);
  const negative = result.items[1];
  assert.equal(negative.followers, 0);
  assert.equal(negative.followersDelta, -10);
  assert.equal(negative.likesDelta, -10);
  assert.equal(negative.postsDelta, -2);
  assert.equal(negative.estimatedPlaysDelta, -1000);
  assert.equal(negative.estimatedPlaysProxy, true);
  assert.equal(negative.likesAt, '2026-09-29T02:00:00.000Z');
  assert.equal(negative.likesBaselineAt, '2026-09-28T02:00:00.000Z');
  assert.match(negative.likesChecksum, /^[a-f0-9]{64}$/);
  assert.match(negative.likesBaselineChecksum, /^[a-f0-9]{64}$/);
  const absent = await f.history({ kind: 'daily', startDate: '2026-09-27', endDate: '2026-09-27' });
  assert.equal(absent.pagination.total, 0);
  assert.deepEqual(absent.items, []);
});

test('phase76 default worker rejects missing proof and a invalid cap then remains usable', async t => {
  const f = fixture(t, { damageOldSource: true });
  assert.equal((await f.history({ kind: 'works' })).pagination.total, 0);
  const detail = await f.reader.account(f.target.id, { reference: ASOF, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(detail.recentWorks, []);
  await assert.rejects(f.history({ kind: 'works', snapshotMaxId: 0 }), { code: 'ACCOUNT_HISTORY_INVALID', status: 400 });
  const daily = await f.history({ kind: 'daily' });
  assert.equal(daily.pagination.total, 2);
  assert.equal(daily.coverage.excludedCount, 1);
});

test('phase76 actual UI all-pages CSV transport uses default real Worker and freezes all three caps', async t => {
  const f = fixture(t), first = await f.history({ kind: 'works', pageSize: 1, sort: 'likes', order: 'asc' });
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8'), requests = [];
  const context = { ...consoleModel, fmt: consoleModel.formatNumber, URL, URLSearchParams, Date, Intl,
    AbortController, Set, Map, location: new URL('http://127.0.0.1:4188/'), document: {}, window: {},
    fetch: async path => {
      const url = new URL(path, 'http://isolated-fixture');
      assert.equal(url.pathname, `/api/rebuild/accounts/${f.target.id}/history`);
      const options = Object.fromEntries(url.searchParams); requests.push(options);
      const body = await f.reader.history(f.target.id, options);
      return { ok: true, status: 200, json: async () => body };
    } };
  // Executes the real CSV/page-validation business functions, not browser rendering.
  runInNewContext(`${source.replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '')}\nthis.readAll=readAllHistoryPages;`, context);
  const result = await context.readAll({ targetId: f.target.id, kind: 'works', asOf: ASOF,
    revision: first.revision, page: 1, pageSize: 1, sort: 'likes', order: 'asc', startDate: '', endDate: '' });
  assert.equal(requests.length, 2);
  assert.deepEqual(Array.from(result.rows, row => row.likes), [0, 7]);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.page, String(index + 1));
    assert.equal(request.asOf, ASOF);
    for (const key of ['snapshotMaxId', 'postMaxId', 'postMetricMaxId']) assert.equal(request[key], String(first.revision[key]));
  }
  assert.match(result.csv, /原始旧观察A/);
  assert.match(result.csv, /原始旧观察B/);
  assert.match(result.csv, /保存的来源值，未逐条独立核验/);
  assert.match(result.csv, /来源未提供/);
  assert.doesNotMatch(result.csv, /FUTURE_TITLE/);
});
