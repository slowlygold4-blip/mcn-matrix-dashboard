import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, copyFile, chmod, mkdir, constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(Date.now() < Date.parse('2026-10-02T07:26:11Z'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function walk(relative) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
  }
}
for (const dir of ['public', 'lib', 'test', 'fixtures', 'vendor', 'scripts']) await walk(dir);
files.push('server.mjs', 'package.json', 'package-lock.json', 'docs/phase102-approved-integrity-source-freeze.json',
  'docs/phase102-integrity-permanent.test.mjs', 'docs/phase103-works-final.json', 'docs/phase103-works-source.patch',
  'data/code-candidates/phase103/phase103-works-candidate.tar.gz');
const protectedPreimages = ['test/phase100-integrity.test.mjs', 'docs/phase102-approved-integrity-source-freeze.json',
  'docs/phase102-integrity-permanent.test.mjs'];
for (const file of protectedPreimages) {
  const destination = join(root, 'data/code-candidates/phase106/preimage', file);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(join(root, file), destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o400);
  assert.equal(sha(await readFile(destination)), sha(await readFile(join(root, file))));
}
const manifest = { at: new Date().toISOString(), expectedProductChanges: ['scripts/douyin_browser_collector.mjs'],
  expectedTestChanges: ['test/phase100-integrity.test.mjs'],
  reason: 'Versioned approved source freeze only, no removal of original 13 business cases or original source evidence.', records: [] };
for (const file of files.sort()) {
  const bytes = await readFile(join(root, file));
  manifest.records.push({ file, bytes: bytes.length, sha256: sha(bytes) });
}
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase106-before-source.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ at: manifest.at, sourceFiles: manifest.records.length, protectedPreimages, noProductEdits: true }));
