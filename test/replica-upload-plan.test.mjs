import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {replicaUploadBatches} from '../lib/replica-upload-plan.mjs';
import {replicaBatchByteLimit} from '../lib/replica-partition-budget.mjs';

const asOf = '2026-10-31T06:37:23.081Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const part = (path, content) => ({path, sha256: sha(content), content});
const publication = files => ({manifest: {asOf}, files});
const payloadBytes = (files, reuse = false) => Buffer.byteLength(JSON.stringify({action: 'upload', asOf,
  files, ...(reuse ? {reuseUnchanged: true} : {})}));
const plan = (files, reuse = false) => [...replicaUploadBatches(publication(files), {reuseUnchanged: reuse})];
const wire = file => ({path: file.path, sha256: file.sha256, data: file.content});

test('preserves exact escaped UTF-8 bodies, ordering, hashes and caller immutability', () => {
  const inputs = Array.from({length: 72}, (_, i) => Object.freeze(part(`daily/${i + 1}.json`,
    JSON.stringify({label: '团团😀', quote: '"\\\n\t', value: i}) + '\n')));
  Object.freeze(inputs);
  for (const reuse of [false, true]) {
    const batches = plan(inputs, reuse);
    assert.deepEqual(batches.map(b => b.length), [35, 35, 2]);
    assert.deepEqual(batches.flat(), inputs.map(wire));
    assert.ok(batches.every(b => payloadBytes(b, reuse) <= replicaBatchByteLimit(b)));
    assert.equal(sha(batches[0][0].data), inputs[0].sha256);
  }
});

test('counts reuse envelope at a tight byte boundary instead of causing HTTP 413', () => {
  const inputs = [part('works/1.json', 'a'.repeat(3_700_000)), part('works/2.json', '')];
  const remaining = 7_500_000 - payloadBytes(inputs.map(wire));
  inputs[1] = part(inputs[1].path, 'b'.repeat(remaining));
  assert.equal(payloadBytes(inputs.map(wire)), 7_500_000);
  assert.ok(payloadBytes(inputs.map(wire), true) > 7_500_000);
  assert.ok(inputs.every(f => Buffer.byteLength(f.content) <= 4_000_000));
  assert.deepEqual(plan(inputs).map(b => b.length), [2]);
  assert.deepEqual(plan(inputs, true).map(b => b.length), [1, 1]);
  assert.deepEqual(plan(inputs, true).flat(), inputs.map(wire));
});

test('accounts for JSON expansion and multibyte bytes rather than raw length', () => {
  for (const content of ['\\'.repeat(1_900_000), '中'.repeat(1_300_000)]) {
    const inputs = [part('works/1.json', content), part('works/2.json', content)];
    assert.deepEqual(plan(inputs).map(b => b.length), [1, 1]);
    assert.deepEqual(plan(inputs).flat(), inputs.map(wire));
  }
});

test('keeps the catalog standalone when the ordinary batch budget is exceeded', () => {
  const inputs = [part('daily/1.json', '{}'), part('catalog.json', 'x'.repeat(7_600_000)),
    part('topics.json', '{}')];
  const batches = plan(inputs, true);
  assert.deepEqual(batches.map(b => b.map(f => f.path)), [['daily/1.json'], ['catalog.json'], ['topics.json']]);
  assert.ok(batches.every(b => payloadBytes(b, true) <= replicaBatchByteLimit(b)));
});

test('supports streaming inputs and empty inventories', () => {
  let visited = 0;
  function* stream() {
    for (let i = 0; i < 70; i++) { visited++; yield part(`daily/${i + 1}.json`, '{}'); }
  }
  const batches = replicaUploadBatches(publication(stream()));
  assert.equal(visited, 0);
  assert.equal(batches.next().value.length, 35);
  assert.equal(visited, 36);
  assert.deepEqual([...batches].map(b => b.length), [35]);
  assert.deepEqual(plan([]), []);
});

test('oversize and malformed inputs fail with bounded non-sensitive errors', () => {
  for (const path of ['works/1.json', 'catalog.json']) {
    assert.throws(() => plan([part(path, 'PRIVATE'.repeat(1_700_000))]),
      {code: 'partition-too-large', message: 'partition-too-large'});
  }
  for (const value of [null, {}, {manifest: {asOf}, files: [{path: 'PRIVATE', content: 'SECRET'}]}]) {
    assert.throws(() => [...replicaUploadBatches(value)], {code: 'invalid-source', message: 'invalid-source'});
  }
  assert.throws(() => [...replicaUploadBatches(publication([]), {reuseUnchanged: 'yes'})],
    {code: 'invalid-source', message: 'invalid-source'});
});
