# Recovering rejected workbook link fields

Excel may store a valid visible Douyin work link beside an unrelated `mailto:`
hyperlink, or a valid hyperlink beside a display label. The original strict
edition importer deliberately rejects such mixed evidence. Its byte hashes,
row membership and original rejection report must remain immutable.

`lib/work-source-row-projection.mjs` provides a read-only derived view of only
previously rejected `invalid-work-url` rows. It verifies the original artifact
and report, reparses with the opt-in link-field policy, and proves that every
original accepted fact remains byte-equivalent. Conflicting work identities,
multiple unbound short links, oversized fields and root/profile links remain
rejected. Missing original reports grant no recovery.

The unified work reader and existing short-link queue consume the projection.
Receipts for recovered rows require a fresh original-artifact verification;
only their content-addressed fact blob and receipt are added transactionally.
Original source editions and memberships are never rewritten. The existing
source policy fingerprints cause one initial recheck, without duplicating a
pending owned import job or introducing another scheduler.

Recovered facts keep the original source time and original metric/publication
dates. A publication date never becomes a measurement date. A successful link
redirect proves a work reference; it does not prove author ownership or fresh
daily likes. The four daily requirements remain independently auditable in
[DAILY_MONITORING_ACCEPTANCE.md](DAILY_MONITORING_ACCEPTANCE.md).

The V19 export revision refreshes this derived view while accepting immutable
older publication stages. The current frontend contract is unchanged. Private
row-recovery evidence remains behind the existing public export allowlist.

Regression coverage includes raw-edition/reimport stability, historical cutoffs,
later genuine source updates, receipt membership forgery, artifact corruption,
pending-job deduplication and unsafe link evidence. Runtime parsing, joining,
link resolution and publication call no model.

```sh
node --test test/work-source-row-projection.test.mjs
```
