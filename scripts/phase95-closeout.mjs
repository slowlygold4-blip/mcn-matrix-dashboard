import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = '/Users/tyke/Documents/Codex/2026-08-31/bi-a/outputs/mcn-public-site';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(root, 'docs/phase95-profile-first-manifest.json')));
for (const entry of manifest) assert.equal(sha(await readFile(join(root, entry.file))), entry.main);
assert.equal(execFileSync('git', ['status', '--short'], { cwd: site, encoding: 'utf8' }).trim(), '');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim(), 'b2a350de2a7d24cba8257be508f382cd5b8eef1b');
const sourceBytes = await readFile(join(root, 'data/source-poll/manifest.json'));
const source = JSON.parse(sourceBytes);
assert.equal(sha(sourceBytes), '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const backup = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase93-backup.json')));
const restored = new DatabaseSync(backup.restoredPath, { readOnly: true });
let restore;
try {
  restored.exec('PRAGMA query_only=ON; BEGIN');
  const quick = restored.prepare('PRAGMA quick_check').all();
  assert.deepEqual(quick, [{ quick_check: 'ok' }].map(row => Object.assign(Object.create(null), row)));
  const foreignKeys = restored.prepare('PRAGMA foreign_key_check').all();
  assert.equal(foreignKeys.length, 0);
  const counts = {};
  for (const table of Object.keys(backup.validation.counts)) {
    assert.match(table, /^[a-z_]+$/);
    counts[table] = restored.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
    assert.equal(counts[table], backup.validation.counts[table]);
  }
  assert.equal(restored.prepare('SELECT total_changes() count').get().count, 0);
  restore = { quickCheck: 'ok', foreignKeyViolations: 0, tablesMatched: Object.keys(counts).length,
    totalChanges: 0, backupSha256: backup.sha256, cutoff: backup.cutoff,
    wholeFileHashesRecheckedThisTurn: true, includesRun2578: false };
  restored.exec('ROLLBACK');
} finally { restored.close(); }
const database = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
let current;
try {
  database.exec('PRAGMA query_only=ON; BEGIN');
  current = database.prepare('SELECT id,trigger_type,status,started_at,finished_at,processed_count,target_count FROM runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(database.prepare('SELECT total_changes() count').get().count, 0);
  database.exec('ROLLBACK');
} finally { database.close(); }
const status = await fetch('http://127.0.0.1:4188/api/monitoring-status', { signal: AbortSignal.timeout(15000) });
assert.equal(status.status, 200);
const monitoring = await status.json();
const queueResponse = await fetch('http://127.0.0.1:4188/api/ingestion-reviews', { signal: AbortSignal.timeout(15000) });
assert.equal(queueResponse.status, 200);
const reviews = await queueResponse.json();
const healthResponse = await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(15000) });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
const savedEvidence = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase95-evidence-preserved.json')));
const logs = ['docs/phase95-profile-first-full-final.log',
  'data/maintenance-journal/2026-10-02-phase95-exact-archive-gate.log',
  'data/maintenance-journal/2026-10-02-phase95-root-envelope-check.log',
  'data/maintenance-journal/2026-10-02-phase95-site-full.log'];
const logProofs = [];
for (const file of logs) {
  const bytes = await readFile(join(root, file));
  const text = bytes.toString();
  assert.match(text, /(?:ℹ|#)\s*fail\s+0(?:\s|$)/);
  logProofs.push({ file, sha256: sha(bytes), tail: text.split('\n').slice(-10).join('\n') });
}
const now = new Date();
const receipt = {
  phase: 95, startedAt: '2026-10-02T02:29:48.000Z', developmentFrozenAt: '2026-10-02T02:48:00.000Z',
  finishedAt: now.toISOString(), elapsedMinutes: (now.getTime() - Date.parse('2026-10-02T02:29:48.000Z')) / 60000,
  originalRequirementsRetained: 'U01-U47', mainPreimagesMatch: manifest.length,
  siteVersion: 39, siteClean: true, siteCodeChanged: false,
  run: current, monitoringCheckedAt: monitoring.checkedAt,
  coverage: { coreDaily: monitoring.updateSla?.coreAccounts?.daily ?? null,
    core8h: monitoring.updateSla?.coreAccounts?.fresh8h ?? null,
    worksDaily: monitoring.updateSla?.works?.daily ?? null,
    works8h: monitoring.updateSla?.works?.fresh8h ?? null,
    topicsDaily: monitoring.updateSla?.topics?.daily ?? null,
    topics8h: monitoring.updateSla?.topics?.fresh8h ?? null },
  source: { sha256: sha(sourceBytes), lastFinishedAt: source.lastFinishedAt, unchanged: true },
  queue: { status: queueResponse.status, pending: reviews.totalPending ?? reviews.summary?.totalPending ?? null,
    completed: reviews.totalCompleted ?? reviews.summary?.totalCompleted ?? null,
    generator: reviews.queue ? { status: reviews.queue.status, scannedCount: reviews.queue.scannedCount,
      pendingCount: reviews.queue.pendingCount, failedCount: reviews.queue.failedCount,
      checkedAt: reviews.queue.checkedAt } : null },
  health: { httpStatus: healthResponse.status, status: health.status, runtimeAI: health.runtimeAI },
  pids: execFileSync('ps', ['-p', '22870,26001,92296', '-o', 'pid=,ppid=,etime=,stat='], { encoding: 'utf8' }).trim(),
  backupValidation: restore, evidenceSaved: savedEvidence, tests: logProofs,
  newTerminalRunsReviewed: 0, reviewedRunIds: [], productionPromoted: false,
  privateTestProcessesRetained: false, newCollectorsOrTimers: false,
  researchDelivered: 'docs/okx-mcn-frontend-design-contract-20261002.md',
  currentOpenP2: 'work metrics return loses original works list pagination and sorting; not fixed or published',
  limits: ['No new visual or keyboard acceptance due browser timeouts', 'No real full701 candidate throughput observation',
    'No Mac-off new sampling proof', 'Full platform works completeness not established', 'Original failed tests retained']
};
receipt.priorReceiptPreserved = 'data/maintenance-journal/2026-10-02-phase95-closeout.json';
receipt.validationProjectionCorrection = 'SLA metrics use updateSla.coreAccounts/works/topics, not a coverage property; original receipt preserved.';
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase95-closeout-final.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ finishedAt: receipt.finishedAt, elapsedMinutes: receipt.elapsedMinutes,
  run: receipt.run, mainPreimagesMatch: receipt.mainPreimagesMatch, sourceUnchanged: true,
  siteClean: true, restoreTables: restore.tablesMatched, tests: logProofs.map(row => ({ file: row.file, sha256: row.sha256 })),
  productionPromoted: false, researchDelivered: receipt.researchDelivered }));
