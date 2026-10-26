import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(Date.now() < Date.parse('2026-10-02T10:09:32Z'));
const entries = [];
async function scan(dir) {
  for (const item of await readdir(join(root, dir), { withFileTypes: true })) {
    const file = join(dir, item.name);
    if (item.isDirectory()) await scan(file);
    else if (item.isFile() && /\.(mjs|js|json|html|css|ts|tsx)$/.test(file)) {
      const bytes = await readFile(join(root, file)); entries.push({ file, sha256: sha(bytes), bytes: bytes.length });
    }
  }
}
for (const dir of ['public', 'lib', 'test', 'scripts']) await scan(dir);
for (const file of ['server.mjs', 'package.json', 'package-lock.json']) {
  const bytes = await readFile(join(root, file)); entries.push({ file, sha256: sha(bytes), bytes: bytes.length });
}
const preimages = [];
for (const file of ['public/rebuild.js', 'public/rebuild.css', 'public/rebuild.html', 'public/console-model.js']) {
  const destination = join(root, 'data/code-candidates/phase113/preimage', file);
  await mkdir(join(destination, '..'), { recursive: true });
  const bytes = await readFile(join(root, file));
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
  assert.equal(sha(await readFile(destination)), sha(bytes));
  preimages.push({ file, destination, sha256: sha(bytes) });
}
const site = join(root, '../mcn-public-site');
const siteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: site, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--short'], { cwd: site, encoding: 'utf8' }).trim(), '');
const response = await fetch('http://127.0.0.1:4188/api/health', { signal: AbortSignal.timeout(15000) });
assert.equal(response.status, 200); const health = await response.json();
assert.equal(health.status, 'ready'); assert.equal(health.runtimeAI, false);
const result = { createdAt: new Date().toISOString(), entries: entries.sort((a,b) => a.file.localeCompare(b.file)),
  preimages, siteHead, health, permittedProductSources: ['public/rebuild.js', 'public/rebuild.css'],
  originalTestsRetained: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase113-code-baseline.json'),
  JSON.stringify(result, null, 2)+'\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ createdAt: result.createdAt, files: entries.length,
  oldTests: entries.filter(row => row.file.startsWith('test/')).length, preimages: preimages.length, siteHead }));
