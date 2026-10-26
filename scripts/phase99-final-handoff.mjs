// Append one actually performed review and an immutable closeout; no collection or DB writes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { completePostIngestionProductReview } from '../lib/post-ingestion-review.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = '2026-10-02T04:23:03Z';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pinned = {
  'data/ingestion-reviews/run-2578.json': 'e94e19b0f8f50f86de7251e60897574b6a893c153b199e600e59aed3003145ac',
  'data/maintenance-journal/phase99-terminal-2578-report.md': 'fb9efe3940cc002d2971bb7f5d539f819ef3335198f3e6c27ab8fc036e0fcfec',
  'data/maintenance-journal/phase99-terminal-2578-audit.json': 'cebff80531d5647fdcbd23355dc0f2e70991cd235f52fcdaea834d4eae211e8e',
  'data/maintenance-journal/phase99-terminal-2578-readback.json': '99b463c27a3f779020785a352873336430b1bbce72e49435ccded844b1da4314',
  'data/source-poll/manifest.json': '184f0c655a7fc200a6d2e5979d15e92d73af8ec58883edc4d0f1635193c4d1d5',
};
for (const [path, checksum] of Object.entries(pinned)) assert.equal(sha(await readFile(join(root, path))), checksum, path);
const peer = JSON.parse(await readFile(join(root, 'data/maintenance-journal/phase99-terminal-2578-readback.json'), 'utf8'));
assert.deepEqual(peer.runIds, [2578]);
assert.equal(peer.exactIndependentRerun, true);
assert.equal(peer.queryOnly, 1);
assert.equal(peer.totalChanges, 0);
assert.equal(peer.metricsSummary.exactFiveFieldVectors, 3423);
assert.equal(peer.productionReaderCoverageAtTerminal.profile8h.complete, 697);
assert.equal(peer.productionReaderCoverageAtTerminal.works8h.complete, 124);
assert.equal(peer.productionReaderCoverageAtTerminal.topics8h.complete, 4);
const site = join(root, '../mcn-public-site');
assert.equal(execFileSync('git', ['status', '--short'], { cwd: site, encoding: 'utf8' }).trim(), '');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim(), 'f8589092b3f2a947bede2a48d64ddabc709fb2f6');
const expectedSources = {
  'components/topic-history.tsx': 'deff3772050591ffbd48d308de2f7baadee13dedc22580a8e55e7ad7f98ebb97',
  'app/replica.css': '9d9e25d0e2deb2ee52432b608b77c94048622833cd99f58e7334d5755056c431',
};
for (const [path, checksum] of Object.entries(expectedSources)) assert.equal(sha(await readFile(join(site, path))), checksum);
const evidence = [
  'data/maintenance-journal/2026-10-02-phase99.md',
  'data/maintenance-journal/phase99-terminal-2578-report.md',
  'data/maintenance-journal/phase99-terminal-2578-audit.json',
  'data/maintenance-journal/phase99-terminal-2578-readback.json',
  'data/maintenance-journal/2026-10-02-phase99-main-full-release.log',
  'data/maintenance-journal/2026-10-02-phase99-site-tests.log',
  'data/maintenance-journal/2026-10-02-phase99-site-types.log',
  'data/maintenance-journal/2026-10-02-phase99-final-focused.log',
  'data/maintenance-journal/2026-10-02-phase99-release.json',
  'data/maintenance-journal/2026-10-02-phase99-public-browser-supplement.json',
  'docs/phase99-topic-ux-peer.md',
  'docs/phase99-okx-ui-delivery.md',
];
const evidenceSha256 = {};
for (const path of evidence) evidenceSha256[path] = sha(await readFile(join(root, path)));
const closeout = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase99-closeout.json'), 'utf8'));
assert.equal(closeout.tests.main.tests, 4173);
assert.equal(closeout.tests.main.fail + closeout.tests.main.skipped + closeout.tests.main.cancelled, 0);
assert.equal(closeout.tests.site.tests, 47);
assert.equal(closeout.tests.site.fail + closeout.tests.site.skipped + closeout.tests.site.cancelled, 0);
assert.equal(closeout.tests.typeCheckPassed, true);
assert.equal(closeout.backup.restoredReadable, true);
assert.equal(evidenceSha256['data/maintenance-journal/2026-10-02-phase99-main-full-release.log'], closeout.tests.main.sha256);
assert.equal(evidenceSha256['data/maintenance-journal/2026-10-02-phase99-site-tests.log'], closeout.tests.site.sha256);

const healthResponse = await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(10000) });
assert.equal(healthResponse.status, 200);
const health = await healthResponse.json();
assert.equal(health.runtimeAI, false);
const lock = JSON.parse(await readFile(join(root, 'data/public-replica-publisher/lock.json'), 'utf8'));
const pids = [22870, 26001, lock.pid];
for (const pid of pids) process.kill(pid, 0);
for (const port of [4336, 4337]) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    assert.fail(`Preview ${port} must be stopped`);
  } catch (error) {
    assert.equal(error.cause?.code, 'ECONNREFUSED', `Preview ${port} did not confirm stopped`);
  }
}
assert.ok(Date.now() < Date.parse('2026-10-02T04:53:03Z'));
const completion = await completePostIngestionProductReview({ ledgerDir: join(root, 'data/ingestion-reviews'), runId: 2578, evidence });
for (const [path, checksum] of Object.entries(pinned)) assert.equal(sha(await readFile(join(root, path))), checksum, path);
const finishedAt = new Date().toISOString();
const result = {
  phase: 99, startedAt, finishedAt, elapsedMinutes: (Date.parse(finishedAt) - Date.parse(startedAt)) / 60000,
  release: closeout.release, tests: closeout.tests,
  reviewedRunIds: [2578], nextUnauditedBoundary: 2579,
  completionStatus: completion.status, completionSha256: sha(await readFile(completion.path)),
  reviewMeaning: completion.completion.meaning, evidenceSha256,
  immutableEventAndSourceSha256: pinned, sourceHashes: expectedSources,
  runtime: { pids, alive: true, healthHttpStatus: 200, healthStatus: health.status, runtimeAI: false, previewsClosed: [4336, 4337] },
  privateFixedTerminalCutoff: peer.fixedCutoff,
  privateFixedTerminalCoverage: { profiles: '697/701', worksComplete: '124/701', worksLimited: 91, worksUnavailable: 482, worksMissing: 4, topics: '4/4' },
  publicActualBrowserCutoff: '2026-10-02T04:14:10.950Z',
  publicCoverageAtActualBrowserReadback: { profiles: '216/701', worksComplete: '0/701', topics: '4/4' },
  publicPrivateCutoffsNotConflated: true, backup: closeout.backup,
  productionDatabaseWrites: false, manualCollection: false, newTimers: false, productionRestart: false,
  limitations: ['All works not complete', 'No Mac-off new collection proof', 'No every-network guarantee', 'No real VoiceOver or user-retention study'],
  fullGoal: 'U01-U47 remains active',
};
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase99-final-handoff.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ finishedAt, elapsedMinutes: result.elapsedMinutes, release: result.release, reviewedRunIds: result.reviewedRunIds, completionStatus: result.completionStatus, runtime: result.runtime, privateCoverage: result.privateFixedTerminalCoverage, publicCoverageAtReadback: result.publicCoverageAtActualBrowserReadback, fullGoal: result.fullGoal }));
