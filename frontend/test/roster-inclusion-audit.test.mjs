import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildTuantuanRoster } from '../lib/tuantuan-roster.mjs';
import { auditRosterInclusion } from '../lib/roster-inclusion-audit.mjs';

const account = (id, enabled, theme = 'tuantuan') => ({ id, platform: 'douyin', enabled,
  classification: { theme: { key: theme } } });
function fixture() {
  const authors = [{ row: 1, name: '作者甲', douyinId: 'a', targetIds: [1], posts: 1, likes: 3, plays: 30 }];
  const supplements = [{ name: '作者甲', douyinId: 'old-a', targetIds: [1], posts: null, likes: null, plays: null, followers: null }];
  const pending = [{ name: '待核验', rowKey: 'roster:' + 'a'.repeat(64), douyinId: null, sourceOnly: true,
    targetIds: [], sourceRows: [{ title: '登记', rows: ['2'] }] }];
  const accounts = [account(1, true), account(2, false), account(3, true, 'douyin-streamers')];
  const inputs = { authors, supplements, pending, accounts };
  return { inputs, roster: buildTuantuanRoster(authors, accounts, supplements, pending) };
}

test('full directory retains pending records, proven aliases and paused matrix accounts without including streamers', () => {
  const { inputs, roster } = fixture(), before = structuredClone({ inputs, roster });
  const report = auditRosterInclusion(roster, inputs);
  assert.equal(report.directoryRows, 3); assert.equal(report.foldedAliases, 1);
  assert.equal(report.retainedSourceIdentities, 3); assert.equal(report.pendingRecords, 1);
  assert.equal(report.matrixTargets, 2); assert.equal(report.enabledTargets, 1); assert.equal(report.pausedTargets, 1);
  assert.equal(report.representedTargets, 2); assert.equal(report.collectionSuccessVerified, false);
  assert.equal(report.visualVerification, false); assert.equal(JSON.stringify(report).includes('old-a'), false);
  assert.deepEqual({ inputs, roster }, before);
});

test('a plausible count cannot hide omitted pending identities or lost alias evidence', () => {
  for (const kind of ['pending', 'alias']) {
    const { inputs, roster } = fixture();
    if (kind === 'pending') { roster.rows = roster.rows.filter(row => !row.source?.sourceOnly); roster.counts.all--; }
    else delete roster.rows.find(row => row.source?.douyinIds).source.douyinIds;
    assert.throws(() => auditRosterInclusion(roster, inputs), /missing-source/);
  }
});

test('omitted paused targets, duplicated rows, foreign scope and altered totals fail explicitly', () => {
  const cases = [
    [roster => { roster.rows = roster.rows.filter(row => row.key !== 'account:2'); roster.counts.all--; }, /missing-target/],
    [roster => { roster.rows.push(roster.rows[0]); roster.counts.all++; }, /duplicate-row/],
    [roster => { roster.rows[0].accounts = [account(3, true, 'douyin-streamers')]; }, /target-membership/],
    [roster => { roster.counts.monitoredEnabled = 99; }, /counts/],
  ];
  for (const [change, error] of cases) { const { inputs, roster } = fixture(); change(roster);
    assert.throws(() => auditRosterInclusion(roster, inputs), error); }
});

function generation(t) {
  const { inputs } = fixture(), dir = mkdtempSync(join(tmpdir(), 'mcn-roster-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const asOf = '2026-10-31T00:00:00.000Z', wrap = body => ({ version: 1, asOf, timeZone: 'Asia/Shanghai', ...body });
  const parts = { 'catalog.json': wrap({ accounts: inputs.accounts }),
    'creator/index.json': wrap({ revision: 'base', stats: { authors: 1 } }),
    'creator/authors.json': wrap({ revision: 'base', items: inputs.authors }),
    'foundation/index.json': wrap({ revision: 'extra', stats: { additionalAuthors: 1, pendingAuthors: 1 } }),
    'foundation/authors.json': wrap({ revision: 'extra', items: inputs.supplements }),
    'foundation/pending-authors.json': wrap({ revision: 'extra', items: inputs.pending }) };
  const files = Object.entries(parts).map(([path, part]) => {
    const bytes = JSON.stringify(part), segments = path.split('/');
    if (segments.length > 1) mkdirSync(join(dir, segments[0]), { recursive: true });
    writeFileSync(join(dir, path), bytes);
    return { path, bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), count: part.items?.length ?? part.accounts?.length ?? 0 };
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ asOf, files }));
  return { dir, parts, files, asOf };
}
const cli = fileURLToPath(new URL('../scripts/audit-roster-inclusion.mjs', import.meta.url));
const run = dir => spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
test('CLI reads one hashed generation without network or DB access and does not expose identifiers', t => {
  const { dir } = generation(t), result = run(dir);
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.directoryRows, 3); assert.equal(report.verifiedParts, 6);
  assert.equal(report.modelCalls, 0); assert.equal(report.networkRequests, 0); assert.equal(report.databaseWrites, 0);
  assert.match(report.rowKeysSha256, /^[a-f0-9]{64}$/); assert.equal(result.stdout.includes('old-a'), false);
});
test('missing or corrupt source partitions produce failure instead of a misleading zero-author report', t => {
  const { dir, parts } = generation(t);
  writeFileSync(join(dir, 'creator/authors.json'), JSON.stringify({ ...parts['creator/authors.json'], items: [] }));
  let result = run(dir); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /partition-integrity/);
  rmSync(join(dir, 'foundation/pending-authors.json'));
  writeFileSync(join(dir, 'creator/authors.json'), JSON.stringify(parts['creator/authors.json']));
  result = run(dir); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /failed/);
});
