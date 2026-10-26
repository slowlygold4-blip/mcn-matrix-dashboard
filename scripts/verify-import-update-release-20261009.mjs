import { readdirSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync, createReadStream, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = new URL('../', import.meta.url).pathname;
const stage = process.argv[2];
assert.ok(['before', 'after'].includes(stage));
const origin = 'http://127.0.0.1:4188';
async function get(path) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path);
  return response.json();
}
const checkedAt = new Date().toISOString();
const health = await get('/healthz');
const status = await get('/api/monitoring-status');
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const active = {
  runs: db.prepare("SELECT id,trigger_type,current_target_id FROM runs WHERE status='running'").all(),
  jobs: db.prepare("SELECT id,status FROM author_resolution_jobs WHERE status='running'").all(),
  leases: db.prepare("SELECT id,status FROM author_resolution_queue WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL").all(),
};
const counts = Object.fromEntries(['targets', 'snapshots', 'author_resolution_jobs', 'author_resolution_import_sources', 'works_observations']
  .map(table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
const latestRuns = db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs ORDER BY id DESC LIMIT 3').all();
db.close();
const backupDir = join(root, 'data/backups/automatic');
const latest = readdirSync(backupDir).filter(name => name.endsWith('.sqlite.manifest.json')).sort().at(-1);
assert.ok(latest, 'consistent backup must exist');
const manifest = JSON.parse(readFileSync(join(backupDir, latest), 'utf8'));
const backupPath = join(backupDir, latest.replace(/\.manifest\.json$/, ''));
const temporary = mkdtempSync(join(tmpdir(), 'mcn-import-release-'));
const copy = join(temporary, 'backup.sqlite');
let backup;
try {
  copyFileSync(backupPath, copy);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(copy)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  assert.equal(sha256, manifest.sha256);
  assert.equal(statSync(copy).size, manifest.bytes);
  const validation = validateSQLiteSnapshot(copy);
  assert.ok(validationCountsMatch(manifest.validation.counts, validation.counts));
  backup = { path: backupPath, sha256, bytes: manifest.bytes, temporaryCopyVerified: true, validation };
} finally {
  try { unlinkSync(copy); } catch {}
  rmdirSync(temporary);
}
let myRecent = null;
if (stage === 'after') {
  assert.equal(typeof status.browserLane?.locked, 'boolean');
  const recent = await get('/api/author-spreadsheet/jobs/recent?scope=mine&limit=8');
  assert.equal(recent.scope, 'mine');
  assert.ok(recent.jobs.length <= 8);
  myRecent = { scope: recent.scope, count: recent.jobs.length };
}
const output = { checkedAt, stage, health, active, counts, latestRuns, backup,
  scheduler: status.scheduler, updateSla: status.updateSla, browserLane: status.browserLane ?? null,
  sourceSummary: { status: status.sourcePoller.status, checkedTodayCount: status.sourcePoller.checkedTodayCount,
    sourceCount: status.sourcePoller.sourceCount, blockedCount: status.sourcePoller.blockedCount, businessPendingCount: status.sourcePoller.businessPendingCount }, myRecent };
writeFileSync(join(root, `data/maintenance-journal/20261009-import-update/${stage}.json`), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ stage, checkedAt, ready: health.ok, active, counts, schedulerRunning: status.scheduler.running,
  nextRunAt: status.scheduler.nextRunAt, browserLane: output.browserLane, backup: { bytes: backup.bytes, sha256: backup.sha256,
    integrity: backup.validation.integrityCheck, counts: backup.validation.counts }, myRecent }));
