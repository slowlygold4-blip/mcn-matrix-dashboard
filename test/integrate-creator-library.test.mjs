import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { integrateCreatorLibrary, parseArguments } from '../scripts/integrate-creator-library.mjs';

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcn-creator-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const targetPath = join(dir, 'monitor.sqlite');
  const target = new DatabaseSync(targetPath);
  target.exec('CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,locator TEXT,metadata_json TEXT); CREATE TABLE posts(external_id TEXT);');
  target.prepare('INSERT INTO targets VALUES(?,?,?,?)').run(1, 'account', 'MS4wLjAB_fixture', JSON.stringify({ douyinId: 'handle_a', identityVerification: { accountId: 'MS4wLjAB_fixture' } }));
  target.close();
  function stage(version = 1, authors = 2, works = 3) {
    const original = join(dir, `original-${version}.xlsx`), sourcePath = join(dir, `staging-${version}.sqlite`);
    // Already-audited staging fixture: integration verifies these exact source
    // bytes; parsing/auditing real XLSX is the preceding importer's job.
    writeFileSync(original, `original source bytes ${version}`);
    const source = new DatabaseSync(sourcePath);
    source.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE source_sheets(sheet_id TEXT PRIMARY KEY,sheet_name TEXT,ordinal INTEGER,row_count INTEGER,headers_json TEXT,restricted INTEGER);
      CREATE TABLE source_rows(sheet_id TEXT,row_number INTEGER,values_json TEXT,search_text TEXT,public_search_text TEXT,PRIMARY KEY(sheet_id,row_number));
      CREATE TABLE account_links(author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT,PRIMARY KEY(author_row,target_id));`);
    const metadata = { sourcePath: original, sourceSha256: sha(original), sourceUrl: 'https://my.feishu.cn/sheets/test', sourceRevision: version,
      sourceModifiedAt: '2026-10-22T01:00:00Z', audit: { sheetCount: 3, authorCount: authors, workCount: works, matchedTargets: 1, matchedAuthors: 1 } };
    for (const [key, value] of Object.entries(metadata)) source.prepare('INSERT INTO metadata VALUES(?,?)').run(key, JSON.stringify(value));
    const sheet = source.prepare('INSERT INTO source_sheets VALUES(?,?,?,?,?,?)');
    sheet.run('08', '08_作者总表', 0, authors, '[]', 0); sheet.run('09', '09_去重作品', 1, works, '[]', 0); sheet.run('16', '16_账号别名合并', 2, 0, '[]', 1);
    const row = source.prepare('INSERT INTO source_rows VALUES(?,?,?,?,?)');
    for (let i = 0; i < authors; i++) row.run('08', i + 2, JSON.stringify([`作者${i}`, i === 0 ? 'handle_a' : `other_${i}`]), '', '');
    for (let i = 0; i < works; i++) row.run('09', i + 2, JSON.stringify([`73000000000000000${version}${i}`, '作者0', 'handle_a']), '', '');
    source.prepare('INSERT INTO account_links VALUES(?,?,?,?)').run(2, 1, 'handle_a', '2026-10-22T02:00:00Z');
    source.close();
    return { sourcePath, targetPath, original };
  }
  return { dir, targetPath, stage };
}
function mutate(path, sql) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
function query(path, sql) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); } }

test('动态审查数量允许增量版本；按源哈希幂等并保留历史版本及严格作品关联', t => {
  const f = fixture(t), first = f.stage(1, 2, 3);
  const result = integrateCreatorLibrary(first);
  assert.equal(result.status, 'imported'); assert.equal(result.authors, 2); assert.equal(result.works, 3); assert.equal(result.rows, 5);
  assert.equal(result.identityLinkedWorks, 3);
  assert.equal(integrateCreatorLibrary(first).status, 'unchanged');
  const second = integrateCreatorLibrary(f.stage(2, 3, 5));
  assert.equal(second.status, 'imported'); assert.equal(second.importId, 2); assert.equal(second.rows, 8);
  assert.deepEqual(query(f.targetPath, 'SELECT import_id,COUNT(*) n FROM creator_source_rows GROUP BY import_id'), [{ import_id: 1, n: 5 }, { import_id: 2, n: 8 }]);
  assert.equal(query(f.targetPath, 'SELECT COUNT(*) n FROM source_rows')[0].n, 8);
  assert.equal(query(f.targetPath, 'SELECT COUNT(*) n FROM creator_source_work_links WHERE import_id=2')[0].n, 5);
});

test('dry-run 对新版本及已入库版本只读：不建表、不改字节，并报告将做/不变', t => {
  const f = fixture(t), input = f.stage(), before = sha(f.targetPath);
  const plan = integrateCreatorLibrary({ ...input, dryRun: true });
  assert.equal(plan.action, 'would-import'); assert.equal(plan.productionDatabaseChanged, false);
  assert.equal(sha(f.targetPath), before);
  assert.equal(query(f.targetPath, "SELECT count(*) n FROM sqlite_master WHERE name='creator_source_imports'")[0].n, 0);
  integrateCreatorLibrary(input); const importedHash = sha(f.targetPath);
  assert.equal(integrateCreatorLibrary({ ...input, dryRun: true }).action, 'unchanged');
  assert.equal(sha(f.targetPath), importedHash);
});

test('重新导出的 XLSX 字节不同但分类与逐行内容相同，不产生重复来源版本', t => {
  const f = fixture(t), first = f.stage(1, 2, 3);
  integrateCreatorLibrary(first);
  const second = f.stage(2, 2, 3);
  mutate(second.sourcePath, "UPDATE source_rows SET values_json=replace(values_json,'730000000000000002','730000000000000001') WHERE sheet_id='09'");
  const before = sha(f.targetPath);
  const dryRun = integrateCreatorLibrary({ ...second, dryRun: true });
  assert.equal(dryRun.action, 'unchanged');
  assert.equal(integrateCreatorLibrary(second).status, 'unchanged');
  assert.equal(sha(f.targetPath), before);
  assert.equal(query(f.targetPath, 'SELECT COUNT(*) n FROM creator_source_imports')[0].n, 1);
});

test('拒绝不存在或同一目标数据库，不创建空生产库', t => {
  const f = fixture(t), input = f.stage(), absent = join(f.dir, 'absent.sqlite');
  assert.throws(() => integrateCreatorLibrary({ ...input, targetPath: absent, dryRun: true }), /不存在/);
  assert.equal(existsSync(absent), false);
  assert.throws(() => integrateCreatorLibrary({ ...input, targetPath: input.sourcePath, dryRun: true }), /不能相同/);
});

test('原件变化、缺审查元数据及逐表行数漂移均在写入前拒绝', t => {
  const f = fixture(t), input = f.stage(), before = sha(f.targetPath);
  writeFileSync(input.original, 'changed bytes');
  assert.throws(() => integrateCreatorLibrary(input), /校验值/);
  const missingAudit = f.stage(2); mutate(missingAudit.sourcePath, "DELETE FROM metadata WHERE key='audit'");
  assert.throws(() => integrateCreatorLibrary(missingAudit), /已审查/);
  const wrongCount = f.stage(3); mutate(wrongCount.sourcePath, "UPDATE source_sheets SET row_count=row_count+1 WHERE sheet_id='08'; UPDATE source_sheets SET row_count=row_count-1 WHERE sheet_id='09'");
  assert.throws(() => integrateCreatorLibrary(wrongCount), /数量或来源行号/);
  assert.equal(sha(f.targetPath), before);
});

test('拒绝公开账号或已核验身份变化，以及没有来源作者依据的绑定', t => {
  const f = fixture(t), input = f.stage();
  mutate(f.targetPath, "UPDATE targets SET metadata_json=json_set(metadata_json,'$.douyinId','different')");
  assert.throws(() => integrateCreatorLibrary(input), /公开账号 ID 已变化/);
  mutate(f.targetPath, "UPDATE targets SET metadata_json=json_set(metadata_json,'$.douyinId','handle_a','$.identityVerification.accountId','changed')");
  assert.throws(() => integrateCreatorLibrary({ ...input, dryRun: true }), /公开账号 ID 已变化/);
  mutate(f.targetPath, "UPDATE targets SET metadata_json=json_set(metadata_json,'$.identityVerification.accountId','MS4wLjAB_fixture')");
  mutate(input.sourcePath, 'UPDATE account_links SET author_row=3');
  assert.throws(() => integrateCreatorLibrary(input), /没有对应来源 ID/);
  assert.equal(query(f.targetPath, "SELECT count(*) n FROM sqlite_master WHERE name='creator_source_imports'")[0].n, 0);
});

test('拒绝重复作品 ID 与不安全数字 ID', t => {
  const f = fixture(t), duplicate = f.stage();
  mutate(duplicate.sourcePath, "UPDATE source_rows SET values_json=json_set(values_json,'$[0]','same') WHERE sheet_id='09'");
  assert.throws(() => integrateCreatorLibrary(duplicate), /重复的作品 ID/);
  const unsafe = f.stage(2);
  mutate(unsafe.sourcePath, "UPDATE source_rows SET values_json=json_set(values_json,'$[0]',999999999999999999) WHERE sheet_id='09' AND row_number=2");
  assert.throws(() => integrateCreatorLibrary(unsafe), /ID 格式错误/);
});

test('事务中断撤销新版本和明细，兼容视图仍指向原已提交版本', t => {
  const f = fixture(t); integrateCreatorLibrary(f.stage());
  mutate(f.targetPath, "CREATE TRIGGER reject_next BEFORE INSERT ON creator_source_rows WHEN NEW.import_id=2 BEGIN SELECT RAISE(ABORT,'fixture-write-failure'); END");
  assert.throws(() => integrateCreatorLibrary(f.stage(2, 3, 4)), /fixture-write-failure/);
  assert.equal(query(f.targetPath, 'SELECT COUNT(*) n FROM creator_source_imports')[0].n, 1);
  assert.equal(query(f.targetPath, 'SELECT COUNT(*) n FROM creator_source_rows')[0].n, 5);
  assert.equal(query(f.targetPath, 'SELECT COUNT(*) n FROM source_rows')[0].n, 5);
});

test('CLI 保留无参行为，显式 dry-run 和来源目标参数不接受未知选项', () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(['--source', '/a.sqlite', '--dry-run', '--target', '/b.sqlite']), { sourcePath: '/a.sqlite', dryRun: true, targetPath: '/b.sqlite' });
  for (const argv of [['--source'], ['--target', '--dry-run'], ['--typo']]) assert.throws(() => parseArguments(argv), /用法/);
});
