import { isExpectedDouyinWorksResponseUrl } from "./douyin-browser-response-identity.mjs";

const STOP_REASONS = new Set(["end-of-list", "item-limit", "page-limit", "unknown-pagination", "cursor-not-progressing",
  "filtered-rows", "no-progress", "page-timeout", "deadline", "cancelled", "navigation-changed", "http-rejection",
  "login-required", "verification-required", "invalid-body", "request-failed", "scroll-unavailable", "scroll-failed"]);
const ERROR_CODES = new Set(["login_required", "blocked", "rate_limited", "network_error", "collector_error", "upstream_changed"]);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const more = value => value === true || value === 1 || value === "1" ? true
  : value === false || value === 0 || value === "0" ? false : null;

/** Reuse the existing origin/account contract; never expose signed URLs. */
export function browserWorksCursor(value, secUid) {
  if (!isExpectedDouyinWorksResponseUrl(value, secUid)) return null;
  const values = new URL(value).searchParams.getAll("max_cursor");
  if (values.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(values[0])) return null;
  return integer(Number(values[0]));
}

export function sanitizeBrowserWorksPagination(value) {
  if (!value || ![1, 2, 3].includes(value.version) || !Array.isArray(value.pages) || value.pages.length > 3) return null;
  if (value.version === 3 && (integer(value.startCursor) === null || ![1, 2].includes(value.baseVersion))) return null;
  const policyVersion = value.version === 3 ? value.baseVersion : value.version;
  if (policyVersion === 1 && (value.requestThreshold !== undefined || value.hardItemLimit !== undefined)) return null;
  if (policyVersion === 2 && (!Number.isSafeInteger(value.requestThreshold) || value.requestThreshold < 1
    || !Number.isSafeInteger(value.hardItemLimit) || value.hardItemLimit < value.requestThreshold || value.hardItemLimit > 100)) return null;
  return {
    version: value.version, ...(value.version === 3 ? { startCursor: value.startCursor, baseVersion: value.baseVersion } : {}),
    ...(policyVersion === 2 ? {requestThreshold: value.requestThreshold, hardItemLimit: value.hardItemLimit} : {}),
    maxPages: [1, 2, 3].includes(value.maxPages) ? value.maxPages : null,
    requestCount: integer(value.requestCount), collectedCount: integer(value.collectedCount),
    stopReason: STOP_REASONS.has(value.stopReason) ? value.stopReason : "unknown-pagination",
    errorCode: ERROR_CODES.has(value.errorCode) ? value.errorCode : null,
    pages: value.pages.map(page => ({
      requestCursor: integer(page?.requestCursor),
      response: { max_cursor: integer(page?.response?.max_cursor),
        has_more: typeof page?.response?.has_more === "boolean" ? page.response.has_more : null },
      rawCount: integer(page?.rawCount), acceptedCount: integer(page?.acceptedCount),
      duplicateCount: integer(page?.duplicateCount), filteredCount: integer(page?.filteredCount),
      truncated: typeof page?.truncated === "boolean" ? page.truncated : null,
      observedAt: typeof page?.observedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(page.observedAt)
        && Number.isFinite(Date.parse(page.observedAt)) && new Date(page.observedAt).toISOString() === page.observedAt ? page.observedAt : null,
    })),
  };
}

/** A bounded, current-navigation ledger. No cache, browser or network access. */
export class BrowserWorksPagination {
  constructor({ limit = 30, maxPages = 3, requestThreshold, startCursor } = {}) {
    if (startCursor !== undefined && integer(startCursor) === null) throw new Error('Invalid continuation cursor');
    this.startCursor = startCursor;
    if (requestThreshold !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      throw new Error('Invalid explicit browser hard limit');
    this.limit = Math.max(1, Math.min(100, integer(limit) ?? 30));
    if (requestThreshold !== undefined && (!Number.isSafeInteger(requestThreshold) || requestThreshold < 1 || requestThreshold > this.limit))
      throw new Error('Invalid explicit browser request threshold');
    this.requestThreshold = requestThreshold;
    this.maxPages = Math.max(1, Math.min(3, integer(maxPages) ?? 3));
    this.posts = []; this.pages = []; this.ids = new Set(); this.cursors = new Set();
    this.expectedCursor = startCursor ?? 0; this.hasMore = null; this.maxCursor = null;
    this.stopReason = null; this.errorCode = null; this.pristine = true;
  }
  stop(reason, errorCode = null) {
    this.stopReason = STOP_REASONS.has(reason) ? reason : "unknown-pagination";
    this.errorCode = ERROR_CODES.has(errorCode) ? errorCode : null;
  }
  accept({ requestCursor, body, normalized, observedAt }) {
    if (this.stopReason || requestCursor !== this.expectedCursor || this.cursors.has(requestCursor)) return false;
    const rawCount = body.aweme_list.length;
    const oldCount = this.posts.length;
    const discarded = normalized.filteredCount > 0 || normalized.duplicateCount > 0 || normalized.locallyTruncated;
    let duplicateCount = normalized.duplicateCount;
    let truncated = normalized.locallyTruncated;
    for (const post of normalized.posts) {
      if (this.ids.has(post.aweme_id)) { this.pristine = false; duplicateCount += 1; continue; }
      if (this.posts.length >= this.limit) { this.pristine = false; truncated = true; continue; }
      this.ids.add(post.aweme_id); this.posts.push(post);
    }
    this.pristine &&= !discarded;
    this.cursors.add(requestCursor);
    this.hasMore = more(body.has_more); this.maxCursor = normalized.maxCursor;
    this.pages.push({ requestCursor, response: { max_cursor: this.maxCursor, has_more: this.hasMore },
      rawCount, acceptedCount: this.posts.length - oldCount, duplicateCount,
      filteredCount: normalized.filteredCount, truncated, observedAt });
    if (this.hasMore === false) this.stop(this.pristine ? "end-of-list" : "filtered-rows");
    else if (this.posts.length >= (this.requestThreshold ?? this.limit)) this.stop("item-limit");
    else if (discarded) this.stop("filtered-rows");
    else if (this.hasMore === null) this.stop("unknown-pagination");
    else if (this.maxCursor === null || this.cursors.has(this.maxCursor)) this.stop("cursor-not-progressing");
    // An explicitly successful raw empty page may still advance the server's
    // cursor. Keep its page evidence and spend only the existing page budget;
    // a nonempty duplicate-only page remains a no-progress stop.
    else if (this.posts.length === oldCount && rawCount > 0) this.stop("no-progress");
    else if (this.pages.length >= this.maxPages) this.stop("page-limit");
    else this.expectedCursor = this.maxCursor;
    return true;
  }
  result(requestCount) {
    return {
      posts: this.posts, hasMore: this.hasMore, maxCursor: this.maxCursor,
      coverage: this.startCursor === undefined && this.stopReason === "end-of-list" && this.pristine ? "complete" : "latest-public-window",
      pagination: sanitizeBrowserWorksPagination({ version: this.startCursor === undefined ? (this.requestThreshold === undefined ? 1 : 2) : 3,
        ...(this.startCursor === undefined ? {} : {startCursor: this.startCursor, baseVersion: this.requestThreshold === undefined ? 1 : 2}),
        ...(this.requestThreshold === undefined ? {} : {requestThreshold: this.requestThreshold, hardItemLimit: this.limit}), maxPages: this.maxPages,
        requestCount, collectedCount: this.posts.length, stopReason: this.stopReason,
        errorCode: this.errorCode, pages: this.pages }),
    };
  }
}
