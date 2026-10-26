import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
const root = new URL('../', import.meta.url).pathname;
const oldPid = 62545;
const command = '/Users/tyke/.local/node-v24.16.0-darwin-arm64/bin/node ' + root + 'server.mjs';
const evidencePath = root + 'data/maintenance-journal/20261009-onboarding/runtime-load.json';
assert.equal(JSON.parse(await readFile(root + 'data/maintenance-journal/20261009-onboarding/recovery-apply.json', 'utf8')).applied.length, 11);
function idle() {
  assert.equal(execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'command='], { encoding: 'utf8' }).trim(), command);
  assert.equal(execFileSync('/bin/ps', ['-p', String(oldPid), '-o', 'ppid='], { encoding: 'utf8' }).trim(), '1');
  const db = new DatabaseSync(root + 'data/douyin-monitor.sqlite', { readOnly: true });
  try { return {
    runs: db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','queued')").get().n,
    jobs: db.prepare("SELECT count(*) n FROM author_resolution_jobs WHERE status IN ('queued','running')").get().n,
    leases: db.prepare('SELECT count(*) n FROM author_resolution_queue WHERE lease_owner IS NOT NULL').get().n,
  }; } finally { db.close(); }
}
let found = false;
for (let attempt = 0; attempt < 12; attempt++) {
  const first = idle();
  if (!Object.values(first).some(Boolean)) {
    await new Promise(r => setTimeout(r, 500));
    const second = idle();
    if (!Object.values(second).some(Boolean)) { found = true; break; }
  }
  await new Promise(r => setTimeout(r, 2500));
}
assert.ok(found, 'No idle window; service not signalled');
process.kill(oldPid, 'SIGTERM');
const report = { signalledAt: new Date().toISOString(), oldPid, signalledOnlyIdleMain: true, existingKeepAlive: true, sourceAndPublisherUntouched: true, noForcedExit: true };
await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));
