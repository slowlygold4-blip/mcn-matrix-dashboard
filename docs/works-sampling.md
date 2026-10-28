# Fresh work discovery and historical continuation

The works-only lane prioritizes a source-verified head request before continuing
older public work pages. A saved historical cursor must not suppress discovery
of work published since the preceding cycle.

## Scheduling

- A successful, identity-bound cursor-zero observation is fresh for eight hours
  from its actual request finish. The exact expiry is inclusive: at eight hours,
  the next eligible request starts at the head.
- Fresh-head candidates precede historical-backfill candidates. Within either
  lane, untouched accounts and then the oldest verified attempt take priority.
- One accepted limited window no longer settles an entire slot. A remaining
  bounded attempt may continue history after the head is fresh.
- The existing hard bound remains two attempted works runs per account/slot.
  Failed transport attempts retain their delay, denial handling, singleton
  browser owner and cross-account circuit breaker.
- An eight-hour freshness target is not a delivery guarantee. Unresolved
  identities, expired profile anchors, authorization, upstream responses and
  total browser capacity can all prevent an observation.

## Persistence and trust

`works-sampling-policy.mjs` selects between independently verified candidates.
It performs no collection, database writes or model calls. The ledger reader
pins the latest head and continuation in addition to its ordinary bounded
latest-window selection. A derived SQLite expression index avoids decoding
every historical payload to find these candidates.

A new head does not overwrite a pending older backfill cursor. Both the
provider and transactional writer revalidate the candidate, source checksum,
stable author identity, run, fresh profile anchor and pagination chain. The
existing seven-day cursor age, 24-hop bound and stricter timeout-only exception
remain. Hints and caller flags do not grant source authority.

No historical evidence is rewritten. Existing public read APIs, provenance
contracts and immutable observation versions remain compatible. Root and
continuation windows stay limited unless the original independent inventory
and chain-completeness checks succeed. Observing a head does not prove complete
daily publication coverage or restore a missing historical counter.

## Regression checks

`test/works-sampling-freshness.test.mjs` exercises real isolated SQLite writes
through the scheduler and provider, with the external transport replaced by a
deterministic fixture. It checks new work discovery, priority, bounded attempts,
deep cursor retention across several later heads, identity/source rejection,
expiry boundaries and the query plan. The old provider/planner reproduces the
expired-head regression: it requests cursor 100 when cursor zero is required.

Related tests cover disk reopen, source corruption, partial chains, inventory
changes, asynchronous planning, cancellation, SIGTERM draining, retry policy,
and profile-before-browser ordering. These are engineering fixtures, not a
real-user retention study or a claim of upstream collection success.
