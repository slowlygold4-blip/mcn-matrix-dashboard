import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubmittedDouyinId, resolveDouyinIdOnlyCandidate } from '../scripts/probes/douyin-id-only-candidates.mjs';

const sec = 'MS4wLjABAAAA_Douyin_Id_Only_Fixture_001';
const id = 'author_001';
const now = () => new Date('2026-10-23T12:00:00.000Z');
const official = (overrides = {}) => ({
  canonicalId: sec, canonicalUrl: `https://www.douyin.com/user/${sec}`,
  profileHttpStatus: 200, profileStatusCode: 0,
  uniqueId: 'Author_001', shortId: '', uid: '1234567890', nickname: '同名不作为证据', ...overrides,
});
const source = (candidates, overrides = {}) => ({
  platform: 'douyin', query: id, queryKind: 'id', candidates,
  loginGateObserved: false, anonymousFreshBrowserContext: true,
  persistentCookiesRead: false, persistentCookiesWritten: false, ...overrides,
});
const lookup = data => ({ search: async (query, kind, options) => {
  assert.equal(query, id);
  assert.equal(kind, 'id');
  assert.deepEqual(options, { headed: false });
  return data;
}, now });

test('strict official profile echo produces a candidate, never a monitoring target', async () => {
  const result = await resolveDouyinIdOnlyCandidate({ douyinId: '@Author_001', name: '另一个昵称' }, lookup(source([official()])));
  assert.equal(result.status, 'candidate-only');
  assert.equal(result.candidate.secUid, sec);
  assert.equal(result.candidate.matchedField, 'unique_id');
  assert.equal(result.candidate.observedPublicId, 'Author_001');
  assert.equal(result.sourceRosterOwnershipVerified, false);
  assert.equal(result.monitoringEnabled, false);
  assert.equal(result.productionDatabaseWritten, false);
  assert.equal(result.metricsSampled, false);
  assert.equal(result.runtimeAI, false);
});

test('nickname is never used for a match; ID must be in official profile field', async () => {
  const result = await resolveDouyinIdOnlyCandidate({ douyinId: id, name: '与平台同名' },
    lookup(source([official({ uniqueId: 'different', nickname: '与平台同名' })])));
  assert.equal(result.status, 'unresolved');
  assert.equal(result.candidate, null);
});

test('malformed, non-200 or nonzero-status official profile cannot become a candidate', async () => {
  for (const row of [
    official({ profileHttpStatus: 403 }), official({ profileStatusCode: 2483 }),
    official({ canonicalId: `${sec}_other` }), official({ canonicalUrl: 'https://evil.example/user/id' }),
  ]) {
    const result = await resolveDouyinIdOnlyCandidate({ douyinId: id }, lookup(source([row])));
    assert.equal(result.status, 'unresolved');
  }
});

test('two exact canonical profiles are ambiguous, not arbitrarily ranked', async () => {
  const otherSec = 'MS4wLjABAAAA_Douyin_Id_Only_Fixture_002';
  const result = await resolveDouyinIdOnlyCandidate({ douyinId: id }, lookup(source([
    official(), official({ canonicalId: otherSec, canonicalUrl: `https://www.douyin.com/user/${otherSec}` }),
  ])));
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidate, null);
  assert.equal(result.matchingProfileCount, 2);
});

test('login gate and uncertain network/source are fail-closed, not not-found', async () => {
  const blocked = await resolveDouyinIdOnlyCandidate({ douyinId: id }, lookup(source([official()], { loginGateObserved: true })));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.candidate, null);
  const network = await resolveDouyinIdOnlyCandidate({ douyinId: id }, {
    now, search: async () => { throw new Error('HTTP 403 / challenge'); },
  });
  assert.equal(network.status, 'unavailable');
  assert.equal(network.candidate, null);
  const unknownSource = await resolveDouyinIdOnlyCandidate({ douyinId: id }, lookup(source([official()], { persistentCookiesRead: true })));
  assert.equal(unknownSource.status, 'unavailable');
  const upstreamRefused = await resolveDouyinIdOnlyCandidate({ douyinId: id }, lookup(source([official()], {
    observedSearchResponses: [{ httpStatus: 200, statusCode: 2483 }],
  })));
  assert.equal(upstreamRefused.status, 'blocked');
  assert.equal(upstreamRefused.candidate, null);
});

test('input parser accepts display ID only, not a name with spaces or sec_uid', () => {
  assert.equal(normalizeSubmittedDouyinId('@Author_001'), id);
  assert.equal(normalizeSubmittedDouyinId('一条小团团'), '');
  assert.equal(normalizeSubmittedDouyinId('author name'), '');
  assert.equal(normalizeSubmittedDouyinId(sec), '');
  assert.equal(normalizeSubmittedDouyinId('0'), '');
});
