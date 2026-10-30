# Daily profile observation coverage

`GET /api/collection-progress` adds nullable `dailyProfiles`. This is operational evidence about currently enabled, linked account targets. It does not claim that every roster author is linked, that all videos were captured, or that a successful account batch satisfies all daily requirements.

Version 1 uses `basis: accepted-profile-day-ends`, `date`, `since`, `previousDate`, `asOf`, and per-platform rows. Each row contains `accounts` and two independent counters, `followers` and `totalLikes`. Each counter contains:

- `observed`: an unambiguous valid final observation within the reported Beijing day.
- `comparable`: an observed account with an unambiguous valid final observation on the immediately previous Beijing day.
- `missingBaseline`: observed accounts without that valid adjacent-day baseline, including conflicting previous-day ends.
- `conflicting`: accounts whose latest valid observation instant has different values on the reported day. Earlier same-day values cannot conceal that conflict; a later valid observation can resolve it.

`comparable + missingBaseline = observed`; `observed + conflicting <= accounts`. These count account observations, not the metric values themselves. A real zero or a decreasing metric can be observed/comparable. Missing values, unsafe numbers, invalid snapshots, missing audit bindings, future timestamps and invalid run/audit clocks cannot count. A valid follower does not depend on a valid account total-like or post count. Equivalent UTC/offset timestamps share the same observation instant. No history is rewritten.

The collector relay whitelists this structure and binds it to its exact telemetry generation, Beijing day and per-platform denominators. Missing/invalid/legacy data remains unavailable rather than becoming fabricated zeros. The public console shows daily observed/comparable counts separately from its rolling 24-hour bar, with missing baselines and conflicting day ends in details. Offline receipts retain their explicit observation date.

Work-level likes, adjacent-day work comparisons, and actual publication evidence retain their existing separate checks. This feature neither fixes upstream work access nor proves that an unobserved account did not publish. Runtime reads, collection, merge and relay use ordinary code without model calls.

Verification: `node --test test/profile-daily-coverage.test.mjs test/collection-progress-platforms.test.mjs test/collection-progress.test.mjs`. Frontend: `test/collection-platform-view.test.mjs`, `test/collection-platform-summary.test.mjs`, `test/collection-console.browser.test.mjs` in the frontend directory. Browser tests simulate receipts and are not real collection coverage or user-retention trials.
