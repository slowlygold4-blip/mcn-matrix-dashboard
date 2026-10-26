import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = '/tmp/phase95-profile-first-ft0tG7';
const reference = '/tmp/phase95-okx-source-ph6Z7V';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(root, 'docs/phase95-profile-first-manifest.json')));
for (const entry of manifest) {
  assert.equal(sha(await readFile(join(root, entry.file))), entry.main);
  assert.equal(sha(await readFile(join(stage, entry.file))), entry.stage);
}
const tests = ['test/phase92-works-resume.test.mjs', 'test/phase92-works-resume-owner.test.mjs',
  'test/phase93-works-depth.test.mjs', 'test/phase94-works-async.test.mjs', 'test/phase95-profile-first.test.mjs'];
const expected = [...manifest.map(entry => entry.file), ...tests].sort();
const sourcePackage = '/tmp/phase95-profile-first-candidate.tar.gz';
assert.deepEqual(execFileSync('tar', ['-tzf', sourcePackage], { encoding: 'utf8' }).trim().split('\n').sort(), expected);
const packageBytes = await readFile(sourcePackage);
assert.equal(sha(packageBytes), '095b6d573fb7c17ae565261fcb688466241a77e8464e38a473879ce256b48774');
const destination = join(root, 'data/code-candidates/phase95');
await mkdir(destination, { recursive: true });
await copyFile(sourcePackage, join(destination, 'profile-first-candidate.tar.gz'), constants.COPYFILE_EXCL);
assert.equal(sha(await readFile(join(destination, 'profile-first-candidate.tar.gz'))), sha(packageBytes));

const research = join(root, 'docs/reference-evidence/okx-20261002-phase95');
await mkdir(join(research, 'code'), { recursive: true });
const referenceReceipt = JSON.parse(await readFile(join(reference, 'evidence.json')));
assert.equal(referenceReceipt.sources.length, 8);
for (const source of referenceReceipt.sources) {
  const body = await readFile(join(reference, source.name));
  assert.equal(body.length, source.bytes);
  assert.equal(sha(body), source.sha256);
  assert.equal(source.status, 200);
  assert.equal(new URL(source.url).hostname, 'www.okx.com');
}
await copyFile(join(reference, 'evidence.json'), join(research, 'evidence.json'), constants.COPYFILE_EXCL);
await copyFile(join(reference, 'code/tokens.json'), join(research, 'code/tokens.json'), constants.COPYFILE_EXCL);
const tokenBag = JSON.parse(await readFile(join(research, 'code/tokens.json')));
const tokenCount = ['colors', 'typography', 'spacing', 'radius', 'shadow'].reduce((count, key) => count + tokenBag[key].length, 0);
assert.equal(tokenCount, 9);
for (const entry of ['colors', 'typography', 'spacing', 'radius'].flatMap(key => tokenBag[key])) {
  assert.ok(entry.sources.length && entry.usage.length);
}
const receipt = {
  savedAt: new Date().toISOString(), mainPreimagesMatch: manifest.length,
  candidateSourceFiles: manifest.length, portableTests: tests.length,
  package: 'data/code-candidates/phase95/profile-first-candidate.tar.gz',
  packageSha256: sha(packageBytes), sourcePackageMembers: expected,
  productionPromoted: false, productionInterrupted: false,
  referenceEvidence: 'docs/reference-evidence/okx-20261002-phase95/evidence.json',
  sourceBodiesVerified: referenceReceipt.sources.length,
  tokens: 'docs/reference-evidence/okx-20261002-phase95/code/tokens.json',
  tokenCount, publicThirdPartyCodeCopiedToProduct: false,
  originalPhase94PackageSha256: sha(await readFile(join(root, 'data/code-candidates/phase94/works-async-candidate.tar.gz')))
};
assert.equal(receipt.originalPhase94PackageSha256, 'b20368227582895e94fce06f380b4e851971030b8b0a108b239d69472ffc51f1');
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase95-evidence-preserved.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt));
