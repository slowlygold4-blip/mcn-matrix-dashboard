# Source author field order and duplicate records

The immutable imported workbook remains the original evidence. Business projections share `readCreatorAuthorRows`, which returns effective author fields alongside the unchanged `values_json` and original row coordinates. This is a source interpretation, not a new platform sample or a user-edit operation.

A displaced name/account pair is corrected only when the declared author-table headers identify the two fields, the current account field is invalid, the proposed ID is an exact valid string or safe integer, and explicitly named account/name fields in supported submission or public-result sheets agree on the pair. Duplicate headers, conflicting source names, unsafe numeric IDs and missing evidence stay unverified. No nickname-only identity match is permitted.

If that exact account ID already has one original primary row, only displaced rows with actual zero work, play and like counters can be folded as source aliases. Unknown or measured rows are not silently discarded, even when their names match. Display-name variations are retained as original names and searchable evidence. Ambiguous original IDs cannot select a primary by row order. A standalone corrected source row retains all its measurements and still requires the existing independent profile/work identity proof before monitoring can bind.

All other original cells, aliases, classifications and stored observations remain unchanged. Folded source aliases retain their original row/hash, correction evidence and source name; the complete original worksheet stays accessible. Their zero registration counters are not added to daily metrics. Native account enable flags, manual classifications and identity holds are unaffected.

The corpus, public authors, table foundation, master-roster extension, UID evidence, profile-proof plans, queue admission and resolution-candidate builder share the same interpretation. Public payloads expose only the existing allowed author/work fields; private source cell hashes and proof details do not leak into them. Source proof changes invalidate the derived corpus cache. Publication revision v15 forces a fresh validated dataset while preserving v14 and older sealed baselines.

Run `node --test test/creator-author-field-order.test.mjs test/public-creator-source.test.mjs` for field-role, zero-only alias, source-change/cache and publication checks. Existing identity, queue, roster, foundation and publication suites remain required. Passing these checks does not prove restored daily video collection.
