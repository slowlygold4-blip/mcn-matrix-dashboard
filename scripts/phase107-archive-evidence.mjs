import assert from 'node:assert/strict';
import { readdir, readFile, copyFile, chmod, mkdir, writeFile, constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const group = process.argv[2];
const sources = { integrity: '/tmp/phase107-integrity-vWF06k', runtime: '/tmp/phase107-runtime-weWxw7', candidate: '/tmp/phase107-frontend-ii0r4p' };
assert.ok(Object.hasOwn(sources, group));
const destination = join(root, 'docs/phase107-evidence', group);
await mkdir(destination, { recursive: true, mode: 0o700 });
const records = [];
for (const entry of await readdir(sources[group], { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  assert.match(entry.name, /^[a-zA-Z0-9._-]+$/);
  if (!/\.(json|mjs|md|log|tap|patch|tar\.gz|png|jpg)$/.test(entry.name)) continue;
  const source = join(sources[group], entry.name), file = join(destination, entry.name);
  const bytes = await readFile(source);
  assert.ok(bytes.length < 20 * 1024 * 1024);
  await copyFile(source, file, constants.COPYFILE_EXCL);
  await chmod(file, 0o400);
  assert.equal(sha(await readFile(file)), sha(bytes));
  records.push({ source, file, bytes: bytes.length, sha256: sha(bytes) });
}
assert.ok(records.length > 0 && records.length < 80);
const receipt = { at: new Date().toISOString(), group, records, originalFilesNotChanged: true,
  meaning: 'Preserved actual complete signed artifacts and failure evidence; no passing claim follows from copying.' };
await writeFile(join(root, `docs/phase107-evidence/${group}-archive.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ group, count: records.length, at: receipt.at }));
