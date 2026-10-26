// Read-only release evidence. Never collects/imports or mutates production data.
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, copyFileSync, statSync, createReadStream, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
import { enrichImportReviewCurrent, CURRENT_RESOLUTION_SCOPE } from '../lib/import-review-current.mjs';
import { projectImportReview } from '../lib/import-review.mjs';

const stage = process.argv[2]; assert.ok(['before', 'after'].includes(stage));
const root = new URL('../', import.meta.url).pathname, journal = join(root, 'data/maintenance-journal');
const get = async path => { const response = await fetch('http://127.0.0.1:4188' + path, { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200, path); return response.json(); };
const status = await get('/api/monitoring-status');
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true }); db.exec('BEGIN');
const counts = Object.fromEntries(['targets', 'snapshots', 'works_observations', 'author_resolution_jobs', 'author_resolution_queue', 'author_resolution_import_sources', 'author_resolution_success_receipts', 'master_roster_entries']
  .map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const rosterSha256 = createHash('sha256').update(JSON.stringify(db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all())).digest('hex');
const jobRow = db.prepare('SELECT * FROM author_resolution_jobs WHERE id=?').get('24ed9508-815c-4c08-81f6-b73266d0f304');
const job = { id: jobRow.id, fileName: jobRow.file_name, sheetName: jobRow.sheet_name, request: JSON.parse(jobRow.request_json), result: JSON.parse(jobRow.result_json), finishedAt: jobRow.finished_at };
const historySha256 = createHash('sha256').update(jobRow.result_json).digest('hex');
const start = performance.now(), page = enrichImportReviewCurrent(db, job, projectImportReview(job, { limit: 500 }));
const projection = { milliseconds: performance.now() - start, total: page.total, rows: page.items.length,
  states: page.items.reduce((sum, row) => { const key = row.currentResolution.status; sum[key] = (sum[key] || 0) + 1; return sum; }, {}) };
const active = { runs: db.prepare("SELECT id,trigger_type FROM runs WHERE status='running'").all(),
  jobs: db.prepare("SELECT id,status FROM author_resolution_jobs WHERE status IN ('queued','running')").all(),
  leases: db.prepare('SELECT id FROM author_resolution_queue WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL').all() };
db.exec('COMMIT'); db.close();
const sourceManifest = JSON.parse(readFileSync(join(root, 'data/source-poll/manifest.json'), 'utf8'));
let endpoint = null, backup = null;
if (stage === 'after') {
  const before = JSON.parse(readFileSync(join(journal, '20261009-current-resolution-before.json'), 'utf8'));
  assert.equal(rosterSha256, before.rosterSha256); assert.equal(historySha256, before.historySha256);
  for (const table of ['targets', 'author_resolution_jobs', 'author_resolution_queue', 'master_roster_entries']) assert.equal(counts[table], before.counts[table], table);
  for (const table of ['snapshots', 'works_observations', 'author_resolution_import_sources']) assert.ok(counts[table] >= before.counts[table], table);
  const response = await get(`/api/author-spreadsheet/jobs/${job.id}/skipped?limit=20`);
  assert.equal(response.currentResolutionScope, CURRENT_RESOLUTION_SCOPE); assert.equal(response.items.length, 20);
  assert.equal(response.total, projection.total); assert.ok(response.items.every(row => row.currentResolution.status === 'rejected'));
  endpoint = { jobId: job.id, checkedAt: response.checkedAt, rows: response.items.length, state: 'rejected', reason: response.items[0].currentResolution.reason };
  const directory = join(root, 'data/backups/automatic'), name = readdirSync(directory).filter(name => name.endsWith('.sqlite.manifest.json')).sort().at(-1);
  const manifest = JSON.parse(readFileSync(join(directory, name), 'utf8')), path = join(directory, name.replace(/\.manifest\.json$/, ''));
  assert.ok(statSync(path).mtimeMs >= Date.parse(before.checkedAt));
  const temporary = mkdtempSync(join(tmpdir(), 'mcn-current-release-')), copy = join(temporary, 'backup.sqlite');
  try {
    copyFileSync(path, copy); const hash = createHash('sha256'); for await (const chunk of createReadStream(copy)) hash.update(chunk);
    const sha256 = hash.digest('hex'); assert.equal(sha256, manifest.sha256); assert.equal(statSync(copy).size, manifest.bytes);
    const validation = validateSQLiteSnapshot(copy); assert.ok(validationCountsMatch(manifest.validation.counts, validation.counts));
    backup = { path, sha256, bytes: manifest.bytes, temporaryCopyVerified: true, validation };
  } finally { unlinkSync(copy); rmdirSync(temporary); }
}
const result = { checkedAt: new Date().toISOString(), stage, counts, rosterSha256, historySha256, projection, active,
  health: await get('/healthz'), scheduler: status.scheduler, browserLane: status.browserLane, updateSla: status.updateSla,
  sources: { lastFinishedAt: sourceManifest.lastFinishedAt, updatedAt: sourceManifest.updatedAt,
    total: status.sourcePoller.sourceCount, today: status.sourcePoller.checkedTodayCount, blocked: status.sourcePoller.blockedCount }, endpoint, backup };
writeFileSync(join(journal, `20261009-current-resolution-${stage}.json`), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ stage, counts, projection, active, endpoint, backup: backup && { path: backup.path, sha256: backup.sha256, integrity: backup.validation.integrityCheck } }));
