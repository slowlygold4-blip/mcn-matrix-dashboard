# Saved publication coverage reconciliation

The existing arithmetic audit checks the numbers inside a published edition. The new coverage audit also compares the saved source works, account work partitions, unified publication rows and the daily index that makes those rows reachable in the product.

```sh
npm run audit:published-coverage -- /absolute/path/to/sealed-edition
npm run audit:published-coverage -- /absolute/path/to/sealed-edition --out /absolute/private/report.json
```

The command is read-only except for an explicitly requested report file. It makes no model, browser, platform or HTTP requests. It verifies the bytes and SHA256 of every consumed partition, reuses the complete existing publication-index checks, and compares exact platform/work IDs. Account names are not identity keys. The private report records the original manifest checksum; stdout omits individual work identifiers and source text.

One work appearing in several sources remains one work. A genuine native publication timestamp determines the Beijing day and can place an initially undated source work before the September 12 business window. That exclusion is explained in the report; the source record and account history remain untouched. First-seen time never supplies a missing publication date. Conflicting dates, conflicting native ownership and unsupported platforms remain incomplete rather than being silently accepted.

The report distinguishes:

- `passed`: the supported saved identities and dates reconcile with the unified ledger and its daily index.
- `failed`: known missing rows, unexplained extra rows, duplicates, wrong dates or internal ledger/index errors.
- `incomplete`: unresolved dates/ownership or a platform that this reconciliation does not yet support.
- `unavailable`: an automatic inspection/report could not finish; never a successful empty result.

CLI exit codes are 0 for passed, 1 for failure/unavailable, and 2 for incomplete. A passed saved-record audit does **not** establish complete platform collection, complete daily publishing counts, source authenticity or metric-adoption provenance. Those remain separate checks. Missing platform observations are never converted into zero publications.

After a successful publisher activation and durable success-state write, the existing publisher writes `data/public-replica-publisher/coverage-audit.json` with the same generation and original manifest hash. This runs inside the existing disposable cycle and adds no scheduler or daemon. Inspection/report failures retain an explicit diagnostic and cannot rewind the confirmed publication, restart collection or clear upload checkpoints. Existing immutable-data and source-validation gates remain in place.

The new synthetic tests include cross-source deduplication, Beijing midnight, genuine source-only and Bilibili rows, before-window exclusions, undated retention, missing/extra rows, conflicting ownership/dates, omitted index shards, byte/hash/path checks, CLI nonzero exit and post-activation failure isolation. The related 15-file backend suite passes 153 cases; the existing cloud workflow includes this suite alongside its interface regressions.
