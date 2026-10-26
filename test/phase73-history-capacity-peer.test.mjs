// Offline capacity/continuation audit of the current authoritative contracts.
// No mock API success is presented as an available transport or a full history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BrowserWorksPagination, sanitizeBrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { validatedBrowserPagination } from '../lib/official-profile-evidence.mjs';
import { normalizeBrowserCollectorInput, normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';

const SEC = 'MS4wLjABAAAAPhase73HistoryCapacityOffline';
const UID = '123456789012345';
const instant = '2026-10-01T13:39:13.000Z';
const post = id => ({ aweme_id: String(7300000000000000000n + BigInt(id)),
  author: { sec_uid: SEC, uid: UID }, statistics: { digg_count: id }, create_time: 1700000000, desc: '离线作品' });
const body = (ids, cursor, hasMore = true) => ({ status_code: 0, aweme_list: ids.map(post), has_more: hasMore, max_cursor: cursor });
const ledger = (limit = 30, maxPages = 3, initialCursor) => new BrowserWorksPagination({ limit, maxPages, initialCursor });
function accept(l, requestCursor, payload, observedAt = instant) {
  return l.accept({ requestCursor, body: payload,
    normalized: normalizeBrowserWorks(payload, SEC, l.limit), observedAt });
}
function evidence(result, overrides = {}) {
  return { version: 1, kind: 'works-only-observation', source: 'authorised-browser', targetId: 1, runId: 2330,
    anchorSnapshotId: 42, anchorChecksum: 'a'.repeat(64), requestedLimit: 30, identity: { secUid: SEC, uid: UID },
    requestStartedAt: '2026-10-01T13:39:12.000Z', requestFinishedAt: '2026-10-01T13:39:14.000Z',
    observedAt: result.pagination.pages.at(-1).observedAt, status: 'accepted', coverage: 'limited',
    errorCode: result.pagination.errorCode, posts: result.posts.map(p => ({ aweme_id: p.aweme_id,
      author: { sec_uid: p.author.sec_uid, uid: p.author.uid }, statistics: p.statistics, desc: p.desc, create_time: p.create_time })),
    pagination: result.pagination, ...overrides };
}
const valid = result => validatedBrowserPagination(result.pagination, {
  limit: 30, posts: result.posts, hasMore: result.hasMore, maxCursor: result.maxCursor,
  notBefore: '2026-10-01T13:39:12.000Z', notAfter: Date.parse('2026-10-01T13:39:14.000Z'),
});

test('current browser input has no resume cursor and never grants a supplied cursor capability', () => {
  const normalized = normalizeBrowserCollectorInput({ items: [{ key: 'offline', secUid: SEC, limit: 30,
    initialCursor: 1749305973000, maxCursor: 1749305973000, cursor: 1749305973000 }] });
  assert.deepEqual(normalized, [{ key: 'offline', secUid: SEC, limit: 30 }]);
});
test('current ledger always starts at zero even when a caller supplies a nonzero cursor', () => {
  const l = ledger(30, 3, 1749305973000);
  assert.equal(l.expectedCursor, 0);
  assert.equal(accept(l, 1749305973000, body([1], 1749000000000)), false);
  assert.equal(l.pages.length, 0); assert.equal(l.posts.length, 0);
});
test('raising caller limits does not bypass the owned hundred-item and three-page ceilings', () => {
  const l = ledger(4000, 100);
  assert.equal(l.limit, 100); assert.equal(l.maxPages, 3);
  assert.equal(normalizeBrowserCollectorInput({ items: [{ key: 'offline', secUid: SEC, limit: 3384 }] })[0].limit, 100);
});
test('three valid ordinary pages with more remain limited and retain their next cursor', () => {
  const l = ledger();
  for (const [requestCursor, next, id] of [[0, 100, 1], [100, 90, 2], [90, 80, 3]]) {
    assert.equal(accept(l, requestCursor, body([id], next)), true);
  }
  const result = l.result(3);
  assert.equal(result.coverage, 'latest-public-window'); assert.equal(result.pagination.stopReason, 'page-limit');
  assert.equal(result.hasMore, true); assert.equal(result.maxCursor, 80);
  assert.ok(valid(result));
});
test('a pristine thirty-item first page with more cannot be promoted to a complete history', () => {
  const l = ledger(); accept(l, 0, body(Array.from({ length: 30 }, (_, i) => i + 1), 1749305973000));
  const result = l.result(1);
  assert.equal(result.posts.length, 30); assert.equal(result.pagination.stopReason, 'item-limit');
  assert.equal(result.coverage, 'latest-public-window'); assert.ok(valid(result));
});
test('an oversized terminal body remains limited when the hundred-item ceiling discards source rows', () => {
  const l = ledger(100); accept(l, 0, body(Array.from({ length: 120 }, (_, i) => i + 1), 0, false));
  const result = l.result(1);
  assert.equal(result.posts.length, 100); assert.equal(result.coverage, 'latest-public-window');
  assert.equal(result.pagination.pages[0].rawCount, 120); assert.equal(result.pagination.pages[0].truncated, true);
});
test('a new nonzero-start history envelope is rejected by the existing v1 pagination validator', () => {
  const l = ledger(); accept(l, 0, body([1], 1749305973000));
  const result = l.result(1); result.pagination.stopReason = 'page-limit';
  result.pagination.pages[0].requestCursor = 1749400000000;
  assert.equal(valid(result), null);
});
test('concatenating independent zero-start windows does not create a valid cursor chain', () => {
  const first = ledger(); accept(first, 0, body([1], 1749305973000));
  const second = ledger(); accept(second, 0, body([2], 0, false));
  const a = first.result(1), b = second.result(1);
  const merged = { posts: [...a.posts, ...b.posts], hasMore: false, maxCursor: 0,
    pagination: { version: 1, maxPages: 3, requestCount: 2, collectedCount: 2,
      stopReason: 'end-of-list', errorCode: null, pages: [...a.pagination.pages, ...b.pagination.pages] } };
  assert.equal(valid(merged), null, 'a locally increasing stored count is not source continuation evidence');
});
test('even a strict terminal works-only window is canonically limited, not an inventory snapshot', () => {
  const l = ledger(); accept(l, 0, body([1], 0, false));
  const raw = evidence(l.result(1));
  assert.equal(validateWorksOnlyEvidence(raw, { now: Date.parse('2026-10-01T13:40:00.000Z') }).coverage, 'limited');
  assert.throws(() => validateWorksOnlyEvidence({ ...raw, coverage: 'complete' },
    { now: Date.parse('2026-10-01T13:40:00.000Z') }), /独立作品证据/);
});
test('inventing v2 cursor fields inside an immutable v1 envelope does not pass canonical checksum admission', () => {
  const l = ledger(); accept(l, 0, body([1], 0, false));
  assert.throws(() => validateWorksOnlyEvidence({ ...evidence(l.result(1)), requestedStartCursor: 1749305973000 },
    { now: Date.parse('2026-10-01T13:40:00.000Z') }), /独立作品证据/);
});
test('the original projection refuses four pages rather than dropping the extra historical proof', () => {
  const l = ledger(); accept(l, 0, body([1], 100)); const p = l.result(1).pagination;
  const more = { ...p, maxPages: 4, pages: [...p.pages, ...p.pages, ...p.pages, ...p.pages] };
  assert.equal(sanitizeBrowserWorksPagination(more), null);
});
test('source audit proves separate immutable works history and page cleanup remain explicit barriers', () => {
  const observation = readFileSync(new URL('../lib/works-only-observation.mjs', import.meta.url), 'utf8');
  const scheduler = readFileSync(new URL('../lib/works-only-scheduler.mjs', import.meta.url), 'utf8');
  const collector = readFileSync(new URL('../scripts/douyin_browser_collector.mjs', import.meta.url), 'utf8');
  assert.match(observation, /coverage TEXT NOT NULL CHECK\(coverage IN \('limited','unavailable'\)\)/);
  assert.match(observation, /immutable works observation/);
  assert.match(scheduler, /if \(acceptedTargets\.has\(target\.id\)\) continue;/);
  assert.match(collector, /try \{ await page\.close\(\); \} finally/);
});
