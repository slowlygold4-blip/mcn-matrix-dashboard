# Incremental immutable replica storage

The public publisher previously rewrote every partition because each publication changes the root `asOf` timestamp. A real read-only comparison examined 11,754 staged base partitions: 7,781 could reuse existing content (169 daily, 4,114 works, 3,329 work-metric and other unchanged source/ledger partitions). This is measured eligibility, not a claim of equal production savings or complete platform coverage.

## Implemented contract

- A producer may opt in with `reuseUnchanged: true`; older clients retain their original upload behavior. Response JSON is unchanged. Fixed numeric `X-Replica-Reused` and `X-Replica-Stored` headers describe that acknowledged batch.
- Canonical input text must round-trip exactly, including UTF-8 and its final newline. Replacing only the root publication timestamp must match a file hash and byte count from a previously published generation. Any payload change, unsupported serialization or invalid chronology materializes a normal new object.
- References flatten to an original immutable object instead of forming chains. A HEAD check uses length/ETag to determine whether to restore the already SHA-proven source bytes; MD5 is not used as the content-integrity authority. Reads reconstruct the precise generation-bound JSON and verify its original SHA256 and byte count. Actual metric observation dates never change.
- The server still performs the existing full date/source/count and publication audits before activation. Missing/corrupt storage fails closed with a fixed repairable refusal; replay restores only bytes proven against the sealed source hash. A legacy exact retry can materialize references without changing public bytes.
- File metadata and storage references commit atomically. Reference insert/delete statements are conditional on the winning immutable checksum so a racing loser cannot poison a winner. Opted-in storage operations are limited to six, within the existing per-batch byte budget; legacy upload concurrency remains two.
- Public GET uses one publication/reference query and one object read; existing URLs and manifest contracts remain. No frontend filters, calculations or business data are changed.

## Migration and compatibility

`drizzle/0001_swift_morph.sql` only adds `replica_file_references`. It does not rewrite old migrations, backfill data or alter existing files, generations, collection sessions or source records. The generated journal/snapshot are committed. Original local business data, raw workbooks and monitoring history remain intact. No paid plan or new service was introduced.

## Validation

The full frontend suite passed 370 checks; a subsequently added full daily-source/reference-loss integration case also passed. Nine reference-ingestion cases cover multiple generations, changed data, deleted/corrupt objects, loss after upload, conflicting metadata, bounded failure draining, anonymous rejection and legacy retries. Producer tests pass 56; public checkout producer tests pass 56 and related cloud tests pass 39. TypeScript passes. These numbers overlap; they must not be summed as independent tests.

Native Site v116 deployed successfully. A production idempotent replay of an existing 223-work partition returned reuse=1 and stored=0; its public GET reported reference storage and matched every original byte and SHA. No metric changed and no platform collection request was made by this probe. Initial sampling of only the first 12 daily partitions found no candidates; the bounded read-only script expanded the comparison across the real corpus before selecting a proven unchanged work partition.

## Operational status

The existing publisher preserves its active generation/checkpoint on graceful reload. It now persists `syncing` activity before synchronization and keeps the preceding terminal result separately, preventing a prior abort from masquerading as current failure. Ordinary scheduling, collection and reconciliation remain model-free. Runtime coverage, latest confirmed generation and acknowledged storage receipts remain separate checks; Douyin works HTTP403 and full author/work coverage are not declared solved by storage optimization.
