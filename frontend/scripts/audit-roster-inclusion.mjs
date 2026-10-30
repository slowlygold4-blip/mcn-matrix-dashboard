import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildTuantuanRoster } from '../lib/tuantuan-roster.mjs';
import { applyLiveAuthorLinks } from '../lib/live-author-links.mjs';
import { auditRosterInclusion } from '../lib/roster-inclusion-audit.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (process.argv.length !== 3) throw Error('usage: audit-roster-inclusion.mjs GENERATION_DIRECTORY');
  const root = resolve(process.argv[2]), raw = await readFile(join(root, 'manifest.json'));
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.files) || typeof manifest.asOf !== 'string'
    || !Number.isFinite(Date.parse(manifest.asOf)) || new Date(manifest.asOf).toISOString() !== manifest.asOf)
    throw Error('invalid-manifest');
  let verifiedParts = 0;
  async function read(path) {
    const matches = manifest.files.filter(file => file.path === path);
    if (matches.length !== 1) throw Error('missing-or-duplicate-partition');
    const meta = matches[0], bytes = await readFile(join(root, path));
    if (meta.bytes !== bytes.length || meta.sha256 !== sha(bytes)) throw Error('partition-integrity');
    const part = JSON.parse(bytes);
    if (part.version !== 1 || part.asOf !== (meta.generation || manifest.asOf)
      || part.timeZone !== 'Asia/Shanghai') throw Error('partition-version');
    if (Array.isArray(part.items) && part.items.length !== meta.count) throw Error('partition-count');
    if (path === 'catalog.json' && (!Array.isArray(part.accounts) || part.accounts.length !== meta.count))
      throw Error('catalog-count');
    verifiedParts++; return part;
  }
  // Fixed partition names only: no paths from an input manifest are executed
  // or followed, and no business database or credential file is opened.
  const catalog = await read('catalog.json'), index = await read('creator/index.json');
  const base = await read('creator/authors.json'), foundation = await read('foundation/index.json');
  const extra = await read('foundation/authors.json'), pending = await read('foundation/pending-authors.json');
  if (base.revision !== index.revision || extra.revision !== foundation.revision
    || pending.revision !== foundation.revision || base.items?.length !== index.stats?.authors
    || extra.items?.length !== foundation.stats?.additionalAuthors
    || pending.items?.length !== foundation.stats?.pendingAuthors || !Array.isArray(catalog.accounts))
    throw Error('source-edition-conflict');
  const authors = applyLiveAuthorLinks(base.items, catalog.creatorSourceLinks, index);
  const inputs = { authors, supplements: extra.items, pending: pending.items, accounts: catalog.accounts };
  const roster = buildTuantuanRoster(authors, catalog.accounts, extra.items, pending.items);
  const audit = auditRosterInclusion(roster, inputs);
  console.log(JSON.stringify({ ...audit, asOf: manifest.asOf, manifestSha256: sha(raw), verifiedParts,
    rowKeysSha256: sha(JSON.stringify(roster.rows.map(row => row.key).sort())),
    runtimeAI: false, modelCalls: 0, networkRequests: 0, databaseWrites: 0 }, null, 2));
} catch (error) {
  console.error(`roster-inclusion-audit failed: ${error.message}`); process.exitCode = 1;
}
