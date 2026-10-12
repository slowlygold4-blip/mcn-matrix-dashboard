import { sanitizeBrowserWorksPagination } from "./browser-works-pagination.mjs";

export const OFFICIAL_DOUYIN_PROFILE_ENDPOINT = "https://www.douyin.com/aweme/v1/web/user/profile/other/";

const DEFERRED_PROFILE_MODES = new Set([
  "guest-ttwid-unsigned-profile",
  "guest-ttwid-unsigned-profile-with-x-bogus-fallback",
]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Recognize the existing collector's profile-success / works-not-requested
 * envelope. This does NOT prove account identity, metrics, time or provenance
 * hashes: callers retain their own dual-ID, source, history and commit guards.
 * In particular, arbitrary profile-only modes and deleted-account envelopes
 * are not admitted. Legacy normal-works envelopes remain caller-owned.
 */
function isOfficialProfileOnlyEnvelope(raw) {
  if (!record(raw) || !record(raw.provenance) || !record(raw.profile?.user)) return false;
  const provenance = raw.provenance;
  if (!DEFERRED_PROFILE_MODES.has(provenance.profileMode)
    || provenance.mode !== provenance.profileMode
    || provenance.profileEndpoint !== OFFICIAL_DOUYIN_PROFILE_ENDPOINT
    || provenance.accountLocator !== "sec_uid"
    || provenance.cookiePersisted !== false || provenance.runtimeAI !== false || provenance.paidAPI !== false
    || (provenance.platform !== undefined && provenance.platform !== "douyin")
    || raw.accountStatus !== "validated" || raw.accountError !== null
    || (raw.status_code !== undefined && raw.status_code !== 0)
    || raw.profile.user.user_deleted === true
    || raw.source !== undefined || raw.roster !== undefined || raw.snapshot !== undefined) return false;

  // Current deferred envelopes omit profileResponse. If one is supplied, it
  // must not contradict the retained normalized profile or mask a challenge.
  if (raw.profileResponse !== undefined) {
    const response = raw.profileResponse;
    if (!record(response) || response.status_code !== 0
      || [response.need_login, response.login_required, response.captcha_required, response.verify_required].some(Boolean)) return false;
    const profiles = [response.user, response.user_info].filter(record);
    if (profiles.length !== 1 || profiles[0].sec_uid !== raw.profile.user.sec_uid
      || profiles[0].uid !== raw.profile.user.uid || profiles[0].user_deleted === true) return false;
  }
  return true;
}

export function isOfficialDeferredProfileEnvelope(raw) {
  return isOfficialProfileOnlyEnvelope(raw)
    && raw.worksCoverage === "unavailable" && raw.worksErrorCode === "deferred"
    && record(raw.works) && raw.works.stopReason === "request-deferred"
    && raw.works.aweme_list === undefined
    && record(raw.works.pagination) && raw.works.pagination.requestCount === 0
    && Array.isArray(raw.works.pagination.pages) && raw.works.pagination.pages.length === 0;
}

// New scheduling envelope, not a rewrite of old normal source. Anonymous works
// were actually attempted; only the browser fallback was put behind the profile
// roster. This recognizes the profile anchor, never complete works coverage.
export function isOfficialScheduledProfileEnvelope(raw) {
  const marker = raw?.worksFallbackDeferred, provenance = raw?.provenance;
  if (!record(marker) || marker.version !== 1 || marker.reason !== 'scheduled-profile-priority'
    || marker.mode !== 'works-only' || Object.keys(marker).length !== 3
    || [raw.need_login, raw.login_required, raw.captcha_required, raw.verify_required].some(Boolean)
    || !DEFERRED_PROFILE_MODES.has(provenance?.profileMode)
    || provenance.mode !== `${provenance.profileMode}-a-bogus-posts`
    || !isOfficialProfileOnlyEnvelope({ ...raw, provenance: { ...provenance, mode: provenance.profileMode } })
    || raw.worksCoverage !== 'unavailable'
    || !['blocked', 'rate_limited', 'login_required', 'network_error', 'business_error', 'upstream_changed', 'unknown'].includes(raw.worksErrorCode)
    || typeof raw.worksError !== 'string' || !raw.worksError
    || raw.worksFallbackErrorCode !== undefined || provenance.worksFallback !== undefined) return false;
  const policy = raw.worksRequestPolicy, anonymous = policy?.anonymous, browser = policy?.browser;
  if (policy?.version !== 1 || policy.endpoint !== 'douyin.author_posts' || policy.scope !== 'endpoint-transport'
    || anonymous?.transport !== 'anonymous-http' || anonymous.attempted !== true || anonymous.deferred !== false
    || anonymous.errorCode !== raw.worksErrorCode || browser?.transport !== 'authorised-browser'
    || browser.attempted !== false || browser.deferred !== false || browser.errorCode !== null
    || browser.nextEligibleAt !== null || browser.cooldownErrorCode !== null || browser.retryAfterStatus !== null) return false;
  const works = raw.works, pagination = works?.pagination;
  if (!record(works) || !Array.isArray(works.aweme_list) || !record(pagination)
    || pagination.evidenceScope !== 'sanitized-pagination-fields-not-full-response'
    || !Number.isSafeInteger(pagination.requestedLimit) || pagination.requestedLimit < 1 || pagination.requestedLimit > 100
    || pagination.collectedCount !== works.aweme_list.length || works.aweme_list.length > pagination.requestedLimit
    || !Number.isSafeInteger(pagination.requestCount) || pagination.requestCount < 1
    || !Array.isArray(pagination.pages) || pagination.pages.length !== pagination.requestCount
    || pagination.pages.some(page => !record(page) || page.endpoint !== 'https://www.douyin.com/aweme/v1/web/aweme/post/')) return false;
  return works.aweme_list.every(post => record(post) && typeof post.aweme_id === 'string' && /^\d{15,25}$/.test(post.aweme_id)
    && post.author?.sec_uid === raw.profile.user.sec_uid
    && (post.author.uid == null || post.author.uid === '' || String(post.author.uid) === raw.profile.user.uid));
}

const cursor = value => value === null || Number.isSafeInteger(value) && value >= 0;

// Browser evidence may come from a natural request or the explicitly labelled
// collector same-origin first GET. Both must pass the same original event-owner
// and projected page-chain checks at the provider/stored-envelope boundary.
export function validatedBrowserPagination(value, { limit, posts, hasMore, maxCursor, notBefore, notAfter, startCursor } = {}) {
  const clean = sanitizeBrowserWorksPagination(value);
  if (clean?.version === 3 ? startCursor !== clean.startCursor : startCursor !== undefined) return null;
  const policyVersion = clean?.version === 3 ? clean.baseVersion : clean?.version;
  if (!clean || ![1, 2, 3].includes(clean.maxPages) || !Array.isArray(posts)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || posts.length > limit
    || clean.pages.length < 1 || clean.pages.length > clean.maxPages
    || clean.requestCount === null || clean.requestCount < clean.pages.length || clean.requestCount > 32
    || clean.collectedCount !== posts.length || clean.stopReason !== value.stopReason
    || clean.errorCode !== value.errorCode) return null;
  if (policyVersion === 2 && clean.hardItemLimit !== limit) return null;
  let accepted = 0, previous = null;
  const cursors = new Set();
  for (const [index, page] of clean.pages.entries()) {
    if (policyVersion === 2 && index > 0 && accepted >= clean.requestThreshold) return null;
    const original = value.pages[index];
    if (original?.response?.max_cursor !== page.response.max_cursor || original?.response?.has_more !== page.response.has_more) return null;
    if (page.requestCursor === null || cursors.has(page.requestCursor)
      || page.requestCursor !== (previous ? previous.response.max_cursor : startCursor ?? 0)
      || (previous && previous.response.has_more !== true)
      || page.observedAt === null || (previous && page.observedAt < previous.observedAt)
      || (notBefore !== undefined && (!Number.isFinite(Date.parse(notBefore)) || Date.parse(page.observedAt) < Date.parse(notBefore)))
      || (notAfter !== undefined && (!Number.isFinite(Number(notAfter)) || Date.parse(page.observedAt) > Number(notAfter)))
      || [page.rawCount, page.acceptedCount, page.duplicateCount, page.filteredCount].some(v => v === null)
      || page.truncated === null) return null;
    const accounted = page.acceptedCount + page.duplicateCount + page.filteredCount;
    if (accounted > page.rawCount || (!page.truncated && accounted !== page.rawCount)) return null;
    accepted += page.acceptedCount;
    if (policyVersion === 2 && (accepted > limit || (page.truncated && accepted !== limit))) return null;
    cursors.add(page.requestCursor); previous = page;
  }
  if (accepted !== posts.length || hasMore !== previous.response.has_more || maxCursor !== previous.response.max_cursor) return null;
  const pristine = clean.pages.every(p => p.filteredCount === 0 && p.duplicateCount === 0 && !p.truncated);
  if (clean.stopReason === "end-of-list" && (!pristine || hasMore !== false || clean.errorCode !== null)) return null;
  if (policyVersion === 2 && clean.stopReason === 'item-limit' && accepted < clean.requestThreshold) return null;
  return clean;
}

/** New browser-only observation contract. Legacy envelopes keep their original
 * collection timestamp; never manufacture per-page times for old records. */
export function browserWorksObservation(raw, { reference } = {}) {
  const works = raw?.works;
  if (['observationVersion', 'observedAt', 'sourceRequestStartedAt', 'sourceRequestFinishedAt'].every(key => works?.[key] === undefined)) return null;
  const pagination = works?.pagination;
  const profile = raw?.profile?.user;
  const exactTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const startedAt = works.sourceRequestStartedAt, finishedAt = works.sourceRequestFinishedAt;
  if (!exactTime(startedAt) || !exactTime(finishedAt) || !Number.isFinite(Date.parse(raw.capturedAt))
    || Date.parse(raw.capturedAt) > Date.parse(startedAt) || startedAt > finishedAt
    || (reference !== undefined && (!Number.isFinite(reference) || Date.parse(finishedAt) > reference))) throw new Error('浏览器作品请求时间边界无效');
  const clean = works?.observationVersion === 1 && pagination?.evidenceScope === 'browser-response-sanitized'
    && raw?.provenance?.worksFallback?.mode === 'douyin-authorised-browser-post-response'
    && validatedBrowserPagination(pagination, { limit: pagination.requestedLimit, posts: works.aweme_list,
      hasMore: works.has_more, maxCursor: works.max_cursor, notBefore: startedAt, notAfter: Date.parse(finishedAt) });
  if (!clean || works.observedAt !== clean.pages.at(-1).observedAt
    || !profile?.sec_uid || clean.pages.some((page, index) => pagination.pages[index].endpoint !== 'https://www.douyin.com/aweme/v1/web/aweme/post/'
      || pagination.pages[index].response.source !== 'authorised-browser')) throw new Error('浏览器作品观察时间证据无效');
  const postTimes = new Map(); let offset = 0;
  for (const page of clean.pages) {
    const pagePosts = works.aweme_list.slice(offset, offset + page.acceptedCount);
    offset += page.acceptedCount;
    for (const post of pagePosts) {
      if (typeof post?.aweme_id !== 'string' || !/^\d{15,25}$/.test(post.aweme_id) || postTimes.has(post.aweme_id)
        || post?.author?.sec_uid !== profile.sec_uid
        || (profile.uid != null && post.author.uid != null && post.author.uid !== '' && String(post.author.uid) !== String(profile.uid))) throw new Error('浏览器作品作者或时间映射无效');
      postTimes.set(post.aweme_id, page.observedAt);
    }
  }
  return { observedAt: works.observedAt, postTimes };
}

/** Recognize only the provider's successful browser merge after a deferred
 * anonymous works request. The original profile provenance stays untouched.
 * Historical authenticated:true is a legacy schema marker, NOT a claim about
 * today's session. Identity/time/raw checksum checks remain caller-owned. */
export function isOfficialMixedProfileEnvelope(raw) {
  try { browserWorksObservation(raw); } catch { return false; }
  if (raw?.works?.pagination?.version !== undefined && ![1, 2].includes(raw.works.pagination.version)) return false;
  const multiPage = [1, 2].includes(raw?.works?.pagination?.version);
  const partialError = multiPage ? raw.works.pagination.errorCode : null;
  if (!isOfficialProfileOnlyEnvelope(raw) || raw.worksError !== null || raw.worksErrorCode !== null
    || (raw.worksFallbackErrorCode ?? null) !== partialError
    || !["complete", "latest-public-window"].includes(raw.worksCoverage)) return false;
  const fallback = raw.provenance.worksFallback;
  if (!record(fallback) || fallback.mode !== "douyin-authorised-browser-post-response"
    || fallback.paidAPI !== false || fallback.runtimeAI !== false || fallback.noChallengeBypass !== true) return false;
  const legacySessionShape = fallback.authenticated === true && fallback.sessionLoaded === undefined
    && fallback.authorisedSessionUsed === undefined && fallback.authenticationStatus === undefined;
  const currentSessionShape = fallback.authenticated === null && fallback.sessionLoaded === true
    && fallback.authorisedSessionUsed === true && fallback.authenticationStatus === "not-verified";
  if (!legacySessionShape && !currentSessionShape) return false;
  const policy = raw.worksRequestPolicy;
  if (!record(policy) || policy.version !== 1 || policy.endpoint !== "douyin.author_posts" || policy.scope !== "endpoint-transport"
    || !record(policy.anonymous) || policy.anonymous.transport !== "anonymous-http"
    || policy.anonymous.attempted !== false || policy.anonymous.deferred !== true
    || !record(policy.browser) || policy.browser.transport !== "authorised-browser"
    || policy.browser.attempted !== true || policy.browser.deferred !== false || policy.browser.errorCode !== partialError) return false;
  const works = raw.works;
  const pagination = works?.pagination;
  if (!record(works) || !Array.isArray(works.aweme_list) || !(typeof works.has_more === "boolean" || multiPage && works.has_more === null) || !cursor(works.max_cursor)
    || !record(pagination) || pagination.evidenceScope !== "browser-response-sanitized"
    || !Number.isSafeInteger(pagination.requestedLimit) || pagination.requestedLimit < 1 || pagination.requestedLimit > 100
    || pagination.collectedCount !== works.aweme_list.length
    || works.aweme_list.length > pagination.requestedLimit
    || !Array.isArray(pagination.pages)) return false;
  if (multiPage) {
    if (!validatedBrowserPagination(pagination, { limit: pagination.requestedLimit, posts: works.aweme_list,
      hasMore: works.has_more, maxCursor: works.max_cursor })) return false;
    if (pagination.pages.some(page => page.endpoint !== "https://www.douyin.com/aweme/v1/web/aweme/post/"
      || page.response.source !== "authorised-browser")) return false;
    if (raw.worksCoverage === "complete" && pagination.stopReason !== "end-of-list") return false;
  } else {
    if (pagination.requestCount !== 1 || pagination.pages.length !== 1) return false;
    const page = pagination.pages[0];
    if (!record(page) || page.endpoint !== "https://www.douyin.com/aweme/v1/web/aweme/post/"
      || !record(page.response) || page.response.source !== "authorised-browser"
      || page.response.has_more !== works.has_more || page.response.max_cursor !== works.max_cursor) return false;
  }
  const ids = new Set();
  for (const post of works.aweme_list) {
    if (!record(post) || typeof post.aweme_id !== "string" || !/^\d{15,25}$/.test(post.aweme_id)
      || ids.has(post.aweme_id) || !record(post.author) || post.author.sec_uid !== raw.profile.user.sec_uid
      // normalizeBrowserWorks emits "" for an absent work-level UID. This is
      // not identity evidence; callers still require both stable profile IDs.
      || (post.author.uid !== undefined && post.author.uid !== "" && post.author.uid !== raw.profile.user.uid)
      || (post.statistics != null && !record(post.statistics))) return false;
    ids.add(post.aweme_id);
  }
  if (raw.worksCoverage === "complete") {
    return works.stopReason === "browser-end-of-list" && works.public_window_limited === false && works.has_more === false
      && Number.isSafeInteger(raw.profile.user.aweme_count) && raw.profile.user.aweme_count >= 0
      && works.aweme_list.length === raw.profile.user.aweme_count;
  }
  // Inventory and the observed public window may disagree. Their cause is
  // unknown here; preserve partial evidence without claiming completeness.
  return works.stopReason === "browser-public-window" && works.public_window_limited === true;
}
