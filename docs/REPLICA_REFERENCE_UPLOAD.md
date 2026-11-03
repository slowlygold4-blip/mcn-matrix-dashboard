# Verified compact replica uploads

The collector remains a script-only service. This transport change makes no model calls, does not collect platform data, and does not change metric values, observation dates, source records, or publication scope.

The producer opts into `referenceUploads` and negotiates `X-Replica-Reference-Upload: v1` on the existing replica endpoint. It reads the latest published manifest once, indexes its metadata once, and sends `{path, sha256, bytes}` only if rebasing the new canonical JSON root `asOf` to the prior published generation exactly reproduces that prior file's SHA-256 and UTF-8 length. Changed or noncanonical files retain their full bodies. Unsupported receivers keep the original protocol.

The receiver accepts compact descriptors only from the existing authenticated producer. It checks expanded batch budgets before storage reads, reads and hashes the named published immutable source with at most six concurrent readers, reconstructs the exact new bytes, and runs the same partition validators. Missing, corrupt, mismatched, unpublished, or cancelled sources cannot commit partial metadata. A compact upload refused with HTTP 409 is retried once using the original full immutable batch; authentication and network failures are not transformed into repeated full uploads.

Batch boundaries, order, hashes and v1 checkpoints are unchanged. An interrupted compact upload can resume with the option disabled. Activation still checks every partition, ownership relationship and complete publication audit before exposing a generation. References flatten to the original immutable object; they do not create reference chains or bypass activation checks. Previously published generations retain their exact public bytes.

`uploadTransport` reports attempted request count, compact-file attempts, uncompressed/wire bytes and full fallbacks. These are transport counters, not successful platform coverage.

Validation covers exact multi-generation readback, corrupt/missing storage, cancellation/draining, expanded byte limits, unauthenticated writes, post-upload storage loss, full repair, interrupted resume and unchanged checkpoints. Existing publication/runtime and cloud product QA include these tests.

A read-only measurement on the 2026-11-03 18:11 and 18:41 UTC staged generations covered 11,767 original partitions: 11,698 qualified for compact transfer. Gzip level 1 request bodies decreased from 43,473,220 to 1,734,919 bytes (96.0%). This measurement excludes derived summary/date-index files and does not establish end-to-end speed or collection completeness. The same existing publisher, cadence and storage bindings are retained.
