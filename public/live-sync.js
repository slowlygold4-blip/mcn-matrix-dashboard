// Read-only refresh coordination. No DOM, timers, collection endpoints or writes.
export function monitoringFingerprint(status = {}) {
  const scheduler = status.scheduler || {}, run = scheduler.currentRun || {};
  return JSON.stringify([
    run.runId ?? null, run.completedCount ?? null,
    scheduler.lastScheduledRunFinishedAt ?? null, scheduler.currentSlotKey ?? null,
    status.sourcePoller?.updatedAt ?? null,
  ]);
}

export function createLiveSync({ readStatus, readData, applyData, context, notify = () => {}, now = Date.now, fallbackMs = 300_000 }) {
  let active = true, flight = null, abort = null, generation = 0;
  let fingerprint = null, pending = null, lastDataReadAt = now(), failed = false;
  const snapshot = () => ({ pending: Boolean(pending), inFlight: Boolean(flight), lastDataReadAt, failed, fingerprint });
  const eligible = value => value.visible !== false && value.online !== false;
  function flush() {
    if (!active || !pending) return false;
    const current = context();
    if (pending.scopeKey !== current.scopeKey) { pending = null; notify({ kind: 'ready', ...snapshot() }); return false; }
    if (!eligible(current) || current.busy || current.blocked) {
      notify({ kind: 'pending', reason: current.blocked || '稍后同步', ...snapshot() });
      return false;
    }
    const candidate = pending;
    if (applyData(candidate.data, { scopeKey: candidate.scopeKey }) === false) return false;
    pending = null;
    notify({ kind: 'updated', ...snapshot() });
    return true;
  }
  function invalidate({ keepPending = false } = {}) {
    generation++; abort?.abort();
    if (!keepPending) pending = null;
  }
  function markApplied(status) {
    invalidate(); lastDataReadAt = now(); failed = false;
    if (status) fingerprint = monitoringFingerprint(status);
    notify({ kind: 'ready', ...snapshot() });
  }
  function tick({ force = false } = {}) {
    if (!active) return Promise.resolve();
    const current = context();
    if (!eligible(current)) {
      if (current.online === false) notify({ kind: 'offline', ...snapshot() });
      return Promise.resolve();
    }
    if (current.busy) return Promise.resolve();
    if (flight) return flight;
    const epoch = generation, scopeKey = current.scopeKey;
    const requestController = new AbortController(); abort = requestController;
    const stillCurrent = () => active && epoch === generation && context().scopeKey === scopeKey;
    flight = (async () => {
      try {
        const status = await readStatus({ signal: requestController.signal });
        if (!stillCurrent() || !eligible(context())) return;
        // Import/task pages still need fresh status, but not a matrix read
        // whose result cannot be displayed there. Keep the data fingerprint
        // unchanged so returning to the dashboard can read any missed update.
        if (context().readDataAllowed === false) {
          if (!flush()) notify({ kind: pending ? 'pending' : 'checked', reason: context().blocked, ...snapshot() });
          return;
        }
        const nextFingerprint = monitoringFingerprint(status);
        if (fingerprint === null) fingerprint = nextFingerprint;
        const shouldRead = force || failed || nextFingerprint !== fingerprint || now() - lastDataReadAt >= fallbackMs;
        if (!shouldRead) {
          if (!flush()) notify({ kind: pending ? 'pending' : 'checked', reason: context().blocked, ...snapshot() });
          return;
        }
        if (context().busy) return;
        notify({ kind: 'checking', ...snapshot() });
        const data = await readData({ signal: requestController.signal, scopeKey });
        if (!stillCurrent()) return;
        pending = { data, scopeKey };
        fingerprint = nextFingerprint; lastDataReadAt = now(); failed = false;
        flush();
      } catch (error) {
        if (!stillCurrent() || requestController.signal.aborted) return;
        failed = true;
        notify({ kind: 'error', status: error?.status, error, ...snapshot() });
      } finally {
        if (abort === requestController) abort = null;
        flight = null;
      }
    })();
    return flight;
  }
  return { tick, flush, invalidate, markApplied, snapshot,
    pause() { invalidate({ keepPending: true }); },
    stop() { active = false; invalidate(); },
  };
}
