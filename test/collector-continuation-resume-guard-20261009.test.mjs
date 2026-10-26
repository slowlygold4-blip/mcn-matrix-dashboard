import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { checksum } from '../lib/utils.mjs';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { normalizeBrowserWorks } from '../scripts/douyin_browser_collector.mjs';

const fixtureURL = new URL('./phase117-works-timeout-resume.test.mjs', import.meta.url);
const fixture = (await readFile(fixtureURL, 'utf8')).split('\ntest(')[0]
  .replace(/from '([^']+)'/g, (text, specifier) => specifier.startsWith('.')
    ? `from '${new URL(specifier, fixtureURL).href}'` : text);
const { setup, END, CURSOR } = await import(`data:text/javascript;base64,${Buffer.from(fixture + '\nexport {setup,END,CURSOR};').toString('base64')}`);

const diagnostic = (lastBranch, reason) => ({ version: 1, probeCount: 1,
  renderRecheckCount: 0, actionCount: 0, lastBranch,
  structure: { reason, regionCount: 1, visibleRegionCount: 1, leafRegionCount: 1, ancestorCount: 12 } });

for (const [branch, reason] of [
  ['blocked', 'visible-gate'], ['blocked', 'occluded'], ['blocked', 'gate-limit'],
  ['projection-held', 'region-ambiguous'], ['projection-held', 'region-not-visible'],
  ['projection-held', 'projection-error'], ['scroll-error', 'eligible'],
  ['unknown-branch', 'eligible'], ['progress', 'unknown-structure'],
]) test(`resume guard: new ${branch}/${reason} evidence cannot grant a continuation cursor`, t => {
  const f = setup(t, input => { input.result.failureDiagnostics.continuationActivation = diagnostic(branch, reason); });
  assert.equal(f.resume(), null);
  const saved = f.db.prepare('SELECT raw_json,source_checksum FROM works_observations').get();
  const raw = JSON.parse(saved.raw_json), checked = validateWorksOnlyEvidence(raw, { now: Date.parse(END) });
  assert.equal(checked.status, 'accepted', 'retain the verified first-page sample');
  assert.equal(checked.posts.length, 17);
  assert.equal(checksum(checked), saved.source_checksum);
  assert.equal(checksum(raw), saved.source_checksum);
});

test('resume guard: known render-only wait keeps its proven cursor without promoting completeness', t => {
  const f = setup(t, input => {
    input.result.failureDiagnostics.continuationActivation = diagnostic('render-wait-exhausted', 'not-scrollable');
  });
  assert.equal(f.resume()?.cursor, CURSOR);
  const saved = f.db.prepare('SELECT raw_json,source_checksum FROM works_observations').get();
  const checked = validateWorksOnlyEvidence(JSON.parse(saved.raw_json), { now: Date.parse(END) });
  assert.equal(checked.coverage, 'limited'); assert.equal(checksum(checked), saved.source_checksum);
});

test('resume guard: legacy diagnostic absence keeps its prior exact receipt and checkpoint interpretation', t => {
  const f = setup(t);
  assert.equal(f.resume()?.cursor, CURSOR);
  const saved = f.db.prepare('SELECT raw_json,source_checksum FROM works_observations').get();
  const raw = JSON.parse(saved.raw_json), checked = validateWorksOnlyEvidence(raw, { now: Date.parse(END) });
  assert.deepEqual(checked, raw); assert.equal(checksum(checked), saved.source_checksum);
  assert.equal(Object.hasOwn(checked.failureDiagnostics, 'continuationActivation'), false);
});

test('continuation diagnostics: provider retains the new optional diagnostic without adding source authority', async () => {
  const at = '2026-10-09T08:00:00.000Z', secUid = 'MS4wLjABAAAAContinuationDiagnostic1234', uid = '12345678';
  const provider = new PublicWebProvider({}, { accountBrowserFallback: true, now: () => Date.parse(at),
    worksRequestPolicyOptions: { now: () => Date.parse(at) }, execFileImpl: () => {},
    fetchImpl: () => { throw new Error('NO_NETWORK'); } });
  const body = { status_code: 0, has_more: true, max_cursor: 10,
    aweme_list: [{ aweme_id: '7200000000000000011', author: { sec_uid: secUid, uid }, statistics: { digg_count: 3 } }] };
  const pager = new BrowserWorksPagination({ limit: 30 });
  pager.accept({ requestCursor: 0, body, normalized: normalizeBrowserWorks(body, secUid), observedAt: at });
  pager.stop('page-timeout', 'collector_error');
  provider.runBrowserWorks = async () => ({ items: [{ key: '42', status: 'ok', ...pager.result(1),
    errorCode: 'collector_error', failureDiagnostics: { version: 1, stopReason: 'deadline',
      continuationActivation: { ...diagnostic('blocked', 'visible-gate'), private: 'PRIVATE_SECRET' } },
  }] });
  const result = (await provider.collectWorksOnly({ id: 42, type: 'account', enabled: true,
    provider: 'public-web', locator: secUid, metadata: {} },
  { snapshotId: 4, sourceChecksum: 'a'.repeat(64), capturedAt: at, secUid, uid })).result;
  assert.equal(result.status, 'ok'); assert.equal(result.worksCoverage, 'limited');
  assert.equal(result.errorCode, 'collector_error');
  assert.equal(result.failureDiagnostics.continuationActivation.lastBranch, 'blocked');
  assert.equal(result.posts.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
});
