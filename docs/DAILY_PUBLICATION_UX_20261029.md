# Daily publication view — 2026-10-29

The daily work chart now distinguishes missing data from a genuine zero: neither becomes an invented peak of one. A missing selected day keeps its status visible and offers a shortcut to the latest date with a record.

Undated works have a direct, paged detail entry. They remain undated and never move into a daily count. Opening a day reads all of that day's bounded shards, checks their bytes/hashes/generation, publication day and unique work IDs, and leaves other days unfetched.

Immutable data refreshes preserve the selected day and detail page; if the new result has fewer pages the page is clamped to the valid range. A same-generation object refresh does not trigger an index reload. Index and detail failures each have a local retry button and never render as an empty success.

No new dependencies or stylesheets. Existing product styles are reused; keyboard navigation and 320/390px layouts are covered. Collection, database records and original worksheets are unchanged by this frontend change.

Validation: TypeScript and all348frontend tests pass, including the actual React component/browser scenarios and source integrity tests. Initial new pagination fixtures used unequal-length toy IDs, whose lexical sort differed from their expected numeric order; the fixture now uses realistic fixed-length synthetic IDs. Production sorting was not changed. A before-fix browser regression separately reproduces the actual false-peak bug.

This improves presentation and navigation, not Douyin collection coverage. It does not claim that all platform works have been collected, that source cumulative plays are daily plays, or that every network can reach the hosted site.
