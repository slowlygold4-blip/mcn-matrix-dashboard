import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
import { validateImportMonitoring } from '../public/import-monitoring.js';

const root = new URL('../', import.meta.url).pathname;
const out = root + 'data/maintenance-journal/20261009-import-pipeline/';
await mkdir(out, { recursive: true, mode: 0o700 });
const files = [
  'author-resolution', 'author-resolution-fairness-20261009', 'database', 'author-queue-leased-board-update-20261009',
  'author-evidence-routine', 'board-ingestion-http', 'compact-author-identity-20261009', 'douyin-browser-collector',
  'public-web-works-only', 'public-web-works-only-diagnostics', 'import-monitoring-status-20261009', 'import-monitoring-ui-20261009',
  'master-roster-live-sources-20261009', 'roster-alias-history', 'roster-profile-links-peer', 'profile-monitoring-recovery',
  'profile-monitoring-recovery-peer', 'import-review-current-20261009', 'import-review-current-resolution-ui-20261009',
  'import-review-navigation-20261009', 'import-light-loading-20261009', 'rebuild-import-outcomes',
  'rebuild-import-workflow-20261009', 'import-replay-semantics-20261009',
].map(name => `test/${name}.test.mjs`);
const tests = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4*1024*1024 });
await writeFile(out + 'tests.txt', tests.stdout + tests.stderr, { flag: 'wx', mode: 0o600 });
assert.equal(tests.status, 0, String(tests.error || tests.stdout.slice(-3000) || tests.stderr));
const sha = value => createHash('sha256').update(value).digest('hex');
const jobId = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
const fileHash = sha(await readFile('/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx'));
assert.equal(fileHash, '88bf7c4c50ac9031c8749254e791bb512306c44c564e65db576c6f84e755a3bb');
const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
db.exec('BEGIN');
let report;
try {
  const row = db.prepare('SELECT id,status,request_json,result_json FROM author_resolution_jobs WHERE id=?').get(jobId);
  const job = { id: row.id, status: row.status, request: JSON.parse(row.request_json) };
  assert.equal(job.request.uploadSha256, fileHash);
  const start = performance.now();
  const status = readImportMonitoringStatus(db, job);
  const readMs = performance.now() - start;
  validateImportMonitoring(status, jobId);
  assert.equal(status.inputRows, 3988); assert.equal(status.counts.submittedIdentities, 394);
  const pages = [];
  for (const filter of ['enabled', 'paused', 'pending', 'conflict', 'unknown']) {
    const page = readImportMonitoringStatus(db, job, { status: filter, offset: 99999 });
    validateImportMonitoring(page, jobId, filter);
    pages.push({ status: filter, pagination: page.pagination, count: page.items.length });
  }
  const frozen = sha(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all()));
  assert.equal(frozen, '5e7b062105a441ea48febf674949229bbb908b6ce4bb5f25eb26e48032db0ab2');
  const oldJob = sha(db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?').get('24ed9508-815c-4c08-81f6-b73266d0f304').result_json);
  assert.equal(oldJob, '0eb5608b368befd7f344e6cc5e1898947094da9f36a52a50a21efd0b3bf59e27');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  report = { checkedAt: new Date().toISOString(), testFileCount: files.length,
    testSummary: (tests.stdout + tests.stderr).split('\n').filter(line => /^ℹ (tests|pass|fail|duration)/.test(line)),
    monitoring: status, pageBounds: pages, readMs, originalFileSha256: fileHash, frozenRosterSha256: frozen,
    oldImportResultSha256: oldJob, newImportRequestSha256: sha(row.request_json), newImportResultSha256: sha(row.result_json),
    databaseWrites: 0, snapshots: db.prepare('SELECT count(*) n FROM snapshots').get().n,
    note: '只读验证。启用账号或主页成功不等于作品明细全量覆盖；本轮未重新导入、人工绑定或启动重复采集。' };
} finally { db.exec('ROLLBACK'); db.close(); }
await writeFile(out + 'verification.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...report, monitoring: { checkedAt: report.monitoring.checkedAt, counts: report.monitoring.counts, inputRows: report.monitoring.inputRows } }));
