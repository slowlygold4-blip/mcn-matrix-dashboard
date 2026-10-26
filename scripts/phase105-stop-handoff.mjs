import { readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const startedAt = '2026-10-02T06:33:28.000Z';
const evidenceArchive = [];
for (const name of ['full-root.log', 'full-root-environment-fixed.log', 'full-root-final.log',
  'final-environment-retest-v2.log', 'focused-final.log', 'labels-focused-root.log', 'new-tests-final-v2.log']) {
  const source = join('/tmp/phase105-frontend-ZbI9v5', name);
  const target = join(root, 'docs/phase105-evidence/frontend', `completed-${name}`);
  const bytes = await readFile(source);
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, 0o400);
  assert.equal(sha(await readFile(target)), sha(bytes));
  evidenceArchive.push({ source, target, bytes: bytes.length, sha256: sha(bytes),
    meaning: 'Full completed log preserved; failure logs remain failures, not all candidate runs passed.' });
}
const finalAudit = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-final-audit.json')));
assert.equal(finalAudit.unchangedStaticFiles, 464);
assert.equal(finalAudit.sourceChanges.length, 7);
const sourceSha = '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5';
assert.equal(sha(await readFile(join(root, 'data/source-poll/manifest.json'))), sourceSha);
const completion = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-product-completion.json')));
assert.equal(completion.count, 40);
assert.equal(completion.originalEventsByteUnchanged, true);
const audit = JSON.parse(await readFile(join(root, 'docs/phase105-evidence/integrity/data-audit.json')));
for (const proof of audit.proofs) assert.equal(sha(await readFile(join(root, `data/ingestion-reviews/run-${proof.runId}.json`))), proof.event.sha256);
const healthResponse = await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(10000) });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.status, 'ready');
assert.equal(health.runtimeAI, false);
const served = [];
for (const [url, file, expected] of [
  ['/', 'public/rebuild.html', '11c0bfa0badad20f3eb68e66961da5e4732c5f8169b79ed5faf026976d27e451'],
  ['/rebuild.js', 'public/rebuild.js', '954cea94f937f02c6199c7c9f0242cfcdcf9782f476d458fb5fc36f2d174fd8a'],
  ['/rebuild.css', 'public/rebuild.css', 'aa149ba75883d897292d8c6241be63ec0bcc547e2c4e553518ce8a541c3232d3']
]) {
  assert.equal(sha(await readFile(join(root, file))), expected);
  const response = await fetch('http://127.0.0.1:4188' + url, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.equal(sha(Buffer.from(await response.arrayBuffer())), expected);
  served.push({ url, file, status: 200, sha256: expected });
}
const pids = [90988, 26001, 79274];
const ps = execFileSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
for (const pid of pids) assert.match(ps, new RegExp(`(?:^|\\n)\\s*${pid}\\s+1\\s+`));
const siteStatus = execFileSync('git', ['status', '--short'], { cwd: join(root, '../mcn-public-site'), encoding: 'utf8' });
assert.equal(siteStatus.trim(), '');
const mainTests = await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-main-full-tests.log'), 'utf8');
for (const [key, value] of [['tests', 4262], ['pass', 4262], ['fail', 0], ['cancelled', 0], ['skipped', 0]])
  assert.match(mainTests, new RegExp(`(?:#|ℹ) ${key} ${value}\\b`));
const screenshots = [];
for (const name of ['production-desktop.jpg', 'production-native200-middle.jpg', 'production-native200-page3.jpg', 'production-detail.jpg', 'production-return-context.jpg']) {
  const bytes = await readFile(join(root, 'docs/phase105-evidence', name));
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  screenshots.push({ name, bytes: bytes.length, sha256: sha(bytes) });
}
const finishedAt = new Date().toISOString();
assert.ok(Date.parse(finishedAt) < Date.parse('2026-10-02T07:03:28.000Z'));
const receipt = { startedAt, finishedAt, elapsedMinutes: (Date.parse(finishedAt) - Date.parse(startedAt)) / 60000,
  frozenNewProductDevelopment: true, evidenceArchive, health, ps, served, screenshots, sourcePollSHA256: sourceSha,
  productReviewsAppended: completion.count, originalEventsByteUnchanged: true, siteSourceClean: true,
  siteUIChangedThisRound: false, mainFullTests: { tests: 4262, pass: 4262, fail: 0, cancelled: 0, skipped: 0 },
  noManualCollection: true, noNewTimer: true, noRestart: true, completeGoal: false,
  macOffNewSamplingImplemented: false, nextFixedReviewRunId: 2676 };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase105-stop.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ finishedAt, elapsedMinutes: receipt.elapsedMinutes, reviews: completion.count,
  tests: receipt.mainFullTests, health, sourcePollUnchanged: true, siteSourceClean: true, completeGoal: false }));
