import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'docs/reference-evidence/okx-20261002-phase110');
const okx = '/tmp/phase110-okx-code-ArlXs1';
const mcn = '/tmp/phase110-mcn-design-r9qt7X';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const verified = JSON.parse(await readFile(join(okx, 'verified-mechanisms.json'), 'utf8'));
const reviewed = JSON.parse(await readFile(join(mcn, 'source-evidence.json'), 'utf8'));
assert.equal(verified.sources.length, 6);
assert.equal(verified.anchors.length, 15);
assert.equal(reviewed.sources.length, 26);
assert.equal(Object.values(reviewed.checks).filter(Boolean).length, 18);
const sourceText = {};
for (const source of verified.sources) {
  assert.equal(source.status, 200);
  assert.match(source.url, /^https:\/\/www\.okx\.com\//);
  assert.ok(!source.name.includes('/'));
  const bytes = await readFile(join(okx, source.name));
  assert.equal(bytes.length, source.bytes);
  assert.equal(sha(bytes), source.sha256);
  sourceText[source.name] = bytes.toString('utf8');
}
for (const source of verified.sources.filter(item => item.declaredBy)) {
  const parent = sourceText[source.declaredBy];
  assert.equal(parent.slice(source.declarationUtf16Offset).startsWith(source.url.split('/').at(-1)), true);
}
for (const anchor of verified.anchors) {
  const text = sourceText[anchor.file];
  assert.equal(text.slice(anchor.utf16Offset, anchor.utf16Offset + anchor.excerpt.length), anchor.excerpt);
  assert.equal(Buffer.byteLength(text.slice(0, anchor.utf16Offset)), anchor.utf8ByteOffset);
  assert.equal(text.slice(0, anchor.utf16Offset).split('\n').length, anchor.line);
}
for (const source of reviewed.sources) {
  const bytes = await readFile(source.path);
  assert.equal(sha(bytes), source.sha256);
  assert.equal(bytes.length, source.bytes);
}
const archived = [];
async function copyEvidence(from, name, folder) {
  const bytes = await readFile(join(from, name));
  await mkdir(join(output, folder), { recursive: true });
  const destination = join(output, folder, name);
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o400 });
  assert.equal(sha(await readFile(destination)), sha(bytes));
  archived.push({ file: `${folder}/${name}`, bytes: bytes.length, sha256: sha(bytes) });
}
for (const name of [...verified.sources.map(source => source.name), 'verified-mechanisms.json', 'report.md']) {
  await copyEvidence(okx, name, 'public-code');
}
for (const name of ['source-evidence.json', 'mcn-presentation-review.md', 'signed-receipt.json']) {
  await copyEvidence(mcn, name, 'mcn-source-review');
}
const screenshots = [];
for (const name of (await readdir(output)).filter(name => /^0[1-6]-.+\.jpg$/.test(name)).sort()) {
  const bytes = await readFile(join(output, name));
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
  screenshots.push({ file: name, bytes: bytes.length, sha256: sha(bytes), mime: 'image/jpeg' });
}
assert.equal(screenshots.length, 6);
const receipt = {
  checkedAt: new Date().toISOString(), publicSourcesVerified: 6, literalAnchorsVerified: 15,
  mcnSourceHashesVerified: 26, sourceChecks: 18, screenshots, archived,
  productionChanges: false, databaseAccessByResearch: false, newProductTestsRun: false,
  nativeScreenshotInspectionCompleted: true, originalEightBrowserTabsPreserved: true,
  researchTabClosed: true, mainZoomRestoredTo100: true,
};
await writeFile(join(output, 'archive-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
console.log(JSON.stringify({ ...receipt, screenshots: screenshots.length, archived: archived.length }));
