# Work classification and daily publishing flow

## User-visible problem and fix

An identity-verified collected work was always assigned an empty content category unless it already appeared in a source workbook. Consequently, even an explicit `#一条小团团OvO切片激励计划` in the stored caption disappeared under the slice filter. The same missing labels reached the daily publication ledger.

One deterministic rule now recognizes only exact, user-confirmed campaign hashtags: slice incentive, creation incentive, Jimeng remix and the existing Tuantuan Cup tag. It supports display punctuation, Unicode normalization and case variations; it rejects bare keywords, generic Tuantuan tags and extended/incorrect tags. No author nickname, author membership or model call supplies the work category.

The unified operating query and publication ledger use the same work-local evidence. Existing source labels/primary category remain; additional explicit labels supplement them. A work with several labels remains one work in the whole-matrix count. Ambiguous source-author links cannot import another author's caption. A current caption with a later observation time cannot reclassify an earlier cutoff query. Original source files, stored observations, author identities and numeric metrics are not rewritten.

A single read-only transaction compared old/new projections over 78,749 saved works. Exactly 3,388 gained content category membership; work IDs, publication dates, author links and numeric source counters had an identical checksum. This is a classification repair, not 3,388 newly collected works. Comparing the staged publication ledger from September 12 onward showed 3,383 changed shared works, with its 57,075 IDs unchanged and zero additions/removals. The difference consists of works outside the published start-date scope. Multiple category memberships must not be added as distinct works.

## Daily product flow

The existing daily-publication panel now offers all content, slice, creation, Jimeng, cup and unclassified filters. Its heading, calendar bars, selected-day count, verified work rows and pagination use the same category. Rows display their labels. Switching category reuses the already verified day data, resets pagination appropriately and preserves the selected category through immutable data refresh. Unknown days remain missing; a known day containing no matching saved works is a genuine zero within that saved subset. This does not certify that every author's publication was discovered.

## Lower idle overhead

The publisher previously opened/scanned the business database before deciding that its thirty-minute publication interval had not elapsed. The lightweight cadence/schema/clock admission now occurs before database access. Actual pending uploads still resume, schema revisions still publish promptly, old-generation catch-up and clock rollback guards remain. An isolated owned-daemon regression starts with no database or credential file: during cooldown it must retain success and exit cleanly on shutdown. Old code failed this case by attempting the database; corrected code passes. This is structural evidence, not a claimed machine-wide CPU benchmark.

The export revision is `catalog-date-range-v9-work-topic-evidence`; the baseline verifier accepts it alongside preceding schemas. Published immutable snapshots and their byte/hash validation are retained. No additional scheduler or full collector was started.

## Verification and deployment

- Four new operating-query integration cases and three exact-topic rule cases cover classification, cutoff, deduplication and source precedence. Related public-checkout backend tests pass **125**; this is not the entire backend repository.
- Full frontend checks pass **373**, including real React component desktop/320/390px browser tests. An additional public-checkout run of the relevant component/view tests passes **21**. Counts overlap.
- TypeScript and the production build pass. The first typecheck found an implicit callback type; it was corrected before the full final run and build.
- Native Site **v117** deployed successfully at [the existing dashboard](https://mcn-matrix-observatory.slowlygold4.chatgpt.site). No audience, environment binding, database migration or visual theme changed in this release.
- Main service was gracefully replaced only after two idle checks and zero running database jobs; the existing startup backup was hash/quick-check/table-count validated through a temporary hardlink with no additional multi-GB database copy. No interrupted run appeared after reload. The original source worker remained running. The existing publisher was replaced from a confirmed completed generation, preserving prior publication history.

Frontend deployment and data publication are separate operations. The ordinary publisher prepares the v9 generation; current activation and selected public byte/hash readback must be verified before claiming that every corrected category is publicly visible. Full work-level collection, all-author identity linkage, original goal-wide UX/math review and the works HTTP403 remain outstanding. These tests do not establish complete monitoring coverage.

Final runtime readback confirms v9 generation `2026-10-29T17:08:23.907Z` activated and completed the ordinary 41-part readback. A separate public check read its daily publication index and one previously omitted work's partition: both returned HTTP200 with exact manifest bytes/SHA and the expected restored category. The 57,075-work ledger retains its original IDs and total; 3,383 shared rows gain explicit category membership. All 11,804 file acknowledgments were retained; 11,656 reused immutable content and 148 required object writes. These are this generation's file/write receipt counts, not a bytes-saved percentage or improved platform-collection success rate. Main42798/source50348/publisher43777 were verified alive; the source worker was not restarted.
