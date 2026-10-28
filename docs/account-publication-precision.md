# UTC observation precision and publication continuity

The original Python collector saved valid UTC ISO observations such as
`2026-09-20T02:00:00Z`. Requiring the exact string emitted by JavaScript
`toISOString()` incorrectly rejected these observations at the committed
publication gate, even though their raw source, account identity and counters
passed validation.

The receipt reader now accepts explicit UTC observations with seconds or one
to three fractional digits. It compares their numeric instants for run start,
capture, audit, finish and cutoff ordering. It does not rewrite stored clocks,
raw JSON, checksums or audit/run associations. Missing audits, other target IDs,
counter/hash changes, invalid calendar dates, timezone-free strings and inverted
ordering remain invalid. Generation cutoffs and immutable manifest identities
retain their canonical millisecond-Z format.

Export revision `catalog-date-range-v6-account-clock-precision` requests a new
publication after the current sealed generation finishes. The preceding v5
generation remains a recognized baseline. In-flight batch hashes, upload
acknowledgements and immutable artifacts are preserved; restarting the publisher
does not make an older frozen artifact contain the new historical read policy.

`test/committed-clock-precision.test.mjs` proves valid legacy precision, mixed
clock representations, chronological rejection, unchanged source bytes and
strict cutoff validation. The old reader fails the corresponding positive
regressions. Real-data comparisons are kept in private audit evidence rather
than committed to this public source repository.

## Hosted upload round trips

The hosted upload route validates all parts before any storage write, reads
existing immutable hashes with one bounded query, stores objects with at most
two drained workers, commits metadata in a D1 batch and rereads exact hashes
before acknowledging. A fifty-file upload makes four D1 calls instead of 101
individual reads/writes. The same synthetic SQLite-backed input produces the
same metadata hash before and after this change. This is a round-trip reduction,
not an unmeasured live-cloud latency claim.

Batch semantics and rollback behavior follow the
[Cloudflare D1 database documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
Upload authentication, byte limits, private-field checks, source hashes, sealed
generations and final activation audits remain in force. R2 failures drain
sibling writes before returning 503; failed metadata batches cannot acknowledge
partial indexes. Immutable objects left by a failed attempt are safe to retry
and never become a published generation merely because an upload returned.

Tests exercise large catalogs, denied anonymous requests, invalid final parts,
duplicate paths, immutable conflicts, R2 and database failures, retry, concurrency
conflicts and sealed exact replay. No test calls a model or a remote service.

## Reproducible regression fixtures

Works-read reuse tests compare the current implementation against the same
implementation with request-local source reuse disabled. They assert identical
reports and 3 versus 5 source verifications, independent comparison scopes,
rollback/write rejection and historical-source recovery. A public checkout no
longer needs a private dated code backup or a frozen older report schema.

Coverage and independent-topic fixtures save synthetic source through the normal
normalization, identity, checksum, audit and run contracts. Test dates precede the
requested report; real zeros stay distinct from missing baselines. They do not
change production validation to accept arbitrary SQL counters. Scheduler tests
provide the constructor's default yield callback when constructing a prototype
fixture. These changes affect tests only, with no platform requests or model use.
