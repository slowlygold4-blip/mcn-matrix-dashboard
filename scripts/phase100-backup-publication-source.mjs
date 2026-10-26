import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const path = 'lib/committed-target-publication.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const before = await readFile(join(root, path));
const destination = join(root, 'data/code-candidates/phase100/preimage', path);
await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
await copyFile(join(root, path), destination, 1);
await chmod(destination, 0o400);
assert.equal(sha(await readFile(destination)), sha(before));
assert.equal(sha(await readFile(join(root, path))), sha(before));
const result = { at: new Date().toISOString(), path, beforeSha256: sha(before), destination,
  cause: 'Independent actual running-profile integration counterexample; preserve Phase97/98 atomic publication contract',
  productionSourceUnchanged: true, originalBackupPreserved: true };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase100-thirteenth-preimage.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
