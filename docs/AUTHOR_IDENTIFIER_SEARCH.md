# Preserve original author identifiers after a verified merge

A confirmed source-author alias may be folded into one account while its
original submitted identifier disappears from the public author partition.
Search and CSV must retain that identifier without recreating a duplicate
author or adding its cumulative counters twice.

The producer keeps the existing primary `douyinId` and optionally adds
`douyinIds` containing that primary followed by normalized-unique original
source identifiers. These come from already admitted source aliases, with no
new target binding, profile request, enable action or database mutation.
They are lookup evidence, not permission to treat every supplied identifier
as a current platform handle. Explicit platform UID evidence retains its own
identity namespace.

The hosted contract accepts legacy authors and validates optional arrays:
primary first, 2–100 bounded strings, no empty/duplicate/markup fields. The
existing roster search and CSV read the identifiers. Merging an additional
source alias preserves all prior identifiers and does not merge unlinked
authors merely because their search text overlaps.

Rollout deploys the compatible reader before the V20 producer. V19 and earlier
immutable publication stages remain accepted. Tests cover schema rejection,
source merge/search/export, no extra author linkage, exact old author/work
metric parity and real source-identifier queries. Publication and browser
readback remain separate from daily platform-collection coverage.
