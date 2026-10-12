function waitWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, Number(timeoutMs) || 0));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Give already-committed ingestion review receipts a bounded chance to finish
 * before shutdown closes SQLite and exits. Unlike scheduler drain timers, this
 * timer must stay referenced: an unresolved receipt promise alone does not keep
 * Node alive long enough to report the timeout to the shutdown coordinator.
 */
export async function drainPostIngestionReviewForShutdown({ reviewPromise, timeoutMs = 10_000 } = {}) {
  const requestedTimeout = Number(timeoutMs);
  const boundedTimeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(2_147_483_647, Math.max(0, requestedTimeout))
    : 10_000;
  let timer;
  const settled = Promise.resolve(reviewPromise).then(
    () => ({ drained: true, timedOut: false, error: null }),
    (error) => ({ drained: false, timedOut: false, error }),
  );
  const timeout = new Promise((resolve) => {
    // Intentionally referenced until the race settles; see function comment.
    timer = setTimeout(() => resolve({ drained: false, timedOut: true, error: null }), boundedTimeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Close scheduling first, then let a single-account works-only request finish
 * before aborting provider children. Profile batches keep the existing fast
 * cancellation policy; planned maintenance should still avoid their window.
 */
export async function drainSchedulerForShutdown({
  schedulerDrain,
  activeCollectionDrain = Promise.resolve(),
  controller,
  activeTrigger,
  worksOnlyGraceMs = 60_000,
  abortGraceMs = 10_000,
  onDrainError = () => {},
  onWorksGraceTimeout = () => {},
  onAbortTimeout = () => {},
} = {}) {
  const schedulerResult = Promise.resolve(schedulerDrain).then(
    () => ({ finished: true }),
    (error) => {
      onDrainError(error);
      return { finished: true, error };
    },
  );
  const activeResult = Promise.resolve(activeCollectionDrain).then(
    () => ({ finished: true }),
    (error) => {
      onDrainError(error);
      return { finished: false, error };
    },
  );
  const drained = Promise.all([schedulerResult, activeResult]).then(([scheduler, active]) => ({
    settled: scheduler.finished && active.finished,
    error: scheduler.error ?? active.error ?? null,
  }));

  if (activeTrigger === "works-only") {
    const gracefulResult = await waitWithin(drained, worksOnlyGraceMs);
    if (gracefulResult?.settled) return { drained: true, aborted: false, forced: false, timedOut: false };
    if (gracefulResult?.error) {
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error("服务正在关闭"));
      }
    } else {
      onWorksGraceTimeout();
    }
  }

  if (controller && !controller.signal.aborted) {
    controller.abort(new Error("服务正在关闭"));
  }
  const abortResult = await waitWithin(drained, abortGraceMs);
  if (abortResult?.settled) return { drained: true, aborted: true, forced: true, timedOut: false };
  if (abortResult?.error) return { drained: false, aborted: true, forced: true, timedOut: false };
  onAbortTimeout();
  return { drained: false, aborted: true, forced: true, timedOut: true };
}
