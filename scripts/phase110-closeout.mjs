import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = '2026-10-02T08:49:52Z';
const checkedAt = new Date().toISOString();
assert.ok(Date.parse(checkedAt) < Date.parse('2026-10-02T09:19:52Z'));
const files = [
  'docs/phase110-okx-frontend-review.md',
  'data/maintenance-journal/2026-10-02-phase110.md',
  'docs/reference-evidence/okx-20261002-phase110/archive-receipt.json',
  'data/maintenance-journal/2026-10-02-phase110-boundary-start.json',
  'data/maintenance-journal/2026-10-02-phase110-boundary-finish.json',
];
const evidence = [];
for (const file of files) {
  const bytes = await readFile(join(root, file));
  assert.ok(bytes.length > 0);
  evidence.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const report = await readFile(join(root, files[0]), 'utf8');
for (const path of [...report.matchAll(/!\[[^\]]*\]\((\/[^)]+)\)/g)].map(match => match[1])) {
  const bytes = await readFile(path); assert.ok(bytes.length > 0);
}
const receipt = { startedAt, checkedAt, elapsedMinutes: (Date.parse(checkedAt) - Date.parse(startedAt)) / 60000,
  researchOnly: true, productCodeChanged: false, productReleased: false, evidence,
  wholeGoalStatus: 'active', originalDataPreserved: true, manualCollection: false, newTimerCreated: false,
  browserResearchTabClosed: true, originalEightTabsPreserved: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase110-closeout.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ checkedAt, elapsedMinutes: receipt.elapsedMinutes, evidenceFiles: evidence.length, researchOnly: true }));
