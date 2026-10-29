import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from '@e965/xlsx';
import { gunzipSync } from 'node:zlib';
import { reconcileWorkSourceFile } from '../scripts/reconcile-work-source-workbook.mjs';

const id = '7684947825248082873';
function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'mcn-work-reconciliation-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const databasePath = join(folder, 'fixture.sqlite'), inputPath = join(folder, 'source.xlsx');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE creator_source_imports(id INTEGER PRIMARY KEY,source_sha256 TEXT,source_revision TEXT);
    CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
    INSERT INTO creator_source_imports VALUES(1,'fixture-sha','1');`);
  db.prepare('INSERT INTO creator_source_rows VALUES(1,?,?,?)').run('09', 2, JSON.stringify([id, '作者', 'handle', '', '', '', '', 30, 4]));
  db.close();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['视频id', '播放', '点赞'], [id, 30, 4], [id, 30, 4]]), '作品');
  writeFileSync(inputPath, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  return { folder, databasePath, inputPath };
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('full file reconciliation is read-only and duplicate facts never add counters', t => {
  const f = fixture(t), original = hash(f.databasePath);
  const result = reconcileWorkSourceFile(f);
  assert.equal(result.databaseWrites, 0);
  assert.equal(result.reconciliation.summary.uniqueWorks, 1);
  assert.equal(result.reconciliation.works[0].metrics.plays.previous, 30);
  assert.deepEqual(result.reconciliation.works[0].metrics.plays.sourceValues, [30]);
  assert.equal(hash(f.databasePath), original);
});

test('CLI stores compressed private evidence and refuses to overwrite an existing review', t => {
  const f = fixture(t), output = join(f.folder, 'review');
  const args = ['scripts/reconcile-work-source-workbook.mjs', '--input', f.inputPath,
    '--database', f.databasePath, '--output-directory', output];
  const first = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).databaseWrites, 0);
  const facts = join(output, 'work-facts.jsonl.gz');
  assert.equal(gunzipSync(readFileSync(facts)).toString().trim().split('\n').length, 2);
  assert.equal(statSync(facts).mode & 0o077, 0);
  const before = hash(facts);
  const second = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.equal(hash(facts), before);
});

test('missing target databases are never created as an accidental empty baseline', t => {
  const f = fixture(t), missing = join(f.folder, 'missing.sqlite');
  assert.throws(() => reconcileWorkSourceFile({ ...f, databasePath: missing }));
  assert.equal(existsSync(missing), false);
});
