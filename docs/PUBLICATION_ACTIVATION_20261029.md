# Public data publication recovery — 2026-10-29

The producer had uploaded all 342 batches of generation `2026-10-29T10:54:17.235Z`, yet repeatedly timed out during activation. The dashboard therefore kept displaying the older generation even while ordinary collection continued.

## Changes

- Keep ordinary request deadlines at 120 seconds. Add an independent activation deadline, configured to 300 seconds by the existing unattended publisher. The enclosing 480-second operation window and caller abort still apply. Library callers that do not set the new option keep their original deadline behavior. Retries retain immutable acknowledged batches.
- Replace repeated full-manifest scans with an indexed metadata map in the hosted activation route. All existing hash, source, identity, date, count and publication checks remain.
- Add fixed phase/count diagnostics for date validation and other activation failures. Diagnostics never include credentials, request bodies, raw source records or arbitrary error text. Failed audits settle bounded in-flight reads and do not publish a generation.

A 90-byte and a 1,930,090-byte authenticated **invalid-action** probe both returned the expected application 400 in approximately 2.1 and 0.9 seconds. These probes perform no storage writes. They establish that requests of the tested sizes reached the application; they do not prove every network path is healthy.

## Verified runtime result

After related tests, the existing publisher was gracefully reloaded from PID 92457 to PID 33128. The main service and source worker were retained. The same 342/342 checkpoint survived; no new collector, timer or model-backed runtime was started.

At 15:34:36 UTC, generation 10:54 successfully activated and passed the producer's 41-file readback. This is **41 selected files**, not a claim that every one of the 11,804 files was independently read back. The server still performs the publication audits. A separate anonymous HTTP read verified the generation's manifest hash plus catalog, topics, date index, publishing index, creator index and foundation index hashes/byte lengths. The published indices contain 47,012 saved daily points and 57,075 works with the latest date 2026-10-29. Counts describe the available dataset, not complete platform collection.

The successful recovery is consistent with the activation budget/lookup fix; it is not a controlled attribution of all prior 503 responses solely to a timeout. The publisher has automatically begun preparing its next generation. Latest-generation catch-up and full collection coverage remain separate acceptance gates.

## Validation

Related producer tests: 52 passed. Related cloud route/date/source tests: 31 passed. TypeScript passed. These checks also passed on the public-source checkout using the same dependency inputs; no clean dependency installation or full-repository acceptance is claimed. Tests cover separate deadlines, enclosing cancellation, invalid budgets, metadata integrity, incomplete sources, storage failures, fixed diagnostic privacy and anonymous write rejection.

Official [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) document request/connection/resource constraints and client-disconnection behavior. No plan, access policy or paid service was changed to obtain this recovery.


## Compressed transfer follow-up (v115)

The producer now opts into gzip HTTP request bodies; existing callers default to plain JSON. The server bounds both wire bytes and expanded bytes to the original 11.5 MB maximum before parsing. Unsupported codecs, corrupt gzip, invalid UTF-8 and oversized streams are rejected with fixed errors; unauthorized requests are rejected before decoding. Partition and manifest SHA256 values are still computed/validated from the exact original decoded text. No stored observations, source files or checkpoint identities are changed.

A production invalid-action request containing the actual public manifest measured 1,927,214 decoded bytes and 620,080 transmitted bytes (67.8% reduction), returning the expected application 400 after successful decoding in 481 ms. This is a transport validation probe, not a successful ingestion or a throughput benchmark. Production logs subsequently show real gzip upload requests returning 200. Related producer tests 53 and cloud tests 36 passed, also on the public checkout; TypeScript passed.

The existing publisher was gracefully reloaded again from 33128 to 34817. The same generation's 132 confirmed batches survived admission; 136 were present when replacement was verified because in-flight acknowledgements settled before shutdown. No checkpoint reset or second publisher was introduced. The publisher process was given lower scheduling priority (nice 10) to yield to desktop work.

Compression reduces network bytes but does not eliminate storage latency. Observed gzip upload requests of roughly 25–50 KB still spent 12–15 seconds in the Worker. Current protocol changes every file envelope's asOf each generation, causing repeated R2 writes. The next architectural priority is immutable content deduplication with exact byte reconstruction, backward-compatible reads, retained hashes and full audit/repair semantics. It must not be represented as already implemented. Full latest-generation catch-up and Douyin works 403 remain unresolved acceptance items.
