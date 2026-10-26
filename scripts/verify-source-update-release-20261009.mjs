// Read-only production inspection; verify backup only through a temporary copy.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync, createReadStream, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), stage = process.argv[2];
assert.ok(['before', 'after'].includes(stage));
const outputPath = join(root, `data/maintenance-journal/20261009-source-update-${stage}.json`);
async function get(path) {
  const response = await fetch('http://127.0.0.1:4188' + path, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path); return response.json();
}
const health = await get('/healthz'), status = await get('/api/monitoring-status');
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
db.exec('BEGIN');
const tables = ['targets', 'snapshots', 'works_observations', 'author_resolution_jobs', 'author_resolution_queue', 'author_resolution_import_sources', 'author_resolution_success_receipts', 'master_roster_entries'];
const counts = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const rosterOriginalSha256 = createHash('sha256').update(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all())).digest('hex');
const active = {
  runs: db.prepare("SELECT id,trigger_type FROM runs WHERE status='running'").all(),
  jobs: db.prepare("SELECT id,status FROM author_resolution_jobs WHERE status IN ('queued','running')").all(),
  leases: db.prepare('SELECT id,status FROM author_resolution_queue WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL').all(),
};
const recentRuns = db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs ORDER BY id DESC LIMIT 6').all();
const scheduled = db.prepare('SELECT id,status,started_at,finished_at FROM runs WHERE id=9881').get();
db.exec('COMMIT'); db.close();
let backup = null, endpoint = null;
if (stage === 'after') {
  const before = JSON.parse(readFileSync(join(root, 'data/maintenance-journal/20261009-source-update-before.json'), 'utf8'));
  assert.equal(rosterOriginalSha256, before.rosterOriginalSha256);
  for (const table of ['targets', 'author_resolution_jobs', 'author_resolution_queue', 'master_roster_entries']) assert.equal(counts[table], before.counts[table], table);
  for (const table of ['snapshots', 'works_observations', 'author_resolution_import_sources']) assert.ok(counts[table] >= before.counts[table], table);
  const recent = await get('/api/author-spreadsheet/jobs/recent?scope=mine&limit=8');
  const job = recent.jobs.find(item => Number(item.result?.skippedTotal) > 0);
  if (job) {
    const review = await get(`/api/author-spreadsheet/jobs/${encodeURIComponent(job.id)}/skipped?limit=20`);
    assert.equal(review.version, 1); assert.equal(review.scope, 'historical-job-review-not-live-queue');
    assert.ok(review.items.length <= 20); endpoint = { jobId: job.id, total: review.total, pageCount: review.items.length, scope: review.scope };
  }
  const directory = join(root, 'data/backups/automatic');
  const filename = readdirSync(directory).filter(name => name.endsWith('.sqlite.manifest.json')).sort().at(-1);
  const manifest = JSON.parse(readFileSync(join(directory, filename), 'utf8'));
  const path = join(directory, filename.replace(/\.manifest\.json$/, ''));
  assert.ok(statSync(path).mtimeMs >= Date.parse(before.checkedAt), 'verify the newly released startup backup');
  const temporary = mkdtempSync(join(tmpdir(), 'mcn-source-release-')), copy = join(temporary, 'backup.sqlite');
  try {
    copyFileSync(path, copy);
    const hash = createHash('sha256'); for await (const chunk of createReadStream(copy)) hash.update(chunk);
    const sha256 = hash.digest('hex'); assert.equal(sha256, manifest.sha256); assert.equal(statSync(copy).size, manifest.bytes);
    const validation = validateSQLiteSnapshot(copy); assert.ok(validationCountsMatch(manifest.validation.counts, validation.counts));
    backup = { path, sha256, bytes: manifest.bytes, temporaryCopyVerified: true, validation };
  } finally { try { unlinkSync(copy); } catch {} rmdirSync(temporary); }
}
const output = { checkedAt: new Date().toISOString(), stage, health, counts, rosterOriginalSha256, active, recentRuns, scheduled,
  scheduler: status.scheduler, browserLane: status.browserLane, updateSla: status.updateSla, backup, endpoint,
  sources: { total: status.sourcePoller.sourceCount, checkedToday: status.sourcePoller.checkedTodayCount, blocked: status.sourcePoller.blockedCount, businessPending: status.sourcePoller.businessPendingCount } };
writeFileSync(outputPath, JSON.stringify(output, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ checkedAt: output.checkedAt, stage, counts, rosterOriginalSha256, active, scheduled,
  schedulerRunning: status.scheduler.running, browserLane: status.browserLane, sources: output.sources, endpoint,
  backup: backup && { path: backup.path, bytes: backup.bytes, sha256: backup.sha256, integrity: backup.validation.integrityCheck, tables: Object.keys(backup.validation.counts).length } }));
