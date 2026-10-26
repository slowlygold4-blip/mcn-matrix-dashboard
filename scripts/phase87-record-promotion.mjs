import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const afterHashes = { 'scripts/douyin_browser_collector.mjs': '420d4d18dda12987df0ef0cf2b7241130f2a1c0ef6ba3d411fe4d5a3d878369e',
  'lib/browser-first-works-request.mjs': '82151b237b23a056d877cf3c71a65100700b5c749e848ea306e6a5ced59b0aa7' };
const beforeHashes = { 'douyin_browser_collector.mjs': 'ee1d40508a43a098cc28e5b522e0af60b563666c6f7f6ddd46258b6d069f2444',
  'browser-first-works-request.mjs': 'ccd295c0776c6b4af38c990e909358f36f72c44ae5b774d250fba993cec8926c' };
for (const [file, hash] of Object.entries(afterHashes)) assert.equal(sha(await readFile(join(root, file))), hash);
for (const [file, hash] of Object.entries(beforeHashes)) assert.equal(sha(await readFile(join(root, 'data/backups/phase87-code-20261002', file))), hash);
const tests = await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase87-stage-full-final.txt'), 'utf8');
const count = Number(/ℹ tests (\d+)\b/.exec(tests)?.[1]);
assert.ok(count >= 3975); assert.equal(count, Number(/ℹ pass (\d+)\b/.exec(tests)?.[1]));
for (const key of ['fail', 'cancelled', 'skipped']) assert.match(tests, new RegExp('ℹ ' + key + ' 0\\b'));
const receipt = { completedAt: new Date().toISOString(), afterHashes, beforeHashes,
  backupDirectory: 'data/backups/phase87-code-20261002', stageFullCount: count,
  stageSourceUnchanged: true, noServiceRestart: true, futureOrdinaryChildLoadsFiles: true,
  noSamplingTriggered: true, noSiteDeployment: true, noSourceOrHistoryRewrite: true,
  syntheticTestNotPlatformRecovery: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase87-promotion.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(receipt));
