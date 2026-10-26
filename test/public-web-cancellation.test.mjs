import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicWebProvider } from '../lib/providers/public-web.mjs';

const evidence = count => Array.from({ length: count }, (_, i) => ({ key: `douyin:test-${i}`, douyinId: `test-${i}`, videoIds: ['7679000000000000002'] }));
const success = items => JSON.stringify({ ok: true, data: { items: items.map(item => ({ key: item.key, candidates: [], errors: [] })) } });
const abortError = () => Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });

test('already-cancelled author resolution launches no helper or browser process', async () => {
  for (const authorResolverMode of ['signed-only', 'browser-first']) {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const provider = new PublicWebProvider({}, { authorResolverMode, signal: controller.signal, execFileImpl() { calls++; } });
    await assert.rejects(provider.resolveDouyinAuthors(evidence(1)), { name: 'AbortError' });
    assert.equal(calls, 0);
  }
});

test('browser AbortError is preserved and never starts signed fallback', async () => {
  let calls = 0;
  const provider = new PublicWebProvider({}, { authorResolverMode: 'browser-first', execFileImpl(_file, _args, _options, callback) {
    calls++;
    return { stdin: { end() { callback(abortError(), '', ''); } } };
  } });
  await assert.rejects(provider.resolveDouyinAuthors(evidence(40)), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(calls, 1);
});

test('shutdown during signed batch propagates original reason and prevents a later batch', async () => {
  const controller = new AbortController(); const reason = new Error('graceful shutdown');
  let calls = 0;
  const provider = new PublicWebProvider({}, { authorResolverMode: 'signed-only', signal: controller.signal,
    execFileImpl(_file, _args, _options, callback) {
      calls++;
      return { stdin: { end() { controller.abort(reason); callback(new Error('process terminated'), '', ''); } } };
    } });
  await assert.rejects(provider.resolveDouyinAuthors(evidence(40)), error => error === reason);
  assert.equal(calls, 1);
});

test('aborted unresolved-item fallback is not retried again by the outer browser catch', async () => {
  let calls = 0;
  const provider = new PublicWebProvider({}, { authorResolverMode: 'browser-first', execFileImpl(_file, _args, _options, callback) {
    calls++;
    return { stdin: { end(input) {
      if (calls === 1) callback(null, success(JSON.parse(input).items), '');
      else callback(abortError(), '', '');
    } } };
  } });
  await assert.rejects(provider.resolveDouyinAuthors(evidence(40)), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('late successful transport response after shutdown is rejected rather than returned', async () => {
  const controller = new AbortController(); let calls = 0;
  const provider = new PublicWebProvider({}, { authorResolverMode: 'signed-only', signal: controller.signal,
    execFileImpl(_file, _args, _options, callback) {
      calls++;
      return { stdin: { end(input) { controller.abort(); callback(null, success(JSON.parse(input).items), ''); } } };
    } });
  await assert.rejects(provider.resolveDouyinAuthors(evidence(40)), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('ordinary browser failure still uses the configured signed fallback', async () => {
  let calls = 0;
  const provider = new PublicWebProvider({}, { authorResolverMode: 'browser-first', execFileImpl(_file, _args, _options, callback) {
    calls++;
    return { stdin: { end(input) {
      if (calls === 1) callback(new Error('browser unavailable'), '', '');
      else callback(null, success(JSON.parse(input).items), '');
    } } };
  } });
  const result = await provider.resolveDouyinAuthors(evidence(1));
  assert.equal(calls, 2); assert.equal(result.items.length, 1);
});
