# Recover isolated replica storage reads

Publication checks compare every dated summary against its immutable daily source.
Previously, one thrown R2 object/body read rejected that complete pass. A later
publisher attempt could succeed, but repeated all-or-nothing reads delayed delivery.

`frontend/lib/replica-storage-read.mjs` retries an object/body read at most three
times, with 50 ms and 150 ms delays. Only the failing read is retried. Missing
objects, byte/hash/reference proof failures, permission failures, resource limits
and aborts are never converted into successful content. Request cancellation
stops backoff, prevents another GET and releases a body returned after cancellation.

All original exact byte, SHA-256, immutable reference, JSON, source count and
per-target digest checks remain in place. No source is skipped. Fixed diagnostic
categories identify read, resource, access and cancellation failures without
logging provider exception text or credentials. A persistent failure still rejects
publication and leaves the last verified generation available.

This is a server-side storage change. It does not improve access to a social
platform, prove complete work sampling, change the audience or add a model call.
Live delivery after deployment must be verified independently of unit tests.

Tests cover GET/body recovery, bounded failure, terminal failures, corruption,
cancellation, immutable references and complete daily-source audits with one
simulated failure near a previously observed failure boundary.

Resource limits are not assumed to be transient. Consult the current
[Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)
before diagnosing a request budget; paid and free limits differ.
