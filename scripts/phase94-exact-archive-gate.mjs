import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Execute the unchanged historical test against the actual frozen candidate
// modules. Only its archive URL is redirected to the existing read-only Main
// archive; no production DB is copied/symlinked into the candidate test tree.
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = '/tmp/phase94-works-async-rkQiaj';
const testUrl = pathToFileURL(join(stage, 'test/phase62-terminal-structure.test.mjs'));
const original = await readFile(testUrl, 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');
const manifest = JSON.parse(await readFile(join(root, 'docs/phase94-works-async-source-manifest.json')));
for (const row of manifest) assert.equal(sha(await readFile(join(stage, row.file))), row.stage);
const archiveExpression = "new URL('../data/douyin-monitor.sqlite', import.meta.url)";
assert.equal(original.split(archiveExpression).length, 2);
let source = original.replace(archiveExpression, `new URL(${JSON.stringify(pathToFileURL(join(root, 'data/douyin-monitor.sqlite')).href)})`);
source = source.replace(/(?<!['"])import\.meta\.url(?!['"])/g, JSON.stringify(testUrl.href))
  .replaceAll('import.meta.resolve(specifier)', 'phase94Resolve(specifier)')
  .replace(/(from\s+)(['"])(\.\.?\/[^'"]+)\2/g, (_whole, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, testUrl).href}${quote}`);
const esmPackages = { 'playwright-core': import.meta.resolve('playwright-core') };
source = `const phase94EsmPackages = ${JSON.stringify(esmPackages)};\nconst phase94Resolve = specifier => specifier.startsWith('node:') ? specifier : phase94EsmPackages[specifier];\n` + source;
console.log(JSON.stringify({ candidate: stage, originalTestSha256: sha(original), readonlyArchiveRedirectOnly: true,
  unchangedCandidateFiles: manifest.length, originalTestsRetained: true }));
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
