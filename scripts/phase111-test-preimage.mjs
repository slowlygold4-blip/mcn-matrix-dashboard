import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const baseline = JSON.parse(await readFile(join(root, 'data/maintenance-journal/2026-10-02-phase111-code-baseline.json')));
const files = ['test/phase107-account-metric-browser.test.mjs', 'test/rebuild-refresh-focus.test.mjs'];
const rows = [];
for (const file of files) {
  const old = baseline.entries.find(row => row.file === file); assert.ok(old);
  const bytes = await readFile(join(root, file)); assert.equal(sha(bytes), old.sha256);
  const destination = join(root, 'data/code-candidates/phase111/preimage', file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
  assert.equal(sha(await readFile(destination)), old.sha256); rows.push({ file, destination, sha256: old.sha256 });
}
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase111-extra-preimages.json'), JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2)+'\n', { flag:'wx', mode:0o400 });
console.log(JSON.stringify(rows));
