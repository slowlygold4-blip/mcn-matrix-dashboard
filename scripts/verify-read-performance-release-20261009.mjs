// Read-only release checks. Does not import, collect, restart, or alter the database.
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, copyFileSync, statSync, createReadStream, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const stage = process.argv[2]; assert.ok(['before', 'after'].includes(stage));
const root = new URL('../', import.meta.url).pathname, journal = join(root, 'data/maintenance-journal');
const hash = value => createHash('sha256').update(value).digest('hex');
const get = async path => {
  const start = performance.now();
  const response = await fetch('http://127.0.0.1:4188' + path, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path);
  return { data: await response.json(), milliseconds: performance.now() - start };
};
const monitoring = await get('/api/monitoring-status'), status = monitoring.data;
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true }); db.exec('BEGIN');
const counts = Object.fromEntries(['targets', 'snapshots', 'works_observations', 'author_resolution_jobs', 'author_resolution_queue', 'author_resolution_import_sources', 'author_resolution_success_receipts', 'master_roster_entries']
  .map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const rosterSha256 = hash(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all()));
const historySha256 = hash(db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?').get('24ed9508-815c-4c08-81f6-b73266d0f304').result_json);
const active = { runs: db.prepare("SELECT id,trigger_type FROM runs WHERE status='running'").all(),
  jobs: db.prepare("SELECT id,status FROM author_resolution_jobs WHERE status IN ('queued','running')").all(),
  leases: db.prepare('SELECT id FROM author_resolution_queue WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL').all() };
db.exec('COMMIT'); db.close();
const sourceBytes = readFileSync(join(root, 'data/source-poll/manifest.json'));
const manifest = JSON.parse(sourceBytes), source = status.sourcePoller;
let backup = null;
if (stage === 'after') {
  const before = JSON.parse(readFileSync(join(journal, '20261009-read-performance-before.json'), 'utf8'));
  assert.equal(rosterSha256, before.rosterSha256); assert.equal(historySha256, before.historySha256);
  for (const table of ['targets', 'author_resolution_jobs', 'author_resolution_queue', 'master_roster_entries']) assert.equal(counts[table], before.counts[table], table);
  for (const table of ['snapshots', 'works_observations', 'author_resolution_import_sources']) assert.ok(counts[table] >= before.counts[table], table);
  assert.equal(source.currentJobScope, 'registered-source-latest-import-jobs-not-author-identity-queue');
  assert.equal(source.activeJobCount, 0); assert.equal(source.activeJobUnknownCount, 0);
  assert.equal(source.historicalReviewSourceCount, source.businessPendingCount);
  const directory = join(root, 'data/backups/automatic');
  const name = readdirSync(directory).filter(name => name.endsWith('.sqlite.manifest.json')).sort().at(-1);
  const saved = JSON.parse(readFileSync(join(directory, name), 'utf8')), path = join(directory, name.replace(/\.manifest\.json$/, ''));
  assert.ok(statSync(path).mtimeMs >= Date.parse(before.checkedAt));
  const temporary = mkdtempSync(join(tmpdir(), 'mcn-read-release-')), copy = join(temporary, 'backup.sqlite');
  try {
    copyFileSync(path, copy); const digest = createHash('sha256');
    for await (const chunk of createReadStream(copy)) digest.update(chunk);
    const sha256 = digest.digest('hex'); assert.equal(sha256, saved.sha256); assert.equal(statSync(copy).size, saved.bytes);
    const validation = validateSQLiteSnapshot(copy); assert.ok(validationCountsMatch(saved.validation.counts, validation.counts));
    backup = { path, sha256, bytes: saved.bytes, temporaryCopyVerified: true, validation };
  } finally { unlinkSync(copy); rmdirSync(temporary); }
}
const files = ['server.mjs','lib/works-deferred-read.mjs','lib/browser-access-gate.mjs','lib/source-poller-status.mjs',
  'lib/source-job-state-read.mjs','public/rebuild.js','public/rebuild.html','public/live-sync.js'];
const result = { checkedAt: new Date().toISOString(), stage, counts, rosterSha256, historySha256, active,
  health: (await get('/healthz')).data, monitoringMilliseconds: monitoring.milliseconds,
  scheduler: status.scheduler, browserLane: status.browserLane, updateSla: status.updateSla,
  sourceManifestSha256: hash(sourceBytes), sources: { lastFinishedAt: manifest.lastFinishedAt, updatedAt: manifest.updatedAt,
    sourceCount: source.sourceCount, checkedTodayCount: source.checkedTodayCount, blockedCount: source.blockedCount,
    currentJobScope: source.currentJobScope, activeJobCount: source.activeJobCount,
    activeJobUnknownCount: source.activeJobUnknownCount, currentFailedJobCount: source.currentFailedJobCount,
    historicalReviewSourceCount: source.historicalReviewSourceCount },
  code: stage === 'after' ? Object.fromEntries(files.map(file => [file, hash(readFileSync(join(root, file)))])) : null, backup };
writeFileSync(join(journal, `20261009-read-performance-${stage}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ stage, counts, active, source: result.sources, monitoringMilliseconds: result.monitoringMilliseconds,
  backup: backup && { path: backup.path, sha256: backup.sha256, integrity: backup.validation.integrityCheck } }));
