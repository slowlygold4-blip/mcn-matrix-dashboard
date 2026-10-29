import test from 'node:test';
import assert from 'node:assert/strict';
import { readBitable } from '../scripts/source-poller.mjs';

const page = (overrides = {}) => ({ fields: ['作者', '抖音号'],
  data: [['测试作者', 'fixture123']], record_id_list: ['recFixtureOne'],
  rev: 4, has_more: false, ...overrides });

function reader(pages) {
  const calls = [];
  return { calls, read: () => readBitable({ baseToken: 'fixture', tableId: 'fixture' }, {
    command: '/synthetic-cli', commandRunner: async (_command, args) => {
      const offset = Number(args[args.indexOf('--offset') + 1]);
      calls.push(offset);
      assert.ok(calls.length <= pages.length, 'must not request beyond supplied pages');
      return { stdout: JSON.stringify({ ok: true, data: pages[calls.length - 1] }) };
    },
  }) };
}

for (const value of [undefined, null, 0, 1, 'false', 'true']) {
  test(`pagination cannot infer completeness from has_more=${String(value)}`, async () => {
    const fixture = reader([page({ has_more: value })]);
    await assert.rejects(fixture.read(), /分页结束标志/);
    assert.deepEqual(fixture.calls, [0]);
  });
}

for (const value of [undefined, null, '', false, true]) {
  test(`source revision must not silently coerce ${String(value)} to a number`, async () => {
    await assert.rejects(reader([page({ rev: value })]).read(), /无效修订号/);
  });
}

test('an explicitly empty terminal page is valid and a real zero revision remains valid', async () => {
  const result = await reader([page({ data: [], record_id_list: [], rev: 0 })]).read();
  assert.equal(result.revision, 0);
  assert.equal(result.count, 0);
  assert.deepEqual(result.rows, []);
});

test('short nonterminal pages continue by actual row count until an explicit false', async () => {
  const fixture = reader([page({ has_more: true }), page({
    data: [['第二作者', 'fixture456']], record_id_list: ['recFixtureTwo'],
  })]);
  const result = await fixture.read();
  assert.deepEqual(fixture.calls, [0, 1]);
  assert.equal(result.count, 2);
  assert.deepEqual(result.rows.map(row => row.sourceRecordId), ['recFixtureOne', 'recFixtureTwo']);
});

test('missing terminal marker on the second page rejects all pages rather than returning a partial import', async () => {
  const fixture = reader([page({ has_more: true }), page({
    data: [['第二作者', 'fixture456']], record_id_list: ['recFixtureTwo'], has_more: undefined,
  })]);
  await assert.rejects(fixture.read(), /分页结束标志/);
  assert.deepEqual(fixture.calls, [0, 1]);
});
