import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { projectProfileBootstrapStructure as project, sanitizeProfileBootstrapStructure as sanitize } from '../lib/phase70-profile-bootstrap-structure.mjs';
const SEC = 'MS4wLjABAAAAphase70SyntheticProfile';
const OTHER = 'MS4wLjABAAAAphase70OtherSyntheticProfile';
const SECRET = 'PRIVATE_VALUE_OR_DYNAMIC_KEY';
const run = value => JSON.parse(JSON.stringify(vm.runInNewContext(`(${project.toString()})(JSON.parse(input),secUid)`,
  { input: JSON.stringify(value), secUid: SEC })));

test('plain and percent decoded JSON have identical fixed app projections, never works evidence', () => {
  const value = { app: { userInfo: { secUid: SEC, nickname: SECRET }, userDetail: { userInfo: { sec_uid: OTHER } },
    post: { data: [{ desc: SECRET, aweme_id: '7300000000000000000' }] }, videoDetail: { authorInfo: { secUid: OTHER } } }, [SECRET]: SECRET };
  const direct = run(JSON.parse(JSON.stringify(value))), percent = run(JSON.parse(decodeURIComponent(encodeURIComponent(JSON.stringify(value)))));
  assert.deepEqual(direct, percent); assert.equal(direct.appKind, 'object'); assert.equal(direct.appUserInfoKind, 'object');
  assert.equal(direct.identitySlotCount, 2); assert.equal(direct.identityMatchCount, 1); assert.equal(direct.identityConflictCount, 1);
  assert.equal(direct.postArrayCount, 1); assert.equal(direct.postItemCount, 1); assert.equal(direct.otherRootKeyCount, 1);
  assert.doesNotMatch(JSON.stringify(direct), new RegExp(`${SECRET}|${SEC}|${OTHER}|7300000000000000000`));
  assert.equal('works' in direct, false); assert.equal('eligible' in direct, false); assert.equal('profileIdentity' in direct, false);
});
test('exact legacy numeric roots retain shape counts without extracting items', () => {
  const out = run({ 42: { user: { user: { secUid: SEC } }, post: { data: [] } }, 43: { unrelated: SECRET } });
  assert.equal(out.numericBranchCount, 2); assert.equal(out.identitySlotCount, 1); assert.equal(out.postItemCount, 0);
});
test('nested recommendations, auth objects and deep ids do not count as fixed profile slots', () => {
  const out = run({ auth: { secUid: SEC, cookie: SECRET }, recommendation: { userInfo: { secUid: SEC } },
    app: { videoDetail: { userInfo: { secUid: SEC } }, children: { userInfo: { secUid: SEC } } } });
  assert.equal(out.identitySlotCount, 0); assert.equal(out.identityMatchCount, 0); assert.equal(out.postArrayCount, 0);
});
test('both identity aliases must agree; one matching and one conflicting is conflict', () => {
  const out = run({ app: { userInfo: { secUid: SEC, sec_uid: OTHER } } });
  assert.equal(out.identitySlotCount, 1); assert.equal(out.identityMatchCount, 0); assert.equal(out.identityConflictCount, 1);
});
test('invalid identity formats are unknown, never coerced', () => {
  for (const secUid of [null, 123, SEC.slice(0, 10), {}, SECRET]) assert.equal(run({ app: { userInfo: { secUid } } }).identitySlotCount, 0);
  for (const secUid of [null, 0, {}, SECRET]) assert.equal(project({}, secUid), null);
});
test('unknown root and app kinds are fixed enums only', () => {
  for (const [input, expected] of [[null, 'null'], [[], 'array'], [0, 'scalar'], [SECRET, 'scalar']]) assert.equal(run(input).rootKind, expected);
  for (const [app, expected] of [[null, 'null'], [[], 'array'], [0, 'scalar']]) assert.equal(run({ app }).appKind, expected);
});
test('root and post limits discard partial fields without leaking raw text', () => {
  for (const input of [Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [i, SECRET])),
    { app: { post: { data: Array(1001).fill(SECRET) } } }]) assert.deepEqual(run(input),
    { version: 1, attribution: 'bootstrap-structure-not-works-evidence', observation: 'unavailable' });
});
test('aliasing and cycles do not duplicate declared identity or post counts', () => {
  const user = { secUid: SEC }, data = [1], value = { userInfo: user, app: { userInfo: user, post: { data } }, post: { data } };
  value.loop = value; const out = project(value, SEC);
  assert.equal(out.identitySlotCount, 1); assert.equal(out.postArrayCount, 1); assert.equal(out.postItemCount, 1);
});
test('accessor slot is never invoked and discards partial observations', () => {
  let calls = 0; const value = { app: {} };
  Object.defineProperty(value.app, 'userInfo', { get() { calls++; throw Error(SECRET); } });
  assert.equal(project(value, SEC).observation, 'unavailable'); assert.equal(calls, 0);
});
test('hostile proxy never raises or leaks', () => {
  const value = new Proxy({}, { ownKeys() { throw Error(SECRET); } });
  assert.equal(project(value, SEC).observation, 'unavailable');
});
test('sanitizer drops arbitrary values, fields, prototypes, injection enums and oversized counters', () => {
  const good = run({ app: {} }); const out = sanitize({ ...good, raw: SECRET, rootKind: SECRET, appKind: SECRET, postItemCount: 10001 });
  assert.equal(out.rootKind, 'unknown'); assert.equal(out.appKind, 'unknown'); assert.equal(out.postItemCount, null);
  assert.equal('raw' in out, false); assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET));
  assert.equal(sanitize({ version: 1, attribution: SECRET }), null); assert.equal(sanitize(null), null);
});
test('sanitizer malicious getters fail closed without throwing exported details', () => {
  const bad = run({}); Object.defineProperty(bad, 'appKind', { get() { throw Error(SECRET); } }); assert.equal(sanitize(bad), null);
});
test('pure helper roundtrip projection is canonical and immutable to caller input', () => {
  const input = { app: { userInfo: { secUid: SEC } } }; const before = JSON.stringify(input);
  const out = run(input); assert.deepEqual(sanitize(out), out); assert.equal(JSON.stringify(input), before);
});
test('aggregate post items remain bounded across individually valid numeric branches', () => {
  const input = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, { post: { data: Array(1000).fill(SECRET) } }]));
  assert.equal(run(input).observation, 'unavailable');
});
test('maximum valid identity slots and empty arrays remain canonical through the sanitizer', () => {
  const input = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [i, { user: { user: { secUid: SEC } }, post: { data: [] } }]));
  const out = run(input); assert.equal(out.identitySlotCount, 1000); assert.equal(out.postArrayCount, 1000);
  assert.deepEqual(sanitize(out), out);
});
test('no private/global/network/action source calls exist in pure diagnostic helper', () => {
  const source = project.toString();
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|setTimeout|setInterval|addEventListener|localStorage|sessionStorage|document|location|window)\s*[.(]/);
  assert.doesNotMatch(source, /\.(?:click|wheel|move|goto|reload|evaluate|send|route)\s*\(/);
});
