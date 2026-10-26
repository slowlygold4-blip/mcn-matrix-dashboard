import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { checksum } from '../lib/utils.mjs';
import { describeWorksObservation, loadWorksObservations } from '../lib/works-observation.mjs';

// Independent pre-optimization query, embedded rather than loaded from a
// local backup. It intentionally retains ROW_NUMBER and the original single
// asOf parameter so candidate selection cannot silently follow the new query.
function legacyQuery(hasWorksTime, targetId) {
  const worksTime = hasWorksTime ? 'COALESCE(s.works_observed_at,s.captured_at)' : 's.captured_at';
  const clause = targetId === null ? "t.type='account'" : "t.type='account' AND t.id=?";
  return `
    WITH ranked AS (
      SELECT s.id,s.target_id,${worksTime} AS captured_at,s.total_posts,s.works_coverage,s.source_checksum,
        ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY julianday(${worksTime}) DESC,s.id DESC) AS latest_rank,
        ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY
          CASE WHEN s.works_coverage IN ('complete','limited','latest-public-window') THEN 0 ELSE 1 END,
          julianday(${worksTime}) DESC,s.id DESC) AS window_rank
      FROM snapshots s JOIN targets t ON t.id=s.target_id
      WHERE ${clause} AND s.quality_status!='rejected' AND julianday(${worksTime})<=julianday(?)
    ), chosen AS (
      SELECT r.*,CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END AS source_json
      FROM ranked r JOIN snapshots s ON s.id=r.id
      WHERE r.latest_rank=1 OR (r.window_rank<=2 AND r.works_coverage IN ('complete','limited','latest-public-window'))
    )
    SELECT c.id,c.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',c.captured_at) AS captured_at,
      c.total_posts,c.works_coverage,c.source_checksum,
      json_type(c.source_json,'$.works.aweme_list') AS list_type,
      CASE WHEN json_type(c.source_json,'$.works.aweme_list')='array'
        THEN json_array_length(c.source_json,'$.works.aweme_list') END AS list_count,
      CASE WHEN json_type(c.source_json,'$.works.stopReason')='text'
        THEN json_extract(c.source_json,'$.works.stopReason') END AS stop_reason,
      (SELECT json_group_array(json_object(
        'id',CASE WHEN j.type='object' AND json_type(j.value,'$.aweme_id')='text'
          THEN json_extract(j.value,'$.aweme_id') END,
        'publishedAt',CASE WHEN j.type='object' AND json_type(j.value,'$.create_time') IN ('text','integer','real')
          THEN json_extract(j.value,'$.create_time') END))
       FROM json_each(CASE WHEN json_type(c.source_json,'$.works.aweme_list')='array'
         THEN json_extract(c.source_json,'$.works.aweme_list') ELSE '[]' END) j) AS entries_json
    FROM chosen c ORDER BY c.target_id,julianday(c.captured_at) DESC,c.id DESC
  `;
}

const BASE = Date.parse('2026-09-28T00:00:00.000Z');
const iso = milliseconds => new Date(milliseconds).toISOString();
const at = hours => iso(BASE + hours * 3600_000);
const offset = milliseconds => iso(milliseconds + 8 * 3600_000).replace('Z', '+08:00');

function fixture(t, hasWorksTime) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // Deliberately no works ledger: isolate snapshot selection without invoking
  // ingestion, migrations, network collection, or any production database.
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,
      quality_status TEXT,total_posts INTEGER,works_coverage TEXT,source_checksum TEXT,raw_json TEXT
      ${hasWorksTime ? ',works_observed_at TEXT' : ''});
    CREATE INDEX idx_snapshots_target_captured_id ON snapshots(target_id,captured_at DESC,id DESC);
    INSERT INTO targets(id,type) VALUES(1,'account'),(2,'account'),(3,'account'),(4,'hashtag');`);
  const columns = db.prepare('PRAGMA table_info(snapshots)').all();
  const insert = db.prepare(`INSERT INTO snapshots(id,target_id,captured_at,quality_status,total_posts,
    works_coverage,source_checksum,raw_json${hasWorksTime ? ',works_observed_at' : ''})
    VALUES(?,?,?,?,?,?,?,?${hasWorksTime ? ',?' : ''})`);
  const add = ({ id, target = 1, capturedAt = at(id), worksAt = null, quality = 'validated',
    coverage = 'complete', inventory = 1, rawJson } = {}) => {
    const raw = { works: { stopReason: 'end-of-list', aweme_list: [
      { aweme_id: String(7200000000000000000n + BigInt(id)), create_time: BASE / 1000 },
    ] } };
    const text = rawJson === undefined ? JSON.stringify(raw) : rawJson;
    insert.run(id, target, capturedAt, quality, inventory, coverage, checksum(raw), text,
      ...(hasWorksTime ? [worksAt] : []));
  };
  const seal = () => db.exec('PRAGMA query_only=ON');
  return { db, add, seal, hasWorksTime, columns };
}

function compare(f, asOf, targetId = null) {
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const sources = f.db.prepare('SELECT * FROM snapshots ORDER BY id').all();
  const expectedRows = f.db.prepare(legacyQuery(f.hasWorksTime, targetId))
    .all(...(targetId === null ? [asOf] : [targetId, asOf]));
  const selections = [];
  const wrapped = new Proxy(f.db, { get(db, name) {
    if (name !== 'prepare') return typeof db[name] === 'function' ? db[name].bind(db) : db[name];
    return sql => {
      const statement = db.prepare(sql);
      if (!sql.includes('AS entries_json') || !sql.includes('FROM chosen c')) return statement;
      return new Proxy(statement, { get(value, method) {
        if (method !== 'all') return typeof value[method] === 'function' ? value[method].bind(value) : value[method];
        return (...args) => {
          const rows = value.all(...args);
          selections.push(rows);
          return rows;
        };
      } });
    };
  } });
  const actual = loadWorksObservations({ db: wrapped }, asOf, targetId);
  assert.equal(selections.length, 1, 'inspect exactly one production snapshot projection');
  assert.deepEqual(selections[0], expectedRows, `selected source rows differ: ${asOf}, target ${targetId}`);
  const grouped = new Map();
  for (const row of expectedRows) {
    if (!grouped.has(row.target_id)) grouped.set(row.target_id, []);
    grouped.get(row.target_id).push(row);
  }
  const expected = new Map([...grouped].map(([id, rows]) => [id, describeWorksObservation(rows, asOf)]));
  assert.deepEqual(actual, expected, 'the downstream works observation contract is unchanged');
  assert.deepEqual(f.db.prepare('SELECT * FROM snapshots ORDER BY id').all(), sources);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(f.db.prepare('PRAGMA table_info(snapshots)').all(), f.columns, 'reads do not migrate legacy schemas');
  return { rows: selections[0], observations: actual };
}

for (const hasWorksTime of [false, true]) {
  const schema = hasWorksTime ? 'separate works time' : 'legacy captured time';
  test(`snapshot candidates (${schema}): latest failure and exactly two accepted windows, with target scoping`, t => {
    const f = fixture(t, hasWorksTime);
    f.add({ id: 1, capturedAt: at(10), coverage: 'complete' });
    f.add({ id: 2, capturedAt: offset(BASE + 10 * 3600_000), coverage: 'limited', quality: 'warning' });
    f.add({ id: 3, capturedAt: at(11), coverage: 'latest-public-window' });
    f.add({ id: 4, capturedAt: at(12), coverage: 'unavailable' });
    f.add({ id: 5, capturedAt: at(13), quality: 'rejected' });
    f.add({ id: 6, capturedAt: at(24) });
    f.add({ id: 20, target: 2, capturedAt: at(9), coverage: 'retry' });
    f.add({ id: 40, target: 4, capturedAt: at(11) });
    f.add({ id: 99, target: 99, capturedAt: at(11) });
    f.seal();
    assert.deepEqual(compare(f, at(12)).rows.map(row => row.id), [4, 3, 2, 20]);
    const selected = compare(f, at(12), 1);
    assert.deepEqual(selected.rows.map(row => row.id), [4, 3, 2]);
    assert.equal(selected.observations.get(1).coverage, 'unavailable');
    assert.equal(selected.observations.get(1).observedAt, at(11));
    assert.equal(selected.observations.get(1).lastAttemptAt, at(12));
    assert.equal(selected.observations.get(1).carriedForward, true);
    assert.deepEqual(compare(f, at(10), 1).rows.map(row => row.id), [2, 1], 'offset-equal timestamps use descending id');
    assert.deepEqual(compare(f, at(11), 1).rows.map(row => row.id), [3, 2], 'UNION removes overlap with latest');
    assert.deepEqual(compare(f, at(13), 1).rows.map(row => row.id), [4, 3, 2], 'rejected rows occupy no selected slot');
    for (const target of [3, 4, 99]) assert.deepEqual(compare(f, at(12), target).rows, []);
    assert.deepEqual(compare(f, at(8)).rows, [], 'before every observation is an empty result');
  });

  test(`snapshot candidates (${schema}): null, malformed and millisecond timestamps retain SQL cutoff semantics`, t => {
    const f = fixture(t, hasWorksTime);
    f.add({ id: 10, capturedAt: at(10) });
    f.add({ id: 11, capturedAt: offset(BASE + 10 * 3600_000) });
    f.add({ id: 12, capturedAt: null });
    f.add({ id: 13, capturedAt: 'not-a-time' });
    f.add({ id: 14, capturedAt: '2026-09-28T25:00:00Z' });
    f.add({ id: 15, capturedAt: at(10), quality: null });
    f.add({ id: 16, capturedAt: iso(BASE + 10 * 3600_000 + 1) });
    f.seal();
    assert.deepEqual(compare(f, at(10), 1).rows.map(row => row.id), [11, 10]);
    assert.deepEqual(compare(f, offset(BASE + 10 * 3600_000), 1).rows.map(row => row.id), [11, 10]);
    assert.deepEqual(compare(f, iso(BASE + 10 * 3600_000 + 1), 1).rows.map(row => row.id), [16, 11]);
    assert.deepEqual(compare(f, at(24), 1).rows.map(row => row.id), [16, 11]);
  });

  test(`snapshot candidates (${schema}): selection does not replace malformed advertised windows with older usable JSON`, t => {
    const f = fixture(t, hasWorksTime);
    f.add({ id: 1, capturedAt: at(8), coverage: 'complete' });
    f.add({ id: 2, capturedAt: at(9), coverage: 'limited', rawJson: '{broken-json' });
    f.add({ id: 3, capturedAt: at(10), coverage: 'latest-public-window', rawJson: '{"works":{"aweme_list":null}}' });
    f.add({ id: 4, capturedAt: at(11), coverage: 'unavailable', rawJson: 'null' });
    f.seal();
    const result = compare(f, at(12), 1);
    assert.deepEqual(result.rows.map(row => row.id), [4, 3, 2]);
    assert.deepEqual(result.rows.map(row => row.list_count), [null, null, null]);
    assert.equal(result.observations.get(1).coverage, 'unavailable');
    assert.equal(result.observations.get(1).observedAt, null);
  });

  test(`snapshot candidates (${schema}): deterministic mixed histories match the independent old query`, t => {
    const f = fixture(t, hasWorksTime);
    const targets = [1, 2, 3, 4, 99];
    const qualities = ['validated', 'warning', 'rejected', null];
    const coverages = ['complete', 'limited', 'latest-public-window', 'retry', 'unavailable', 'unknown', null];
    for (let id = 1; id <= 90; id++) {
      const instant = BASE + (id % 8) * 3600_000 + (id % 3) * 1000;
      f.add({ id, target: targets[id % targets.length],
        capturedAt: id % 11 === 0 ? null : id % 13 === 0 ? 'invalid-time' : id % 2 ? iso(instant) : offset(instant),
        worksAt: id % 4 === 0 ? null : id % 7 === 0 ? 'invalid-works-time' : iso(instant + (id % 5 - 2) * 60_000),
        quality: qualities[id % qualities.length], coverage: coverages[id % coverages.length],
        inventory: id % 4,
        ...(id % 17 === 0 ? { rawJson: 'malformed' } : {}),
      });
    }
    f.seal();
    for (const asOf of [at(-1), at(0), at(3), at(6), at(10)]) {
      for (const target of [null, 1, 2, 3, 4, 999]) compare(f, asOf, target);
    }
  });
}

test('snapshot candidates: independent works time, null fallback and invalid non-null time remain distinct', t => {
  const f = fixture(t, true);
  f.add({ id: 1, capturedAt: at(8), worksAt: at(10) });
  f.add({ id: 2, capturedAt: at(9), worksAt: at(11) });
  f.add({ id: 3, capturedAt: at(12), worksAt: at(9), coverage: 'limited' });
  f.add({ id: 4, capturedAt: at(11), worksAt: null, coverage: 'unavailable' });
  f.add({ id: 5, capturedAt: at(9), worksAt: 'invalid-works-time' });
  f.add({ id: 6, capturedAt: null, worksAt: at(10.5), coverage: 'latest-public-window' });
  f.add({ id: 7, capturedAt: 'invalid-profile-time', worksAt: at(10.75), coverage: 'limited' });
  f.add({ id: 8, capturedAt: 'invalid-profile-time', worksAt: null });
  f.add({ id: 9, capturedAt: at(8), worksAt: null });
  f.seal();
  assert.deepEqual(compare(f, at(10), 1).rows.map(row => row.id), [1, 3],
    'a later profile capture must not replace the independent works-time cutoff');
  assert.deepEqual(compare(f, at(10.75), 1).rows.map(row => row.id), [7, 6]);
  const result = compare(f, at(11), 1);
  assert.deepEqual(result.rows.map(row => row.id), [4, 2, 7]);
  assert.deepEqual(result.rows.map(row => row.captured_at), [at(11), at(11), at(10.75)]);
  assert.equal(result.observations.get(1).carriedForward, true);
  assert.equal(result.observations.get(1).observedAt, at(11));
});

test('snapshot candidates: equal offset works timestamps break ties by id independently of profile time', t => {
  const f = fixture(t, true);
  f.add({ id: 1, capturedAt: at(12), worksAt: at(10), coverage: 'complete' });
  f.add({ id: 2, capturedAt: at(8), worksAt: offset(BASE + 10 * 3600_000), coverage: 'limited' });
  f.add({ id: 3, capturedAt: at(7), worksAt: at(10), coverage: 'latest-public-window' });
  f.seal();
  const result = compare(f, at(10), 1);
  assert.deepEqual(result.rows.map(row => row.id), [3, 2]);
  assert.equal(result.observations.get(1).sourceChecksum, result.rows[0].source_checksum);
});

test('snapshot candidates: an empty target catalog stays empty for both reader scopes', t => {
  const f = fixture(t, false);
  f.add({ id: 1, capturedAt: at(10) });
  f.db.exec('DELETE FROM targets');
  f.seal();
  assert.deepEqual(compare(f, at(12)).rows, []);
  assert.deepEqual(compare(f, at(12), 1).rows, []);
});
