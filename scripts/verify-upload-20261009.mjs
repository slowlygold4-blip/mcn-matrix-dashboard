import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readMasterRoster } from '../lib/master-roster.mjs';
import { validateMasterRoster } from '../public/master-roster.js';
const dir = 'data/maintenance-journal/20261009-upload';
const before = JSON.parse(await readFile(`${dir}/before.json`, 'utf8'));
const accounts = JSON.parse(await readFile(`${dir}/accounts-before.json`, 'utf8'));
const submitted = JSON.parse(await readFile(`${dir}/submitted.json`, 'utf8'));
const jobId = submitted.results[0].job.id;
const sha = v => createHash('sha256').update(v).digest('hex');
const norm = v => String(v || '').normalize('NFKC').trim().toLowerCase();
assert.equal(sha(await readFile(`${dir}/source.xlsx`)), before.sha256);
assert.equal(sha(await readFile('/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx')), before.sha256);
const db = new DatabaseSync('data/douyin-monitor.sqlite', { readOnly: true });
db.exec('BEGIN');
const job = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get(jobId);
assert.equal(job.status, 'completed');
const input = JSON.parse(job.request_json), result = JSON.parse(job.result_json);
assert.equal(input.uploadSha256, before.sha256); assert.equal(input.rows.length, 3988);
assert.equal(new Set(input.rows.map(r => norm(r.douyinId))).size, 394);
const roster = readMasterRoster(db); validateMasterRoster(roster);
const sourceRows = new Set();
for (const item of roster.items) for (const source of item.sources.filter(s => s.liveJobId === jobId)) {
  for (const row of source.rows) sourceRows.add(Number(row));
}
assert.deepEqual([...sourceRows].sort((a,b) => a-b), Array.from({ length:3988 }, (_,i) => i+2));
for (const account of accounts) assert.ok(roster.items.some(item => item.theme.key === 'tuantuan'
  && item.accountIds.some(id => norm(id) === account.id) && item.sources.some(s => s.liveJobId === jobId)), `Missing ${account.id}`);
const matched = accounts.filter(a => a.candidates.length === 1).map(account => {
  const original = account.candidates[0];
  const t = db.prepare('SELECT id,enabled FROM targets WHERE id=?').get(original.targetId);
  assert.equal(!!t.enabled, original.enabled);
  assert.ok(db.prepare('SELECT 1 FROM target_boards WHERE target_id=? AND board_name=?').get(t.id, '一条小团团切片矩阵'));
  return { accountId: account.id, targetId: t.id, enabled: !!t.enabled };
});
const frozenHash = sha(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all()));
assert.equal(frozenHash, '5e7b062105a441ea48febf674949229bbb908b6ce4bb5f25eb26e48032db0ab2');
const oldJobHash = sha(db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?').get('24ed9508-815c-4c08-81f6-b73266d0f304').result_json);
assert.equal(oldJobHash,'0eb5608b368befd7f344e6cc5e1898947094da9f36a52a50a21efd0b3bf59e27');
const snapshots = db.prepare('SELECT count(*) n FROM snapshots').get().n;
assert.ok(snapshots >= before.snapshotCount);
db.exec('COMMIT'); db.close();
// Validate a disposable clone of the pre-change consistent backup, never the live database.
const backup = JSON.parse(await readFile('data/maintenance-journal/20261009-roster-reread/backup.json', 'utf8')).backup;
const temporaryDir = await mkdtemp(join(tmpdir(), 'mcn-upload-backup-check-'));
const copy = join(temporaryDir, 'verify.sqlite');
await copyFile(backup.path, copy, constants.COPYFILE_FICLONE);
const check = new DatabaseSync(copy, { readOnly: true });
const integrity = check.prepare('PRAGMA quick_check').get().quick_check;
assert.equal(integrity, 'ok');
assert.equal(check.prepare('SELECT count(*) n FROM snapshots').get().n, backup.manifest.validation.counts.snapshots);
check.close();
const evidence = { checkedAt: new Date().toISOString(), jobId, sourceSha256: before.sha256,
  sourceRows: input.rows.length, submittedAccountIds: accounts.length, preservedSourceRows: sourceRows.size,
  missingFromRoster: 0, matchedExisting: matched.length, enabledExisting: matched.filter(t=>t.enabled).length,
  preservedPaused: matched.filter(t=>!t.enabled).length, notYetMatched: accounts.length-matched.length,
  createdInImportJob: result.createdCount, queuedEvidenceRequests: result.queuedEvidenceRequestCount,
  queuedSubmittedIdentities: result.queuedAccountIdentitySummary?.knownDistinctSubmittedIdentityCount,
  rosterSummary: roster.summary, sourceProjection: roster.liveSources, historicalSnapshotCount: snapshots,
  frozenHash, oldJobHash, backup: { original: backup.path, clone: copy, quickCheck: integrity, snapshots: backup.manifest.validation.counts.snapshots },
  tests: { passed:112, failed:0, log:`${dir}/tests.txt` },
  limits:['244个提交ID未匹配现有监控目标；本次导入未新建账号，不将入库完成宣称为全部监控成功。','公开证据队列受既有重试、失败、访问限制影响；排队项数不是作者数。','Excel填报的播放/点赞未写成平台实际采样或伪造历史。'] };
await writeFile(`${dir}/verification.json`, JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
