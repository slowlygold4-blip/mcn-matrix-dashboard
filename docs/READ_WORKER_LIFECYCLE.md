# Read worker lifecycle

`ConsoleReader` creates its existing single worker only when a real request reaches the lane. It keeps queue limits, request deadlines, per-subscriber cancellation, source/planning freshness, and response formats unchanged.

An idle lane retires its read-only worker after 90 seconds from the last completed read, provided it has no active or queued requests. Retirement never interrupts collection or a running read. New requests wait for any existing termination to finish before a replacement worker is created. Valid cache entries can still serve requests without waking a worker; the worker returns on demand for a fresh read.

One unreferenced maintenance timeout per lane removes expired result entries and retires idle workers. It does not create collection schedules or background development tasks. Cache invalidation from collection does not extend an unused worker's lifetime. Closing a reader clears maintenance and waits for worker termination. `idleTimeoutMs: 0` disables retirement for an explicitly configured caller.

Resident process memory and per-isolate JavaScript heap usage are different measurements. The implementation does not force garbage collection, impose smaller data limits, truncate results or reduce monitoring coverage. A synthetic worker lifecycle test proves worker exit and identical recreated responses, not production memory savings. Actual runtime measurements and fixed-cutoff complete response parity must be checked separately.

Tests: `test/console-reader-resilience.test.mjs`, `test/console-reader-real-lifecycle.test.mjs`, the real creator operating reader, cancellation, scheduling, startup and first-page readiness suites.
