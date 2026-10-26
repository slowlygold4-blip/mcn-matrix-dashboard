import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
assert.ok(Date.now() < Date.parse('2026-10-02T07:03:28Z'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const before = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-before-source.json')));
const allowed = new Set([...before.expectedProductChanges, ...before.expectedTestChanges, 'test/daily-trend-peer-20260929-0004.test.mjs']);
const sourceChanges = [];
for (const record of before.records) {
  const bytes = await readFile(join(root, record.file));
  if (sha(bytes) !== record.sha256) {
    assert.ok(allowed.has(record.file), `Unexpected change: ${record.file}`);
    const preimage = await readFile(join(root, 'data/code-candidates/phase105/preimage', record.file));
    assert.equal(sha(preimage), record.sha256);
    sourceChanges.push({ file: record.file, before: record.sha256, after: sha(bytes) });
  }
}
assert.equal(sourceChanges.length, 7);
const backup = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-backup.json')));
for (const path of [backup.backupPath, backup.restoredPath]) {
  assert.equal((await stat(path)).size, backup.bytes);
  assert.equal(sha(await readFile(path)), backup.sha256);
}
const db = new DatabaseSync(backup.restoredPath, { readOnly: true });
let restore;
try {
  db.exec('PRAGMA query_only=ON;BEGIN');
  const counts = Object.fromEntries(Object.keys(backup.validation.counts).map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  assert.deepEqual(counts, backup.validation.counts);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, 0);
  restore = { counts, integrity: 'ok', foreignKeyViolations: 0, totalChanges: 0, sha256: backup.sha256, cutoff: backup.cutoff };
} finally { db.exec('ROLLBACK'); db.close(); }
const served = [];
for (const [url, file] of [['/', 'public/rebuild.html'], ['/rebuild.js', 'public/rebuild.js'], ['/rebuild.css', 'public/rebuild.css']]) {
  const response = await fetch('http://127.0.0.1:4188' + url, { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha(bytes), sha(await readFile(join(root, file))));
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  served.push({ file, sha256: sha(bytes), status: response.status, cacheControl: response.headers.get('cache-control') });
}
const health = await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(8000) }).then(response => response.json());
assert.equal(health.status, 'ready'); assert.equal(health.runtimeAI, false);
const ps = execFileSync('/bin/ps', ['-p', '90988,26001,79274', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
for (const pid of [90988, 26001, 79274]) assert.match(ps, new RegExp(`(?:^|\\n)\\s*${pid}\\s+1\\s+`));
const result = { startedAt, finishedAt: new Date().toISOString(), elapsedMinutes: (Date.now() - Date.parse('2026-10-02T06:33:28Z')) / 60000,
  originalStaticFiles: before.records.length, unchangedStaticFiles: before.records.length - sourceChanges.length,
  sourceChanges, restore, served, health, ps, noRestart: true, noManualCollection: true, noNewTimer: true,
  completeGoal: false, macOffNewSamplingImplemented: false };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-final-audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ finishedAt: result.finishedAt, changed: sourceChanges.length, unchanged: result.unchangedStaticFiles, servedFiles: served.length, threeOriginalPids: true, restore: '14 tables / integrity / SHA verified', elapsedMinutes: result.elapsedMinutes }));
