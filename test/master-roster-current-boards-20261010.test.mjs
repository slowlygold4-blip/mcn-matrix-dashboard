import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE target_boards(
      target_id INTEGER NOT NULL,board_key TEXT NOT NULL,board_name TEXT NOT NULL,
      organization TEXT NOT NULL DEFAULT '',tier TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(target_id,board_key)
    );
    INSERT INTO targets VALUES
      (270,'account','{"platform":"douyin"}','MS4wLjABAAAAauthor270abcdef','作者270',1),
      (391,'account','{"platform":"douyin"}','MS4wLjABAAAAauthor391abcdef','作者391',0),
      (500,'account','{"platform":"douyin"}','MS4wLjABAAAAauthor500abcdef','作者500',1);
    INSERT INTO target_boards VALUES
      (270,'一条小团团切片矩阵','一条小团团切片矩阵','团团','','切片'),
      (391,'一条小团团切片矩阵','一条小团团切片矩阵','','A',''),
      (500,'来源保留板块','来源保留板块','','',''),
      (500,'新增当前板块','新增当前板块','当前机构','S','AI二创');
  `);
  const entity = (id, boards = []) => ({
    key: `target:${id}`, targetId: id, enabled: id !== 391, platform: 'douyin', currentName: `旧作者${id}`,
    names: [`旧作者${id}`], ids: [`douyin-${id}`], locators: [`MS4wLjABAAAAauthor${id}abcdef`],
    sources: [{ file: '原始总表.xlsx', sheet: '作者', rows: [String(id)] }], boards,
  });
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:00:00.000Z', entities: [
    entity(270), entity(391),
    entity(500, [
      { name: '来源保留板块', category: '原始分类', tier: '', organization: '原始机构' },
      { name: '仅冻结板块', category: '原创', tier: '', organization: '' },
    ]),
  ] }, { fileName: 'MCN全部来源账号合并表.xlsx', sha256: 'a'.repeat(64) });
  installMasterRoster(db, snapshot, { now: '2026-10-10T00:00:00.000Z' });
  return { db };
}

test('bound roster entries merge current target boards without mutating the frozen roster', t => {
  const { db } = fixture(t);
  const before = {
    roster: db.prepare('SELECT * FROM master_roster_entries ORDER BY entry_key').all(),
    memberships: db.prepare('SELECT * FROM target_boards ORDER BY target_id,board_key').all(),
    changes: db.prepare('SELECT total_changes() AS value').get().value,
  };

  const first = readMasterRoster(db);
  const second = readMasterRoster(db);
  const byTarget = new Map(first.items.map(item => [item.targetId, item]));

  assert.deepEqual(byTarget.get(270).boards, [
    { name: '一条小团团切片矩阵', category: '切片', tier: '', organization: '团团' },
  ]);
  assert.deepEqual(byTarget.get(391).boards, [
    { name: '一条小团团切片矩阵', category: '', tier: 'A', organization: '' },
  ]);
  assert.deepEqual(byTarget.get(500).boards, [
    { name: '来源保留板块', category: '原始分类', tier: '', organization: '原始机构' },
    { name: '仅冻结板块', category: '原创', tier: '', organization: '' },
    { name: '新增当前板块', category: 'AI二创', tier: 'S', organization: '当前机构' },
  ]);
  assert.equal(byTarget.get(500).sources[0].fileName, '原始总表.xlsx');
  assert.deepEqual(second, first, '重复读取必须返回相同只读投影');
  assert.deepEqual(db.prepare('SELECT * FROM master_roster_entries ORDER BY entry_key').all(), before.roster);
  assert.deepEqual(db.prepare('SELECT * FROM target_boards ORDER BY target_id,board_key').all(), before.memberships);
  assert.equal(db.prepare('SELECT total_changes() AS value').get().value, before.changes);
});

test('compatible same-name board metadata fills blanks without duplicating or replacing frozen values', t => {
  const { db } = fixture(t);
  db.prepare("UPDATE target_boards SET organization='原始机构',tier='S',category='原始分类' WHERE target_id=500 AND board_key='来源保留板块'").run();
  const item = readMasterRoster(db).items.find(value => value.targetId === 500);
  assert.deepEqual(item.boards.slice(0, 2), [
    { name: '来源保留板块', category: '原始分类', tier: 'S', organization: '原始机构' },
    { name: '仅冻结板块', category: '原创', tier: '', organization: '' },
  ]);
  assert.deepEqual(item.boards[2], { name: '新增当前板块', category: 'AI二创', tier: 'S', organization: '当前机构' });
});
