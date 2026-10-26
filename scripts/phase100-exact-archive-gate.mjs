import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = process.env.PHASE100_CANDIDATE;
assert.match(stage ?? '', /^\/tmp\/phase100-candidate-[A-Za-z0-9]+\/main$/);
const testUrl = pathToFileURL(join(stage, 'test/phase62-terminal-structure.test.mjs'));
const original = await readFile(testUrl, 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(original), sha(await readFile(join(root, 'test/phase62-terminal-structure.test.mjs'))));
const manifest = JSON.parse(await readFile(join(root, 'docs/phase100-candidate-manifest.json'), 'utf8'));
for (const row of manifest.files) {
  assert.equal(sha(await readFile(join(stage, row.file))), row.candidate, row.file);
  if (row.preimage !== null) assert.equal(sha(await readFile(join(root, row.file))), row.preimage, row.file);
}
const archiveExpression = "new URL('../data/douyin-monitor.sqlite', import.meta.url)";
assert.equal(original.split(archiveExpression).length, 2);
let source = original.replace(archiveExpression, `new URL(${JSON.stringify(pathToFileURL(join(root, 'data/douyin-monitor.sqlite')).href)})`);
source = source.replace(/(?<!['"])import\.meta\.url(?!['"])/g, JSON.stringify(testUrl.href))
  .replaceAll('import.meta.resolve(specifier)', 'phase100Resolve(specifier)')
  .replace(/(from\s+)(['"])(\.\.?\/[^'"]+)\2/g, (_whole, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, testUrl).href}${quote}`);
const packages = { 'playwright-core': import.meta.resolve('playwright-core') };
source = `const phase100Packages = ${JSON.stringify(packages)};\nconst phase100Resolve = specifier => specifier.startsWith('node:') ? specifier : phase100Packages[specifier];\n` + source;
console.log(JSON.stringify({ candidate: stage, originalTestSha256: sha(original), readonlyArchiveRedirectOnly: true,
  unchangedCandidateFiles: manifest.files.length, originalTestAssertionsRetained: true }));
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
