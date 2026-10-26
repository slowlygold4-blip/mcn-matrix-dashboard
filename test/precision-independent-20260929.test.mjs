import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { MonitorDatabase } from '../lib/database.mjs';
import { checksum } from '../lib/utils.mjs';
import { observeFirstPageActivation, sanitizeFirstPageActivationStructure } from '../lib/browser-first-page-activation.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

const USER = '619e0b66000000001000e923';
const NOTE = '68e66fef0000000004023fdb';
const SECOND = '68e66fef0000000004023fdc';
const account = { type: 'account', label: 'offline precision peer', locator: `https://www.xiaohongshu.com/user/profile/${USER}`, provider: 'public-web', metadata: { platform: 'xiaohongshu' } };
const note = (id, likes) => ({ id, noteCard: { user: { userId: USER, nickname: 'offline precision peer' }, time: 1788184800000, displayTitle: 'offline', interactInfo: { likedCount: likes } } });
async function collect(target, { fans = '0', combined = '0', notes = [] } = {}) {
  let requests = 0;
  const initial = { user: { userPageData: { basicInfo: { nickname: 'offline precision peer' }, result: { success: true }, interactions: [
    { type: 'fans', count: fans }, { type: 'interaction', count: combined },
  ] }, noteQueries: [{ userId: USER }], notes: [notes], hasMore: false, cursor: 0 } };
  const provider = new PublicWebProvider({ publicPostsPerAccount: '30' }, {
    fetchImpl: async url => { requests++; assert.equal(url, account.locator); return { ok: true, status: 200, text: async () => `<script>window.__INITIAL_STATE__=${JSON.stringify(initial)}</script>` }; },
    execFileImpl: () => { throw Error('Offline fixture forbids subprocesses'); },
  });
  const result = await provider.collect(target);
  assert.equal(requests, 1);
  return result;
}

test('independent mixed XHS notes preserve exact zero, drop invalid identity, and never promote first screen to complete', async t => {
  const db = new MonitorDatabase(':memory:'); t.after(() => db.close());
  const target = db.createTarget(account);
  const result = await collect(target, { notes: [note(NOTE.toUpperCase(), '0'), note('../../invalid', '999'), note(SECOND, '约123')] });
  assert.equal(result.snapshot.followers, 0);
  assert.equal(result.snapshot.totalLikes, null);
  assert.equal(result.snapshot.totalPosts, null);
  assert.equal(result.worksCoverage, 'limited');
  assert.deepEqual(result.posts.map(p => [p.externalId, p.likes]), [[NOTE, 0], [SECOND, null]]);
  assert.equal(result.raw.publicObservations.notes.length, 3);
  assert.equal(result.raw.publicObservations.notes[1].accepted, false);
  db.saveCollection(target, db.beginRun('test', target.id, 1), result);
  const snapshot = db.db.prepare('SELECT followers,total_likes,total_posts,works_coverage,raw_json,source_checksum FROM snapshots').get();
  assert.deepEqual([snapshot.followers, snapshot.total_likes, snapshot.total_posts, snapshot.works_coverage], [0, null, null, 'limited']);
  assert.equal(snapshot.source_checksum, checksum(JSON.parse(snapshot.raw_json)));
  assert.deepEqual(db.db.prepare('SELECT external_id,likes FROM posts ORDER BY external_id').all().map(p => [p.external_id, p.likes]), [[NOTE, 0], [SECOND, null]]);
  assert.deepEqual(db.db.prepare('SELECT likes,comments,shares,collects,plays FROM post_metrics ORDER BY id').all().map(p => Object.values(p)), [[0, null, null, null, null], [null, null, null, null, null]]);
});

test('independent nested source observations do not contaminate metrics or fabricate notes through DB persistence', async t => {
  const db = new MonitorDatabase(':memory:'); t.after(() => db.close());
  const target = db.createTarget(account);
  const injected = { follower_count: 9876, total_favorited: 7654, aweme_count: 123, aweme_list: [{ aweme_id: NOTE, statistics: { digg_count: 111 } }] };
  const result = await collect(target, { fans: injected, combined: injected, notes: [note({ id: NOTE, aweme_id: NOTE }, injected)] });
  assert.deepEqual([result.snapshot.followers, result.snapshot.totalLikes, result.snapshot.totalPosts], [null, null, null]);
  assert.equal(result.worksCoverage, 'unavailable'); assert.deepEqual(result.posts, []);
  assert.deepEqual(result.raw.publicObservations.accountInteractions[0].count, injected);
  db.saveCollection(target, db.beginRun('test', target.id, 1), result);
  for (const table of ['posts', 'post_metrics']) assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  const row = db.db.prepare('SELECT raw_json,source_checksum,followers,total_likes,total_posts FROM snapshots').get();
  assert.deepEqual([row.followers, row.total_likes, row.total_posts], [null, null, null]);
  const saved = JSON.parse(row.raw_json); assert.equal(row.source_checksum, checksum(saved));
  saved.publicObservations.accountInteractions[0].count.follower_count++;
  assert.notEqual(row.source_checksum, checksum(saved), 'source observations remain hash-bound even when excluded from normalization');
});

test('independent approximate and malformed display values stay unknown while combined zero remains unknown likes', async () => {
  for (const value of ['约 100', '100+', '1.00', '１２０', '1 000', '01,234', '1,234万', false, ['123'], Number.MAX_SAFE_INTEGER + 1]) {
    const result = await collect({ ...account, id: 1 }, { fans: value, notes: [note(NOTE, value)] });
    assert.equal(result.snapshot.followers, null, String(value));
    assert.equal(result.posts[0].likes, null, String(value));
    assert.equal(result.snapshot.totalLikes, null);
  }
});

test('independent diagnostics sanitizer is idempotent and rejects non-integer counts and arbitrary content', () => {
  const privateValue = 'PRIVATE_DO_NOT_PERSIST';
  for (const invalid of [NaN, Infinity, -1, 0.5, '1', true, [], {}, Number.MAX_SAFE_INTEGER]) {
    const input = { reason: privateValue, regionCount: invalid, visibleRegionCount: invalid, leafRegionCount: invalid, ancestorCount: invalid, x: 42, cookie: privateValue, nodes: [privateValue] };
    const expected = { reason: 'not-eligible', regionCount: null, visibleRegionCount: null, leafRegionCount: null, ancestorCount: null };
    assert.deepEqual(sanitizeFirstPageActivationStructure(input), expected);
    const output = sanitizeBrowserWorksDiagnostics({ version: 1, firstPageActivation: { state: privateValue, attemptCount: 2, structure: input } });
    assert.deepEqual(output.firstPageActivation, { state: 'unavailable', attemptCount: null, structure: expected });
    assert.deepEqual(sanitizeBrowserWorksDiagnostics(output), output);
    assert.ok(!JSON.stringify(output).includes(privateValue));
    assert.ok(!JSON.stringify(output).includes('"x"'));
  }
  for (const input of [null, undefined, [], 'eligible', 1, false]) assert.equal(sanitizeFirstPageActivationStructure(input), null);
});

function project({ gates = 0, regions = 1, occluded = false, wrongPage = false } = {}) {
  const rect = { left: 10, top: 10, right: 510, bottom: 410, width: 500, height: 400 };
  const region = { parentElement: null, scrollHeight: 1200, clientHeight: 400, scrollTop: 0, getBoundingClientRect: () => rect, contains: other => other === region };
  const document = { readyState: 'complete', scrollingElement: null, querySelectorAll: selector => selector.includes('user-post-list') ? Array(regions).fill(region) : Array(gates).fill(region), elementFromPoint: () => occluded ? {} : region };
  for (const key of ['cookie', 'body', 'textContent']) Object.defineProperty(document, key, { get() { throw Error('private content must not be read'); } });
  return JSON.parse(JSON.stringify(runInNewContext(`(${observeFirstPageActivation.toString()})({secUid:'offline-sec'})`, {
    URL, location: new URL(`https://www.douyin.com/user/${wrongPage ? 'other' : 'offline-sec'}`), document,
    window: { innerWidth: 1000, innerHeight: 800 }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }),
  })));
}

test('independent structural stages stop before later counts on wrong page, gate cap, and region cap', () => {
  const cases = [
    [{ wrongPage: true }, 'not-eligible', null, null],
    [{ gates: 101 }, 'gate-limit', null, null],
    [{ gates: 1 }, 'visible-gate', null, null],
    [{ regions: 99 }, 'region-limit', 9, null],
    [{ regions: 0 }, 'region-absent', 0, 0],
    [{ occluded: true }, 'occluded', 1, 1],
  ];
  for (const [options, reason, regionCount, visibleRegionCount] of cases) {
    const result = project(options);
    assert.equal(result.eligible, false); assert.equal(result.structure.reason, reason);
    assert.equal(result.structure.regionCount, regionCount); assert.equal(result.structure.visibleRegionCount, visibleRegionCount);
    assert.equal('x' in result, false); assert.equal('deltaY' in result, false);
  }
  const eligible = project(); assert.equal(eligible.eligible, true);
  assert.deepEqual(sanitizeFirstPageActivationStructure(eligible.structure), { reason: 'eligible', regionCount: 1, visibleRegionCount: 1, leafRegionCount: 1, ancestorCount: 1 });
});
