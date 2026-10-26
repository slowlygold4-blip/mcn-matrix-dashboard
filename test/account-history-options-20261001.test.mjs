import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { accountHistoryOptions } from '../lib/account-history-options.mjs';
import { ConsoleReader } from '../lib/console-reader.mjs';

const AT = new Date('2026-10-01T00:00:00.000Z');
test('history HTTP defaults to all saved works at a canonical Beijing cutoff, not a seven-day period', () => {
  const options = accountHistoryOptions(new URLSearchParams(), AT);
  assert.deepEqual(options, { timeZone: 'Asia/Shanghai', kind: 'works', asOf: AT.toISOString() });
  assert.equal(options.startDate, undefined);
  assert.equal(options.period, undefined);
});
test('history HTTP accepts complete revision and preserves zero caps and numeric work identity', () => {
  const options = accountHistoryOptions(new URLSearchParams('kind=workMetrics&workId=7&page=2&pageSize=25&snapshotMaxId=0&postMaxId=8&postMetricMaxId=9&sort=capturedAt&order=asc'), AT);
  assert.equal(options.workId, 7); assert.equal(options.page, 2); assert.equal(options.snapshotMaxId, 0);
});
test('history HTTP uses actual offset instants and allows legitimate multi-year saved history', () => {
  const options = accountHistoryOptions(new URLSearchParams('kind=daily&asOf=2025-02-02T08:00:00%2B08:00&startDate=2020-01-01&endDate=2025-02-02'), AT);
  assert.equal(options.asOf, '2025-02-02T00:00:00.000Z');
  assert.equal(options.startDate, '2020-01-01');
});
for (const query of ['kind=all', 'kind=daily&kind=works', 'page=0', 'page=-1', 'page=1e2', 'pageSize=101',
  'pageSize=0', 'page=100001', 'workId=2', 'kind=workMetrics', 'kind=workMetrics&workId=0',
  'snapshotMaxId=2', 'snapshotMaxId=0&postMaxId=0&postMetricMaxId=-1', 'order=DESC', 'sort=likes;DROP',
  'asOf=2099-01-01T00:00:00Z', 'asOf=2026-02-30T00:00:00Z', 'asOf=2025-02-01',
  'startDate=2025-01-01', 'startDate=2025-03-01&endDate=2025-02-01',
  'startDate=2025-01-01&endDate=2027-01-01', 'startDate=2025-02-30&endDate=2025-03-01', 'cookie=SECRET']) {
  test(`history HTTP refuses malformed, ambiguous or future query: ${query}`, () => {
    assert.throws(() => accountHistoryOptions(new URLSearchParams(query), AT), { status: 400, code: 'INVALID_ACCOUNT_HISTORY_QUERY' });
  });
}
test('history read jobs are separately cached, coalesced, queued and isolated by account/revision', async (t) => {
  class Worker extends EventEmitter {
    sent = []; unref() {} terminate() { return Promise.resolve(); }
    postMessage(job) { this.sent.push(job); }
    answer(index, value) { this.emit('message', { id: this.sent[index].id, ok: true, result: value }); }
  }
  const worker = new Worker();
  const reader = new ConsoleReader({ databasePath: '/isolated-fixture.sqlite', workerFactory: () => worker });
  t.after(() => reader.close());
  const options = { kind: 'daily', asOf: AT.toISOString(), page: 2 };
  const first = reader.history(1, options);
  assert.strictEqual(first, reader.history(1, { page: 2, asOf: AT.toISOString(), kind: 'daily' }));
  const detail = reader.account(1, options);
  const another = reader.history(2, options);
  const next = reader.history(1, { ...options, page: 3 });
  worker.answer(0, { kind: 'daily', targetId: 1 });
  assert.equal(worker.sent[1].kind, 'account');
  worker.answer(1, { account: { id: 1 } });
  worker.answer(2, { kind: 'daily', targetId: 2 });
  worker.answer(3, { kind: 'daily', page: 3 });
  assert.deepEqual((await Promise.all([first, detail, another, next])).map(value => value.targetId ?? value.account?.id ?? value.page), [1, 1, 2, 3]);
  assert.equal(worker.sent[0].kind, 'history');
});
