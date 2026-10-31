# Work fields must belong to the work

The generic work normalizer previously searched nested objects recursively.
When a work omitted statistics, an author's `likes` or a nested recommendation
counter could become that work's likes. Similarly an author's registration
date, biography, ID or profile URL could be adopted as work metadata. This
could manufacture daily work-like comparisons and publication activity.

`normalizePost` now reads work metadata directly from the recognized work
record, and counters directly from its explicit `statistics`, `stats`,
`metrics` object or flat work record. Existing recognized outer wrappers are
retained. Account/profile parsing stays separate. Missing work fields remain
missing; explicit work counters, true zero, safe integer strings, canonical
work links and deterministic fallback identifiers retain their behavior.

Seven regressions cover author/sibling contamination, work metadata isolation,
automatic and manual imports, genuine counters and zero, adjacent-day
comparability, and actual SQLite persistence. The persistence check verifies
that an earlier known value survives while the new missing observation stays
NULL and cannot establish a current-day growth comparison.

Initial counter cases reproduced four failures out of five; the metadata case
also failed before its fix. Eighteen related files pass 248 tests in both the
source and runtime directories, including existing provider, storage,
history, works-only, export, daily readiness and zero-value semantics tests.

A read-only comparison scanned all 98,095 currently stored work raw records
(38,702,284 bytes), including other platforms and inactive accounts. No record
in that scan changed its normalized work fields. This is a preventive repair,
not evidence of corrected historical figures. No raw sources or historical
metrics were rewritten. The scan is not an audit of every older metric
response or a claim of independent source verification.

This repair does not restore upstream access or daily work sampling. Daily
acceptance still requires actual follower, independent profile-total-like,
per-work-like and publication observations. Imported tables remain valid
sources, but author registration dates are not publication dates and missing
work observations are not zero.
