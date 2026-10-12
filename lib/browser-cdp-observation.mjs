import { classifyBrowserDocumentTarget } from './browser-resource-observation.mjs';
import { isExpectedDouyinWorksResponseUrl } from './douyin-browser-response-identity.mjs';
import { browserWorksCursor } from './browser-works-pagination.mjs';
import { isCdpAuthorPostsEndpointUrl, sanitizeCdpEndpointCounts } from './browser-cdp-endpoint-observation.mjs';

const PHASES = ['beforeStop', 'afterStop', 'cleanup'];
const SCOPES = ['current-document', 'prior-document', 'unbound'];
const KINDS = ['document', 'script', 'stylesheet', 'xhr', 'fetch', 'image', 'font', 'other'];
const BLOCKS = ['other', 'csp', 'mixed-content', 'origin', 'inspector', 'integrity', 'subresource-filter',
  'content-type', 'coep-frame-resource-needs-coep-header', 'coop-sandboxed-iframe-cannot-navigate-to-coop-page',
  'corp-not-same-origin', 'corp-not-same-origin-after-defaulted-to-same-origin-by-coep',
  'corp-not-same-origin-after-defaulted-to-same-origin-by-dip',
  'corp-not-same-origin-after-defaulted-to-same-origin-by-coep-and-dip',
  'corp-not-same-site', 'sri-message-signature-mismatch', 'unknown'];
const record = keys => Object.fromEntries(keys.map(key => [key, 0]));
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null;
const safeCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
const RESOURCE_TYPES = new Map([['Document', 'document'], ['Script', 'script'], ['Stylesheet', 'stylesheet'],
  ['XHR', 'xhr'], ['Fetch', 'fetch'], ['Image', 'image'], ['Font', 'font']]);
const kind = value => RESOURCE_TYPES.get(value) || 'other';
const target = (url, secUid) => classifyBrowserDocumentTarget(url, secUid) === 'same-profile';

/** Fixed whitelist projection. No identifier, raw URL, error or protocol object escapes. */
export function sanitizeCdpObservation(value) {
  try {
    if (!value || value.version !== 1 || Array.isArray(value)) return null;
    const counts = (source, keys) => Object.fromEntries(keys.map(key => [key, safeCount(source?.[key])]));
    return { version: 1, attribution: 'cdp-session-not-playwright-works-evidence',
      phase: [...PHASES, 'closed'].includes(value.phase) ? value.phase : 'unknown',
      state: ['observing', 'unavailable', 'capacity-stopped', 'closed'].includes(value.state) ? value.state : 'unavailable',
      captureBoundary: ['attempt-return', 'page-close-return', 'page-close-timeout'].includes(value.captureBoundary)
        ? value.captureBoundary : 'unknown',
      currentDocumentVerified: typeof value.currentDocumentVerified === 'boolean' ? value.currentDocumentVerified : null,
      ...counts(value, ['requested', 'finished', 'failed', 'invalid', 'untracked', 'duplicates', 'capacity', 'documentsVerified']),
      retainedIdentifiers: safeCount(value.retainedIdentifiers),
      failuresByPhase: Object.fromEntries(PHASES.map(phase => [phase, {
        scopes: counts(value.failuresByPhase?.[phase]?.scopes, SCOPES),
        resources: counts(value.failuresByPhase?.[phase]?.resources, KINDS),
        blockedReasons: counts(value.failuresByPhase?.[phase]?.blockedReasons, BLOCKS),
        canceled: counts(value.failuresByPhase?.[phase]?.canceled, ['yes', 'no', 'unknown']),
        authorPosts: counts(value.failuresByPhase?.[phase]?.authorPosts, SCOPES),
        ...(() => { try { const endpoint = sanitizeCdpEndpointCounts(value.failuresByPhase?.[phase]?.authorPostsEndpoint);
          return endpoint ? { authorPostsEndpoint: endpoint } : {}; } catch { return {}; } })(),
        ...(value.failuresByPhase?.[phase]?.authorPostsBlockedReasons ? {
          authorPostsBlockedReasons: Object.fromEntries(SCOPES.map(scope => [scope,
            counts(value.failuresByPhase[phase].authorPostsBlockedReasons[scope], BLOCKS)])),
        } : {}),
      }])) };
  } catch { return null; }
}

/** Pure, private session reducer. Inputs are transient CDP events, never copied wholesale. */
export function createCdpObservation({ mainFrameId, secUid, maxIdentifiers = 256 } = {}) {
  const root = id(mainFrameId);
  const cap = Number.isSafeInteger(maxIdentifiers) && maxIdentifiers > 0 ? Math.min(maxIdentifiers, 256) : 256;
  let phase = 'beforeStop', state = root ? 'observing' : 'unavailable', closed = false;
  let current = null, frame = root, identity = secUid;
  const pending = new Map(), docs = new Map(), tombstones = new Set();
  const values = record(['requested', 'finished', 'failed', 'invalid', 'untracked', 'duplicates', 'capacity', 'documentsVerified']);
  const failures = Object.fromEntries(PHASES.map(p => [p, { scopes: record(SCOPES), resources: record(KINDS),
    blockedReasons: record(BLOCKS), canceled: record(['yes', 'no', 'unknown']), authorPosts: record(SCOPES),
    authorPostsEndpoint: record(SCOPES),
    authorPostsBlockedReasons: Object.fromEntries(SCOPES.map(scope => [scope, record(BLOCKS)])) }]));
  const bump = (object, key) => { object[key] = Math.min(1_000_000, object[key] + 1); };
  const retained = () => pending.size + docs.size + tombstones.size;
  const verified = doc => !!doc && doc.eligible && doc.committed && doc.status >= 200 && doc.status < 300;
  const ready = () => state === 'observing' && verified(current);
  const stopCapacity = () => { bump(values, 'capacity'); state = 'capacity-stopped'; pending.clear(); docs.clear(); tombstones.clear(); current = null; };
  const available = () => !closed && state === 'observing';
  const invalid = () => { bump(values, 'invalid'); return false; };
  const scope = item => verified(item.doc) ? (item.doc === current && ready() ? 'current-document' : 'prior-document') : 'unbound';
  const update = doc => { if (verified(doc) && !doc.counted) { doc.counted = true; bump(values, 'documentsVerified'); } };

  function request(event) {
    if (!available()) return false;
    try {
      const requestId = id(event?.requestId);
      if (!requestId) return invalid();
      if (tombstones.has(requestId)) { bump(values, 'duplicates'); return false; }
      const old = pending.get(requestId);
      if (old) {
        // Redirects reuse IDs. Retire all prior binding; never guess a hop by URL/time.
        if (event.redirectResponse) { old.doc = null; old.authorPosts = false; old.authorPostsEndpoint = false; old.redirected = true;
          if (old.kind === 'document') current = null;
        } else bump(values, 'duplicates');
        return false;
      }
      if (retained() >= cap) { stopCapacity(); return false; }
      const frameId = id(event.frameId), loaderId = id(event.loaderId), resource = kind(event.type);
      const entry = { kind: resource, doc: null, authorPosts: false, authorPostsEndpoint: false, redirected: false };
      if (resource === 'document' && frameId === frame) {
        current = null;
        if (loaderId && !docs.has(loaderId) && !event.redirectResponse) {
          if (retained() + 2 > cap) { stopCapacity(); return false; }
          const doc = { loaderId, frameId, eligible: event.request?.method === 'GET' && target(event.request?.url, identity),
            committed: false, status: null, counted: false };
          docs.set(loaderId, doc); current = doc; entry.doc = doc;
        }
      } else if (frameId === frame && loaderId) entry.doc = docs.get(loaderId) || null;
      if (resource !== 'document' && frameId === frame && loaderId && entry.doc && !event.redirectResponse) {
        const request = event.request;
        entry.authorPosts = request?.method === 'GET' && typeof request.url === 'string' && request.url.length <= 4_096
          && isExpectedDouyinWorksResponseUrl(request.url, identity)
          && browserWorksCursor(request.url, identity) !== null;
      }
      // Origin/path-only diagnostic; does not change strict authorPosts or request admission.
      try { entry.authorPostsEndpoint = resource !== 'document' && !event.redirectResponse
        && isCdpAuthorPostsEndpointUrl(event.request?.url); } catch { /* Optional URL metadata only. */ }
      pending.set(requestId, entry); bump(values, 'requested'); return true;
    } catch { return invalid(); }
  }

  function response(event) {
    if (!available()) return false;
    try {
      const requestId = id(event?.requestId), item = requestId && pending.get(requestId);
      if (!item) { bump(values, 'untracked'); return false; }
      if (item.kind !== 'document' || !item.doc || item.redirected) return false;
      const doc = item.doc;
      if (id(event.frameId) !== doc.frameId || id(event.loaderId) !== doc.loaderId || event.type !== 'Document') return false;
      const status = event.response?.status;
      if (!Number.isInteger(status) || status < 100 || status > 599 || !target(event.response?.url, identity)) {
        doc.eligible = false; return false;
      }
      if (doc.status !== null) { doc.eligible = false; return false; }
      doc.status = status; update(doc); return true;
    } catch { return invalid(); }
  }

  function commit(event) {
    if (!available()) return false;
    try {
      const value = event?.frame;
      if (id(value?.id) !== frame || value.parentId) return false;
      const doc = docs.get(id(value.loaderId));
      if (!doc || doc !== current || !target(value.url, identity)) { current = null; return false; }
      doc.committed = true; update(doc); return true;
    } catch { current = null; return invalid(); }
  }

  function sameDocument(event) {
    if (!available()) return false;
    try {
      if (id(event?.frameId) !== frame) return false;
      // Same-document identity remains only while the exact public profile remains.
      if (!target(event.url, identity)) current = null;
      return true;
    } catch { current = null; return invalid(); }
  }

  function terminal(event, failed) {
    if (!available()) return false;
    try {
      const requestId = id(event?.requestId), entry = requestId && pending.get(requestId);
      if (!entry) { bump(values, requestId && tombstones.has(requestId) ? 'duplicates' : 'untracked'); return false; }
      pending.delete(requestId); tombstones.add(requestId);
      bump(values, failed ? 'failed' : 'finished');
      if (failed) {
        const bucket = failures[phase], relation = entry.redirected ? 'unbound' : scope(entry);
        bump(bucket.scopes, relation); bump(bucket.resources, entry.kind);
        let blockedReason, canceled;
        try { blockedReason = event.blockedReason; } catch { /* Unknown fixed metadata only. */ }
        try { canceled = event.canceled; } catch { /* Missing is not false. */ }
        const reason = BLOCKS.includes(blockedReason) ? blockedReason : 'unknown';
        bump(bucket.blockedReasons, reason);
        bump(bucket.canceled, canceled === true ? 'yes' : canceled === false ? 'no' : 'unknown');
        if (entry.authorPostsEndpoint) bump(bucket.authorPostsEndpoint, relation);
        if (entry.authorPosts) {
          bump(bucket.authorPosts, relation);
          bump(bucket.authorPostsBlockedReasons[relation], reason);
        }
        if (entry.kind === 'document' && entry.doc) entry.doc.eligible = false;
      }
      return true;
    } catch { return invalid(); }
  }

  function snapshot(captureBoundary = 'attempt-return') {
    const observedFailures = Object.fromEntries(PHASES.map(phase => {
      const { authorPostsBlockedReasons, ...bucket } = failures[phase];
      // Avoid serializing large all-zero matrices into the bounded IPC output.
      // Their absence means no author-post failure was recorded in this phase.
      return [phase, SCOPES.some(scope => bucket.authorPosts[scope] > 0)
        ? { ...bucket, authorPostsBlockedReasons } : bucket];
    }));
    return sanitizeCdpObservation({ version: 1, phase: closed ? 'closed' : phase, state,
      captureBoundary, currentDocumentVerified: ready(), ...values, retainedIdentifiers: retained(), failuresByPhase: observedFailures });
  }
  function close(captureBoundary) {
    closed = true; state = 'closed'; frame = null; identity = null; current = null;
    pending.clear(); docs.clear(); tombstones.clear(); return snapshot(captureBoundary);
  }
  return Object.freeze({ request, response, commit, sameDocument,
    finished: event => terminal(event, false), failed: event => terminal(event, true), snapshot, close,
    markStop: () => { if (!closed && phase === 'beforeStop') phase = 'afterStop'; },
    beginCleanup: () => { if (!closed) phase = 'cleanup'; } });
}
