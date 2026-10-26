import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reuse Phase94's exact historical gate without copying a production database.
// Candidate imports change; original test assertions and readonly archive stay.
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = '/tmp/phase95-profile-first-ft0tG7';
const testUrl = pathToFileURL(join(stage, 'test/phase62-terminal-structure.test.mjs'));
const original = await readFile(testUrl, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(join(root, 'docs/phase95-profile-first-manifest.json')));
for (const row of manifest) {
  assert.equal(sha(await readFile(join(stage, row.file))), row.stage);
  assert.equal(sha(await readFile(join(root, row.file))), row.main);
}
const archiveExpression = "new URL('../data/douyin-monitor.sqlite', import.meta.url)";
assert.equal(original.split(archiveExpression).length, 2);
let source = original.replace(archiveExpression, `new URL(${JSON.stringify(pathToFileURL(join(root, 'data/douyin-monitor.sqlite')).href)})`);
source = source.replace(/(?<!['"])import\.meta\.url(?!['"])/g, JSON.stringify(testUrl.href))
  .replaceAll('import.meta.resolve(specifier)', 'phase95Resolve(specifier)')
  .replace(/(from\s+)(['"])(\.\.?\/[^'"]+)\2/g, (_whole, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, testUrl).href}${quote}`);
const esmPackages = { 'playwright-core': import.meta.resolve('playwright-core') };
source = `const phase95EsmPackages = ${JSON.stringify(esmPackages)};\nconst phase95Resolve = specifier => specifier.startsWith('node:') ? specifier : phase95EsmPackages[specifier];\n` + source;
console.log(JSON.stringify({ candidate: stage, originalTestSha256: sha(original), readonlyArchiveRedirectOnly: true,
  unchangedCandidateFiles: manifest.length, unchangedMainPreimages: manifest.length, originalTestsRetained: true }));
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
