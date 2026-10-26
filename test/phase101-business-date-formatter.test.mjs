import test from 'node:test';
import assert from 'node:assert/strict';

const legacy = (value = new Date(), timeZone = 'Asia/Shanghai') => {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
};

test('Phase101: formatter reuse avoids per-snapshot construction without caching date results', async () => {
  const { businessDateKey } = await import('../lib/utils.mjs?phase101-count');
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = function (...args) { constructions++; return new original(...args); };
  try {
    for (let index = 0; index < 1000; index++) businessDateKey(new Date(1790899200000 + index * 86400000), 'Asia/Shanghai');
    assert.equal(constructions, 1);
    businessDateKey('2026-10-02T00:00:00Z', 'UTC');
    assert.equal(constructions, 2);
  } finally { Intl.DateTimeFormat = original; }
});

test('Phase101: calendar output equals legacy across zones, DST, offsets, invalid and mutable dates', async () => {
  const { businessDateKey } = await import('../lib/utils.mjs?phase101-values');
  const values = [null, undefined, '', 'invalid', 0, '2026-10-01T15:59:59.999Z', '2026-10-01T16:00:00Z', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', '2000-02-29T23:59:59-05:00'];
  for (const zone of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Honolulu', 'Europe/London']) {
    for (const value of values) assert.equal(businessDateKey(value, zone), legacy(value, zone));
  }
  const date = new Date('2026-10-01T15:59:59.999Z');
  assert.equal(businessDateKey(date), '2026-10-01');
  date.setTime(date.getTime() + 1);
  assert.equal(businessDateKey(date), '2026-10-02');
});

test('Phase101: invalid zones keep throwing and non-string coercion is not cached', async () => {
  const { businessDateKey } = await import('../lib/utils.mjs?phase101-coercion');
  for (let i = 0; i < 2; i++) assert.throws(() => businessDateKey(0, 'not-a-zone'), RangeError);
  assert.throws(() => businessDateKey(0, null), RangeError);
  let zone = 'UTC';
  const mutableZone = { toString() { return zone; } };
  const date = '2026-10-01T20:00:00Z';
  assert.equal(businessDateKey(date, mutableZone), '2026-10-01');
  zone = 'Asia/Shanghai';
  assert.equal(businessDateKey(date, mutableZone), '2026-10-02');
});

test('Phase101: formatter cache is bounded and eviction preserves results', async () => {
  const { businessDateKey } = await import('../lib/utils.mjs?phase101-bound');
  const zones = Intl.supportedValuesOf('timeZone').slice(0, 40);
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = function (...args) { constructions++; return new original(...args); };
  try {
    for (const zone of zones) businessDateKey(0, zone);
    assert.equal(constructions, 40);
    businessDateKey(0, zones.at(-1));
    assert.equal(constructions, 40);
    businessDateKey(0, zones[0]);
    assert.equal(constructions, 41);
  } finally { Intl.DateTimeFormat = original; }
  for (const zone of zones) assert.equal(businessDateKey(0, zone), legacy(0, zone));
});
