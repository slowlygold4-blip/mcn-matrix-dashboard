import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = '/tmp/phase94-works-async-rkQiaj';
const prefix = 'data/maintenance-journal/2026-10-02-phase94-';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileSha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const tests = {};
for (const [name, path, count, pass, skip] of [
  ['main', prefix + 'main-final-full.log', 4032, 4032, 0],
  ['site', prefix + 'site-full.log', 47, 47, 0],
  ['candidate', 'docs/phase94-works-async-full-final.log', 4066, 4065, 1],
  ['candidateActualArchive', prefix + 'exact-archive-gate-final-v3.log', 60, 60, 0],
  ['snapshotPeerFinal', prefix + 'snapshot-peer-final-frozen-six-source-green.log', 2, 2, 0],
]) {
  const bytes = await readFile(join(root, path)), log = bytes.toString();
  const result = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key =>
    [key, Number(log.match(new RegExp('ℹ ' + key + ' (\\d+)'))?.[1])]));
  assert.equal(result.tests, count); assert.equal(result.pass, pass); assert.equal(result.skipped, skip);
  assert.equal(result.fail + result.cancelled, 0);
  tests[name] = { ...result, path, sha256: sha(bytes) };
}
const manifestPath = 'docs/phase94-works-async-source-manifest.json';
const manifest = JSON.parse(await readFile(join(root, manifestPath)));
assert.equal(manifest.length, 12);
for (const entry of manifest) {
  assert.equal(await fileSha(join(root, entry.file)), entry.main);
  assert.equal(await fileSha(join(stage, entry.file)), entry.stage);
}
const candidatePackage = '/tmp/phase94-works-async-candidate.tar.gz';
const packageSha = await fileSha(candidatePackage);
assert.equal(packageSha, 'b20368227582895e94fce06f380b4e851971030b8b0a108b239d69472ffc51f1');
const members = execFileSync('tar', ['-tzf', candidatePackage], { encoding: 'utf8' }).trim().split('\n');
assert.equal(members.length, 16);
assert.deepEqual(members.slice(0, 12), manifest.map(row => row.file));
assert.ok(members.slice(12).every(file => /^test\/phase\d+-[^/]+\.test\.mjs$/.test(file)));
const keptPackage = 'data/code-candidates/phase94/works-async-candidate.tar.gz';
await mkdir(join(root, 'data/code-candidates/phase94'), { recursive: true, mode: 0o700 });
await copyFile(candidatePackage, join(root, keptPackage), constants.COPYFILE_EXCL);
assert.equal(await fileSha(join(root, keptPackage)), packageSha);

const handoff = JSON.parse(await readFile(join(root, prefix + 'reviewed-events-handoff.json')));
assert.equal(handoff.results.length, 22);
for (const item of handoff.results) {
  assert.equal(await fileSha(join(root, `data/ingestion-reviews/run-${item.runId}.json`)), item.originalEventSha256);
  assert.equal(await fileSha(join(root, `data/ingestion-reviews/reviewed-${item.runId}.json`)), item.completionSha256);
}
const sourceBytes = await readFile(join(root, 'data/source-poll/manifest.json'));
assert.equal(sha(sourceBytes), '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const source = JSON.parse(sourceBytes);
const jobIds = Object.entries(source.sources).map(([key, value]) => ({ key, jobId: value.lastJobId ?? null })).sort((a, b) => a.key.localeCompare(b.key));
assert.equal(sha(JSON.stringify(jobIds)), 'aa555691924a6dc7651c3a426e740dff8edeb1501c6962bdf0ec05d94a10738d');
const site = join(root, '../mcn-public-site');
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: site, encoding: 'utf8' }).trim(), '');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim(), 'b2a350de2a7d24cba8257be508f382cd5b8eef1b');
const health = await (await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(8000) })).json();
assert.equal(health.status, 'ready'); assert.equal(health.runtimeAI, false);
const monitoring = await (await fetch('http://127.0.0.1:4188/api/monitoring-status', { signal: AbortSignal.timeout(10000) })).json();
assert.equal(monitoring.scheduler.scheduleIntervalHours, 8);
assert.deepEqual(monitoring.scheduler.slotTimes, ['02:00', '10:00', '18:00']);
const services = execFileSync('ps', ['-p', '22870,26001,92296', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' });
for (const pid of [22870, 26001, 92296]) assert.match(services, new RegExp('^\\s*' + pid + '\\s+1\\s', 'm'));
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
let database;
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  database = { activeRuns: db.prepare("SELECT id,trigger_type,status,started_at,finished_at,target_count,processed_count FROM runs WHERE status='running'").all(),
    counts: Object.fromEntries(['snapshots', 'posts', 'post_metrics', 'works_observations'].map(table => [table, db.prepare('SELECT COUNT(*) n FROM ' + table).get().n])),
    settings: db.prepare("SELECT key,value,updated_at FROM settings WHERE key='publicPostsPerAccount' OR key LIKE 'publicWorks%' ORDER BY key").all(),
    totalChanges: db.prepare('SELECT total_changes() n').get().n };
  assert.equal(database.totalChanges, 0); assert.ok(database.activeRuns.length <= 1);
  assert.equal(database.settings.find(row => row.key === 'publicPostsPerAccount').value, '30');
  assert.equal(database.settings.find(row => row.key === 'publicPostsPerAccount').updated_at, '2026-09-04T07:53:16.606Z');
  db.exec('ROLLBACK');
} finally { db.close(); }
const evidencePaths = [manifestPath, 'docs/phase94-works-async-review.md', 'docs/phase94-async-peer-review.md', 'docs/phase94-snapshot-peer.md',
  'docs/phase94-data-audit.md', prefix + 'data-audit.json', prefix + 'data-readback.json', prefix + 'final-integrity-peer.json',
  prefix + 'readonly-verification.json', prefix + 'candidate-archive.json', prefix + 'reviewed-events-handoff.json'];
const evidence = [];
for (const path of evidencePaths) evidence.push({ path, sha256: await fileSha(join(root, path)) });
const finishedAt = new Date().toISOString();
const result = { phase: 94, startedAt: '2026-10-02T02:04:42.000Z', finishedAt,
  elapsedMinutes: (Date.parse(finishedAt) - Date.parse('2026-10-02T02:04:42.000Z')) / 60000,
  candidatePackage: { path: keptPackage, sha256: packageSha, members, productionPreimagesUnchanged: 12, promoted: false },
  tests, evidence, reviewedRunIds: handoff.results.map(item => item.runId), originalEventsPreserved: true,
  fixedFirstSeenWorks: 44, fixedMetricObservations: 302, fixedNewProfileSnapshots: 0,
  source: { sha256: sha(sourceBytes), lastFinishedAt: source.lastFinishedAt, jobIdProjectionUnchanged: true },
  database, health, scheduler: monitoring.scheduler, liveCoverage: monitoring.updateSla, sourceStatus: monitoring.sourcePoller,
  services, siteUnchangedV39: true, noNewDeployment: true, noManualCollectionOrNewAiSchedule: true,
  releaseDeferredWhileOrdinaryRunActive: true, nextSourceReviewStartsAt: 2578,
  backupVerifiedEarlierThisRun: { receipt: prefix + 'readonly-verification.json', terminalCutoff: 2558, containsFullFixedBatch: false },
  unresolvedFullGoal: ['Mac-off ordinary new sampling', 'complete works coverage', 'all-network/client reachability'],
  noRealUserRetentionClaim: true, goalRemainsActive: true };
await writeFile(join(root, prefix + 'closeout.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ finishedAt, elapsedMinutes: result.elapsedMinutes, tests,
  candidateKeptNotPromoted: keptPackage, unchangedMainSourceFiles: 12, originalEvents: 22, activeRuns: database.activeRuns.map(row => row.id), goalRemainsActive: true }));
