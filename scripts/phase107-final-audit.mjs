import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = new Date().toISOString();
assert.ok(Date.now() < Date.parse('2026-10-02T07:54:34Z'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const before = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase107-before-source.json')));
const allowed = new Set([...before.expectedProductChanges, ...before.expectedTestChanges]);
const sourceChanges = [];
for (const record of before.records) {
  const bytes = await readFile(join(root, record.file));
  if (sha(bytes) !== record.sha256) {
    assert.ok(allowed.has(record.file), `Unexpected change: ${record.file}`);
    const preimage = await readFile(join(root, 'data/code-candidates/phase107/preimage', record.file));
    assert.equal(sha(preimage), record.sha256);
    sourceChanges.push({ file: record.file, before: record.sha256, after: sha(bytes) });
  }
}
assert.equal(sourceChanges.length, 2);
const backup = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase107-backup.json')));
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
const sourceManifestSHA256 = sha(await readFile(join(root, 'data/source-poll/manifest.json')));
assert.equal(sourceManifestSHA256, '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5');
const siteStatus = execFileSync('git', ['status','--short'], {cwd:join(root,'../mcn-public-site'),encoding:'utf8'});
assert.equal(siteStatus.trim(),'');
const installed = JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase107-install.json')));
assert.equal(sha(await readFile(join(root,'scripts/douyin_browser_collector.mjs'))), 'a97d4645c2102fa3f5d9dd1b5585745fb6d394f9a33fec37f8de00cfba8446b1');
const mainTestResult = JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase107-main-tests-result.json')));
assert.equal(mainTestResult.outcome.code,0); assert.equal(mainTestResult.outcome.signal,null);
const mainTestText = await readFile(mainTestResult.logPath,'utf8');
for(const p of [/pass 4290\b/,/fail 0\b/,/cancelled 0\b/,/skipped 0\b/]) assert.match(mainTestText,p);
const result = { sourceManifestSHA256, siteSourceClean:true, siteUIChangedThisRound:false, installedAt:installed.installedAt, mainTestResult, startedAt, finishedAt: new Date().toISOString(), elapsedMinutes: (Date.now() - Date.parse('2026-10-02T07:24:34Z')) / 60000,
  originalStaticFiles: before.records.length, unchangedStaticFiles: before.records.length - sourceChanges.length,
  sourceChanges, restore, served, health, ps, noRestart: true, noManualCollection: true, noNewTimer: true,
  completeGoal: false, macOffNewSamplingImplemented: false };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase107-final-audit.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ finishedAt: result.finishedAt, changed: sourceChanges.length, unchanged: result.unchangedStaticFiles, servedFiles: served.length, threeOriginalPids: true, restore: '14 tables / integrity / SHA verified', elapsedMinutes: result.elapsedMinutes }));
