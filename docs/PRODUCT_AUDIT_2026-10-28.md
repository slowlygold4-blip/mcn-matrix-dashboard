# Product audit and fixes · 2026-10-28

This public note contains code and synthetic-test results only. Operational reports, account lists, raw observations, original source tables, browser sessions and credentials remain outside this repository.

## Changes

- Source maintenance uses an authenticated, editor-only narrow bootstrap endpoint. Dashboard aggregation latency is no longer mistaken for missing edit permission.
- Semantic activation conflicts preserve acknowledged uploads and expose only fixed diagnostic enums. Missing remote uploads remain replayable; arbitrary error bodies stay private.
- The producer and public ingestion route share bounded UTF-8 byte budgets. A growing catalog can be uploaded separately without raising limits for ordinary work partitions or anonymous uploads.
- Continuous profile freshness no longer depends on the works queue becoming empty. Durable work cursors and upstream cooldowns remain independent.
- Collection coverage can include atomically committed, matching snapshot/audit evidence during a long running batch. Progress counters alone do not prove usable observations.
- The committed-topic reader recognizes the current writer's time-contract version 1 without relaxing the parent, source, hash or timestamp checks. Unsupported versions remain rejected. Related positive/negative checks: 80 passed. The publisher was reloaded without stopping the collection server. Already sealed generations are not rewritten.
- A missing endpoint comparison offers a clearly dated, verified alternative range. It never fabricates the business-start baseline or silently replaces the requested dates.
- Phone account metrics keep numeric values and change indicators aligned; desktop, phone and print checks cover all seven columns.
- An unused geometry experiment and its tests have moved from production `lib/` into `experiments/profile-root-geometry/`.
- Two `brace-expansion` transitive dependencies receive same-major security patches. The dependency audit reports no remaining known advisory in the tested backend dependency tree.

## Reproducible checks

The backend requires **Node 24** because it uses `node:sqlite`. Changing only `engines` to Node 18 would break startup.

```sh
npm ci --ignore-scripts
npm run test:core
npm run audit:code-layout
```

`test:core` uses synthetic data and temporary SQLite databases. It passed independently from this public checkout after dependency installation: 61 tests. Including the table-import tests after the dependency patches: 103 tests passed.

The full hosted frontend checkout passed 302 tests and TypeScript checks. A further actual-Home fixture verifies the comparison action changes dates and net growth only on click and restores keyboard focus. Some historical frontend integration tests intentionally require the owner's sealed data fixtures and local browser test harness; the public repository does not include those business files. Do not interpret a missing private fixture as a new collection failure.

With an authorized local data restore, deterministic read-only operational checks are available:

```sh
npm run audit:product-state
npm run audit:published-math -- /absolute/path/to/sealed-publication
```

The arithmetic checker exits nonzero on a mismatch. The reference inventory lists candidates for human review; it never deletes files automatically.

## Remaining acceptance gaps

- Complete author linkage and complete works pagination are still not achieved. Profile success, partial works and complete works must have separate denominators.
- Missing daily history cannot be reconstructed from a later cumulative number or a work's publication date.
- The current immutable full-publication upload can lag live collection. Content-addressed reuse and catalog sharding remain planned.
- A local machine that is powered off cannot collect new observations. Public hosting serves the last published edition.
- The in-flight telemetry fix is source-ready, but should be loaded at a safe collection boundary rather than cancelling a long batch.

Hosted frontend version: **v106**, source commit `fc91766213759fc5ab7b60a2ac3d0853f41003fd`.

## Continuation: profile/works scheduling fairness

A fresh checkpoint previously excluded accepted profile observations from the prior checkpoint, even if they were only minutes old. Advancing after a profile pass could therefore trigger another full profile sweep and starve the works lane. Continuous freshness now uses the actual rolling eight-hour observation/audit window across checkpoints. Checkpoints advance only after all currently eligible work settles and the checkpoint is at least eight hours old. Old observations still age out even if works remain deferred.

The real SQLite planning-worker tests include both fresh checkpoint rollover and eventual expiry; related scheduling/telemetry tests pass 42 cases, with 10 separate shutdown/drain cases. Groups overlap earlier reports and must not be added as unique product-wide coverage. This patch is source-ready pending an idle production reload; it must not interrupt the current full batch.

A single read-only test using the existing authorized production works collector returned 30 identity-checked works in the latest public window. It did not modify the production DB, does not prove complete history, and is not a full-roster success rate. A stricter legacy diagnostic stopped on an ordinary same-profile replacement document; that probe's navigation error is not evidence the production collector failed.

## Deterministic topic arithmetic checks

The standalone arithmetic audit now also checks both topic daily deltas and their previous-calendar-day baseline timestamps/checksums. Missing fields, missing dates, zero substitution and cross-topic baselines are rejected. Eight standard-library tests include fault injection and real CLI nonzero exit without input changes.

```sh
npm run test:audit-math
npm run audit:published-math -- /absolute/path/to/sealed-publication
```

The latest reviewed sealed edition has 41,437 account-day rows and 164 topic-day rows. All 166,732 arithmetic/baseline comparisons match. This is arithmetic evidence only, not proof of full-roster/source coverage or current publication status.

## Source-link performance and code boundaries

Receipt verification is now a pure module (`lib/author-resolution-proof.mjs`); the legacy export remains compatible. The five-module source/roster reference cycle is reduced to the existing two-module roster/supplement cycle, which remains a separate refactor candidate. Reference-cycle inventory distinguishes literal worker/script references from confirmed initialization bugs.

A production read-only diagnostic exposed an N+1 full-table scan: the legacy source table lacks a queue-ID lookup index. Current links now scan source receipts once, restricted to the already eligible queue IDs, while retaining all source hashes, immutable admission receipts, queue versions and identity checks. A fault test reproduces 20 scans before the fix and one scan after it; 19 invalid queue receipts remain rejected. Related source/identity tests pass 126 cases; publication/board tests pass 17 and the targeted performance combination passes 52 (overlapping groups).

The same production read, stopped after exceeding 95 seconds before the fix, completes in about 362 ms afterward. All 3,436 derived links match the sealed reference hash exactly, and SQLite reports zero local writes. This measured result is one snapshot/read operation, not a general full-product latency guarantee. Production process loading is tracked separately at the safe collection boundary.

## Public handoff source integrity

A compile-only inventory found 10 synthetic test files whose quote/backtick delimiters were broken by an earlier archive-redaction pass. They now use explicit synthetic fixture values; no real credentials were restored. A reusable `npm run audit:source-syntax` compiles tracked JavaScript modules without evaluating them. The post-fix scan covers 1,153 tracked JS modules with zero syntax errors; all 16 tracked Python files also parse. This is syntax validation, not execution of the entire test suite.

Three stale Bitable fixture checks were updated to include the real idempotency-key helper and valid synthetic record IDs, while retaining source-hash, read-completion-time and rejection assertions. The source/roster/publication combination passes 144 cases in the public checkout.

## Legacy management bootstrap follow-up

Default `/api/bootstrap` no longer runs a whole-database integrity audit before opening the management UI. It returns `runtimeAudit:null` and `runtimeAuditStatus:"not-requested"`; `/api/bootstrap?audit=1` preserves the explicit diagnostic path, and `/api/system-audit` remains the existing full-check action. Unperformed checks are never presented as passed.

The account-period endpoint query is now an indexed per-account reader with the same counter-specific baselines, null handling, cutoff and ID tie-breakers. Report metric/activity queries materialize the already eligible target scope once instead of repeating historical enablement checks for every metric. No history, business data or endpoint values were rewritten.

Real read-only endpoint parity: all six tested day/week/month and target-subset cases match the prior SQL field-for-field; SQLite reports zero writes. Synthetic mixed-history and query-plan checks exercise seven indexed endpoint seeks. Related regressions pass81 cases. Three pre-existing timezone fixture failures also reproduced before this patch: those fixtures now use normalized, source-bound profile payloads rather than unsupported quality flags, preserving the original timezone and metric assertions.

The current overview-only read completes in about6.6s, versus earlier10/12/20s budget expirations. This is an internal read benchmark; actual HTTP latency and safe process loading are recorded separately. The hosted product's public replica path remains distinct from the legacy bootstrap.
