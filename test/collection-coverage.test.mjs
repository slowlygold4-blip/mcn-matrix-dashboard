import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCollectionCoverage, summarizeCollectionCoverage } from '../lib/collection-coverage.mjs';

const date = '2026-09-24';
const timestamp = '2026-09-24T02:00:00Z';
const priorTimestamp = '2026-09-23T02:00:00Z';
const observed = (coverage, extra = {}) => ({ coverage, observedAt: timestamp, lastAttemptAt: timestamp, carriedForward: false, ...extra });
const account = (extra = {}) => ({ enabled: true, trend: [], worksObservation: {}, ...extra });
const collected = (value, day = date) => ({ ...value, collection: accountCollectionCoverage(value, day) });

test('coverage preserves real zero profile counts and zero-work complete observations', () => {
  const result = accountCollectionCoverage(account({
    trend: [{ date, followers: 0, likes: 0, posts: 0 }],
    worksObservation: observed('complete', { sampleCount: 0 }),
  }), date);
  assert.deepEqual(result, { date, profileObserved: true, worksState: 'complete' });
});

test('a profile needs a finite nonnegative observation on the requested day', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '', '100']) {
    const result = accountCollectionCoverage(account({ trend: [{ date, followers: value, likes: value, posts: value }] }), date);
    assert.equal(result.profileObserved, false, `invalid profile value ${String(value)} must not count`);
  }
  for (const key of ['followers', 'likes', 'posts']) {
    const result = accountCollectionCoverage(account({ trend: [{ date, [key]: 0 }] }), date);
    assert.equal(result.profileObserved, true, `an actual ${key} observation is profile coverage`);
  }
});

test('previous-day profile values and latest-success metadata cannot fill a missing day', () => {
  const result = accountCollectionCoverage(account({
    trend: [{ date: '2026-09-23', followers: 900, likes: 1_000, posts: 12 }],
    metrics: { followers: { value: 900 }, likes: { value: 1_000 }, posts: { value: 12 } },
    status: { lastSuccessAt: timestamp, key: 'updated' },
  }), date);
  assert.deepEqual(result, { date, profileObserved: false, worksState: 'missing' });
});

test('profile and works coverage are independent rather than two names for one success', () => {
  const profileOnly = accountCollectionCoverage(account({ trend: [{ date, followers: 100 }] }), date);
  assert.equal(profileOnly.profileObserved, true);
  assert.equal(profileOnly.worksState, 'missing');
  const worksOnly = accountCollectionCoverage(account({ worksObservation: observed('limited') }), date);
  assert.equal(worksOnly.profileObserved, false);
  assert.equal(worksOnly.worksState, 'limited');
});

test('old complete works with no current-day attempt are missing, not successful', () => {
  const result = accountCollectionCoverage(account({ worksObservation: observed('complete', {
    observedAt: priorTimestamp, lastAttemptAt: priorTimestamp,
  }) }), date);
  assert.equal(result.worksState, 'missing');
});

test('current failed attempts carrying earlier samples remain unavailable', () => {
  for (const coverage of ['retry', 'unavailable']) {
    const result = accountCollectionCoverage(account({ worksObservation: observed(coverage, {
      observedAt: priorTimestamp, carriedForward: true, sampleCount: 20,
    }) }), date);
    assert.equal(result.worksState, 'unavailable');
  }
});

test('carried or undated samples never substantiate complete or limited current-day coverage', () => {
  for (const coverage of ['complete', 'limited']) {
    for (const extra of [{ carriedForward: true }, { observedAt: priorTimestamp }, { observedAt: null }]) {
      const result = accountCollectionCoverage(account({ worksObservation: observed(coverage, extra) }), date);
      assert.equal(result.worksState, 'unknown');
    }
  }
  assert.equal(accountCollectionCoverage(account({ worksObservation: observed('unknown') }), date).worksState, 'unknown');
});

test('Beijing calendar day changes at UTC 16:00 and respects an explicit alternate timezone', () => {
  const crossing = account({ worksObservation: observed('complete', {
    lastAttemptAt: '2026-09-23T16:00:00Z', observedAt: '2026-09-23T16:00:00Z',
  }) });
  assert.equal(accountCollectionCoverage(crossing, '2026-09-24').worksState, 'complete');
  assert.equal(accountCollectionCoverage(crossing, '2026-09-23').worksState, 'missing');
  assert.equal(accountCollectionCoverage(crossing, '2026-09-23', 'UTC').worksState, 'complete');
  const before = account({ worksObservation: observed('complete', {
    lastAttemptAt: '2026-09-23T15:59:59Z', observedAt: '2026-09-23T15:59:59Z',
  }) });
  assert.equal(accountCollectionCoverage(before, '2026-09-23').worksState, 'complete');
  assert.equal(accountCollectionCoverage(before, '2026-09-24').worksState, 'missing');
});

test('historical coverage uses the requested date rather than wall-clock today', () => {
  const historical = account({ trend: [{ date: '2026-09-12', followers: 10 }], worksObservation: observed('limited', {
    lastAttemptAt: '2026-09-12T02:00:00Z', observedAt: '2026-09-12T02:00:00Z',
  }) });
  assert.deepEqual(accountCollectionCoverage(historical, '2026-09-12'), {
    date: '2026-09-12', profileObserved: true, worksState: 'limited',
  });
  assert.deepEqual(accountCollectionCoverage(historical, date), { date, profileObserved: false, worksState: 'missing' });
});

test('empty summary and paused accounts do not fabricate missing work or inflate denominators', () => {
  const expected = { date, total: 0, profileObservedCount: 0, profileMissingCount: 0,
    works: { complete: 0, limited: 0, unavailable: 0, unknown: 0, missing: 0 } };
  assert.deepEqual(summarizeCollectionCoverage([], date), expected);
  assert.deepEqual(summarizeCollectionCoverage([collected(account({ enabled: false,
    trend: [{ date, followers: 100 }], worksObservation: observed('complete'),
  }))], date), expected);
});

test('enabled work groups are exclusive and sum to the complete enabled denominator', () => {
  const values = [
    collected(account({ trend: [{ date, followers: 0 }], worksObservation: observed('complete') })),
    collected(account({ worksObservation: observed('limited') })),
    collected(account({ trend: [{ date, likes: 10 }], worksObservation: observed('retry', { observedAt: null }) })),
    collected(account({ worksObservation: observed('unknown', { observedAt: null }) })),
    collected(account()),
    collected(account({ enabled: false, worksObservation: observed('complete') })),
  ];
  const result = summarizeCollectionCoverage(values, date);
  assert.equal(result.total, 5);
  assert.equal(result.profileObservedCount, 2);
  assert.equal(result.profileMissingCount, 3);
  assert.deepEqual(result.works, { complete: 1, limited: 1, unavailable: 1, unknown: 1, missing: 1 });
  assert.equal(Object.values(result.works).reduce((sum, count) => sum + count, 0), result.total);
  assert.equal(result.profileObservedCount + result.profileMissingCount, result.total);
});

test('summary rejects stale or unknown collection states and does not mutate input', () => {
  const values = [
    { enabled: true, collection: { date: '2026-09-23', profileObserved: true, worksState: 'complete' } },
    { enabled: true, collection: { date, profileObserved: false, worksState: 'unexpected' } },
    { enabled: true },
  ];
  const before = structuredClone(values);
  const result = summarizeCollectionCoverage(values, date);
  assert.equal(result.total, 3);
  assert.equal(result.profileObservedCount, 0);
  assert.equal(result.profileMissingCount, 3);
  assert.deepEqual(result.works, { complete: 0, limited: 0, unavailable: 0, unknown: 0, missing: 3 });
  assert.deepEqual(values, before);
});

test('invalid works dates never become current-day coverage', () => {
  for (const lastAttemptAt of [null, '', 'not-a-date']) {
    const result = accountCollectionCoverage(account({ worksObservation: observed('complete', { lastAttemptAt }) }), date);
    assert.equal(result.worksState, 'missing');
  }
});


test('a current latest-public-window is partial coverage, never unknown or complete',()=>{
 const current=account({worksObservation:observed('latest-public-window')});
 assert.equal(accountCollectionCoverage(current,date).worksState,'limited');
 for(const extra of [{carriedForward:true},{observedAt:priorTimestamp},{observedAt:null}])assert.equal(accountCollectionCoverage(account({worksObservation:observed('latest-public-window',extra)}),date).worksState,'unknown');
});
