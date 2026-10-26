// Bounded read-only verification; only a new immutable handoff receipt is written.
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
const stage = '/tmp/phase92-works-rev4-J2GMTY';
const sha = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const get = async path => {
  const response = await fetch(`http://127.0.0.1:4188${path}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
};
const files = [
  ['lib/browser-works-pagination.mjs', 'browser-works-pagination.mjs'],
  ['lib/official-profile-evidence.mjs', 'official-profile-evidence.mjs'],
  ['lib/works-only-observation.mjs', 'works-only-observation.mjs'],
  ['lib/works-observation.mjs', 'works-observation.mjs'],
  ['lib/works-only-scheduler.mjs', 'works-only-scheduler.mjs'],
  ['lib/providers/public-web.mjs', 'public-web.mjs'],
  ['scripts/douyin_browser_collector.mjs', 'douyin_browser_collector.mjs'],
];
const manifest = new Map((await readFile(join(root, 'docs/phase92-works-resume-rev4-sha256.txt'), 'utf8'))
  .trim().split('\n').map(line => { const [, hash, path] = line.match(/^(\w{64})\s+(.+)$/); return [path, hash]; }));
const production = [];
for (const [path, name] of files) {
  const actual = await sha(join(root, path));
  const candidate = await sha(join(stage, path));
  assert.equal(actual, manifest.get(`preimage/${name}`), `production changed: ${path}`);
  assert.equal(candidate, manifest.get(path), `candidate changed: ${path}`);
  production.push({ path, productionSha256: actual, candidateSha256: candidate, unchanged: true });
}
const archive = '/tmp/phase92-works-resume-rev4.tar.gz';
const archiveSha256 = await sha(archive);
assert.equal(archiveSha256, 'a4410cd678f0008b062e088e2d6a29fe1ddf1a9c6b3603c0c79a19fc200fc1ff');
const candidateLog = join(root, 'docs/phase92-works-full-rev4.log');
assert.equal(await sha(candidateLog), 'e2711536cdf0a482f3a8699aeda99c5993faaad85837094c2aa8fd4081e7e522');
const log = await readFile(candidateLog, 'utf8');
assert.match(log, /tests 4052/); assert.match(log, /pass 4051/);
assert.match(log, /fail 0/); assert.match(log, /skipped 1/);
const reviewed = await readJson(join(root, 'data/maintenance-journal/2026-10-02-phase92-reviewed-events-handoff.json'));
assert.equal(reviewed.results.length, 33);
assert.ok(reviewed.results.every((item, index) => item.runId === 2498 + index && item.status === 'created' && item.originalPreserved));
for (const item of reviewed.results) {
  assert.equal(await sha(join(root, `data/ingestion-reviews/run-${item.runId}.json`)), item.originalEventSha256);
  assert.ok((await stat(join(root, `data/ingestion-reviews/reviewed-${item.runId}.json`))).size > 0);
}
const backupPrior = await readJson(join(root, 'data/maintenance-journal/2026-10-02-phase91-backup-recheck.json'));
const backupBefore = await stat(backupPrior.restoredPath);
const backupSha256 = await sha(backupPrior.restoredPath);
assert.equal(backupSha256, backupPrior.expectedSha256);
assert.equal(backupBefore.mode & 0o777, 0o400);
const db = new DatabaseSync(backupPrior.restoredPath, { readOnly: true });
let backup;
try {
  db.exec('PRAGMA query_only=ON');
  const checks = db.prepare('PRAGMA quick_check').all();
  assert.deepEqual(checks.map(item => Object.values(item)[0]), ['ok']);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const changes = db.prepare('SELECT total_changes() AS changes').get().changes;
  assert.equal(changes, 0);
  const cutoff = db.prepare("SELECT MAX(id) AS maxRunId, MAX(CASE WHEN finished_at IS NOT NULL AND status <> 'running' THEN id END) AS maxTerminalRunId FROM runs").get();
  assert.equal(cutoff.maxTerminalRunId, 2448);
  backup = { sha256: backupSha256, bytes: backupBefore.size, readOnly: true, queryOnly: true, changes, quickCheck: 'ok', foreignKeyViolations: 0, cutoff, containsPhase92: false, noNewCopy: true };
} finally { db.close(); }
const backupAfter = await stat(backupPrior.restoredPath);
assert.equal(backupAfter.mtimeMs, backupBefore.mtimeMs);
assert.equal(backupAfter.size, backupBefore.size);
const health = await get('/api/health');
assert.equal(health.runtimeAI, false);
const monitoring = await get('/api/monitoring-status');
const queue = await get('/api/ingestion-reviews');
const keys = ['running', 'scheduleTime', 'scheduleIntervalHours', 'timeZone', 'slotTimes', 'currentSlotKey', 'lastTickAt', 'lastSuccessfulTickAt', 'nextRunAt', 'scheduledAccountTargetCount', 'scheduledProfileCompletedTargetCount', 'scheduledWorksCompleteTargetCount', 'scheduledWorksLimitedTargetCount', 'scheduledWorksAwaitingNextSlotTargetCount', 'scheduledInactiveTargetCount'];
const scheduler = Object.fromEntries(keys.map(key => [key, monitoring.scheduler[key]]));
assert.equal(scheduler.scheduleIntervalHours, 8);
assert.deepEqual(scheduler.slotTimes, ['02:00', '10:00', '18:00']);
// `running` means a sampling job is busy, not that the ordinary timer exists.
const tickAgeMs = Date.now() - Date.parse(scheduler.lastTickAt);
assert.ok(tickAgeMs >= 0 && tickAgeMs < 90000, 'ordinary scheduler tick is stale');
const current = monitoring.scheduler.currentRun;
const sourcePath = join(root, 'data/source-poll/manifest.json');
const source = await readJson(sourcePath);
const sourceSha256 = await sha(sourcePath);
assert.equal(sourceSha256, '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const siteRoot = join(root, '../mcn-public-site');
const siteCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:siteRoot, encoding:'utf8'}).trim();
const siteStatus = execFileSync('git', ['status', '--porcelain'], {cwd:siteRoot, encoding:'utf8'}).trim();
assert.equal(siteStatus, '');
assert.equal(siteCommit, '2b4aa1a7b2b6998c222d3bc608a1e926c4565b93');
const services = execFileSync('ps', ['-p', '22870,26001,92296', '-o', 'pid=,ppid=,comm='], {encoding:'utf8'}).trim().split('\n').map(line => line.trim());
assert.equal(services.length, 3);
const finishedAt = new Date().toISOString();
const evidence = { schemaVersion:1, phase:92, startedAt, finishedAt, elapsedSincePhaseStartMinutes:(Date.parse(finishedAt)-Date.parse('2026-10-02T01:19:57Z'))/60000,
  health, scheduler, tickAgeMs, currentRun: current ? { runId: current.runId, triggerType: current.triggerType, startedAt: current.startedAt } : null,
  ingestionReview: { totalPending:queue.totalPending, totalCompleted:queue.totalCompleted, reviewedRunIds:reviewed.results.map(item=>item.runId), nextUnreviewedBatchRunId:2531, originalEventsPreserved:true },
  source:{ sha256:sourceSha256, lastFinishedAt:source.lastFinishedAt, unchanged:true }, services, backup,
  candidate:{ stage, archive, archiveSha256, production, testCount:4052, passed:4051, failed:0, skipped:1, skipReason:'production archive not copied into isolation', independentRefusalRaceCases:10, directionalCases:20, promoted:false },
  site:{ commit:siteCommit, clean:true, publicURL:'https://mcn-matrix-observatory.slowlygold4.chatgpt.site/', version:'V38', productionFrontendChanged:false, newBrowserAcceptance:false },
  firstVerificationFailure:'The verifier initially treated the per-job busy flag as timer liveness; verified its actual owner and replaced that assertion with exact slot times and recent tick age. No product code was changed.',
  noManualCollection:true, noNewAITimer:true, goalStatus:'active', limitations:['actual platform continuation benefit not verified','full works coverage not achieved','Mac-off new collection not achieved','all networks not guaranteed','new ranking shortcuts researched, not shipped'] };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase92-closeout.json'), JSON.stringify(evidence,null,2)+'\n', {flag:'wx',mode:0o600});
console.log(JSON.stringify({ finishedAt, reviewedCount:33, productionUnchanged:true, candidatePromoted:false, siteClean:true, backupCutoff:2448, pending:queue.totalPending, completed:queue.totalCompleted, runtimeAI:false }));
