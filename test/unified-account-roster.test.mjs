import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildUnifiedAccountRoster, mergeUnifiedAccountRoster } from '../lib/unified-account-roster.mjs';

const entry = (key, extra = {}) => ({ key, targetId: null, name: key, platform: 'douyin',
  accountIds: [key], originalNames: [key], theme: { key: 'tuantuan', label: '团团' },
  classifications: [{ key: 'slice', label: '切片' }], sources: [], boards: [], ...extra });
const monitored = (id = 1) => ({ id, label: '当前作者', enabled: true, platform: 'douyin',
  classification: { theme: { key: 'tuantuan' } }, metrics: { followers: { value: 123, delta: 2 } },
  status: { key: 'ok', lastSuccessAt: '2026-10-22T01:00:00Z' } });
const source = { importId: 7, url: 'https://my.feishu.cn/sheets/test', revision: '8',
  refreshedAt: '2026-10-22T01:00:00Z', authors: new Map([
    [2, { row: 2, accountId: 'alice', works: 3, likes: 20, plays: 1200, followers: 5, followersNote: '来源截图，时间未知' }],
    [3, { row: 3, accountId: 'bob', works: 4, likes: null, plays: null, followers: null }],
  ]) };

test('empty database has no invented accounts or metrics', () => {
  const db = new DatabaseSync(':memory:');
  try { assert.deepEqual(mergeUnifiedAccountRoster(db, []).accounts, []); }
  finally { db.close(); }
});

test('existing target identities collapse while monitored metrics remain untouched', () => {
  const account = monitored();
  const result = buildUnifiedAccountRoster([account], [entry('one', { targetId: 1, creatorSourceRows: [2] }),
    entry('two', { targetId: 1, creatorSourceRows: [2] })], source);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.accounts[0].metrics, account.metrics);
  assert.deepEqual(result.accounts[0].status, account.status);
  assert.equal(result.accounts[0].sourceSummary.cumulativeLikes, 20);
  assert.equal(result.rosterSummary.duplicateTargetEntriesCollapsed, 1);
  assert.equal(account.sourceSummary, undefined);
});

test('the same physical source row is one author and an audited normalized ID can join its monitor', () => {
  const account = { ...monitored(292), label: '揽梦钟晚OvO', publicId: 'Ni.De.GIRL_LMZW' };
  const sheet = { url: 'https://feishu.cn/sheets/works', sheetName: '数据表', rows: ['162'], title: '登记表' };
  const submitted = entry('submitted', { name: account.label,
    accountIds: ['[Ni.De](http://Ni.De).GIRL_LMZW'], creatorSourceRows: [59], sources: [sheet] });
  const repeated = entry('live-source:douyin:one', { liveSource: true, name: account.label,
    accountIds: [], sources: [{ ...sheet }] });
  const sourceWithNormalizedId = { ...source, authors: new Map([[59, { row: 59,
    accountId: '[Ni.De](http://Ni.De).GIRL_LMZW', normalizedId: 'ni.de.girl_lmzw',
    works: 45, likes: 5331, plays: 284504, followers: 493 }]]) };
  const result = buildUnifiedAccountRoster([account], [submitted, repeated], sourceWithNormalizedId);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.rosterSummary.repeatedSourceRowsCollapsed, 1);
  assert.equal(result.rosterSummary.sourceIdentityLinked, 1);
  assert.deepEqual(result.accounts[0].metrics, account.metrics);
  assert.equal(result.accounts[0].sourceSummary.works, 45);
  assert.deepEqual(result.accounts[0].sourceSummary.authorKeys, ['source-author:7:59']);
  assert.deepEqual(result.accounts[0].rosterKeys, ['submitted', 'live-source:douyin:one']);
  assert.ok(result.accounts[0].sourceProvenance.length);
});

test('a name or a conflicting normalized ID never merges distinct source rows', () => {
  const account = { ...monitored(), label: '同名作者', publicId: 'sameid' };
  const sheet = { url: 'https://feishu.cn/sheets/works', sheetName: '数据表', title: '登记表' };
  const submitted = entry('submitted', { name: account.label, accountIds: ['[sameid](http://sameid).'],
    creatorSourceRows: [59], sources: [{ ...sheet, rows: ['162'] }] });
  const unrelated = entry('live-source:douyin:two', { liveSource: true, name: account.label,
    accountIds: [], sources: [{ ...sheet, rows: ['999'] }] });
  const badSource = { ...source, authors: new Map([[59, { row: 59,
    accountId: '[sameid](http://sameid).', normalizedId: 'different', works: 1 }]]) };
  const result = buildUnifiedAccountRoster([account], [submitted, unrelated], badSource);
  assert.equal(result.accounts.length, 3);
  assert.equal(result.rosterSummary.repeatedSourceRowsCollapsed, 0);
  assert.equal(result.rosterSummary.sourceIdentityLinked, 0);
});

test('multiple verified source statements on one monitor retain all rows and reveal conflicting totals', () => {
  const account = { ...monitored(), publicId: 'alice' };
  const differing = { ...source, authors: new Map([
    [2, { row: 2, accountId: 'alice', normalizedId: 'alice', works: 3, likes: 20, plays: 1200, followers: 5 }],
    [3, { row: 3, accountId: 'alice', normalizedId: 'alice', works: 4, likes: 25, plays: 1300, followers: 5 }],
  ]) };
  const result = buildUnifiedAccountRoster([account], [
    entry('target:1', { targetId: 1, accountIds: ['alice'], creatorSourceRows: [2] }),
    entry('pending', { accountIds: ['alice'], creatorSourceRows: [3] }),
  ], differing);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].sourceSummary.works, null);
  assert.equal(result.accounts[0].sourceSummary.hasConflicts, true);
  assert.deepEqual(result.accounts[0].sourceSummary.authorKeys, ['source-author:7:2', 'source-author:7:3']);
  assert.deepEqual(result.accounts[0].metrics, account.metrics);
});

test('all source authors are in the main list but are never enabled monitors', () => {
  const result = buildUnifiedAccountRoster([monitored()], [entry('alice', { creatorSourceRows: [2] }),
    entry('bob', { creatorSourceRows: [3] })], source);
  assert.equal(result.rosterSummary.total, 3);
  assert.equal(result.rosterSummary.enabled, 1);
  assert.equal(result.rosterSummary.sourceOnly, 2);
  const account = result.accounts[1];
  assert.match(account.id, /^roster:[a-f0-9]{32}$/);
  assert.equal(account.enabled, false);
  assert.equal(account.sourceOnly, true);
  assert.equal(account.metrics.likes.delta, null);
  assert.equal(account.metrics.followers.value, null);
  assert.equal(account.status.lastSuccessAt, null);
  assert.equal(account.sourceSummary.observedAt, null);
  assert.equal(account.sourceSummary.followers, 5);
  assert.deepEqual(account.sourceSummary.authorKeys, ['source-author:7:2']);
  assert.equal(account.boards[0].key, '一条小团团切片矩阵');
  assert.equal(account.classification.theme.key, 'tuantuan');
  assert.equal(result.accounts[2].sourceSummary.cumulativePlays, null);
});

test('exact valid public IDs merge pending submissions but nicknames do not', () => {
  const result = buildUnifiedAccountRoster([], [entry('a', { accountIds: ['Alice'] }),
    entry('b', { accountIds: ['alice'] }), entry('c', { accountIds: ['一颗团ovo'] }),
    entry('d', { accountIds: ['一颗团𝗢𝘃𝗢'] })]);
  assert.equal(result.accounts.length, 3);
  assert.equal(result.rosterSummary.pendingIdsMerged, 1);
});

test('distinct profile anchors and signed identity corrections stay distinct', () => {
  const rows = [entry('a', { accountIds: ['alice'] }),
    entry('b', { accountIds: ['alice'], profileLinks: ['https://www.douyin.com/user/A'] }),
    entry('c', { accountIds: ['alice'], profileLinks: ['https://www.douyin.com/user/B'] }),
    entry('d', { accountIds: ['alice'], identityCorrection: { signed: true } })];
  assert.equal(buildUnifiedAccountRoster([], rows).accounts.length, 4);
});

test('a linked target outside historical monitored input is source-only, not resurrected', () => {
  const result = buildUnifiedAccountRoster([], [entry('alice', { targetId: 20, creatorSourceRows: [2] })], source);
  assert.equal(result.accounts[0].linkedTargetId, 20);
  assert.equal(typeof result.accounts[0].id, 'string');
  assert.equal(result.accounts[0].enabled, false);
  assert.equal(result.accounts[0].metrics.likes.value, null);
});

test('same source row never doubles cumulative values and unsafe source links are suppressed', () => {
  const result = buildUnifiedAccountRoster([], [entry('alice', { creatorSourceRows: [2, 2] })], {
    ...source, url: 'https://my.feishu.cn/sheets/test?token=[REDACTED]',
  });
  assert.equal(result.accounts[0].sourceSummary.works, 3);
  assert.equal(result.accounts[0].sourceSummary.sourceUrl, '');
});

test('identical repeated public ID counters are retained once, including a real zero', () => {
  const duplicateSource = { ...source, authors: new Map([
    [2, { row: 2, accountId: 'Alice', works: 0, likes: 20, plays: 1200, followers: 5 }],
    [3, { row: 3, accountId: 'alice', works: 0, likes: 20, plays: 1200, followers: 5 }],
  ]) };
  const result = buildUnifiedAccountRoster([], [entry('alice', { creatorSourceRows: [2, 3] })], duplicateSource);
  const summary = result.accounts[0].sourceSummary;
  assert.equal(summary.works, 0);
  assert.equal(summary.cumulativeLikes, 20);
  assert.equal(summary.cumulativePlays, 1200);
  assert.equal(summary.followers, 5);
  assert.equal(summary.hasConflicts, false);
  assert.deepEqual(summary.conflicts, []);
  assert.deepEqual(summary.authorKeys, ['source-author:7:2', 'source-author:7:3']);
});

test('conflicting undated source counters are null rather than max, last, or sum', () => {
  const duplicateSource = { ...source, authors: new Map([
    [2, { row: 2, accountId: 'Alice', works: 3, likes: 20, plays: 1200, followers: 5 }],
    [3, { row: 3, accountId: 'alice', works: 2, likes: 10, plays: 900, followers: 4 }],
  ]) };
  const result = buildUnifiedAccountRoster([], [entry('alice', { creatorSourceRows: [2, 3] })], duplicateSource);
  const summary = result.accounts[0].sourceSummary;
  for (const field of ['works', 'cumulativeLikes', 'cumulativePlays', 'followers']) assert.equal(summary[field], null);
  assert.equal(summary.hasConflicts, true);
  assert.deepEqual(summary.conflicts.map(conflict => conflict.field), ['works', 'cumulativeLikes', 'cumulativePlays', 'followers']);
  assert.deepEqual(summary.conflicts[1].values, [20, 10]);
  assert.deepEqual(summary.conflicts[1].sourceRows, [2, 3]);
  assert.equal(summary.conflicts[1].reason, 'undated-source-conflict');
  assert.match(summary.note, /冲突值留空/);
  assert.deepEqual(summary.authorKeys, ['source-author:7:2', 'source-author:7:3']);
});

test('known versus missing duplicate fields conflict without discarding matching fields', () => {
  const duplicateSource = { ...source, authors: new Map([
    [2, { row: 2, accountId: 'Alice', works: 3, likes: 20, plays: null, followers: null }],
    [3, { row: 3, accountId: 'alice', works: 3, likes: null, plays: null, followers: null }],
  ]) };
  const result = buildUnifiedAccountRoster([], [entry('alice', { creatorSourceRows: [2, 3] })], duplicateSource);
  const summary = result.accounts[0].sourceSummary;
  assert.equal(summary.works, 3);
  assert.equal(summary.cumulativeLikes, null);
  assert.equal(summary.cumulativePlays, null);
  assert.deepEqual(summary.conflicts.map(conflict => conflict.field), ['cumulativeLikes']);
  assert.deepEqual(summary.conflicts[0].values, [20, null]);
});
