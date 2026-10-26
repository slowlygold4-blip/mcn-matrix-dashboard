// One inexpensive indexed probe determines whether the existing queue ticker
// should call the much heavier fair-claim query. This does not choose workers,
// reorder identities, or change the existing two-claims-per-cycle rate limit.
export const AUTHOR_QUEUE_WAKE_POLICY = Object.freeze({
  idleMaximumMs: 30_000,
  dueBacklogMs: 60_000,
  minimumMs: 1_000,
  clockDriftToleranceMs: 5 * 60_000,
});

export function assessAuthorQueueClock(previous, wallNowMs, monotonicNowMs,
  policy = AUTHOR_QUEUE_WAKE_POLICY) {
  if (!Number.isFinite(wallNowMs) || !Number.isFinite(monotonicNowMs)
    || wallNowMs < 0 || wallNowMs > 8.64e15 || monotonicNowMs < 0) {
    return { healthy: false, reason: 'invalid-clock' };
  }
  if (!previous) return { healthy: true, reason: null };
  const wallElapsed = wallNowMs - previous.wallNowMs;
  const monotonicElapsed = monotonicNowMs - previous.monotonicNowMs;
  if (!Number.isFinite(wallElapsed) || !Number.isFinite(monotonicElapsed) || monotonicElapsed < 0)
    return { healthy: false, reason: 'invalid-clock-sequence' };
  if (Math.abs(wallElapsed - monotonicElapsed) > policy.clockDriftToleranceMs)
    return { healthy: false, reason: 'clock-jump' };
  return { healthy: true, reason: null };
}

export function planAuthorResolutionQueueWakeup(db, wallNowMs = Date.now(),
  policy = AUTHOR_QUEUE_WAKE_POLICY) {
  if (!Number.isFinite(wallNowMs) || wallNowMs < 0 || wallNowMs > 8.64e15) return {
    delayMs: policy.idleMaximumMs, hasDueCandidate: false, reason: 'invalid-clock', nextAttemptAt: null,
  };
  const nowIso = new Date(wallNowMs).toISOString();
  // The existing (status,next_attempt_at) index makes both probes cheap even
  // when thousands of old records exist. Fairness and leases remain the
  // responsibility of claimDueAuthorResolutions, not this optimistic probe.
  const dueCanonical = db.prepare(`SELECT 1 present FROM author_resolution_queue
    WHERE status IN ('pending','retry') AND next_attempt_at<=?
      AND substr(next_attempt_at,-1)='Z' AND julianday(next_attempt_at) IS NOT NULL
    LIMIT 1`).get(nowIso);
  // Older rows may carry an explicit timezone offset. A lexicographic test
  // can miss them by hours, so use SQLite's instant comparison as a fallback.
  // This scan runs only when the indexed canonical check found no due row.
  const dueOffset = dueCanonical ? null : db.prepare(`SELECT 1 present FROM author_resolution_queue
    WHERE status IN ('pending','retry')
      AND julianday(next_attempt_at)<=julianday(?) LIMIT 1`).get(nowIso);
  const due = dueCanonical || dueOffset;
  if (due) return { delayMs: policy.dueBacklogMs, hasDueCandidate: true,
    reason: 'due-candidate', nextAttemptAt: null };
  const upcoming = db.prepare(`SELECT MIN(next_attempt_at) AS next_attempt_at
    FROM author_resolution_queue WHERE status IN ('pending','retry')
      AND next_attempt_at>?`).get(nowIso)?.next_attempt_at;
  const nextMs = upcoming ? Date.parse(upcoming) : NaN;
  const untilNext = Number.isFinite(nextMs) && nextMs > wallNowMs
    ? nextMs - wallNowMs : policy.idleMaximumMs;
  return { delayMs: Math.max(policy.minimumMs, Math.min(policy.idleMaximumMs, untilNext)),
    hasDueCandidate: false, reason: upcoming
      ? Number.isFinite(nextMs) ? 'future-retry' : 'invalid-next-at' : 'idle',
    nextAttemptAt: Number.isFinite(nextMs) ? upcoming : null };
}
