import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';
import { buildMasterRosterSnapshot, installMasterRoster } from '../lib/master-roster.mjs';
import { checksum } from '../lib/utils.mjs';

const options = { period: 'custom', startDate: '2026-09-21', endDate: '2026-09-21',
  timeZone: 'Asia/Shanghai', reference: new Date('2026-10-22T12:00:00Z') };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'unified-account-insights-'));
  const database = new MonitorDatabase(join(directory, 'test.sqlite'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const make = (name, handle, enabled) => {
    const target = database.createTarget({ type: 'account', label: name,
      locator: `MS4wLjABAAAA${handle}abcdefghijklmnop`, provider: 'public-web',
      metadata: { platform: 'douyin', douyinId: handle,
        identityVerification:{accountId:`MS4wLjABAAAA${handle}abcdefghijklmnop`} } });
    database.db.prepare('UPDATE targets SET created_at=?,updated_at=?,enabled=? WHERE id=?')
      .run('2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', enabled ? 1 : 0, target.id);
    database.assignTargetsToBoard([target.id], '一条小团团切片矩阵');
    database.db.prepare('UPDATE target_boards SET created_at=? WHERE target_id=?')
      .run('2026-06-01T00:00:00Z', target.id);
    for (const [day, followers, likes] of [['2026-09-20', 100, 1000], ['2026-09-21', 110, 1200]]) {
      const capturedAt = `${day}T02:00:00.000Z`;
      const raw = { capturedAt, profile: { user: { sec_uid: target.locator, uid: '222523170759696',
        follower_count: followers, total_favorited: likes, aweme_count: 10 } }, works: { aweme_list: [] } };
      database.db.prepare(`INSERT INTO snapshots(target_id,captured_at,followers,total_likes,total_posts,
        quality_status,account_status,works_coverage,source_checksum,raw_json)
        VALUES(?,?,?,?,?,'validated','available','complete',?,?)`)
        .run(target.id, capturedAt, followers, likes, 10, checksum(raw), JSON.stringify(raw));
    }
    return target;
  };
  const linked = make('已监控', 'alice', true), paused = make('已暂停', 'paused', false);
  const before = getProductInsights(database, options);
  const roster = buildMasterRosterSnapshot({ exportedAt: '2026-10-22T00:00:00.000Z', entities: [linked, paused].map(target => ({
    key: `target:${target.id}`, targetId: target.id, platform: 'douyin', enabled: target.id === linked.id,
    currentName: target.label, names: [target.label], ids: [target.id === linked.id ? 'alice' : 'paused'],
    locators: [target.locator], sources: [], boards: [{ name: '一条小团团切片矩阵' }],
    classification: { theme: { key: 'tuantuan', label: '团团' }, labels: [{ key: 'slice', label: '切片' }] },
  })) }, { fileName: 'fixture.xlsx', sha256: 'b'.repeat(64) });
  installMasterRoster(database.db, roster);
  database.db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_url TEXT,
      source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
    CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);
    INSERT INTO creator_source_imports VALUES(1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','https://my.feishu.cn/sheets/source','42',
      '2026-10-22T00:00:00Z','2026-10-22T01:00:00Z','{"audit":{"sourceRefreshedAt":"2026-10-22T00:00:00Z"}}',3);`);
  const insert = database.db.prepare("INSERT INTO creator_source_rows VALUES(1,'08',?,?)");
  insert.run(2, JSON.stringify(['已监控', 'alice', '', '', 1, 1, 2, 2, 0, 0, 0, 8000, 80, 0, 900, '截图时点未知']));
  insert.run(3, JSON.stringify(['来源原创', 'bob', '', '', 2, 2, 4, 0, 4, 0, 0, 12000, 120, 0, null, null]));
  insert.run(4, JSON.stringify(['来源AI', 'charlie', '', '', 3, 3, 6, 0, 0, 6, 0, null, null, 0, null, null]));
  database.db.prepare('INSERT INTO creator_source_account_links VALUES(1,2,?,?,?)').run(linked.id,'alice','2026-10-22T01:00:00Z');
  const read = extra => getProductInsights(database, { ...options, ...extra });
  return { database, linked, paused, before, read };
}

test('actual overview contract includes all source authors and keeps the monitored cohort unchanged', t => {
  const { database, linked, before, read } = fixture(t);
  const changes = database.db.prepare('SELECT total_changes() n').get().n;
  const result = read({ theme: 'tuantuan' });
  assert.equal(result.accounts.length, 4);
  assert.equal(result.summary.memberCount, 4);
  assert.equal(result.summary.enabledCount, 1);
  assert.equal(result.summary.pausedCount, 1);
  assert.equal(result.summary.sourceOnlyCount, 2);
  assert.equal(result.themeSummary.items.find(item => item.key === 'tuantuan').count, 4);
  assert.equal(result.rosterSummary.scopedTotal, 4);
  assert.equal(result.rosterSummary.scopedSourceOnly, 2);
  const account = result.accounts.find(item => item.id === linked.id);
  assert.deepEqual(account.metrics, before.accounts.find(item => item.id === linked.id).metrics);
  assert.equal(account.sourceSummary.cumulativeLikes, 80);
  assert.equal(account.sourceSummary.followers, 900);
  assert.equal(account.metrics.followers.value, 110, 'undated screenshot followers cannot replace platform observations');
  assert.equal(result.summary.metrics.likes.delta, before.summary.metrics.likes.delta);
  assert.equal(result.summary.metrics.followers.delta, 10);
  assert.equal(database.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('board and secondary classification filters include source accounts without a new side panel', t => {
  const { read } = fixture(t);
  const matrix = read({ board: '一条小团团切片矩阵', theme: 'tuantuan', classification: 'slice' });
  assert.equal(matrix.accounts.length, 4);
  const original = read({ board: '一条小团团切片矩阵', theme: 'tuantuan', classification: 'original' });
  assert.deepEqual(original.accounts.map(item => item.publicId), ['bob']);
  assert.equal(original.summary.pausedCount, 0);
  assert.equal(original.summary.sourceOnlyCount, 1);
  assert.equal(original.summary.metrics.likes.value, null);
  const ai = read({ theme: 'tuantuan', classification: 'ai-remix' });
  assert.deepEqual(ai.accounts.map(item => item.publicId), ['charlie']);
  assert.equal(read({ theme: 'yuqilin' }).accounts.length, 0);
  assert.equal(read({ board: '未存在板块' }).accounts.length, 0);
});

test('historical date selection retains source directory but never invents metric history or growth', t => {
  const { read } = fixture(t);
  const result = read({ startDate: '2026-07-01', endDate: '2026-07-02' });
  assert.equal(result.accounts.length, 4);
  const source = result.accounts.find(item => item.publicId === 'bob');
  assert.equal(source.sourceSummary.cumulativePlays, 12000);
  assert.equal(source.sourceSummary.observedAt, null);
  for (const name of ['followers', 'likes', 'posts', 'estimatedPlays']) {
    assert.equal(source.metrics[name].value, null);
    assert.equal(source.metrics[name].delta, null);
    assert.equal(result.summary.metrics[name].delta, null);
  }
  assert.equal(result.summary.trend.every(point => point.followers === null && point.likes === null), true);
  assert.equal(result.scopeBasis.accountDirectory, 'current-unified-source-and-monitored-roster');
});

test('source-linked target created after selected historical endpoint remains source-only', t => {
  const { database, linked, read } = fixture(t);
  database.db.prepare('UPDATE targets SET created_at=? WHERE id=?').run('2026-10-22T00:00:00Z', linked.id);
  const result = read({});
  const source = result.accounts.find(item => item.linkedTargetId === linked.id);
  assert.ok(source);
  assert.equal(source.sourceOnly, true);
  assert.equal(source.enabled, false);
  assert.equal(source.metrics.followers.value, null);
  assert.equal(result.summary.enabledCount, 0);
  assert.equal(result.summary.sourceOnlyCount, 3);
  assert.equal(result.accounts.some(item => item.id === linked.id), false);
});

test('a legacy source row without the verified canonical anchor remains separate from the monitored author',t=>{
 const {database,linked,read}=fixture(t);
 database.db.prepare('UPDATE targets SET metadata_json=? WHERE id=?').run(JSON.stringify({platform:'douyin',douyinId:'alice'}),linked.id);
 const result=read({theme:'tuantuan'});
 assert.equal(result.accounts.length,5);assert.equal(result.summary.sourceOnlyCount,3);
 assert.equal(result.accounts.filter(account=>account.publicId==='alice').length,2);
 assert.equal(result.accounts.find(account=>account.id===linked.id).sourceSummary??null,null);
});
