// Optional near-deadline diagnostics only. Never grants readiness, accepts
// works, retries, navigates, scrolls, or changes the owner's absolute budget.
const PROFILE_ID = /^MS4wLj[\w-]{12,220}$/;
const ATTRIBUTION = 'terminal-structure-not-works-evidence';
const MIN_ATTEMPT_ELAPSED_MS = 1_000;
const MIN_ACCOUNT_BUDGET_MS = 20_000;
const OBSERVATIONS = new Set(['observed', 'timeout', 'unavailable', 'stale-document', 'superseded', 'cancelled']);
const count = (value, maximum = 1_000_000) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;

// Serialized into the browser. Read no text, JSON, attributes, URLs, storage,
// credentials or response bodies; do not query or act on controls.
export function readTerminalStructure() {
  const limit = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : null;
  return {
    readyState: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unknown',
    bodyPresent: Boolean(document.body),
    bodyChildCount: document.body ? limit(document.body.childElementCount) : 0,
    scriptCount: limit(document.scripts?.length),
  };
}

/** Reconstruct at every child/parent boundary; absent historical fields stay absent. */
export function sanitizeTerminalObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || value.attribution !== ATTRIBUTION || !OBSERVATIONS.has(value.observation)) return null;
  const result = {
    version: 1, attribution: ATTRIBUTION, observation: value.observation,
    generation: count(value.generation), startedElapsedMs: count(value.startedElapsedMs, 900_000),
    finishedElapsedMs: count(value.finishedElapsedMs, 900_000),
  };
  if (value.observation === 'observed') {
    const structure = value.structure;
    result.structure = {
      readyState: ['loading', 'interactive', 'complete'].includes(structure?.readyState) ? structure.readyState : 'unknown',
      bodyPresent: typeof structure?.bodyPresent === 'boolean' ? structure.bodyPresent : null,
      bodyChildCount: count(structure?.bodyChildCount), scriptCount: count(structure?.scriptCount),
    };
  }
  return result;
}

function sameProfile(value, secUid) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.douyin.com' && !url.username && !url.password
      && [`/user/${secUid}`, `/user/${secUid}/`].includes(url.pathname);
  } catch { return false; }
}

/**
 * Call observe() without awaiting it from the owner's existing wait loop.
 * The observer must not hold up works/pagination processing. close() releases
 * only this observer's timer/listener; Playwright owns an already-issued read.
 * A timeout bounds waiting and acceptance, not cancellation inside Chromium.
 */
export function createTerminalStructureObservation({ page, secUid, getState, now = Date.now } = {}) {
  let attempted = false, closed = false, result = null, inFlight = null, settle = null, initial = null;
  let timer = null, abortListener = null;
  const clock = () => { try { const value = now(); return Number.isSafeInteger(value) ? value : null; } catch { return null; } };
  const state = () => {
    try {
      const value = getState();
      // Copy the specific gates, not a mutable caller container or its extras.
      return { active: value.active, barrier: value.barrier, successful: value.successful,
        navigationFailed: value.navigationFailed, navigationCommitted: value.navigationCommitted,
        targetNavigationObserved: value.targetNavigationObserved, generation: value.generation,
        documentRequest: value.documentRequest, documentRequestGeneration: value.documentRequestGeneration,
        documentStatus: value.documentStatus, worksRequests: value.worksRequests, pendingReads: value.pendingReads,
        signal: value.signal, startedAt: value.startedAt, deadline: value.deadline, totalDeadline: value.totalDeadline };
    } catch { return null; }
  };
  const eligible = value => {
    try {
      return value?.active === true && !value.barrier && !value.successful && !value.signal?.aborted
        && value.navigationFailed === false && value.navigationCommitted === true && value.targetNavigationObserved === true
        && Number.isSafeInteger(value.generation) && value.generation > 0
        && value.documentRequest && typeof value.documentRequest === 'object'
        && value.documentRequestGeneration === value.generation
        && Number.isInteger(value.documentStatus) && value.documentStatus >= 200 && value.documentStatus < 300
        && [value.startedAt, value.deadline, value.totalDeadline].every(Number.isSafeInteger)
        && value.deadline >= value.startedAt && value.totalDeadline >= value.startedAt
        && value.worksRequests === 0 && value.pendingReads === 0
        && PROFILE_ID.test(secUid) && sameProfile(page.url(), secUid);
    } catch { return false; }
  };
  const invalidation = current => {
    if (closed || current?.signal?.aborted || initial?.signal?.aborted) return 'cancelled';
    if (!current) return 'unavailable';
    if (current.generation !== initial.generation || current.documentRequest !== initial.documentRequest) return 'stale-document';
    return eligible(current) ? null : 'superseded';
  };
  const receipt = (observation, structure) => {
    const finishedAt = clock();
    const invalidClock = finishedAt === null || finishedAt < initial.observationStartedAt;
    const value = sanitizeTerminalObservation({ version: 1, attribution: ATTRIBUTION,
      observation: invalidClock ? 'unavailable' : observation,
      generation: initial.generation, startedElapsedMs: initial.observationStartedAt - initial.startedAt,
      finishedElapsedMs: invalidClock ? null : finishedAt - initial.startedAt, ...(!invalidClock && structure ? { structure } : {}) });
    if (value.structure) Object.freeze(value.structure);
    return Object.freeze(value);
  };
  const cleanup = () => {
    clearTimeout(timer); timer = null;
    try { initial?.signal?.removeEventListener('abort', abortListener); } catch { /* no raw error */ }
    abortListener = null;
  };
  function observe() {
    if (closed) return Promise.resolve(result);
    if (attempted) return inFlight ?? Promise.resolve(result);
    const before = state(), observationStartedAt = clock();
    if (![before?.startedAt, before?.deadline, before?.totalDeadline, observationStartedAt].every(Number.isSafeInteger)) return Promise.resolve(null);
    const cutoff = Math.min(before.deadline, before.totalDeadline);
    let canRead = false;
    try { canRead = typeof page?.evaluate === 'function' && eligible(before); } catch { /* no raw adapter error */ }
    if (cutoff - observationStartedAt > 250 || cutoff <= observationStartedAt
      // Short caller budgets retain their original evaluation-count contract.
      // This is eligibility only: never wait for or add this minimum duration.
      || before.totalDeadline - before.startedAt < MIN_ACCOUNT_BUDGET_MS
      || observationStartedAt - before.startedAt < MIN_ATTEMPT_ELAPSED_MS || !canRead) return Promise.resolve(null);
    attempted = true;
    initial = { ...before, observationStartedAt, cutoff };
    inFlight = new Promise(resolve => {
      settle = (observation, structure) => {
        if (result) return;
        const current = state(), finishedAt = clock();
        const invalid = invalidation(current);
        const deadlineExpired = finishedAt === null || finishedAt >= Math.min(cutoff, current?.deadline ?? cutoff, current?.totalDeadline ?? cutoff);
        result = receipt(invalid ?? (deadlineExpired ? 'timeout' : observation), invalid || deadlineExpired ? undefined : structure);
        cleanup(); resolve(result);
      };
      timer = setTimeout(() => settle('timeout'), Math.max(1, cutoff - observationStartedAt));
      abortListener = () => settle('cancelled');
      try { before.signal?.addEventListener('abort', abortListener, { once: true }); }
      catch { settle('unavailable'); return; }
      // Recheck after the microtask boundary; an owner may already have stopped,
      // navigated, accepted works or changed its absolute budget.
      Promise.resolve().then(() => {
        if (result) return;
        const current = state(), at = clock(), invalid = invalidation(current);
        if (invalid) { settle(invalid); return; }
        if (at === null || at >= Math.min(cutoff, current.deadline, current.totalDeadline)) { settle('timeout'); return; }
        return Promise.resolve(page.evaluate(readTerminalStructure)).then(value => settle('observed', value));
      }).catch(() => settle('unavailable'));
    });
    return inFlight;
  }
  function snapshot() {
    // A replacement after a fast read must not masquerade as final-document
    // structure. Keep the original receipt immutable and omit stale structure.
    if (!result || result.observation !== 'observed' || closed) return result;
    const invalid = invalidation(state());
    return invalid ? receipt(invalid) : result;
  }
  function close() {
    closed = true;
    if (attempted && !result) settle('cancelled');
    cleanup();
  }
  return Object.freeze({ observe, snapshot, close, attempted: () => attempted });
}
