import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const phase = process.argv[2];
assert.ok(['start', 'finish'].includes(phase));
assert.ok(Date.now() < Date.parse('2026-10-02T09:19:52Z'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function collect(relative) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile()) files.push(path);
  }
}
await collect('public'); await collect('lib');
files.push('server.mjs', 'scripts/douyin_browser_collector.mjs');
const runtimeSources = Object.fromEntries(await Promise.all(files.sort().map(async path => [path, sha(await readFile(join(root, path)))])));
const get = async path => {
  const response = await fetch(`http://127.0.0.1:4188${path}`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); return response.json();
};
const health = await get('/api/health');
assert.equal(health.status, 'ready'); assert.equal(health.runtimeAI, false);
const monitoring = await get('/api/monitoring-status');
assert.deepEqual(monitoring.scheduler.slotTimes, ['02:00', '10:00', '18:00']);
assert.equal(monitoring.scheduler.scheduleIntervalHours, 8);
const site = join(root, '../mcn-public-site');
const siteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim();
const siteStatus = execFileSync('git', ['status', '--short'], { cwd: site, encoding: 'utf8' }).trim();
assert.equal(siteStatus, '');
const serviceProcesses = execFileSync('/bin/ps', ['-p', '90988,26001,79274', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
for (const pid of [90988, 26001, 79274]) assert.match(serviceProcesses, new RegExp(`(?:^|\\n)\\s*${pid}\\s+1\\s+`));
if (phase === 'finish') {
  const baseline = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase110-boundary-start.json'), 'utf8'));
  assert.deepEqual(runtimeSources, baseline.runtimeSources);
  assert.equal(siteHead, baseline.siteHead);
  for (const path of ['public/rebuild.js', 'public/rebuild.css', 'public/console-model.js']) {
    const response = await fetch(`http://127.0.0.1:4188/${path.slice(7)}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); assert.equal(sha(Buffer.from(await response.arrayBuffer())), runtimeSources[path]);
  }
}
const result = { phase, checkedAt: new Date().toISOString(), runtimeSources, health, schedule: monitoring.scheduler, siteHead, siteStatus, serviceProcesses,
  sourceManifestSHA256: sha(await readFile(join(root, 'data/source-poll/manifest.json'))), runtimeSourceChanges: 0,
  researchOnly: true, databaseWritesByThisRun: false, manualCollection: false, timerCreated: false, deployment: false };
await writeFile(join(root, `data/maintenance-journal/2026-10-02-phase110-boundary-${phase}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ phase, checkedAt: result.checkedAt, runtimeSources: files.length, health: health.status, runtimeAI: health.runtimeAI, siteHead, sourceManifestSHA256: result.sourceManifestSHA256 }));
