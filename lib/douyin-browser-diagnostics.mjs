import { sanitizeBrowserRenderDiagnostics } from "./browser-render-diagnostics.mjs";
import { sanitizeFirstPageActivationStructure } from "./browser-first-page-activation.mjs";
import { sanitizeCdpObservation } from "./browser-cdp-observation.mjs";
import { sanitizeTerminalObservation } from "./douyin-terminal-structure.mjs";

const STOP_REASONS = new Set(["success", "navigation-timeout", "navigation-failed", "no-bound-request", "http-rejection", "body-timeout", "invalid-body", "deadline", "collector-exception", "unknown"]);
const PAGE_KINDS = new Set(["profile", "login", "other", "unknown"]);
const REJECTIONS = ["nonMainFrame", "frameUnavailable", "beforeCommit", "accountIdentity", "firstCursor", "method", "capacity"];
const RUNTIME_ERROR_KINDS = new Set(["type-error", "reference-error", "syntax-error", "range-error", "timeout", "error", "unknown"]);
const ERROR_NAMES = new Map([["TypeError", "type-error"], ["ReferenceError", "reference-error"], ["SyntaxError", "syntax-error"],
  ["RangeError", "range-error"], ["TimeoutError", "timeout"], ["Error", "error"]]);
const SCREEN_OBSERVATIONS = new Set(["observed", "unavailable", "timeout"]);
const READY_STATES = new Set(["loading", "interactive", "complete"]);
const ACTIVATION_STATES = new Set(["not-eligible", "no-container", "blocked", "attempted", "timeout", "unavailable"]);
const FIRST_REQUEST_STATES = new Set(["not-eligible", "issued", "blocked", "timeout", "unavailable"]);
const CONTINUATION_BRANCHES = new Set(["not-started", "render-wait", "render-wait-exhausted", "blocked", "projection-held",
  "gate-wait", "gate-wait-exhausted",
  "explicit-request", "hover-changed", "scroll-issued", "progress", "no-progress", "scroll-timeout", "scroll-error"]);
const SCREEN_SOURCES = new Set(["none", "commit", "domcontentloaded", "navigation-return", "readiness-recheck"]);
const RESOURCE_KINDS = ["document", "script", "stylesheet", "xhr", "fetch", "image", "font", "other"];
const DOCUMENT_RELATIONS = ["initial", "linked-http-redirect", "new-document", "same-document", "unknown"];
const DOCUMENT_TARGETS = ["same-profile", "other-profile", "login", "verification", "other-official", "other-origin", "invalid", "unknown"];
const RESOURCE_FAILURE_KINDS = ["aborted", "dns", "timeout", "connection", "tls", "blocked-client", "other", "unknown"];
const RESOURCE_PHASES = ["beforeStop", "afterStop", "cleanup"];
// Exact Chromium transport codes only. Never export, trim or retain errorText.
// Category describes an observed failure, not its cause or recoverability.
const RESOURCE_ERROR_CODES = new Map([
  ["net::ERR_ABORTED", "aborted"],
  ["net::ERR_NAME_NOT_RESOLVED", "dns"],
  ["net::ERR_DNS_TIMED_OUT", "dns"],
  ["net::ERR_TIMED_OUT", "timeout"],
  ["net::ERR_CONNECTION_TIMED_OUT", "timeout"],
  ["net::ERR_CONNECTION_CLOSED", "connection"],
  ["net::ERR_CONNECTION_RESET", "connection"],
  ["net::ERR_CONNECTION_REFUSED", "connection"],
  ["net::ERR_CONNECTION_ABORTED", "connection"],
  ["net::ERR_CONNECTION_FAILED", "connection"],
  ["net::ERR_INTERNET_DISCONNECTED", "connection"],
  ["net::ERR_NETWORK_CHANGED", "connection"],
  ["net::ERR_ADDRESS_UNREACHABLE", "connection"],
  ["net::ERR_SSL_PROTOCOL_ERROR", "tls"],
  ["net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH", "tls"],
  ["net::ERR_CERT_COMMON_NAME_INVALID", "tls"],
  ["net::ERR_CERT_DATE_INVALID", "tls"],
  ["net::ERR_CERT_AUTHORITY_INVALID", "tls"],
  ["net::ERR_CERT_REVOKED", "tls"],
  ["net::ERR_CERT_INVALID", "tls"],
  ["net::ERR_BLOCKED_BY_CLIENT", "blocked-client"],
]);
export function browserResourceFailureKind(errorText) {
  return typeof errorText === "string" && errorText.length <= 64
    ? RESOURCE_ERROR_CODES.get(errorText) ?? "unknown" : "unknown";
}
/** Read the fixed name only: messages, stacks, URLs and transport text stay private. */
export function browserRuntimeErrorKind(error) {
  try { return ERROR_NAMES.get(error?.name) ?? "unknown"; } catch { return "unknown"; }
}
const count = (value, max = 1_000_000) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const bool = (value) => typeof value === "boolean" ? value : null;
const statuses = (value, min, max) => Array.isArray(value)
  ? [...new Set(value.slice(0, 100).filter((item) => Number.isSafeInteger(item) && item >= min && item <= max))].slice(0, 10) : [];

/** Reconstruct at both child and parent boundaries; never spread input records. */
export function sanitizeBrowserResourceObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  const counts = (source, keys, maximum = 1_000_000) => Object.fromEntries(keys.map(key => [key, count(source?.[key], maximum)]));
  const positive = (item, maximum) => Number.isSafeInteger(item) && item > 0 && item <= maximum ? item : null;
  const documents = value.documents || {};
  return {
    version: 1,
    captureBoundary: ["attempt-return", "page-close-return", "page-close-timeout"].includes(value.captureBoundary) ? value.captureBoundary : "unknown",
    phase: [...RESOURCE_PHASES, "closed"].includes(value.phase) ? value.phase : "unknown",
    stopInitiated: bool(value.stopInitiated),
    limits: { maxRequests: positive(value.limits?.maxRequests, 1_024), countLimit: positive(value.limits?.countLimit, 1_000_000),
      maxStatusCodes: positive(value.limits?.maxStatusCodes, 32) },
    trackedRequests: count(value.trackedRequests, 1_024),
    discarded: counts(value.discarded, ["capacity", "invalid", "untrackedEvents"]),
    documents: {
      lastRelation: DOCUMENT_RELATIONS.includes(documents.lastRelation) ? documents.lastRelation : "unknown",
      lastTarget: DOCUMENT_TARGETS.includes(documents.lastTarget) ? documents.lastTarget : "unknown",
      lastStatus: Number.isInteger(documents.lastStatus) && documents.lastStatus >= 100 && documents.lastStatus <= 599 ? documents.lastStatus : null,
      relations: counts(documents.relations, DOCUMENT_RELATIONS), targets: counts(documents.targets, DOCUMENT_TARGETS),
    },
    resources: Object.fromEntries(RESOURCE_KINDS.map(kind => {
      const source = value.resources?.[kind] || {}, seenStatuses = new Set();
      const statusCounts = Array.isArray(source.statusCounts) ? source.statusCounts.slice(0, 32).flatMap(item => {
        const status = item?.status, amount = count(item?.count);
        if (!Number.isInteger(status) || status < 100 || status > 599 || amount === null || seenStatuses.has(status)) return [];
        seenStatuses.add(status); return [{ status, count: amount }];
      }) : [];
      return [kind, { ...counts(source, ["requested", "finished", "failed", "unresolvedAtClose", "statusOverflow", "invalidStatus"]),
        pending: count(source.pending, 1_024), statusCounts }];
    })),
    failuresByPhase: Object.fromEntries(RESOURCE_PHASES.map(phase => {
      const source = value.failuresByPhase?.[phase] || {};
      return [phase, { total: count(source.total), resources: counts(source.resources, RESOURCE_KINDS),
        kinds: counts(source.kinds, RESOURCE_FAILURE_KINDS) }];
    })),
  };
}

/** No raw strings, URLs, identifiers, exception messages or payloads cross this boundary. */
export function sanitizeBrowserWorksDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return null;
  const nav = value.navigation || {};
  const requests = value.requests || {};
  const responses = value.responses || {};
  const runtime = value.runtime || {};
  const screen = value.firstScreen;
  const render = sanitizeBrowserRenderDiagnostics(screen?.render);
  const activationStructure = sanitizeFirstPageActivationStructure(value.firstPageActivation?.structure);
  const continuation = value.continuationActivation && typeof value.continuationActivation === "object"
    && !Array.isArray(value.continuationActivation) && value.continuationActivation.version === 1 ? value.continuationActivation : null;
  const continuationStructure = sanitizeFirstPageActivationStructure(continuation?.structure);
  const resourceObservation = sanitizeBrowserResourceObservation(value.resourceObservation);
  const cdpObservation = sanitizeCdpObservation(value.cdpObservation);
  const terminalStructure = sanitizeTerminalObservation(value.terminalStructure);
  const lifecycle = value.lifecycle && typeof value.lifecycle === "object" && !Array.isArray(value.lifecycle)
    && value.lifecycle.version === 1 ? value.lifecycle : null;
  return {
    version: 1,
    ...(resourceObservation ? { resourceObservation } : {}),
    ...(cdpObservation ? { cdpObservation } : {}),
    ...(terminalStructure ? { terminalStructure } : {}),
    ...(lifecycle ? { lifecycle: {
      version: 1, eventAttribution: "listener-window-not-document-identity",
      generation: count(lifecycle.generation),
      domContentLoadedCount: count(lifecycle.domContentLoadedCount), loadCount: count(lifecycle.loadCount),
      firstDomContentLoadedElapsedMs: count(lifecycle.firstDomContentLoadedElapsedMs, 900_000),
      lastDomContentLoadedElapsedMs: count(lifecycle.lastDomContentLoadedElapsedMs, 900_000),
      firstLoadElapsedMs: count(lifecycle.firstLoadElapsedMs, 900_000),
      lastLoadElapsedMs: count(lifecycle.lastLoadElapsedMs, 900_000),
      firstScreenAttemptCount: count(lifecycle.firstScreenAttemptCount, 2),
      lastAcceptedFirstScreenAttempt: count(lifecycle.lastAcceptedFirstScreenAttempt, 2),
      lastAcceptedFirstScreenSource: SCREEN_SOURCES.has(lifecycle.lastAcceptedFirstScreenSource)
        ? lifecycle.lastAcceptedFirstScreenSource : "unknown",
    } } : {}),
    ...(value.firstPageActivation && typeof value.firstPageActivation === "object" ? { firstPageActivation: {
      state: ACTIVATION_STATES.has(value.firstPageActivation.state) ? value.firstPageActivation.state : "unavailable",
      attemptCount: count(value.firstPageActivation.attemptCount, 1),
      ...(Object.hasOwn(value.firstPageActivation, "probeCount") ? { probeCount: count(value.firstPageActivation.probeCount, 9) } : {}),
      ...(Object.hasOwn(value.firstPageActivation, "actionCount") ? { actionCount: count(value.firstPageActivation.actionCount, 1) } : {}),
      ...(activationStructure ? { structure: activationStructure } : {}),
    } } : {}),
    ...(value.firstPageRequest && typeof value.firstPageRequest === "object" && !Array.isArray(value.firstPageRequest)
      && value.firstPageRequest.kind === "collector-same-origin-get" ? { firstPageRequest: {
        kind: "collector-same-origin-get", state: FIRST_REQUEST_STATES.has(value.firstPageRequest.state)
          ? value.firstPageRequest.state : "unavailable", attemptCount: count(value.firstPageRequest.attemptCount, 1),
      } } : {}),
    ...(continuation ? { continuationActivation: {
      version: 1, attribution: "continuation-structure-not-works-evidence",
      probeCount: count(continuation.probeCount, 64), renderRecheckCount: count(continuation.renderRecheckCount, 24),
      ...(Object.hasOwn(continuation, 'gateRecheckCount') ? { gateRecheckCount: count(continuation.gateRecheckCount, 24) } : {}),
      actionCount: count(continuation.actionCount, 8),
      lastBranch: CONTINUATION_BRANCHES.has(continuation.lastBranch) ? continuation.lastBranch : "projection-held",
      ...(continuationStructure ? { structure: continuationStructure } : {}),
    } } : {}),
    navigation: { observed: bool(nav.observed), committed: bool(nav.committed), failed: bool(nav.failed), timedOut: bool(nav.timedOut) },
    requests: { candidate: count(requests.candidate), matched: count(requests.matched),
      rejected: Object.fromEntries(REJECTIONS.map((key) => [key, count(requests.rejected?.[key])])) },
    responses: { matched: count(responses.matched), invalidBodies: count(responses.invalidBodies), bodyTimeouts: count(responses.bodyTimeouts) },
    runtime: { pageErrorCount: count(runtime.pageErrorCount),
      pageErrorKinds: Array.isArray(runtime.pageErrorKinds)
        ? [...new Set(runtime.pageErrorKinds.slice(0, 100).filter(kind => RUNTIME_ERROR_KINDS.has(kind)))].slice(0, 7) : [],
      boundRequestFailedCount: count(runtime.boundRequestFailedCount),
      navigationErrorKind: runtime.navigationErrorKind === "none" || RUNTIME_ERROR_KINDS.has(runtime.navigationErrorKind)
        ? runtime.navigationErrorKind : "unknown",
      ...(runtime.supersededNavigationError && typeof runtime.supersededNavigationError === "object"
        && !Array.isArray(runtime.supersededNavigationError) && runtime.supersededNavigationError.version === 1
        ? { supersededNavigationError: { version: 1,
          commandedGeneration: count(runtime.supersededNavigationError.commandedGeneration),
          generation: count(runtime.supersededNavigationError.generation),
          errorKind: runtime.supersededNavigationError.errorKind === "error" ? "error" : "unknown",
          attribution: "goto-command-not-current-document" } } : {}),
    },
    ...(screen && typeof screen === "object" && !Array.isArray(screen) ? { firstScreen: {
      observation: SCREEN_OBSERVATIONS.has(screen.observation) ? screen.observation : "unavailable",
      readyState: READY_STATES.has(screen.readyState) ? screen.readyState : "unknown",
      bodyPresent: bool(screen.bodyPresent), bodyChildCount: count(screen.bodyChildCount),
      scriptCount: count(screen.scriptCount), jsonScriptCount: count(screen.jsonScriptCount),
      renderDataPresent: bool(screen.renderDataPresent), nextDataPresent: bool(screen.nextDataPresent),
      worksAnchorCount: count(screen.worksAnchorCount),
      ...(render ? { render } : {}),
    } } : {}),
    httpStatuses: statuses(value.httpStatuses, 100, 599),
    businessStatusCodes: statuses(value.businessStatusCodes, 0, Number.MAX_SAFE_INTEGER),
    finalPageKind: PAGE_KINDS.has(value.finalPageKind) ? value.finalPageKind : "unknown",
    elapsedMs: count(value.elapsedMs, 900_000),
    stopReason: STOP_REASONS.has(value.stopReason) ? value.stopReason : "unknown",
  };
}

/** Resource creation/read-state exceptions have no observed navigation evidence. */
export function unknownBrowserWorksDiagnostics(stopReason = "collector-exception") {
  return sanitizeBrowserWorksDiagnostics({ version: 1, stopReason });
}
