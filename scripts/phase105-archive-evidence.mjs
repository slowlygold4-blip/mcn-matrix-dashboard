import assert from 'node:assert/strict';
import { readdir, readFile, copyFile, mkdir, chmod, constants, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(Date.now() < Date.parse('2026-10-02T07:03:28Z'));
const destinationRoot = join(root, 'docs/phase105-evidence');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [
  ['frontend', '/tmp/phase105-frontend-ZbI9v5'],
  ['integrity', '/tmp/phase105-integrity-JAAGZz'],
  ['runtime', '/tmp/phase105-runtime-JSituc'],
];
const records = [];
for (const [label, directory] of sources) {
  const output = join(destinationRoot, label);
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(json|md|mjs|log|png|patch)$/.test(entry.name)) continue;
    const source = join(directory, entry.name), destination = join(output, entry.name);
    const bytes = await readFile(source);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o400);
    assert.equal(sha(await readFile(destination)), sha(bytes));
    records.push({ source, file: `docs/phase105-evidence/${label}/${entry.name}`, bytes: bytes.length, sha256: sha(bytes) });
  }
}
const report = { at: new Date().toISOString(), records, copiedExclusively: true,
  boundary: 'Independent synthetic browser/source audits and fixed 2636–2675 data review; not complete platform or Mac-off collection.' };
await writeFile(join(destinationRoot, 'archive.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ at: report.at, preservedFiles: records.length, noProductWrite: true }));
