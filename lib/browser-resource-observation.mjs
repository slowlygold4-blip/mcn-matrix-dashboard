// Passive diagnostics only. No browser actions, evidence binding or persistence.
const RESOURCE_KINDS = ['document', 'script', 'stylesheet', 'xhr', 'fetch', 'image', 'font', 'other'];
const RELATIONS = ['initial', 'linked-http-redirect', 'new-document', 'same-document', 'unknown'];
const TARGETS = ['same-profile', 'other-profile', 'login', 'verification',
  'other-official', 'other-origin', 'invalid', 'unknown'];
const FAILURE_KINDS = ['aborted', 'dns', 'timeout', 'connection', 'tls', 'blocked-client', 'other', 'unknown'];
const PHASES = ['beforeStop', 'afterStop', 'cleanup'];
const record = keys => Object.fromEntries(keys.map(key => [key, 0]));
const validObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const boundedOption = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0
  ? Math.min(value, maximum) : fallback;
const validSecUid = value => typeof value === 'string' && /^MS4wLj[\w-]{12,220}$/.test(value);

/** Classifies a transient URL, never returns or retains the URL or identity. */
export function classifyBrowserDocumentTarget(value, secUid) {
  if (typeof value !== 'string' || value.length > 4_096) return 'invalid';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return 'invalid';
    const official = url.protocol === 'https:' && !url.port
      && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
    if (!official) return 'other-origin';
    if (/\/(?:captcha|verify|challenge)(?:\/|$)/i.test(url.pathname)) return 'verification';
    if (/^(?:login|passport)\./i.test(url.hostname)
      || /\/(?:login|passport)(?:\/|$)/i.test(url.pathname)) return 'login';
    if (url.origin === 'https://www.douyin.com' && validSecUid(secUid)
      && [`/user/${secUid}`, `/user/${secUid}/`].includes(url.pathname)) return 'same-profile';
    if (url.origin === 'https://www.douyin.com' && /^\/user\/[^/]+\/?$/.test(url.pathname)) {
      return validSecUid(secUid) ? 'other-profile' : 'unknown';
    }
    return 'other-official';
  } catch { return 'invalid'; }
}

/** Accepts an already classified enum, not raw Error, message or errorText. */
function failureKind(value) {
  return FAILURE_KINDS.includes(value) ? value : 'unknown';
}

/**
 * One attempt per observer. Caller explicitly forwards events and phase boundaries.
 * maxRequests caps strong Request references; weak dedup/redirect refs retain no URLs.
 * No request.failure(), frame(), headers(), body(), or browser mutation is invoked.
 */
export function createBrowserResourceObservation(options = {}) {
  const maxRequests = boundedOption(options.maxRequests, 256, 1_024);
  const countLimit = boundedOption(options.countLimit, 10_000, 1_000_000);
  const maxStatusCodes = boundedOption(options.maxStatusCodes, 16, 32);
  let secUid = validSecUid(options.secUid) ? options.secUid : null;
  let phase = 'beforeStop', closed = false, stopInitiated = false;
  let seen = new WeakSet(), lastDocument = null;
  const pending = new Map();
  const resources = Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, {
    requested: 0, finished: 0, failed: 0, statusCounts: new Map(),
    statusOverflow: 0, invalidStatus: 0, unresolvedAtClose: 0,
  }]));
  const failuresByPhase = Object.fromEntries(PHASES.map(key => [key, {
    total: 0, resources: record(RESOURCE_KINDS), kinds: record(FAILURE_KINDS),
  }]));
  const documents = { lastRelation: 'unknown', lastTarget: 'unknown', lastStatus: null,
    relations: record(RELATIONS), targets: record(TARGETS) };
  const discarded = { capacity: 0, invalid: 0, untrackedEvents: 0 };
  const bump = (object, key) => { object[key] = Math.min(countLimit, object[key] + 1); };
  const documentEvent = (relation, target) => {
    documents.lastRelation = relation; documents.lastTarget = target;
    bump(documents.relations, relation); bump(documents.targets, target);
  };

  function request(value, navigation = {}) {
    if (closed) return false;
    if (!validObject(value)) { bump(discarded, 'invalid'); return false; }
    if (seen.has(value)) return false;
    seen.add(value);
    if (pending.size >= maxRequests) { bump(discarded, 'capacity'); return false; }
    let kind;
    try {
      const candidate = value.resourceType();
      kind = RESOURCE_KINDS.includes(candidate) ? candidate : 'other';
    } catch { bump(discarded, 'invalid'); return false; }
    const state = { kind, mainDocument: false, responseSeen: false };
    pending.set(value, state); bump(resources[kind], 'requested');
    try {
      if (navigation?.isMainFrame === true) {
        if (value.isNavigationRequest() === true) {
          state.mainDocument = true;
          const previous = value.redirectedFrom();
          const last = lastDocument?.deref();
          const relation = previous ? (previous === last ? 'linked-http-redirect' : 'unknown')
            : (lastDocument ? 'new-document' : 'initial');
          documentEvent(relation, classifyBrowserDocumentTarget(value.url(), secUid));
          documents.lastStatus = null;
          lastDocument = new WeakRef(value);
        }
      }
    } catch { documentEvent('unknown', 'unknown'); }
    return true;
  }

  function response(value) {
    if (closed) return false;
    try {
      const boundRequest = value.request(), state = pending.get(boundRequest);
      if (!state) { bump(discarded, 'untrackedEvents'); return false; }
      if (state.responseSeen) return false;
      state.responseSeen = true;
      const status = value.status(), resource = resources[state.kind];
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        bump(resource, 'invalidStatus'); return false;
      }
      if (state.mainDocument && lastDocument?.deref() === boundRequest) documents.lastStatus = status;
      if (resource.statusCounts.has(status)) {
        resource.statusCounts.set(status, Math.min(countLimit, resource.statusCounts.get(status) + 1));
      } else if (resource.statusCounts.size < maxStatusCodes) resource.statusCounts.set(status, 1);
      else bump(resource, 'statusOverflow');
      return true;
    } catch { bump(discarded, 'invalid'); return false; }
  }

  function terminal(value, failed, kind) {
    if (closed) return false;
    const state = validObject(value) ? pending.get(value) : null;
    if (!state) { bump(discarded, 'untrackedEvents'); return false; }
    pending.delete(value);
    bump(resources[state.kind], failed ? 'failed' : 'finished');
    if (failed) {
      const failures = failuresByPhase[phase];
      bump(failures, 'total'); bump(failures.resources, state.kind);
      bump(failures.kinds, failureKind(kind));
    }
    return true;
  }

  function sameDocument(value) {
    if (closed) return false;
    // Caller must distinguish History API/hash changes from a document commit.
    documentEvent('same-document', classifyBrowserDocumentTarget(value, secUid));
    return true;
  }

  function markStop() {
    if (closed || stopInitiated) return false;
    stopInitiated = true; phase = 'afterStop'; return true;
  }

  function beginCleanup() {
    if (closed || phase === 'cleanup') return false;
    markStop(); phase = 'cleanup'; return true;
  }

  function snapshot() {
    const pendingCounts = record(RESOURCE_KINDS);
    for (const state of pending.values()) pendingCounts[state.kind]++;
    return {
      version: 1, phase: closed ? 'closed' : phase, stopInitiated,
      limits: { maxRequests, countLimit, maxStatusCodes },
      trackedRequests: pending.size, discarded: { ...discarded },
      documents: { ...documents, relations: { ...documents.relations }, targets: { ...documents.targets } },
      resources: Object.fromEntries(RESOURCE_KINDS.map(kind => {
        const resource = resources[kind];
        return [kind, {
          requested: resource.requested, finished: resource.finished, failed: resource.failed,
          pending: pendingCounts[kind], unresolvedAtClose: resource.unresolvedAtClose,
          statusCounts: [...resource.statusCounts].sort(([a], [b]) => a - b)
            .map(([status, count]) => ({ status, count })),
          statusOverflow: resource.statusOverflow, invalidStatus: resource.invalidStatus,
        }];
      })),
      failuresByPhase: Object.fromEntries(PHASES.map(key => [key, {
        total: failuresByPhase[key].total,
        resources: { ...failuresByPhase[key].resources }, kinds: { ...failuresByPhase[key].kinds },
      }])),
    };
  }

  function close() {
    if (!closed) {
      for (const state of pending.values()) bump(resources[state.kind], 'unresolvedAtClose');
      pending.clear(); lastDocument = null; seen = new WeakSet(); secUid = null; closed = true;
    }
    return snapshot();
  }

  return Object.freeze({ request, response, finished: value => terminal(value, false),
    failed: (value, kind) => terminal(value, true, kind), sameDocument, markStop,
    beginCleanup, snapshot, close });
}
