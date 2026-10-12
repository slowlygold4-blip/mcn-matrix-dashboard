import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';

const LOCATOR = 'MS4wLjABAAAAauthorImportAtomicFixture123456';
const EVIDENCE = { key: `douyin:account:${LOCATOR}|video:7686424948055891786`, name: '测试作者',
  douyinId: 'atomicfixture123', accountLocator: LOCATOR, videoIds: ['7686424948055891786'],
  sourceRows: [2], boards: ['事务分类'] };
const INPUT = { label: '测试作者', locator: LOCATOR, boards: ['事务分类'],
  metadata: { platform: 'douyin', importSource: { type: 'author-spreadsheet', fileName: 'fixture.xlsx', sheetName: '作者名单', sourceRow: 2 } } };

function fixture(t) {
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  return database;
}

function counts(db) {
  return Object.fromEntries(['board_catalog', 'author_resolution_queue', 'author_resolution_import_sources', 'targets', 'target_boards', 'audits']
    .map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

test('outer author import rolls back catalog, queue, target and audit on late failure', t => {
  const database = fixture(t), db = database.db, before = counts(db);
  db.exec('BEGIN IMMEDIATE');
  database.createBoard('事务分类', { sourceType: 'author-spreadsheet' });
  database.enqueueAuthorResolutions([EVIDENCE], { fileName: 'fixture.xlsx', sheetName: '作者名单' });
  database.importAuthorTargets([INPUT], { fileName: 'fixture.xlsx', reviewedRows: 1 });
  assert.equal(db.isTransaction, true, 'nested operations must not commit their caller');
  db.exec('ROLLBACK');
  assert.deepEqual(counts(db), before);
});

test('successful outer author import commits the same catalog, queue and target together', t => {
  const database = fixture(t), db = database.db;
  db.exec('BEGIN IMMEDIATE');
  database.createBoard('事务分类', { sourceType: 'author-spreadsheet' });
  database.enqueueAuthorResolutions([EVIDENCE], { fileName: 'fixture.xlsx', sheetName: '作者名单' });
  database.importAuthorTargets([INPUT], { fileName: 'fixture.xlsx', reviewedRows: 1 });
  db.exec('COMMIT');
  const saved = counts(db);
  assert.equal(saved.board_catalog, 1);
  assert.equal(saved.author_resolution_queue, 1);
  assert.equal(saved.targets, 1);
  assert.equal(saved.target_boards, 1);
  assert.equal(saved.audits, 1);
});

test('nested target failure rolls back its savepoint without committing the outer queue', t => {
  const database = fixture(t), db = database.db, before = counts(db);
  db.exec(`CREATE TEMP TRIGGER fail_author_audit BEFORE INSERT ON audits
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
  db.exec('BEGIN IMMEDIATE');
  database.enqueueAuthorResolutions([EVIDENCE], { fileName: 'fixture.xlsx', sheetName: '作者名单' });
  assert.throws(() => database.importAuthorTargets([INPUT], { fileName: 'fixture.xlsx' }), /injected audit failure/);
  assert.equal(db.isTransaction, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM author_resolution_queue').get().n, before.author_resolution_queue + 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM targets').get().n, before.targets);
  db.exec('ROLLBACK');
  assert.deepEqual(counts(db), before);
});
