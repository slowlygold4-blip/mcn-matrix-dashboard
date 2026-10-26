import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { rowsFor, csv } from '../../mcn-public-site/lib/replica-model.mjs';
import { growthSeries } from '../../mcn-public-site/lib/replica-trends.mjs';
import { parseAccountRequest, accountShareQuery, personalPoints, personalWindow } from '../../mcn-public-site/lib/replica-account.mjs';
import { readReplicaPart } from '../../mcn-public-site/lib/replica-reader.mjs';

const directory = new URL('../data/public-replica-staging/publisher-2026-10-01T02-43-24-280Z/', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, directory), 'utf8'));
const manifest = read('manifest.json'), catalog = read('catalog.json');
const keys = ['followers', 'likes', 'posts'];
const account = id => catalog.accounts.find(a => a.id === id);
const source = id => read(`daily/${id}.json`).items;
// The oracle reads the original account-specific saved daily files, not summary shards.
function expected(items, start, end) {
  const byDay = new Map(items.map(item => [item.date, item]));
  return Object.fromEntries(keys.map(key => {
    const first = byDay.get(start), last = byDay.get(end);
    return [key, { baseline: first?.[key] ?? null, value: last?.[key] ?? null,
      delta: first?.[key] == null || last?.[key] == null ? null : last[key] - first[key],
      baselineAt: first?.[`${key}At`] ?? null, currentAt: last?.[`${key}At`] ?? null }];
  }));
}
const projection = items => items.map(item => Object.fromEntries(['targetId', 'date', 'capturedAt', ...keys.flatMap(key => [key, `${key}At`])].map(key => [key, item[key]])));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const results = (id, start, end) => rowsFor([account(id)], projection(source(id)), start, end)[0].metrics;

test('reference files are the new natural publication generation and match its sealed hashes', () => {
  assert.equal(manifest.asOf, '2026-10-01T02:43:24.280Z');
  assert.equal(catalog.asOf, manifest.asOf);
  assert.equal(catalog.accounts.length, 761);
  const frozen = { 234: ['9dd996e6bbe117743b511a7cc363f77435aacf9cb7a35d575b1141dce7eccfe5', 29],
    2333: ['72a81e8b4a4dc2e1291f8c92d5c3fa195dd743282a951a49055fb1d54e7a8cfd', 16],
    348: ['2287a58d949bc2433688aaa75c3935eba6e4a16d3ce2b98d98180907d5119646', 7] };
  for (const [id, [hash, count]] of Object.entries(frozen)) {
    const path = `daily/${id}.json`, descriptor = manifest.files.find(file => file.path === path);
    assert.equal(createHash('sha256').update(readFileSync(new URL(path, directory))).digest('hex'), hash);
    assert.equal(descriptor.sha256, hash); assert.equal(descriptor.count, count);
    assert.equal(read(path).asOf, manifest.asOf); assert.equal(source(id).length, count);
  }
});

test('one real account has its own weekly endpoints, not matrix totals or legacy seed numbers', () => {
  const result = results(234, '2026-09-24', '2026-10-01');
  assert.deepEqual(result, expected(source(234), '2026-09-24', '2026-10-01'));
  assert.deepEqual(keys.map(key => result[key].delta), [14, 11_955, 17]);
  assert.equal(result.likes.delta * 100, 1_195_500);
  assert.equal(result.followers.baselineAt, '2026-09-24T02:24:50.000Z');
  assert.equal(result.followers.currentAt, '2026-10-01T02:40:02.117Z');
});

test('all personal weekly metric curves match raw dated observations at every position', () => {
  const fixed = { followers: [0, 0, 4, 5, 5, 7, 14, 14],
    likes: [0, 1_431, 3_618, 6_350, 7_454, 8_637, 10_559, 11_955],
    posts: [0, 3, 4, 8, 10, 12, 17, 17] };
  for (const metric of [...keys, 'estimated']) {
    const result = growthSeries([account(234)], projection(source(234)), { start: '2026-09-24', end: '2026-10-01', metric });
    const scale = metric === 'estimated' ? 100 : 1, field = metric === 'estimated' ? 'likes' : metric;
    const actual = result.points.map(point => point.current);
    assert.deepEqual(actual, fixed[field].map(value => value * scale));
    assert.equal(result.cohortCount, 1); assert.equal(result.points.length, 8);
    for (const point of result.points) {
      const independent = expected(source(234), '2026-09-24', point.currentDate)[field].delta;
      assert.equal(point.current, independent * scale); assert.equal(point.currentKnown, 1);
    }
  }
});

test('business baseline and all saved personal history are distinct scopes', () => {
  const business = results(234, '2026-09-12', '2026-10-01'), all = results(234, '2026-09-01', '2026-10-01');
  assert.deepEqual(business, expected(source(234), '2026-09-12', '2026-10-01'));
  assert.deepEqual(all, expected(source(234), '2026-09-01', '2026-10-01'));
  assert.deepEqual(keys.map(key => business[key].delta), [201, 42_259, 44]);
  assert.deepEqual(keys.map(key => all[key].delta), [342, 59_778, 54]);
  assert.equal(source(234)[0].date, '2026-09-01');
});

test('paused pre-business account remains accessible as saved personal history and real zero', () => {
  assert.equal(account(348).enabled, false);
  const result = results(348, '2026-09-02', '2026-09-08');
  assert.deepEqual(result, expected(source(348), '2026-09-02', '2026-09-08'));
  assert.deepEqual(keys.map(key => result[key].delta), [0, 1, 0]);
  const series = growthSeries([account(348)], projection(source(348)), { start: '2026-09-02', end: '2026-09-08' });
  assert.equal(series.cohortCount, 1); assert.equal(series.totalCount, 1);
  assert.deepEqual(series.points.map(point => point.current), [0, 0, 0, 0, 0, 0, 0]);
  const likes = growthSeries([account(348)], projection(source(348)), { start: '2026-09-02', end: '2026-09-08', metric: 'likes' });
  assert.deepEqual(likes.points.map(point => point.current), [0, 0, 1, 1, 1, 1, 1]);
});

test('real endpoint zero does not become unknown while a missing baseline does not become zero', () => {
  const paired = results(2333, '2026-09-24', '2026-10-01'), missing = results(2333, '2026-09-12', '2026-10-01');
  assert.deepEqual(keys.map(key => paired[key].delta), [0, 0, 0]);
  assert.deepEqual(keys.map(key => missing[key].delta), [null, null, null]);
  assert.deepEqual(keys.map(key => missing[key].value), [211, 186, 5]);
  const a = growthSeries([account(2333)], projection(source(2333)), { start: '2026-09-24', end: '2026-10-01' });
  const b = growthSeries([account(2333)], projection(source(2333)), { start: '2026-09-12', end: '2026-10-01' });
  assert.equal(a.cohortCount, 1); assert.ok(a.points.every(point => point.current === 0));
  assert.equal(b.cohortCount, 0); assert.ok(b.points.every(point => point.current === null));
});

test('personal decrease and its estimated proxy are preserved, never clamped to growth', () => {
  const first = results(2333, '2026-09-21', '2026-09-22'), second = results(2333, '2026-09-23', '2026-09-24');
  assert.equal(first.followers.delta, -1); assert.equal(second.likes.delta, -1);
  const series = growthSeries([account(2333)], projection(source(2333)), { start: '2026-09-23', end: '2026-09-24', metric: 'estimated' });
  assert.deepEqual(series.points.map(point => point.current), [0, -100]);
});

test('personal growth keeps missing calendar positions as null instead of interpolation', () => {
  const result = growthSeries([account(2333)], projection(source(2333)), { start: '2026-09-14', end: '2026-10-01' });
  assert.equal(result.points.length, 18); assert.equal(result.cohortCount, 1);
  const gaps = result.points.filter(point => ['2026-09-18', '2026-09-19'].includes(point.currentDate));
  assert.equal(gaps.length, 2); assert.ok(gaps.every(point => point.current === null && point.currentKnown === 0));
  assert.equal(result.points.at(-1).current, 10);
});

test('individual four-endpoint comparison keeps one same account or no comparable cohort', () => {
  const points = projection(source(2333)), accounts = [account(2333)];
  const complete = growthSeries(accounts, points, { start: '2026-09-24', end: '2026-10-01', otherStart: '2026-09-20', otherEnd: '2026-09-24' });
  assert.equal(complete.cohortCount, 1); assert.equal(complete.points.at(-1).current, 0);
  const incomplete = growthSeries(accounts, points, { start: '2026-09-24', end: '2026-10-01', otherStart: '2026-09-12', otherEnd: '2026-09-24' });
  assert.equal(incomplete.cohortCount, 0); assert.ok(incomplete.points.every(point => point.current === null && point.comparison === null));
});

test('personal model is immutable and CSV preserves zero, negative, null and formula-safe identity', () => {
  const accounts = freeze([structuredClone(account(2333))]), points = freeze(projection(source(2333)));
  const before = JSON.stringify({ accounts, points });
  rowsFor(accounts, points, '2026-09-23', '2026-09-24');
  growthSeries(accounts, points, { start: '2026-09-23', end: '2026-09-24', metric: 'likes' });
  assert.equal(JSON.stringify({ accounts, points }), before);
  const exported = csv([['=HYPERLINK("https://invalid.test")', 0, -1, null]]);
  assert.ok(exported.startsWith('\ufeff')); assert.match(exported, /"0","-1",""/); assert.match(exported, /'=HYPERLINK/);
});

test('individual URLs support no dates yet and round-trip only the canonical four-field share contract', () => {
  assert.equal(parseAccountRequest(''), null);
  assert.equal(parseAccountRequest('?theme=tuantuan&classification=slice&period=week'), null);
  assert.deepEqual(parseAccountRequest('?account=348'), { id: 348, start: null, end: null, generation: null });
  const wanted = { id: 348, start: '2026-09-02', end: '2026-09-08', generation: manifest.asOf };
  const query = accountShareQuery(wanted);
  assert.ok(query.startsWith('?')); assert.deepEqual(parseAccountRequest(query), wanted);
  assert.deepEqual([...new URLSearchParams(query).keys()], ['account', 'start', 'end', 'generation']);
});

test('duplicate or non-canonical account identifiers cannot select a different author silently', () => {
  for (const query of ['?account=234&account=348', '?account=234&%61ccount=348',
    ...['', '0', '-1', '0234', '234.0', '2.34e2', '0xea', '%2B234', '%20234', '9007199254740992', '100000000'].map(id => `?account=${id}`)]) {
    assert.throws(() => parseAccountRequest(query), Error, query);
  }
  const unknown = parseAccountRequest('?account=99999999');
  assert.equal(unknown.id, 99_999_999); assert.equal(catalog.accounts.find(a => a.id === unknown.id), undefined);
});

test('duplicate, half-provided, reversed and invalid calendar ranges are rejected at the personal URL boundary', () => {
  for (const query of [
    '?account=234&start=2026-09-24', '?account=234&end=2026-10-01',
    '?account=234&start=&end=', '?account=234&start=2026-09-24&start=2026-09-25&end=2026-10-01',
    '?account=234&start=2026-09-24&end=2026-10-01&end=2026-10-02',
    '?account=234&start=2026-10-01&end=2026-09-24',
    '?account=234&start=2026-02-29&end=2026-10-01',
    '?account=234&start=2026-09-31&end=2026-10-01',
    '?account=234&start=2026-09-24T00:00:00Z&end=2026-10-01',
    '?start=2026-09-24&end=2026-10-01',
  ]) assert.throws(() => parseAccountRequest(query), Error, query);
  assert.deepEqual(parseAccountRequest('?account=234&start=2026-09-24&end=2026-09-24'),
    { id: 234, start: '2026-09-24', end: '2026-09-24', generation: null });
});

test('generation selectors are canonical, fixed, optional for initial navigation and mandatory for share', () => {
  const old = '2026-10-01T01:31:30.130Z';
  assert.equal(parseAccountRequest(`?account=234&generation=${old}`).generation, old);
  for (const query of ['?account=234&generation=', '?account=234&generation=not-a-generation',
    '?account=234&generation=2026-10-01T02:43:24.280%2B00:00',
    '?account=234&generation=2026-10-01T02:43:24Z',
    `?account=234&generation=${old}&generation=${manifest.asOf}`, `?generation=${manifest.asOf}`]) {
    assert.throws(() => parseAccountRequest(query), Error, query);
  }
  assert.throws(() => accountShareQuery({ id: 234, start: '2026-09-24', end: '2026-10-01', generation: null }));
  assert.throws(() => accountShareQuery({ id: 234, start: null, end: null, generation: manifest.asOf }));
});

test('foreign hosts and redirect parameters cannot be reflected into the personal share target', () => {
  const wanted = { id: 234, start: '2026-09-24', end: '2026-10-01', generation: manifest.asOf };
  const query = accountShareQuery({ ...wanted, origin: 'https://invalid.test', redirect: 'https://invalid.test', part: '../../private' });
  assert.deepEqual(parseAccountRequest(query + '&redirect=https%3A%2F%2Finvalid.test&origin=https%3A%2F%2Finvalid.test'), wanted);
  assert.equal(new URL(query, 'https://mcn-matrix-observatory.slowlygold4.chatgpt.site/').origin,
    'https://mcn-matrix-observatory.slowlygold4.chatgpt.site');
  assert.equal(new URLSearchParams(query).has('redirect'), false);
  assert.equal(new URLSearchParams(query).has('origin'), false); assert.equal(new URLSearchParams(query).has('part'), false);
  assert.throws(() => parseAccountRequest('?account=https%3A%2F%2Finvalid.test%2Fprivate'));
});

test('personal safe projection contains only nine public summary keys and preserves raw source input', () => {
  const original = source(234), raw = freeze(structuredClone(original)), before = JSON.stringify(raw);
  const actual = personalPoints(raw, 234, manifest.asOf);
  assert.deepEqual(actual, projection(original)); assert.equal(JSON.stringify(raw), before);
  const permitted = ['targetId', 'date', 'capturedAt', ...keys.flatMap(key => [key, `${key}At`])].sort();
  assert.ok(actual.every(point => Object.keys(point).sort().join() === permitted.join()));
  const extra = [{ ...original[0], cookie: 'synthetic-private-field', authorization: 'synthetic-private-field' }];
  const filtered = personalPoints(extra, 234, manifest.asOf);
  assert.equal(Object.hasOwn(filtered[0], 'cookie'), false); assert.equal(Object.hasOwn(filtered[0], 'authorization'), false);
});

test('paused and early personal defaults come from all saved dates, not enabled business-only dates', () => {
  const paused = personalPoints(source(348), 348, manifest.asOf);
  const active = personalPoints(source(234), 234, manifest.asOf);
  const recent = personalPoints(source(2333), 2333, manifest.asOf);
  assert.deepEqual(personalWindow(paused, manifest.asOf), { start: '2026-09-02', end: '2026-09-08' });
  assert.deepEqual(personalWindow(active, manifest.asOf), { start: '2026-09-01', end: '2026-10-01' });
  assert.deepEqual(personalWindow(recent, manifest.asOf), { start: '2026-09-14', end: '2026-10-01' });
  assert.deepEqual(personalWindow([], manifest.asOf), { start: null, end: null });
  assert.deepEqual(personalWindow([...paused].reverse(), manifest.asOf), { start: '2026-09-02', end: '2026-09-08' });
});

test('personal boundary rejects wrong author, repeated daily identity and invalid counts without mutation', () => {
  const original = source(234), first = original[0], before = JSON.stringify(original);
  assert.throws(() => personalPoints([first], 348, manifest.asOf));
  assert.throws(() => personalPoints([first, structuredClone(first)], 234, manifest.asOf));
  for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '10']) {
    assert.throws(() => personalPoints([{ ...first, followers: value }], 234, manifest.asOf));
  }
  for (const id of [0, -1, 234.5, 100_000_000]) assert.throws(() => personalPoints(original, id, manifest.asOf));
  assert.equal(JSON.stringify(original), before);
});

test('future or inconsistent per-metric observations cannot become current personal values', () => {
  const first = source(234)[0], last = source(234).at(-1);
  const future = { ...last, capturedAt: '2026-10-01T02:43:24.281Z' };
  assert.throws(() => personalPoints([future], 234, manifest.asOf));
  assert.throws(() => personalPoints([last], 234, '2026-10-01T01:31:30.130Z'));
  assert.throws(() => personalPoints([{ ...last, followersAt: '2026-10-01T02:40:02.118Z' }], 234, manifest.asOf));
  assert.throws(() => personalPoints([{ ...first, date: '2026-09-02' }], 234, manifest.asOf));
  assert.throws(() => personalPoints([{ ...first, followersAt: null }], 234, manifest.asOf));
  assert.throws(() => personalWindow(projection([future]), manifest.asOf));
});

test('an explicit unknown value with no observation time stays null alongside real zero and immutable window', () => {
  const first = { ...source(234)[0], followers: 0, likes: null, likesAt: null };
  const raw = freeze([first]), before = JSON.stringify(raw), safe = freeze(personalPoints(raw, 234, manifest.asOf));
  assert.equal(safe[0].followers, 0); assert.equal(safe[0].likes, null); assert.equal(safe[0].likesAt, null);
  assert.deepEqual(personalWindow(safe, manifest.asOf), { start: '2026-09-01', end: '2026-09-01' });
  const model = rowsFor([account(234)], safe, '2026-09-01', '2026-09-01')[0].metrics;
  assert.equal(model.followers.delta, 0); assert.equal(model.likes.delta, null); assert.equal(JSON.stringify(raw), before);
});

function sealedReader(payload, targetId = 234, changes = {}, headerChanges = {}) {
  const text = JSON.stringify(payload), bytes = new TextEncoder().encode(text).length;
  const sha256 = createHash('sha256').update(text).digest('hex');
  const part = `daily/${targetId}.json`;
  const meta = { path: part, kind: 'daily', targetId, count: payload.items.length, bytes, sha256, ...changes };
  return { generation: manifest.asOf, part, meta,
    fetcher: async path => {
      const query = new URL(path, 'https://local.invalid').searchParams;
      assert.equal(query.get('generation'), manifest.asOf); assert.equal(query.get('part'), part);
      return new Response(text, { headers: { 'X-Data-SHA256': sha256,
        'X-Data-Cutoff': manifest.asOf, ...headerChanges } });
    } };
}

test('personal reader verifies a whole real partition before any row is rendered or exported', async () => {
  const body = freeze(read('daily/234.json')), before = JSON.stringify(body);
  const result = await readReplicaPart(sealedReader(body));
  assert.deepEqual(result, body); assert.equal(JSON.stringify(body), before);
  assert.equal(result.items.length, 29);
  const configured = sealedReader(body, 234, { targetId: 348 });
  await assert.rejects(() => readReplicaPart(configured), /有效发布清单/);
});

test('a valid hash from another generation cannot be relabelled as this personal cutoff', async () => {
  const old = read('daily/234.json'); old.asOf = '2026-10-01T01:31:30.130Z';
  await assert.rejects(() => readReplicaPart(sealedReader(old)), /版本不一致/);
  const body = read('daily/234.json');
  await assert.rejects(() => readReplicaPart(sealedReader(body, 234, {}, { 'X-Data-Cutoff': old.asOf })), /版本不一致/);
  await assert.rejects(() => readReplicaPart(sealedReader(body, 234, {}, { 'X-Data-SHA256': '0'.repeat(64) })), /校验不一致/);
  await assert.rejects(() => readReplicaPart(sealedReader(body, 234, { bytes: JSON.stringify(body).length + 1 })), /校验不一致/);
  await assert.rejects(() => readReplicaPart(sealedReader(body, 234, { sha256: '0'.repeat(64) })), /校验不一致/);
});

test('a sealed personal body with wrong author, count or duplicate raw identities fails closed', async () => {
  const body = read('daily/234.json');
  const wrongAuthor = structuredClone(body); wrongAuthor.items[0].targetId = 348;
  await assert.rejects(() => readReplicaPart(sealedReader(wrongAuthor)), /归属或条数/);
  await assert.rejects(() => readReplicaPart(sealedReader(body, 234, { count: 30 })), /归属或条数/);
  const duplicateId = structuredClone(body); duplicateId.items[1].id = duplicateId.items[0].id;
  await assert.rejects(() => readReplicaPart(sealedReader(duplicateId)), /重复或无效/);
  const duplicateDate = structuredClone(body); duplicateDate.items[1].date = duplicateDate.items[0].date;
  await assert.rejects(() => readReplicaPart(sealedReader(duplicateDate)), /观察日重复/);
});
