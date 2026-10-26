import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection } from '../lib/providers/normalize.mjs';
import { checksum } from '../lib/utils.mjs';
import { initializeWorksOnlyObservations, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import { loadWorksObservations, loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { inspectUpdateSla, buildUpdateSla } from '../lib/update-sla.mjs';

const SEC = 'MS4wLjABAAAAWorksReadModelIndependent12345', UID = '101115710974';
const ANCHOR = '2026-09-28T15:59:00.000Z';
const START = '2026-09-28T16:00:01.000Z', PAGE = '2026-09-28T16:00:02.000Z', END = '2026-09-28T16:00:03.000Z';
const ASOF = '2026-09-28T16:01:00.000Z';
const iso = value => new Date(value).toISOString();

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(ANCHOR) });
  const database = new MonitorDatabase(':memory:'); t.after(() => database.close());
  const db = database.db;
  const target = database.createTarget({ type: 'account', provider: 'public-web', locator: SEC, label: 'offline', metadata: { platform: 'douyin' } });
  const raw = { capturedAt: ANCHOR, accountStatus: 'validated', accountError: null,
    profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: 1 } },
    worksCoverage: 'unavailable', worksErrorCode: 'deferred', works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
    provenance: { mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
      profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/', accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false } };
  const profileRun = database.beginRun('manual', target.id, 1);
  database.saveCollection(target, profileRun, normalizeCollection(target, raw, { capturedAt: ANCHOR }));
  database.finishRun(profileRun, { status: 'success', successCount: 1 });
  const anchor = db.prepare('SELECT * FROM snapshots WHERE target_id=?').get(target.id);
  initializeWorksOnlyObservations(db);
  const makeInput = ({ start = START, page = PAGE, end = END, failed = false, failureDiagnostics } = {}) => ({
    targetId: target.id, anchorSnapshotId: anchor.id, anchorChecksum: anchor.source_checksum,
    requestStartedAt: start, requestFinishedAt: end,
    result: failed ? { status: 'unavailable', posts: [], errorCode: 'blocked', ...(failureDiagnostics ? { failureDiagnostics } : {}) } : {
      status: 'ok', hasMore: false, maxCursor: 0,
      posts: [{ aweme_id: '7200000000000000001', author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: 9 } }],
      pagination: { version: 1, maxPages: 3, requestCount: 1, collectedCount: 1, stopReason: 'end-of-list', errorCode: null,
        pages: [{ requestCursor: 0, response: { max_cursor: 0, has_more: false }, rawCount: 1, acceptedCount: 1,
          duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: page }] } } });
  const append = (options = {}) => {
    const input = makeInput(options); t.mock.timers.setTime(Date.parse(input.requestStartedAt));
    input.runId = database.beginRun('works-only', target.id, 1);
    t.mock.timers.setTime(Date.parse(input.requestFinishedAt));
    const saved = recordWorksOnlyObservation(db, input, { now: Date.now() });
    if (!options.running) {
      t.mock.timers.setTime(Date.parse(input.requestFinishedAt) + 1);
      database.finishRun(input.runId, { status: options.runStatus ?? (options.failed ? 'error' : 'success'),
        successCount: options.failed ? 0 : 1, errorCount: options.failed ? 1 : 0 });
    }
    return { input, saved };
  };
  return { db, database, target, anchor, append };
}

test('works-only read: genuine completed run crosses BJT midnight without refreshing yesterday profile', t => {
  const f = fixture(t);
  const profile = f.db.prepare('SELECT * FROM snapshots').all();
  const target = f.db.prepare('SELECT * FROM targets').all();
  const audits = f.db.prepare('SELECT * FROM audits').all();
  const { saved } = f.append(); f.db.exec('PRAGMA query_only=ON');
  const works = loadWorksObservations(f.database, ASOF).get(f.target.id);
  assert.equal(works.coverage, 'complete'); assert.equal(works.observedAt, PAGE); assert.equal(works.lastAttemptAt, END);
  assert.equal(works.carriedForward, false); assert.equal(works.sampleCount, 1);
  assert.equal(works.sourceChecksum, saved.sourceChecksum);
  const sla = inspectUpdateSla(f.db, { now: ASOF, includeTargets: true });
  assert.equal(sla.works.daily.counts.complete, 1); assert.equal(sla.works.daily.counts.limited, 0);
  assert.equal(sla.coreAccounts.daily.complete, 0); assert.equal(sla.coreAccounts.targets[0].capturedAt, ANCHOR);
  assert.deepEqual(f.db.prepare('SELECT * FROM snapshots').all(), profile);
  assert.deepEqual(f.db.prepare('SELECT * FROM targets').all(), target);
  assert.deepEqual(f.db.prepare('SELECT * FROM audits').all(), audits);
});

test('works-only SLA projection verifies only the newest accepted row without changing the read-model default', t => {
  const f = fixture(t);
  f.append();
  f.append({ start: '2026-09-28T16:01:01.000Z', page: '2026-09-28T16:01:02.000Z', end: '2026-09-28T16:01:03.000Z' });
  f.append({ start: '2026-09-28T16:02:01.000Z', page: '2026-09-28T16:02:02.000Z', end: '2026-09-28T16:02:03.000Z' });
  const asOf = '2026-09-28T16:03:00.000Z';
  const defaultRows = loadVerifiedWorksOnlyRows(f.db, asOf);
  const slaRows = loadVerifiedWorksOnlyRows(f.db, asOf, null, { acceptedPerTarget: 1 });
  assert.equal(defaultRows.length, 2, 'the general read model keeps two accepted observations for comparison');
  assert.equal(slaRows.length, 1, 'the SLA projection only needs the newest accepted observation');
  assert.equal(slaRows[0].run_id, defaultRows[0].run_id, 'latest attempt remains the same');
  const expected = buildUpdateSla({ targets: [f.target], snapshots: [], worksObservations: defaultRows, now: asOf });
  const actual = inspectUpdateSla(f.db, { now: asOf });
  const contract = works => Object.fromEntries(['daily', 'fresh8h'].map(key => {
    const { total, complete, missing, counts, status, targetStatus } = works[key];
    return [key, { total, complete, missing, counts, status, targetStatus }];
  }));
  assert.deepEqual(contract(actual.works), contract(expected.works), 'daily and rolling-window coverage must not change');
});

test('works-only read: newer failure remains latest despite late old successful append; no freshness renewal', t => {
  const f = fixture(t);
  f.append({ failed: true, start: '2026-09-28T16:00:10.000Z', end: '2026-09-28T16:00:12.000Z' });
  f.append();
  const works = loadWorksObservations(f.database, ASOF).get(f.target.id);
  assert.equal(works.coverage, 'unavailable'); assert.equal(works.observedAt, PAGE);
  assert.equal(works.lastAttemptAt, '2026-09-28T16:00:12.000Z'); assert.equal(works.carriedForward, true);
  const sla = inspectUpdateSla(f.db, { now: ASOF, includeTargets: true });
  assert.equal(sla.works.daily.counts.unavailable, 1); assert.equal(sla.works.daily.targets[0].observedAt, null);
  assert.equal(sla.coreAccounts.targets[0].capturedAt, ANCHOR);
});

test('works-only SLA counts sanitized reason codes only for the latest verified attempt', t => {
  const f = fixture(t);
  f.append({ failed: true, failureDiagnostics: { version: 1, stopReason: 'http-rejection', httpStatuses: [403] } });
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const row = f.db.prepare('SELECT raw_json,source_checksum FROM works_observations').get();
  f.db.exec('PRAGMA query_only=ON');
  const works = inspectUpdateSla(f.db, { now: ASOF, includeTargets: true }).works.fresh8h;
  assert.deepEqual(works.latestAttemptDiagnostics, { attemptedTargets: 1, failureCount: 1, reasons: {
    http403: 1, loginRequired: 0, rateLimited: 0, collectorPartial: 0, collectorUnavailable: 0,
    networkError: 0, upstreamChanged: 0, other: 0,
  } });
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(f.db.prepare('SELECT raw_json,source_checksum FROM works_observations').get(), row);
});

test('works-only read: daily and eight-hour cutoff use accepted page time, not later finish', t => {
  const f = fixture(t); f.append();
  const boundary = iso(Date.parse(PAGE) + 8 * 3600_000);
  assert.equal(inspectUpdateSla(f.db, { now: boundary }).works.fresh8h.counts.complete, 1);
  assert.equal(inspectUpdateSla(f.db, { now: iso(Date.parse(boundary) + 1) }).works.fresh8h.counts.missing, 1);
  assert.equal(inspectUpdateSla(f.db, { now: '2026-09-29T16:00:00.000Z' }).works.daily.counts.missing, 1);
});

test('works-only read: running run and not-yet-finished as-of never qualify', t => {
  const f = fixture(t); const { input } = f.append({ running: true });
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF).length, 0);
  t.mock.timers.setTime(Date.parse(END) + 1000); f.database.finishRun(input.runId, { status: 'success', successCount: 1 });
  assert.equal(loadVerifiedWorksOnlyRows(f.db, END).length, 0);
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF).length, 1);
});

test('works-only read: later real profile does not invalidate historical anchor, but remains latest works attempt', t => {
  const f = fixture(t); const r = f.append();
  const later = '2026-09-28T16:00:20.000Z'; t.mock.timers.setTime(Date.parse(later));
  const raw = JSON.parse(f.anchor.raw_json); raw.capturedAt = later;
  const runId = f.database.beginRun('manual', f.target.id, 1);
  f.database.saveCollection(f.target, runId, normalizeCollection(f.target, raw, { capturedAt: later }));
  f.database.finishRun(runId, { status: 'success', successCount: 1 });
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF, null, { runId: r.input.runId }).length, 1);
  const works = loadWorksObservations(f.database, ASOF).get(f.target.id);
  assert.equal(works.coverage, 'unavailable'); assert.equal(works.lastAttemptAt, later);
  assert.equal(works.observedAt, PAGE); assert.equal(works.carriedForward, true);
  assert.equal(inspectUpdateSla(f.db, { now: ASOF }).works.daily.counts.unavailable, 1);
});

for (const runStatus of ['partial', 'interrupted']) test(`works-only read: completed ${runStatus} unavailable remains visible, never accepted`, t => {
  const f = fixture(t); f.append({ failed: true, runStatus });
  const rows = loadVerifiedWorksOnlyRows(f.db, ASOF);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'unavailable'); assert.equal(rows[0].observed_at, null);
  assert.equal(inspectUpdateSla(f.db, { now: ASOF }).works.daily.counts.unavailable, 1);
});

for (const [name, mutate] of [
  ['run target', (f, r) => { const other = f.database.createTarget({ type: 'account', provider: 'public-web', locator: `${SEC}Other`, label: 'other' });
    f.db.prepare('UPDATE runs SET target_id=? WHERE id=?').run(other.id, r.input.runId); }],
  ['run trigger', (f, r) => f.db.prepare("UPDATE runs SET trigger_type='manual' WHERE id=?").run(r.input.runId)],
  ['run incomplete count', (f, r) => f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(r.input.runId)],
  ['run ended before evidence', (f, r) => f.db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run(START, r.input.runId)],
  ['invalid rolled calendar run start', (f, r) => f.db.prepare('UPDATE runs SET started_at=? WHERE id=?').run('2026-02-30T16:00:00.000Z', r.input.runId)],
  ['future run finish', (f, r) => f.db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', r.input.runId)],
  ['accepted row on failed run', (f, r) => f.db.prepare("UPDATE runs SET status='error' WHERE id=?").run(r.input.runId)],
  ['changed target identity', f => f.db.prepare("UPDATE targets SET locator='MS4wLjABAAAAAnotherAuthor123456789'").run()],
  ['anchor raw corruption', f => f.db.prepare("UPDATE snapshots SET raw_json='{}'").run()],
  ['anchor audit missing', f => f.db.exec('DELETE FROM audits')],
  ['canonical checksum corruption', f => { f.db.exec('DROP TRIGGER works_observations_no_update'); f.db.exec("UPDATE works_observations SET source_checksum='bad'"); }],
  ['canonical identity rehash conflicts with anchor', f => {
    f.db.exec('DROP TRIGGER works_observations_no_update'); const row = f.db.prepare('SELECT * FROM works_observations').get();
    const raw = JSON.parse(row.raw_json); raw.identity.uid = '999999'; raw.posts[0].author.uid = '999999';
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=?').run(JSON.stringify(raw), checksum(raw));
  }],
  ['denormalized coverage mismatch', f => { f.db.exec('DROP TRIGGER works_observations_no_update'); f.db.exec("UPDATE works_observations SET coverage='unavailable'"); }],
  ['denormalized observation time mismatch', f => { f.db.exec('DROP TRIGGER works_observations_no_update');
    f.db.prepare('UPDATE works_observations SET observed_at=?').run(END); }],
  ['canonical run rehash cannot borrow existing completed run', f => {
    f.db.exec('DROP TRIGGER works_observations_no_update'); const row = f.db.prepare('SELECT * FROM works_observations').get();
    const raw = JSON.parse(row.raw_json); raw.runId--;
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=?').run(JSON.stringify(raw), checksum(raw));
  }],
]) test(`works-only read rejects ${name}`, t => {
  const f = fixture(t); const r = f.append(); mutate(f, r); f.db.exec('PRAGMA query_only=ON');
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF).length, 0);
  assert.equal(inspectUpdateSla(f.db, { now: ASOF }).works.daily.counts.limited, 0);
});

test('works-only read: legacy missing table stays readonly with unchanged snapshot result', t => {
  const f = fixture(t); f.db.exec('DROP TABLE works_observations; PRAGMA query_only=ON');
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF).length, 0);
  assert.equal(loadWorksObservations(f.database, ASOF).get(f.target.id).coverage, 'unavailable');
  assert.equal(inspectUpdateSla(f.db, { now: ASOF }).coreAccounts.fresh8h.complete, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='works_observations'").get().n, 0);
});

test('works-only read: old experimental ledger without run column is not migrated or credited', t => {
  const f = fixture(t); f.db.exec('DROP TABLE works_observations; CREATE TABLE works_observations(id INTEGER,raw_json TEXT); PRAGMA query_only=ON');
  assert.deepEqual(loadVerifiedWorksOnlyRows(f.db, ASOF), []);
  assert.equal(inspectUpdateSla(f.db, { now: ASOF }).works.daily.counts.limited, 0);
  assert.equal(f.db.prepare('PRAGMA table_info(works_observations)').all().length, 2);
});

test('works-only read: forged caller verification cannot enter SLA; run filter selects actual historical row', t => {
  const f = fixture(t); const r = f.append();
  const actual = loadVerifiedWorksOnlyRows(f.db, ASOF, f.target.id, { runId: r.input.runId });
  assert.equal(actual.length, 1); assert.equal(actual[0].run_id, r.input.runId);
  assert.equal(loadVerifiedWorksOnlyRows(f.db, ASOF, null, { runId: r.input.runId + 100 }).length, 0);
  const targets = [f.target];
  assert.equal(buildUpdateSla({ targets, snapshots: [], now: ASOF, worksObservations: actual }).works.daily.counts.complete, 1);
  assert.equal(buildUpdateSla({ targets, snapshots: [], now: END, worksObservations: actual }).works.daily.counts.limited, 0,
    'a later DB read receipt cannot retroactively make an unfinished run accepted');
  assert.equal(buildUpdateSla({ targets, snapshots: [], now: ASOF, worksObservations: structuredClone(actual) }).works.daily.counts.limited, 0);
  assert.throws(() => { actual[0].works_coverage = 'complete'; }, TypeError);
});
