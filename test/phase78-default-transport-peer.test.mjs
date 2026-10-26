import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeBrowserCollectorInput } from '../scripts/douyin_browser_collector.mjs';

test('Phase78 actual default transport preserves delayed natural responses; opt-in and natural 403 stay stopped',
  { timeout: 12_000 }, () => {
    // Child process isolates the scaled clock; no real browser/network/DB.
    const path = fileURLToPath(new URL('../docs/phase78-collector-peer-offline-proof.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [path], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32_768 });
    const rows = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 1);
    const proof = rows[0];
    assert.equal(proof.kind, 'phase78-actual-consumer-offline-counterfactual');
    assert.equal(proof.platformRequests, 0); assert.equal(proof.browserLaunched, false);
    assert.equal(proof.databaseOpened, false); assert.equal(proof.syntheticNotLiveCauseProof, true);
    assert.equal(proof.acceptedDataNotPersisted, true); assert.equal(proof.actualConsumerAssertionsPassed, true);
    assert.deepEqual(proof.fixed403, { fixedRequests: 1, naturalRequests: 0,
      returnedBeforePlannedNatural: true, posts: 0, error: 'blocked', stop: 'http-rejection' });
    assert.deepEqual(proof.naturalControl, { fixedRequests: 0, naturalRequests: 1, posts: 1, stop: 'end-of-list' });
    assert.deepEqual(proof.natural403Control, { fixedRequests: 0, naturalRequests: 1,
      posts: 0, error: 'blocked', stop: 'http-rejection' });
    assert.equal(proof.default24SecondControl.fixedRequests, 0);
    assert.equal(proof.default24SecondControl.naturalRequests, 1);
    assert.equal(proof.default24SecondControl.posts, 1);
    assert.equal(proof.default24SecondControl.stop, 'end-of-list');
    assert.ok(proof.default24SecondControl.elapsedMs >= 24_000 && proof.default24SecondControl.elapsedMs < 30_000);
    assert.deepEqual(proof.normalizedBatchCallerControl, { runtimeFullyOffline: true,
      payloadExperimentalFlagsIgnored: true, fixedRequests: 0, naturalRequests: 1, posts: 1, stop: 'end-of-list' });
  });

test('Phase78 ordinary item normalization rejects payload transport opt-in authority', () => {
  const secUid = 'MS4wLjABAAAAPhase78SyntheticOnly';
  const actual = normalizeBrowserCollectorInput({ enableUnverifiedFirstPageRequest: true,
    collectOptions: { enableUnverifiedFirstPageRequest: true },
    items: [{ key: 'plain', secUid, limit: 18, enableUnverifiedFirstPageRequest: true,
      collectOptions: { enableUnverifiedFirstPageRequest: true } }] });
  assert.deepEqual(actual, [{ key: 'plain', secUid, limit: 18 }]);
});
