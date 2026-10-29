# Test output

Related backend regression, 70 passed / 0 failed. Synthetic transport, not a live account coverage test.

```text
✔ browser policy recognizes explicit deployment disable values only (0.312125ms)
✔ deployment opt-out overrides every legacy browser opt-in (0.392916ms)
✔ direct browser methods reject before spawning, parsing targets or loading sessions (0.616ms)
✔ ordinary author resolution retains the non-browser HTTP collector path (0.371042ms)
✔ official numeric strings preserve zero, signed reported changes and absent fields (6.524666ms)
✔ missing days and empty success remain missing, not an invented zero series (0.086542ms)
✔ strict Beijing historical window rejects today, old, impossible and duplicate dates (0.416833ms)
✔ rejects lossy, empty, boolean and negative cumulative values (0.15925ms)
✔ malformed shapes and business errors cannot pass as a valid empty dataset (0.200792ms)
✔ all three endpoints run serially using official host, token header and actual day counts (10.532416ms)
✔ missing authorization/scope, bad inputs and pre-cancellation make zero requests (0.224416ms)
✔ refusals stop immediately without retries or next endpoint and never leak messages (0.42925ms)
✔ failure after one successful endpoint cannot be reported as a successful three-metric trial (0.242459ms)
✔ HTML, oversized responses, broken dates and credential-bearing transport exceptions stay safe (0.429208ms)
✔ readiness CLI is network-free and reports unavailable credentials without secret values (26.4645ms)
✔ missing permission fails before the first network request; readiness never returns secrets (1.359584ms)
✔ readiness CLI makes no requests, database writes or model calls (23.918041ms)
✔ real zero differs from missing plays; no like multiplier; opaque IDs stay distinct from public IDs (10.452166ms)
✔ pagination follows exact returned cursors with safe official-host requests and deduplicates items (0.494916ms)
✔ one-page cap is limited coverage, not full inventory success (0.227417ms)
✔ repeated and lossy int64 cursors cannot silently truncate or loop (0.521125ms)
✔ page budget is validated before transport (0.111917ms)
✔ zero publication placeholders and invalid statistics remain missing (0.172458ms)
✔ authentication, rate limits and HTTP refusals retain fixed safe codes (0.574083ms)
✔ HTML, malformed shapes, failed extra codes and oversized bodies fail closed (2.403083ms)
✔ a failed later page never returns the earlier pages as successful full data (0.237667ms)
✔ transport errors and cancellation never expose upstream credential-bearing messages (0.221792ms)
✔ readiness CLI does not request, mutate or call a model (27.790708ms)
✔ balanced JSON preserves braces/escaped quotes and executes no trailing JavaScript (1.489542ms)
✔ raw public plays never become verified actual plays, including reported zero (0.185958ms)
✔ unsafe/negative/fractional/boolean statistics and placeholder dates remain missing (0.160917ms)
✔ only exact work ID and optional exact author identity can match (0.445167ms)
✔ shell/verification/malformed data fail closed and never count as successful empty collection (0.710833ms)
✔ empty route diagnostics contain counts only and retain bounded transport evidence (10.9025ms)
✔ one bounded HTTP request, no cookie/signature/private redirect/media request (0.266458ms)
✔ invalid IDs, clock and aborted inputs do not leak errors or request unrelated URLs (0.174958ms)
✔ refusal/redirect/rate limit never retries or follows Location (0.542792ms)
✔ invalid MIME and oversized streams fail closed; network exceptions are sanitized (1.868125ms)
✔ canonical redirects preserve exact ID, host allowlist, no cookies and a global three-request cap (1.118333ms)
✔ structured blocked code defers saved profiles without depending on HTTP/Chinese wording (13.547041ms)
✔ upstream Retry-After defers before deadline, and permits bounded retry after deadline (9.694375ms)
✔ deferred work requests do not consume failure attempts or become complete (10.751167ms)
✔ profile gaps remain retryable even when works were deferred (9.852875ms)
✔ invalid policy cannot prevent retries and structured network code wins over legacy text (9.923667ms)
✔ a real browser attempt still counts even if the anonymous lane was deferred (10.251792ms)
✔ explicit expired blocked deadline allows bounded retry instead of a legacy all-day hold (10.740917ms)
✔ two waiting transports defer only until the first lane becomes eligible (9.306417ms)
✔ long upstream hold remains visible without forging a retry date (8.88425ms)
✔ a later actual profile failure cannot inherit an earlier works cooldown (9.355083ms)
✔ topic counters including real zero are complete without profile or works coverage (8.924666ms)
✔ topic with only one counter remains bounded-retry instead of fabricated completion (9.021208ms)
✔ strict occluded no-request evidence does not trip browser transport cooldown (1.926709ms)
✔ network errors, incomplete occlusion evidence and server waits keep ordinary cooldown policy (0.250542ms)
✔ single-account failures and cross-account non-transient business failures do not close a lane (0.139958ms)
✔ distinct 403 evidence is windowed, transport-isolated, and cooldown expires without timers (0.074375ms)
✔ valid server wait cannot be shortened; hold and future deadlines survive validated restoration (0.278792ms)
✔ shorter new failures and late successes cannot clear an active upstream deadline or hold (0.14ms)
✔ malformed persistence cannot suppress requests (0.06675ms)
✔ public policy projection removes arbitrary payloads and validates action/date enums (0.31675ms)
✔ three distinct browser failures defer only that lane while anonymous profile requests continue (1.41475ms)
✔ provider requests only fresh profiles during anonymous cooldown and never manufactures works (0.3615ms)
✔ browser fallback does not globally stop after one target 403, and exception text is redacted (0.358333ms)
✔ new provider restores future wait across newer compatibility snapshots without policy (5.012291ms)
✔ browser success requires a works array; incomplete inventory, invalid or duplicate rows cannot be complete (0.6385ms)
✔ three distinct consecutive transient failures pause only their transport for sixty seconds (0.059ms)
✔ success, non-transient outcomes and unverifiable targets break the transient sequence (0.058333ms)
✔ transient evidence expires with the configured window and is not shared across transports (0.036458ms)
✔ short transient backoff preserves the deadline and reason of longer upstream waits (0.044958ms)
✔ transient deadlines restore through the existing safe projection and expire without timers (0.070458ms)
✔ provider transient browser backoff keeps profiles fresh without manufacturing works (0.16775ms)
ℹ tests 70
ℹ suites 0
ℹ pass 70
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 292.840542
```

Public checkout probes, 35 passed / 0 failed.

```text
✔ official numeric strings preserve zero, signed reported changes and absent fields (5.907ms)
✔ missing days and empty success remain missing, not an invented zero series (0.069834ms)
✔ strict Beijing historical window rejects today, old, impossible and duplicate dates (0.236708ms)
✔ rejects lossy, empty, boolean and negative cumulative values (0.131208ms)
✔ malformed shapes and business errors cannot pass as a valid empty dataset (0.153208ms)
✔ all three endpoints run serially using official host, token header and actual day counts (11.271ms)
✔ missing authorization/scope, bad inputs and pre-cancellation make zero requests (0.256875ms)
✔ refusals stop immediately without retries or next endpoint and never leak messages (0.543417ms)
✔ failure after one successful endpoint cannot be reported as a successful three-metric trial (0.347ms)
✔ HTML, oversized responses, broken dates and credential-bearing transport exceptions stay safe (0.514292ms)
✔ readiness CLI is network-free and reports unavailable credentials without secret values (24.580084ms)
✔ missing permission fails before the first network request; readiness never returns secrets (1.304667ms)
✔ readiness CLI makes no requests, database writes or model calls (24.525625ms)
✔ real zero differs from missing plays; no like multiplier; opaque IDs stay distinct from public IDs (11.314833ms)
✔ pagination follows exact returned cursors with safe official-host requests and deduplicates items (0.452041ms)
✔ one-page cap is limited coverage, not full inventory success (0.233959ms)
✔ repeated and lossy int64 cursors cannot silently truncate or loop (0.594667ms)
✔ page budget is validated before transport (0.112625ms)
✔ zero publication placeholders and invalid statistics remain missing (0.170834ms)
✔ authentication, rate limits and HTTP refusals retain fixed safe codes (0.551667ms)
✔ HTML, malformed shapes, failed extra codes and oversized bodies fail closed (2.250834ms)
✔ a failed later page never returns the earlier pages as successful full data (0.220791ms)
✔ transport errors and cancellation never expose upstream credential-bearing messages (0.24775ms)
✔ readiness CLI does not request, mutate or call a model (24.919291ms)
✔ balanced JSON preserves braces/escaped quotes and executes no trailing JavaScript (1.345708ms)
✔ raw public plays never become verified actual plays, including reported zero (0.180917ms)
✔ unsafe/negative/fractional/boolean statistics and placeholder dates remain missing (0.209ms)
✔ only exact work ID and optional exact author identity can match (0.580542ms)
✔ shell/verification/malformed data fail closed and never count as successful empty collection (0.7855ms)
✔ empty route diagnostics contain counts only and retain bounded transport evidence (10.572542ms)
✔ one bounded HTTP request, no cookie/signature/private redirect/media request (0.396292ms)
✔ invalid IDs, clock and aborted inputs do not leak errors or request unrelated URLs (0.2345ms)
✔ refusal/redirect/rate limit never retries or follows Location (0.632959ms)
✔ invalid MIME and oversized streams fail closed; network exceptions are sanitized (1.778709ms)
✔ canonical redirects preserve exact ID, host allowlist, no cookies and a global three-request cap (1.145833ms)
ℹ tests 35
ℹ suites 0
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 158.499125
```
