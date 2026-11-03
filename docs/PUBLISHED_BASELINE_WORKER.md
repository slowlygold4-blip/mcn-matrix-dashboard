# Previous-publication verification lifecycle

Before building a new public edition, the publisher validates the entire preceding edition and retains its exact snapshot caps and observed time/checksum pairs. Previously the full staged strings and validator objects occupied the same V8 isolate that subsequently built the next edition. Clearing a local variable did not guarantee those heaps had been reclaimed before export.

`preparePublishedSnapshotBaselineFromDirectory` now performs that complete validation in one disposable worker. The caller waits for actual worker exit, then constructs the existing opaque baseline capability from a private, shape-checked message. There is no public hydration endpoint or persistent unchecked baseline cache. Every file, count, schema, work binding, summary relationship, derived date index and last-confirmed manifest hash still passes the existing verifier. Legacy supported work schemas retain the same rules.

The shared staged reader preserves nested staged directories, rejects path traversal and symlinks in every directory ancestor, and opens files with `O_NOFOLLOW`. The original bytes are neither regenerated nor rewritten. It is only a reader, never proof of validation.

Cancellation and a five-minute maximum validation deadline terminate the worker and await its exit. Failure admits no capability, does not activate a generation, and returns a fixed error without source text or credentials. The existing parent publisher, cadence, immutable upload checkpoints and collection processes remain in place. No browser or model calls are introduced.

The private phase diagnostic revision is `publisher-baseline-isolate-v2`. A running older cycle may finish with its original diagnostic version; the next ordinary worker loads the new code without a daemon restart. This change does not alter public partition contents or require a frontend deployment.

## Verification

```sh
node --test --test-concurrency=1 test/published-baseline-worker.test.mjs \
  test/phase97-published-baseline.test.mjs \
  test/phase97-baseline-source-integrity.test.mjs \
  test/phase65-publisher-catchup-peer.test.mjs \
  test/public-replica-publisher-20261001.test.mjs
```

The related 11-file suite passes 126 tests in the runtime checkout. The tests include actual workers, cancellation/deadline rejection, corrupt bytes, metadata resealing, wrong generation hashes, backdated unpaired snapshots, genuine zero counters, unchanged historical coverage, opaque-token rejection and staged-path safety. Existing publisher tests retain generation catch-up, checkpoint replay, no concurrent cycles and actual topic lifecycle coverage. These are synthetic regressions, not full product acceptance.

A separate read-only production check verified the complete previously confirmed edition, compared 184,167 stored snapshot admission decisions against the preceding rule, and found zero mismatches, matching digests and zero SQLite writes. Exactly 100 rows required the already-published historical baseline. The isolated baseline verification took about 7.58 seconds in that observation; its parent JavaScript heap was about 33.4 MB after worker exit. Process RSS includes worker/native allocations and is a different measurement. This is not a whole-publisher memory or speed benchmark; natural phase telemetry remains the evidence for that scope.

Complete daily Douyin work-level monitoring is still unresolved. Profile freshness and correct historical publication do not prove complete works pagination, daily work likes or complete daily publication counts.
