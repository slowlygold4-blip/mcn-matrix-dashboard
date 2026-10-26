import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, stat, rename, readdir, open, copyFile, constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const expected = 'a97d4645c2102fa3f5d9dd1b5585745fb6d394f9a33fec37f8de00cfba8446b1';
const source = join(root, 'scripts/douyin_browser_collector.mjs');
const staged = join(root, 'scripts/.phase106-approved-douyin_browser_collector.mjs');
const before = 'b1375b015559752e0ed95370994275123821229b4b6c79ff5d71470cc327a7b6';
assert.ok(Date.now() < Date.parse('2026-10-02T07:22:00Z'));
assert.equal(sha(await readFile(source)), before);
assert.equal(sha(await readFile(staged)), expected);
assert.equal(sha(await readFile(join(root, 'data/code-candidates/phase106/preimage/scripts/douyin_browser_collector.mjs'))), before);
const signedLog = await readFile(join(root, 'docs/phase106-evidence/candidate/full-approved-freeze.log'), 'utf8');
for (const p of [/pass 4283\b/, /fail 0\b/, /cancelled 0\b/, /skipped 0\b/]) assert.match(signedLog, p);
const final = JSON.parse(await readFile(join(root, 'docs/phase106-evidence/candidate/final.json')));
assert.ok(final);
const ps = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
const children = ps.split('\n').filter(line => line.includes(root + '/scripts/douyin_browser_collector.mjs'));
assert.equal(children.length, 0, 'Do not install while an existing live collector child is visible');
for (const pid of [90988, 26001, 79274]) assert.match(ps, new RegExp('(?:^|\\n)\\s*' + pid + '\\s+1\\s+'));
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
let idle;
try {
  db.exec('PRAGMA query_only=ON;BEGIN');
  idle = {
    checkedAt: new Date().toISOString(),
    running: db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n,
    activeResolutionJobs: db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,
    totalChanges: db.prepare('SELECT total_changes() n').get().n
  };
  assert.equal(idle.running, 0); assert.equal(idle.activeResolutionJobs, 0); assert.equal(idle.totalChanges, 0);
} finally { db.exec('ROLLBACK'); db.close(); }
await chmod(staged, (await stat(source)).mode & 0o777);
await rename(staged, source);
const installedAt = new Date().toISOString();
assert.equal(sha(await readFile(source)), expected);
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase106-install.json'), JSON.stringify({
  installedAt, before, after: expected, idle,
  mode: 'same-directory atomic replacement of approved complete bytes; no signal or restart',
  limitation: 'idle is a fresh observation, not an atomic scheduler drain; atomic rename protects subsequent children from partial source reads',
  runtimeLoading: 'provider spawns a fresh Node entrypoint by pathname on every owned attempt; next naturally launched child uses new path',
  newSourceExecuted: false, services: [90988,26001,79274]
}, null, 2) + '\n', { flag:'wx', mode:0o400 });
for (const name of ['old-main-reject.tap', 'approved-candidate.tap']) {
  const from = '/tmp/phase106-integrity-WrHr5b/' + name, to = join(root, 'docs/phase106-evidence/integrity', name);
  await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, 0o400);
  assert.equal(sha(await readFile(to)), sha(await readFile(from)));
}
const tests = (await readdir(join(root,'test'))).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'test/'+x);
const logPath = join(root, 'data/maintenance-journal/2026-10-02-phase106-main-full-tests.log');
const fd = await open(logPath, 'wx', 0o600);
const startedAt = new Date().toISOString();
console.log(JSON.stringify({ installedAt, after:expected, testStartedAt:startedAt, testFiles:tests.length, logPath }));
const child = spawn(process.execPath, ['--test','--test-concurrency=4', ...tests], { cwd:root, env:{...process.env, PHASE84_REAL45:'1'}, stdio:['ignore',fd.fd,fd.fd] });
const guard = setTimeout(()=>child.kill('SIGTERM'), Math.max(1,Date.parse('2026-10-02T07:26:00Z')-Date.now()));
const outcome = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
clearTimeout(guard); await fd.close();
const bytes = await readFile(logPath), text = bytes.toString('utf8');
const receipt={startedAt, finishedAt:new Date().toISOString(), outcome, sha256:sha(bytes), logPath, sourceSha256:sha(await readFile(source))};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase106-main-tests-result.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify(receipt));
assert.equal(outcome.code,0); assert.equal(outcome.signal,null);
for(const p of [/pass 4283\b/,/fail 0\b/,/cancelled 0\b/,/skipped 0\b/]) assert.match(text,p);
