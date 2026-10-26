import { readdirSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync, createReadStream, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';

const root = new URL('../', import.meta.url).pathname;
const before = JSON.parse(readFileSync(join(root, 'data/maintenance-journal/20261009-roster-release-before.json'), 'utf8'));
async function get(path) {
  const response = await fetch('http://127.0.0.1:4188' + path, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, path); return response.json();
}
const health = await get('/healthz'), status = await get('/api/monitoring-status'), roster = await get('/api/master-roster');
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
db.exec('BEGIN');
const originals = db.prepare('SELECT import_id,entry_key,target_id,payload_json FROM master_roster_entries ORDER BY import_id,entry_key').all();
const rosterOriginalSha256 = createHash('sha256').update(JSON.stringify(originals)).digest('hex');
assert.equal(rosterOriginalSha256, before.rosterOriginalSha256, 'original roster must remain byte-identical');
const counts = Object.fromEntries([...Object.keys(before.counts), 'author_resolution_success_receipts'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
for (const name of ['snapshots', 'author_resolution_import_sources', 'master_roster_entries']) assert.ok(counts[name] >= before.counts[name], `${name} cannot shrink`);
const accountStatus = db.prepare('SELECT type,enabled,count(*) n FROM targets GROUP BY type,enabled').all();
const latestRuns = db.prepare('SELECT id,trigger_type,status,started_at,finished_at FROM runs ORDER BY id DESC LIMIT 4').all();
db.exec('COMMIT'); db.close();
const backupDir = join(root, 'data/backups/automatic');
const latest = readdirSync(backupDir).filter(name => name.endsWith('.sqlite.manifest.json')).sort().at(-1);
assert.ok(latest); const manifest = JSON.parse(readFileSync(join(backupDir, latest), 'utf8'));
assert.ok(Object.hasOwn(manifest.validation.counts, 'author_resolution_success_receipts'), 'new proof table must be counted in startup backup');
const backupPath = join(backupDir, latest.replace(/\.manifest\.json$/, ''));
const temporary = mkdtempSync(join(tmpdir(), 'mcn-roster-release-')), copy = join(temporary, 'backup.sqlite');
let backup;
try {
  copyFileSync(backupPath, copy);
  const hash = createHash('sha256'); for await (const chunk of createReadStream(copy)) hash.update(chunk);
  const sha256 = hash.digest('hex'); assert.equal(sha256, manifest.sha256); assert.equal(statSync(copy).size, manifest.bytes);
  const validation = validateSQLiteSnapshot(copy); assert.ok(validationCountsMatch(manifest.validation.counts, validation.counts));
  backup = { path: backupPath, sha256, bytes: manifest.bytes, temporaryCopyVerified: true, validation };
} finally { try { unlinkSync(copy); } catch {} rmdirSync(temporary); }
const output = { checkedAt: new Date().toISOString(), health, counts, accountStatus, latestRuns, rosterOriginalSha256, rosterSummary: roster.summary,
  scheduler: status.scheduler, browserLane: status.browserLane, updateSla: status.updateSla, backup,
  sources: { total: status.sourcePoller.sourceCount, checkedToday: status.sourcePoller.checkedTodayCount, blocked: status.sourcePoller.blockedCount, businessPending: status.sourcePoller.businessPendingCount } };
writeFileSync(join(root, 'data/maintenance-journal/20261009-roster-release-after.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ checkedAt: output.checkedAt, healthy: health.ok, counts, accountStatus, rosterUnchanged: true,
  rosterSummary: output.rosterSummary, sources: output.sources, backup: { path: backup.path, sha256: backup.sha256, integrity: backup.validation.integrityCheck, tableCount: Object.keys(backup.validation.counts).length } }));
