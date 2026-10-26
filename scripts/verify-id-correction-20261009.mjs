// One-shot local validation only. No account data edits or platform collection.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteBackupManager, validateSQLiteSnapshot, validationCountsMatch } from '../lib/backup-manager.mjs';
import { validateImportMonitoring } from '../public/import-monitoring.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'data/maintenance-journal/20261009-id-correction');
const databasePath = join(root, 'data/douyin-monitor.sqlite');
const mode = process.argv[2], origin = 'http://127.0.0.1:4188', jobId = 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f';
assert.ok(['test', 'backup', 'backup-final', 'load', 'readback'].includes(mode));
await mkdir(out, { recursive: true, mode: 0o700 });
const save = async (name, value) => { const path = join(out, name + '.json');
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return path; };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => createHash('sha256').update(value).digest('hex');
if (mode === 'test') {
  const prior = await readJson(join(root, 'data/maintenance-journal/20261009-remaining-onboarding/tests-1791569952713.json'));
  const extras = ['roster-id-correction-http-20261009', 'roster-correction-ui-20261009', 'roster-id-correction-peer-20261009', 'source-gap-peer-20261009',
    'master-roster-supplement-http-20261009', 'roster-supplement-ui-20261009', 'roster-submit-readback-peer-20261009',
    'roster-correction-production-shape-20261009', 'douyin-work-author-candidate-20261009',
    'douyin-work-author-candidate-peer-20261009', 'public-web-work-author-candidate-20261009'];
  const files = [...new Set([...prior.files, ...extras])];
  const startedAt = new Date().toISOString(), start = Date.now();
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(name => 'test/' + name + '.test.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const stamp = Date.now(), report = { startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start,
    files, exitCode, summary: output.split('\n').filter(line => /^ℹ /.test(line)), productionCollection: false };
  await writeFile(join(out, `tests-${stamp}.txt`), output, { flag: 'wx', mode: 0o600 });
  await save(`tests-${stamp}`, report); console.log(JSON.stringify({ stamp, ...report })); assert.equal(exitCode, 0);
} else if (mode === 'backup' || mode === 'backup-final') {
  const manager = new SQLiteBackupManager({ databasePath, backupDir: join(root, 'data/backups/20261009-id-correction'), retention: 60 });
  const backup = await manager.createBackup(mode === 'backup' ? 'before-id-correction-release' : 'after-id-correction-verification'); assert.equal(backup.status, 'created');
  const temp = await mkdtemp(join(tmpdir(), 'mcn-id-correction-')), clone = join(temp, 'readback.sqlite');
  await copyFile(backup.path, clone, constants.COPYFILE_FICLONE);
  const validation = validateSQLiteSnapshot(clone);
  assert.ok(validationCountsMatch(backup.manifest.validation.counts, validation.counts));
  const report = { at: new Date().toISOString(), backup, clone, validation, readableCloneVerified: true };
  const evidence = await save(mode === 'backup' ? 'backup' : 'backup-final-' + Date.now(), report); console.log(JSON.stringify({ evidence, path: backup.path, clone, sha256: backup.manifest.sha256, validation }));
} else if (mode === 'load') {
  assert.equal((await readJson(join(out, 'backup.json'))).readableCloneVerified, true);
  const testStamp = process.argv[3]; assert.match(testStamp || '', /^\d+$/);
  const tests = await readJson(join(out, `tests-${testStamp}.json`)); assert.equal(tests.exitCode, 0);
  const oldPid = Number(process.argv[4] || 5308), expected = process.execPath + ' ' + root + 'server.mjs';
  assert.ok([5308, 7890, 9100].includes(oldPid), 'Only a separately verified current PID may be replaced');
  const idle = () => {
    assert.equal(execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'command='], { encoding: 'utf8' }).trim(), expected);
    assert.equal(execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'ppid='], { encoding: 'utf8' }).trim(), '1');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return { runs: db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n,
      jobs: db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,
      leases: db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n }; } finally { db.close(); }
  };
  let ready = false;
  for (let n = 0; n < 20; n++) { if (!Object.values(idle()).some(Boolean)) { await pause(500); if (!Object.values(idle()).some(Boolean)) { ready = true; break; } } await pause(2000); }
  assert.ok(ready, 'No idle window; service not signalled');
  process.kill(oldPid, 'SIGTERM'); await save('runtime-signal-' + oldPid, { at: new Date().toISOString(), oldPid, idleVerified: true, forcedExit: false });
  let loaded;
  for (let n = 0; n < 100; n++) { try { const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) });
    if (response.ok) { const newPid = Number(execFileSync('/usr/sbin/lsof', ['-t', '-iTCP:4188', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim());
      if (newPid !== oldPid) { loaded = { at: new Date().toISOString(), oldPid, newPid, health: await response.json(), tests: `tests-${testStamp}.json` }; break; } }
  } catch {} await pause(500); }
  assert.ok(loaded, 'Restart not verified'); await save('runtime-load-' + oldPid, loaded); console.log(JSON.stringify(loaded));
} else {
  const authResponse = await fetch(origin + '/api/auth/session'), auth = await authResponse.json(); assert.equal(auth.user.role, 'admin');
  const headers = { Cookie: authResponse.headers.get('set-cookie').split(';')[0] }, pages = [], items = [];
  for (let offset = 0; offset < 100; offset += 20) {
    const response = await fetch(origin + `/api/author-spreadsheet/jobs/${jobId}/monitoring?status=pending&limit=20&offset=${offset}`, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200); const page = await response.json(); validateImportMonitoring(page, jobId, 'pending');
    pages.push(page); items.push(...page.items); if (!page.pagination.hasMore) break;
  }
  assert.equal(items.length, pages[0].pagination.total); assert.equal(new Set(items.map(item => item.key)).size, items.length);
  const rosterResponse = await fetch(origin + '/api/master-roster', { headers, signal: AbortSignal.timeout(20000) });
  assert.equal(rosterResponse.status, 200); const roster = await rosterResponse.json();
  const reference = await readJson(join(out, 'backup.json'));
  const clone = new DatabaseSync(reference.clone, { readOnly: true });
  const db = new DatabaseSync(databasePath, { readOnly: true }); let immutable;
  try { const previous = db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(jobId);
    immutable = { requestSha256: sha(previous.request_json), resultSha256: sha(previous.result_json),
      frozenPayloadSha256: db.prepare('SELECT payload_sha256 FROM master_roster_imports ORDER BY id DESC LIMIT 1').get().payload_sha256 };
    assert.equal(immutable.requestSha256, '17732e521fba518599b2d4f85046ff045b5d4846e8bc8c5553e9f14b102e8fa2');
    assert.equal(immutable.resultSha256, '0f8eb53b4db589762ccab9ffafb112a2e112c76de82b1e0ab6a2eb544d97cd22');
    const frozenSql = 'SELECT * FROM master_roster_entries ORDER BY import_id,entry_key';
    assert.deepEqual(db.prepare(frozenSql).all(), clone.prepare(frozenSql).all());
    assert.deepEqual(db.prepare('SELECT * FROM master_roster_imports ORDER BY id').all(), clone.prepare('SELECT * FROM master_roster_imports ORDER BY id').all());
    const historicalSql = 'SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?';
    const oldJob = '24ed9508-815c-4c08-81f6-b73266d0f304';
    assert.deepEqual(db.prepare(historicalSql).get(oldJob), clone.prepare(historicalSql).get(oldJob));
    immutable.originalXlsxSha256 = sha(await readFile('/Users/tyke/Downloads/一条小团团切片作品登记表.xlsx'));
    assert.equal(immutable.originalXlsxSha256, '88bf7c4c50ac9031c8749254e791bb512306c44c564e65db576c6f84e755a3bb');
    immutable.frozenAndPreviousJobUnchanged = true;
  } finally { db.close(); clone.close(); }
  const staticResponse = await fetch(origin + '/'); const html = await staticResponse.text(); assert.equal(staticResponse.status, 200);
  assert.match(html, /20261009-id-correction-1/);
  const report = { at: new Date().toISOString(), counts: pages[0].counts, pending: items, pageCount: pages.length,
    rosterEntryCount: roster.items.length, immutable, accountWrites: 0, platformRequests: 0, status: 'verified' };
  const evidence = await save('readback-' + Date.now(), report); console.log(JSON.stringify({ evidence, counts: report.counts, pageCount: report.pageCount, immutable }));
}
