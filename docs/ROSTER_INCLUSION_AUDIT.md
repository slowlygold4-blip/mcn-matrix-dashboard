# Verify the complete published author directory

Run with Node against an existing immutable publication directory:

```sh
node frontend/scripts/audit-roster-inclusion.mjs /path/to/published-generation
```

The command reads six fixed local partitions and checks their declared sizes,
SHA-256 hashes, versions and source revisions before using the same roster
builder and current-link projection as the product. It verifies that every
saved source identity and every eligible matrix account remains represented,
including paused targets, pending source rows and explicitly folded aliases.
It rejects missing partitions, missing rows, lost aliases, foreign-scope accounts,
duplicate row keys and inconsistent counters. Search, category filters and
pagination must not be applied to the input full directory.

Output contains counts and fingerprints, not raw author names or identifiers.
Failure exits nonzero without emitting a successful partial or zero-count report.
The command performs no network requests, database writes or model calls. It does
not install a schedule or start collection.

This is a local data-binding/inclusion audit. Matching partition hashes alone do
not establish platform truth; passing does not prove successful sampling,
complete work discovery, real-world person deduplication or browser rendering.
