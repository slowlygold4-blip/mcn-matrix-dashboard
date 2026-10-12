const ERROR_CODES = new Set(["blocked", "rate_limited", "login_required", "network_error", "business_error", "upstream_changed", "collector_error", "unknown", "deferred"]);
const TRANSIENT_ERROR_CODES = new Set(["network_error", "collector_error"]);
const TRANSIENT_COOLDOWN_MS = 60_000;
export const WORKS_ENDPOINT = "douyin.author_posts";
export function worksErrorCode(value) {
  return ERROR_CODES.has(value) ? value : "unknown";
}

export function projectWorksRequestPolicy(value) {
  if (value?.version !== 1 || value.endpoint !== WORKS_ENDPOINT || value.scope !== "endpoint-transport") return null;
  const result = { version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport" };
  for (const [key, transport] of [["anonymous", "anonymous-http"], ["browser", "authorised-browser"]]) {
    const lane = value[key];
    if (!lane || lane.transport !== transport || typeof lane.attempted !== "boolean" || typeof lane.deferred !== "boolean"
      || (lane.attempted && lane.deferred) || (lane.errorCode !== null && !ERROR_CODES.has(lane.errorCode))) continue;
    let nextEligibleAt = null;
    if (typeof lane.nextEligibleAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lane.nextEligibleAt)) {
      const timestamp = Date.parse(lane.nextEligibleAt);
      if (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === lane.nextEligibleAt) nextEligibleAt = lane.nextEligibleAt;
    }
    result[key] = { transport, attempted: lane.attempted, deferred: lane.deferred, errorCode: lane.errorCode,
      cooldownErrorCode: ERROR_CODES.has(lane.cooldownErrorCode) ? lane.cooldownErrorCode : null,
      nextEligibleAt, reason: ["upstream-error", "transport-cooldown", "upstream-wait-exceeds-policy"].includes(lane.reason) ? lane.reason : null,
      retryAfterStatus: ["valid", "invalid", "absent", "too-long"].includes(lane.retryAfterStatus) ? lane.retryAfterStatus : null };
  }
  return result.anonymous || result.browser ? result : null;
}

// Run-local, transport-scoped backpressure, not a platform availability verdict.
// No timers, network, credentials or persisted account identifiers.
export class WorksRequestPolicy {
  constructor({ now = Date.now, cooldownMs = 15 * 60_000, windowMs = 5 * 60_000 } = {}) {
    this.now = now;
    this.cooldownMs = Math.max(60_000, Number(cooldownMs) || 15 * 60_000);
    this.windowMs = Math.max(60_000, Number(windowMs) || 5 * 60_000);
    this.lanes = new Map();
  }

  lane(transport) {
    if (!["anonymous-http", "authorised-browser"].includes(transport)) throw new Error("Unknown works transport");
    if (!this.lanes.has(transport)) this.lanes.set(transport, { failures: [], transientFailures: [], until: 0, code: null, hold: false });
    return this.lanes.get(transport);
  }

  decision(transport) {
    const lane = this.lane(transport);
    const deferred = lane.hold || lane.until > this.now();
    return { transport, attempted: false, deferred, errorCode: deferred ? lane.code : null,
      cooldownErrorCode: deferred ? lane.code : null,
      reason: deferred ? (lane.hold ? "upstream-wait-exceeds-policy" : "transport-cooldown") : null,
      retryAfterStatus: lane.hold ? "too-long" : null,
      nextEligibleAt: deferred && !lane.hold ? new Date(lane.until).toISOString() : null };
  }

  restore(policy) {
    policy = projectWorksRequestPolicy(policy);
    if (!policy) return;
    for (const [key, transport] of [["anonymous", "anonymous-http"], ["browser", "authorised-browser"]]) {
      const saved = policy[key];
      const code = saved?.cooldownErrorCode || saved?.errorCode;
      if (saved?.transport !== transport || !ERROR_CODES.has(code)) continue;
      if (saved.retryAfterStatus === "too-long") {
        Object.assign(this.lane(transport), { hold: true, code });
        continue;
      }
      if (typeof saved.nextEligibleAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(saved.nextEligibleAt)) continue;
      const until = Date.parse(saved.nextEligibleAt);
      if (!Number.isFinite(until) || until <= this.now() || new Date(until).toISOString() !== saved.nextEligibleAt) continue;
      const lane = this.lane(transport);
      if (until > lane.until) Object.assign(lane, { until, code });
    }
  }

  record(transport, { targetKey, errorCode = null, retryAfterSeconds = null, retryAfterStatus = null } = {}) {
    const lane = this.lane(transport);
    const now = this.now();
    const code = errorCode === null ? null : worksErrorCode(errorCode);
    lane.failures = lane.failures.filter((item) => now - item.at < this.windowMs);
    // Browser no-response/collector failures can otherwise spend ~30 seconds
    // on every account indefinitely. Require a consecutive, windowed pattern
    // across distinct targets before a short transport-only pause. This is a
    // load-shedding decision, never proof that those accounts have no works.
    if (!TRANSIENT_ERROR_CODES.has(code) || typeof targetKey !== "string" || !targetKey) {
      lane.transientFailures = [];
    } else {
      lane.transientFailures = lane.transientFailures.filter((item) => now - item.at >= 0 && now - item.at < this.windowMs);
      lane.transientFailures.push({ key: targetKey, at: now });
      lane.transientFailures = lane.transientFailures.slice(-32);
      if (new Set(lane.transientFailures.map((item) => item.key)).size >= 3) {
        const until = now + TRANSIENT_COOLDOWN_MS;
        // A local short wait cannot shorten or relabel a still-active longer
        // platform wait (or an unrepresentable Retry-After hold).
        if (!lane.hold && until > lane.until) Object.assign(lane, { until, code });
        lane.transientFailures = [];
      }
    }
    if (code === null) {
      lane.failures = [];
      // A request already in flight can succeed after another request was
      // told to wait. Success must not erase that still-valid server hint.
      if (!lane.hold && lane.until <= now) {
        lane.until = 0;
        lane.code = null;
      }
    } else if (code === "blocked") {
      // Repeated requests for the same private/unavailable account are not
      // proof of a shared transport failure. Require distinct target evidence.
      if (typeof targetKey === "string" && targetKey) lane.failures.push({ key: targetKey, at: now });
      lane.failures = lane.failures.slice(-32);
      if (new Set(lane.failures.map((item) => item.key)).size >= 3) {
        lane.until = Math.max(lane.until, now + this.cooldownMs);
        lane.code = code;
        lane.failures = [];
      }
    } else if (code === "rate_limited" || (code === "login_required" && transport === "authorised-browser")) {
      lane.until = Math.max(lane.until, now + this.cooldownMs);
      lane.code = code;
    }
    // Retry-After can accompany 503 as well as 429. Never shorten a valid
    // upstream wait. An unrepresentably long hint holds this provider run.
    if (code !== null && retryAfterStatus === "too-long") {
      lane.hold = true;
      lane.code = code;
    } else if (code !== null && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0) {
      const until = now + retryAfterSeconds * 1000;
      if (Number.isSafeInteger(until) && until <= 253402300799000) {
        lane.until = Math.max(lane.until, until);
        if (lane.until > now) lane.code = code;
      } else {
        lane.hold = true;
        lane.code = code;
      }
    }
    const next = this.decision(transport);
    return { ...next, attempted: true, deferred: false, errorCode: code,
      retryAfterStatus: next.retryAfterStatus || retryAfterStatus,
      reason: code ? "upstream-error" : null };
  }
}
