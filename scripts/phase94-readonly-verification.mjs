import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = 'data/maintenance-journal/2026-10-02-phase94-';
const startedAt = new Date().toISOString();
const sha = value => createHash('sha256').update(value).digest('hex');
async function fileSha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const backup = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase93-backup.json')));
const backupSha = await fileSha(backup.backupPath), restoreSha = await fileSha(backup.restoredPath);
assert.equal(backupSha, backup.sha256);
assert.equal(restoreSha, backup.sha256);
assert.equal((await stat(backup.restoredPath)).size, backup.bytes);
const restoredValidation = validateSQLiteSnapshot(backup.restoredPath);
assert.ok(validationCountsMatch(backup.validation.counts, restoredValidation.counts));
const productionCode = [];
for (const entry of backup.code) {
  const current = await fileSha(join(root, entry.path));
  assert.equal(current, entry.sha256);
  assert.equal(await fileSha(entry.destination), entry.sha256);
  productionCode.push({ path: entry.path, sha256: current, unchanged: true });
}

const tests = {};
for (const [name, expected] of [['main', 4032], ['site', 47]]) {
  const path = prefix + name + '-full.log';
  const bytes = await readFile(join(root, path)), log = bytes.toString();
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key =>
    [key, Number(log.match(new RegExp('ℹ ' + key + ' (\\d+)'))?.[1])]));
  assert.equal(summary.tests, expected);
  assert.equal(summary.pass, expected);
  assert.equal(summary.fail + summary.cancelled + summary.skipped, 0);
  tests[name] = { ...summary, logPath: path, logSha256: sha(bytes) };
}

const health = await (await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(8_000) })).json();
assert.equal(health.status, 'ready');
assert.equal(health.runtimeAI, false);
const status = await (await fetch('http://127.0.0.1:4188/api/monitoring-status', { signal: AbortSignal.timeout(10_000) })).json();
assert.equal(status.scheduler.scheduleIntervalHours, 8);
assert.deepEqual(status.scheduler.slotTimes, ['02:00', '10:00', '18:00']);
const manifestBytes = await readFile(join(root, 'data/source-poll/manifest.json'));
const manifest = JSON.parse(manifestBytes);
assert.equal(sha(manifestBytes), '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const jobIds = Object.entries(manifest.sources).map(([key, value]) => ({ key, jobId: value.lastJobId ?? null })).sort((a, b) => a.key.localeCompare(b.key));
assert.equal(sha(JSON.stringify(jobIds)), 'aa555691924a6dc7651c3a426e740dff8edeb1501c6962bdf0ec05d94a10738d');

const site = join(root, '../mcn-public-site');
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: site, encoding: 'utf8' }).trim(), '');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim(), 'b2a350de2a7d24cba8257be508f382cd5b8eef1b');
const siteSource = {};
for (const [path, expected] of [
  ['app/page.tsx', '0a517d64cabf819434c46efc3114453ff75b747b31f21652a418e0206971e272'],
  ['app/replica.css', '8f2fe645bc8ba323eaffaea6e65717f145bdabc2694d89d79dd6e4d3dbcd8b0c'],
]) {
  siteSource[path] = await fileSha(join(site, path));
  assert.equal(siteSource[path], expected);
}

const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
let database;
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  database = {
    counts: Object.fromEntries(['snapshots', 'posts', 'post_metrics', 'works_observations'].map(table =>
      [table, db.prepare('SELECT COUNT(*) n FROM ' + table).get().n])),
    activeRuns: db.prepare("SELECT id,trigger_type,started_at,status FROM runs WHERE status='running'").all(),
    settings: db.prepare("SELECT key,value,updated_at FROM settings WHERE key='publicPostsPerAccount' OR key LIKE 'publicWorks%' ORDER BY key").all(),
    totalChanges: db.prepare('SELECT total_changes() n').get().n,
  };
  assert.equal(database.totalChanges, 0);
  assert.ok(database.activeRuns.length <= 1);
  db.exec('ROLLBACK');
} finally { db.close(); }
const evidence = {
  phase: 94, startedAt, finishedAt: new Date().toISOString(), health,
  tests, siteSource, siteUnchangedV39: true, productionCode,
  backup: { backupPath: backup.backupPath, restoredPath: backup.restoredPath, bytes: backup.bytes,
    sha256: backupSha, cutoff: backup.cutoff, temporaryReadonlyRestoredValidation: restoredValidation,
    containsEntireFixedPhase94Batch: false, noAdditionalBackupCopy: true },
  scheduler: status.scheduler, liveCoverage: status.updateSla, database,
  source: { sha256: sha(manifestBytes), jobIdProjectionSha256: sha(JSON.stringify(jobIds)), lastFinishedAt: manifest.lastFinishedAt,
    checkedToday: status.sourcePoller.checkedTodayCount, blocked: status.sourcePoller.blockedCount, stale: status.sourcePoller.staleCount },
  currentTestsAreNotCandidateReleaseAcceptance: true, noNewCloudSamplingClaim: true,
  noRealUserRetentionTrial: true, noManualCollection: true, noNewAiTimer: true,
};
await writeFile(join(root, prefix + 'readonly-verification.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ checkedAt: evidence.finishedAt, mainPass: tests.main.pass, sitePass: tests.site.pass,
  backupReverified: true, backupTerminalCutoff: backup.cutoff.maxTerminalRunId,
  siteUnchangedV39: true, running: database.activeRuns.map(x => x.id) }));
