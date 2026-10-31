#!/usr/bin/env node
/**
 * Historical work-response parsing and offline lifecycle regression adapters.
 * The command and default live browser launch are retired. Injected fixture
 * operations are retained to test stored evidence without platform access.
 */
import { access, chmod, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { reportRetiredDouyinBrowserCommand, retiredDouyinBrowserError } from "../lib/retired-douyin-browser-command.mjs";
import { classifyBrowserWorksFailure, safeBrowserCollectorException } from "../lib/douyin-browser-failure.mjs";
import { isExpectedDouyinWorksResponseUrl } from "../lib/douyin-browser-response-identity.mjs";
import { browserResourceFailureKind, browserRuntimeErrorKind, sanitizeBrowserResourceObservation, sanitizeBrowserWorksDiagnostics, unknownBrowserWorksDiagnostics } from "../lib/douyin-browser-diagnostics.mjs";
import { createBrowserResourceObservation } from "../lib/browser-resource-observation.mjs";
import { createCdpObservation } from "../lib/browser-cdp-observation.mjs";
import { BrowserWorksPagination, browserWorksCursor } from "../lib/browser-works-pagination.mjs";
import { observeBrowserFirstScreen } from "../lib/browser-render-diagnostics.mjs";
import { observeFirstPageActivation, sanitizeFirstPageActivationStructure } from "../lib/browser-first-page-activation.mjs";
import { requestBrowserFirstPage } from "../lib/browser-first-works-request.mjs";
import { createTerminalStructureObservation } from "../lib/douyin-terminal-structure.mjs";
import { shouldObserveReservedFirstScreen, observeReservedFirstScreenReadiness, isReservedFirstScreenReady } from "../lib/browser-readiness-observation.mjs";
import { parseBrowserRetryAfterValues } from "../lib/browser-retry-after.mjs";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DATA_DIR = resolve(PROJECT_DIR, "data");
const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const MAX_ITEMS = 32;
const RESOURCE_MONITOR = Symbol("private-resource-monitor");

// Passive attempt-scoped listeners, separate from current-generation works evidence.
// They remain through the batch's existing page.close, never initiate an action.
function observePageResources(page, secUid, cdpMonitor = null) {
  const observer = createBrowserResourceObservation({ secUid });
  const failureEligible = new WeakSet();
  let awaitingCommit = false, diagnosticView = null, attached = false, closed = false;
  const onRequest = request => {
    try {
      let isMainFrame = false;
      if (request.isNavigationRequest() === true) {
        try { isMainFrame = request.frame() === page.mainFrame(); } catch { /* Unknown frame is not a main document. */ }
      }
      if (observer.request(request, { isMainFrame })) failureEligible.add(request);
      if (isMainFrame) awaitingCommit = true;
    } catch { /* Diagnostics never change collection behavior. */ }
  };
  const onFrame = frame => {
    try {
      if (frame !== page.mainFrame()) return;
      if (awaitingCommit) awaitingCommit = false;
      else observer.sameDocument(frame.url());
    } catch { /* Do not export frame/URL errors. */ }
  };
  const onResponse = response => { observer.response(response); };
  const onFinished = request => { failureEligible.delete(request); observer.finished(request); };
  const onFailed = request => {
    // Read metadata once, only for a tracked live request. Malformed, duplicate,
    // finished, overflowed and retained-after-close events never inspect it.
    if (closed || !failureEligible.delete(request)) { observer.failed(request, "unknown"); return; }
    let kind = "unknown";
    try { kind = browserResourceFailureKind(request.failure()?.errorText); }
    catch { /* Passive metadata may be unavailable; collection still proceeds. */ }
    observer.failed(request, kind);
  };
  const attach = () => {
    if (attached) return;
    page.on("request", onRequest); page.on("framenavigated", onFrame);
    page.on("response", onResponse); page.on("requestfinished", onFinished); page.on("requestfailed", onFailed);
    attached = true;
  };
  const projection = captureBoundary => sanitizeBrowserResourceObservation({ ...observer.snapshot(), captureBoundary });
  const publish = captureBoundary => {
    if (diagnosticView) {
      diagnosticView.resourceObservation = projection(captureBoundary);
      if (cdpMonitor) diagnosticView.cdpObservation = cdpMonitor.snapshot(captureBoundary);
    }
  };
  return {
    onRequest, onFrame, onResponse, onFinished, onFailed, attach,
    snapshot: projection, cdpSnapshot: boundary => cdpMonitor?.snapshot(boundary),
    bind: value => { diagnosticView = value; },
    markStop: () => { cdpMonitor?.markStop(); return observer.markStop(); },
    beginCleanup: () => { cdpMonitor?.beginCleanup(); return observer.beginCleanup(); },
    publish,
    close: captureBoundary => {
      closed = true;
      if (attached) {
        page.off("request", onRequest); page.off("framenavigated", onFrame); page.off("response", onResponse);
        page.off("requestfinished", onFinished); page.off("requestfailed", onFailed);
        attached = false;
      }
      observer.close(); publish(captureBoundary);
    },
  };
}

// Only called for this batch's newly-created Page in its registered private browser.
// Three observation commands, no browser-security/cache/request mutation or replay.
// The caller subtracts setup time from the existing account deadline.
export async function observePrivatePageCdp(context, page, secUid, timeoutMs = 250) {
  let accepting = true, session = null, observer = null;
  const listeners = [];
  const closingSessions = new WeakMap();
  const remove = () => { for (const [name, callback] of listeners) session?.off(name, callback); listeners.length = 0; };
  const closeSession = async () => {
    accepting = false; remove(); observer?.close();
    if (!session || (typeof session !== 'object' && typeof session !== 'function')) return;
    if (closingSessions.has(session)) return closingSessions.get(session);
    const actualSession = session;
    const closing = Promise.resolve().then(async () => {
      try { await actualSession.detach(); } catch { /* Local observation loss does not alter collection. */ }
    });
    closingSessions.set(actualSession, closing); return closing;
  };
  const setup = Promise.resolve().then(async () => {
    session = await context.newCDPSession(page);
    if (!accepting) return closeSession();
    await session.send('Page.enable');
    if (!accepting) return closeSession();
    await session.send('Network.enable');
    if (!accepting) return closeSession();
    const tree = await session.send('Page.getFrameTree');
    if (!accepting) return closeSession();
    const root = tree?.frameTree?.frame;
    if (root?.parentId) return closeSession();
    observer = createCdpObservation({ mainFrameId: root?.id, secUid });
    const events = { 'Network.requestWillBeSent': 'request', 'Network.responseReceived': 'response',
      'Network.loadingFinished': 'finished', 'Network.loadingFailed': 'failed',
      'Page.frameNavigated': 'commit', 'Page.navigatedWithinDocument': 'sameDocument' };
    for (const [name, method] of Object.entries(events)) {
      const callback = event => { if (accepting) observer[method](event); };
      listeners.push([name, callback]); session.on(name, callback);
    }
    return true;
  }).catch(() => false);
  const result = await bounded(setup, Math.max(1, Math.min(250, timeoutMs)));
  if (result !== true) {
    accepting = false; remove(); observer?.close();
    // A timed-out local creation releases itself if it eventually resolves.
    void bounded(Promise.resolve().then(closeSession), 100).catch(() => {});
    return null;
  }
  return Object.freeze({ snapshot: boundary => observer.snapshot(boundary), markStop: observer.markStop,
    beginCleanup: observer.beginCleanup, close: closeSession });
}

function clean(value, max = 360) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeInt(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

export function normalizeBrowserCollectorInput(payload) {
  if (!Array.isArray(payload?.items) || !payload.items.length) throw new Error("浏览器作品采集缺少账号");
  if (payload.items.length > MAX_ITEMS) throw new Error(`浏览器作品采集单批不能超过 ${MAX_ITEMS} 个账号`);
  return payload.items.map((item) => {
    const secUid = clean(item?.secUid, 240);
    if (!SEC_UID_RE.test(secUid)) throw new Error("浏览器作品采集需要合法 sec_uid");
    const limit = Math.max(1, Math.min(100, safeInt(item?.limit) ?? 30));
    const requestThreshold = item?.requestThreshold;
    if (requestThreshold !== undefined && (!Number.isSafeInteger(item?.limit) || item.limit < 1 || item.limit > 100))
      throw new Error('完整页保存上限必须是 1 至 100 的整数');
    if (requestThreshold !== undefined && (!Number.isSafeInteger(requestThreshold) || requestThreshold < 1 || requestThreshold > limit))
      throw new Error('浏览器作品请求阈值必须为 1 至保存上限的整数');
    if (item.startCursor !== undefined && (!Number.isSafeInteger(item.startCursor) || item.startCursor < 0)) throw new Error('Invalid continuation cursor');
    return { key: clean(item?.key, 240), secUid, limit, ...(requestThreshold === undefined ? {} : {requestThreshold}),
      ...(item.startCursor === undefined ? {} : {startCursor:item.startCursor}) };
  });
}

async function readAuthorisedState() {
  const statePath = resolve(process.env.DOUYIN_ACCOUNT_BROWSER_STATE || process.env.DOUYIN_TOPIC_BROWSER_STATE
    || resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR, "douyin-topic-browser-state.json"));
  const fileStat = await stat(statePath).catch(() => null);
  if (!fileStat) throw new Error("未配置抖音浏览器会话；请先在本机完成抖音授权");
  if ((fileStat.mode & 0o077) !== 0) throw new Error("抖音浏览器会话文件权限过宽；仅允许当前用户读取");
  let state;
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch { throw new Error("抖音浏览器会话文件不可读取；请重新授权"); }
  if (!Array.isArray(state?.cookies) || !state.cookies.length) throw new Error("抖音浏览器会话为空；请重新授权");
  // The state was created by the explicit connect flow.  Do not persist a
  // refreshed state here: an account collector must not silently rotate a
  // user's login session.
  return state;
}

function compactPublicAuthorIdentity(author) {
  // Preserve only the source's exact text, never coerce/round a numeric ID or
  // substitute a nickname/uid. Identity matching remains a separate step.
  const identity = {};
  for (const [key, pattern] of [["unique_id", /^[A-Za-z0-9_.-]{1,100}$/], ["short_id", /^[0-9]{1,25}$/]]) {
    const value = author[key];
    if (typeof value === "string" && pattern.test(value)) identity[key] = value;
  }
  return identity;
}

function normalizePost(item, expectedSecUid) {
  if (!item || typeof item !== "object") return null;
  const author = item.author && typeof item.author === "object" ? item.author : {};
  if (String(author.sec_uid ?? "").trim() !== expectedSecUid) return null;
  const externalId = clean(item.aweme_id, 80);
  if (!/^\d{15,25}$/.test(externalId)) return null;
  const stats = item.statistics && typeof item.statistics === "object" ? item.statistics : {};
  return {
    aweme_id: externalId,
    desc: clean(item.desc, 2_000),
    create_time: safeInt(item.create_time),
    author: { sec_uid: expectedSecUid, uid: clean(author.uid, 80), nickname: clean(author.nickname, 160), ...compactPublicAuthorIdentity(author) },
    statistics: {
      ...(safeInt(stats.digg_count) !== null ? { digg_count: safeInt(stats.digg_count) } : {}),
      ...(safeInt(stats.comment_count) !== null ? { comment_count: safeInt(stats.comment_count) } : {}),
      ...(safeInt(stats.share_count) !== null ? { share_count: safeInt(stats.share_count) } : {}),
      ...(safeInt(stats.collect_count) !== null ? { collect_count: safeInt(stats.collect_count) } : {}),
      ...(safeInt(stats.play_count) !== null ? { play_count: safeInt(stats.play_count) } : {}),
    },
    text_extra: Array.isArray(item.text_extra) ? item.text_extra.slice(0, 100).map((extra) => ({
      ...(extra?.hashtag_name ? { hashtag_name: clean(extra.hashtag_name, 160) } : {}),
      ...(extra?.hashtag_id ? { hashtag_id: clean(extra.hashtag_id, 80) } : {}),
    })) : [],
  };
}

export function normalizeBrowserWorks(payload, expectedSecUid, limit = 30) {
  if (!payload || payload.status_code !== 0) throw new Error("浏览器公开作品未明确返回业务成功；未将错误或未知状态视为空作品");
  const list = Array.isArray(payload?.aweme_list) ? payload.aweme_list : null;
  if (!list) throw new Error("浏览器公开作品响应缺少 aweme_list；未将其视为空作品");
  const seen = new Set();
  const items = [];
  let filteredCount = 0;
  let duplicateCount = 0;
  let locallyTruncated = false;
  for (const item of list) {
    const post = normalizePost(item, expectedSecUid);
    if (!post) { filteredCount += 1; continue; }
    if (seen.has(post.aweme_id)) { duplicateCount += 1; continue; }
    seen.add(post.aweme_id);
    if (items.length < limit) items.push(post);
    else locallyTruncated = true;
  }
  if (list.length && !items.length) throw new Error("浏览器公开作品未包含可确认属于该账号的有效作品");
  const hasMore = payload?.has_more === true || payload?.has_more === 1 || payload?.has_more === "1";
  const explicitEnd = payload?.has_more === false || payload?.has_more === 0 || payload?.has_more === "0";
  const maxCursor = safeInt(payload?.max_cursor);
  return {
    posts: items,
    hasMore,
    maxCursor,
    filteredCount, duplicateCount, locallyTruncated,
    // A browser page proves the current public window only.  It is never
    // presented as a complete historical archive unless the API explicitly
    // reports no next page, every row was verified, and nothing was omitted
    // locally. Missing/invalid has_more is unknown, not an end-of-list signal.
    coverage: explicitEnd && !locallyTruncated && filteredCount === 0 && duplicateCount === 0 ? "complete" : "latest-public-window",
  };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const timedOut = Symbol("timed-out");
async function bounded(promise, milliseconds, signal) {
  let timer;
  let onAbort;
  try {
    return await Promise.race([promise, new Promise((resolve) => {
      onAbort = () => resolve(timedOut);
      timer = setTimeout(onAbort, milliseconds);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}
function deadlineOption(value, fallback, maximum) {
  return Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.max(1, Math.trunc(value))) : fallback;
}
async function openBoundedResource(create, milliseconds) {
  const opening = Promise.resolve().then(create);
  const resource = await bounded(opening, milliseconds);
  if (resource !== timedOut) return resource;
  // If Playwright resolves creation after our deadline, release that resource
  // instead of allowing a late page/browser to survive this collection.
  void opening.then((late) => bounded(Promise.resolve().then(() => late?.close()).catch(() => {}), 2_000), () => {});
  throw new Error("浏览器资源创建超时；未形成可用作品证据");
}
function expectedProfile(value, secUid) {
  try {
    const url = new URL(value);
    return url.origin === "https://www.douyin.com" && !url.username && !url.password
      && [ `/user/${secUid}`, `/user/${secUid}/` ].includes(url.pathname);
  } catch { return false; }
}
function officialWorksEndpoint(value) {
  try { const url = new URL(value); return url.origin === "https://www.douyin.com" && url.pathname === "/aweme/v1/web/aweme/post/"; }
  catch { return false; }
}
function finalPageKind(page, secUid) {
  try {
    const value = page.url();
    if (expectedProfile(value, secUid)) return "profile";
    if (classifyBrowserWorksFailure({ pageUrl: value }).errorCode === "login_required") return "login";
    return value ? "other" : "unknown";
  } catch { return "unknown"; }
}

function explicitAccessBarrier(body) {
  const set = value => value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
  if (set(body?.need_login) || set(body?.login_required)) return "login_required";
  if (set(body?.captcha_required) || set(body?.verify_required)) return "blocked";
  return null;
}

function officialVerificationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com"))
      && /\/(?:captcha|verify|challenge)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

export async function collectOne(page, item, options = {}) {
  // Preserve the previous 20 s navigation + 25 s response opportunity. The
  // total bound also applies when goto itself never settles in the adapter.
  const timeoutMs = deadlineOption(options.timeoutMs, 45_000, 45_000);
  const bodyTimeoutMs = deadlineOption(options.bodyTimeoutMs, 25_000, 25_000);
  const failureGraceMs = deadlineOption(options.failureGraceMs, 500, 1_000);
  const pageWaitMs = deadlineOption(options.pageWaitMs, 3_000, 3_000);
  const maxPages = deadlineOption(options.maxPages, 3, 3);
  const startedAt = Date.now();
  const resourceMonitor = options[RESOURCE_MONITOR] ?? observePageResources(page, item.secUid);
  const totalDeadline = startedAt + timeoutMs;
  let deadline = totalDeadline;
  let responseOpportunityDeadline = null;
  let sawWorksCandidate = false, sawWorksFailure = false;
  const requests = new Set();
  const requestCursors = new Map();
  const refusalOnlyRequests = new WeakSet();
  const consumed = new Set();
  const failedRequests = new Set();
  const pending = new Map();
  const retryAfterReads = new Set();
  let retryAfter = null;
  // A browser may prefetch before our predecessor JSON read settles. Retain
  // only bounded, document-bound handles; no body or cursor is trusted yet.
  const provisionalRequests = new Map();
  let bodyController = new AbortController();
  let active = true;
  let generation = 0;
  let commandedNavigationGeneration = null;
  let targetNavigationObserved = false;
  let navigationCommitted = false;
  let documentRequest = null;
  let documentRequestGeneration = null;
  let documentStatus = null;
  let responseWindowStarted = false;
  const responseOpportunityRequests = new WeakSet();
  let successful = null;
  let pagination = new BrowserWorksPagination({ limit: item.limit, maxPages, requestThreshold: item.requestThreshold, startCursor:item.startCursor });
  let barrier = null;
  let nextPageDeadline = null;
  let scrollAttempts = 0;
  let scrolledPageCount = 0;
  let scrollProgress = null, scrollHeld = false, scrollRequalifications = 0;
  let scrollWaitingProbeCount = 0, scrollNextQualificationAt = null, scrollNextQualificationKind = null, scrollPageActionCount = 0;
  let hardGateSeen = false;
  const rememberHardGate = structure => {
    if (["limit", "modal", "challenge", "credential-form", "gate-ancestor", "gate-descendant"].includes(structure?.gates?.decision)) hardGateSeen = true;
  };
  const continuationActivation = { version: 1, probeCount: 0, renderRecheckCount: 0, actionCount: 0, lastBranch: "not-started" };
  const explicitContinuationCursors = new Set();
  const trackScrollId = randomUUID();
  // attemptCount remains the legacy 0/1 opportunity flag, not a probe count.
  // Up to eight read-only qualifications may precede one mouse action pair.
  const firstPageActivation = { state: "not-eligible", attemptCount: 0, probeCount: 0, actionCount: 0 };
  const firstPageRequest = { kind: "collector-same-origin-get", state: "not-eligible", attemptCount: 0 };
  let activationGeneration = null;
  let activationFinished = false;
  let activationRebindPending = false;
  let qualificationCount = 0;
  let nextQualificationAt = null;
  const stopPaging = (reason, errorCode) => {
    provisionalRequests.clear();
    resourceMonitor.markStop();
    barrier = { reason, errorCode }; pagination.stop(reason, errorCode); bodyController.abort();
  };
  const refreshVerifiedDocumentOpportunity = () => {
    // A normally loaded replacement owns a fresh response opportunity, not
    // the retired document's shorter deadline. Join real current-request 2xx
    // and commit evidence first. History, duplicate events and old responses
    // cannot renew it; the original absolute account ceiling stays unchanged.
    if (!responseWindowStarted || !active || barrier || successful || options.signal?.aborted
      || navigationFailed || !navigationCommitted || !targetNavigationObserved || !documentRequest
      || documentRequestGeneration !== generation || responseOpportunityRequests.has(documentRequest)
      || !Number.isInteger(documentStatus) || documentStatus < 200 || documentStatus >= 300
      || Date.now() >= deadline || !expectedProfile(page.url(), item.secUid)) return;
    responseOpportunityRequests.add(documentRequest);
    deadline = Math.min(totalDeadline, Date.now() + 25_000);
    responseOpportunityDeadline = deadline;
  };
  const onAbort = () => stopPaging("cancelled", "collector_error");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let invalidBodies = 0;
  let navigationFailed = false;
  let navigationTimedOut = false;
  let diagnosticRequests;
  let diagnosticResponses;
  let httpStatuses;
  let businessStatusCodes;
  let runtimeDiagnostics;
  let lifecycleDiagnostics;
  let firstScreen;
  let screenAttempts = 0;
  let screenAcceptedAttempt = 0;
  let activationReadyAt = null;
  let reservedReadinessAttempted = false;
  const resetDiagnostics = () => {
    retryAfter = null;
    diagnosticRequests = { candidate: 0, matched: 0, rejected: { nonMainFrame: 0, frameUnavailable: 0, beforeCommit: 0, accountIdentity: 0, firstCursor: 0, method: 0, capacity: 0 } };
    diagnosticResponses = { matched: 0, invalidBodies: 0, bodyTimeouts: 0 };
    httpStatuses = []; businessStatusCodes = [];
    runtimeDiagnostics = { pageErrorCount: generation <= 1 ? 0 : null, pageErrorKinds: [],
      boundRequestFailedCount: 0, navigationErrorKind: "none" };
    // These Page events have no document identity. Record only what this
    // listener window observed; they never grant readiness or source success.
    lifecycleDiagnostics = { domContentLoadedCount: 0, loadCount: 0,
      firstDomContentLoadedElapsedMs: null, lastDomContentLoadedElapsedMs: null,
      firstLoadElapsedMs: null, lastLoadElapsedMs: null, lastAcceptedFirstScreenSource: "none" };
    failedRequests.clear();
    firstScreen = undefined; screenAttempts = 0; screenAcceptedAttempt = 0; activationReadyAt = null;
    reservedReadinessAttempted = false;
  };
  resetDiagnostics();
  const terminalStructure = createTerminalStructureObservation({ page, secUid: item.secUid, getState: () => ({
    active, barrier, successful, navigationFailed, navigationCommitted, targetNavigationObserved,
    generation, documentRequest, documentRequestGeneration, documentStatus,
    worksRequests: requests.size, pendingReads: pending.size, startedAt, deadline, totalDeadline, signal: bodyController.signal,
  }) });
  const diagnostics = (stopReason) => {
    resourceMonitor.markStop();
    const value = sanitizeBrowserWorksDiagnostics({ version: 1,
    navigation: { observed: targetNavigationObserved, committed: navigationCommitted, failed: navigationFailed, timedOut: navigationTimedOut },
    requests: diagnosticRequests, responses: diagnosticResponses, runtime: runtimeDiagnostics,
    lifecycle: { version: 1, generation, ...lifecycleDiagnostics,
      firstScreenAttemptCount: screenAttempts, lastAcceptedFirstScreenAttempt: screenAcceptedAttempt },
    firstScreen, terminalStructure: terminalStructure.snapshot(), firstPageActivation,
    ...(continuationActivation.probeCount ? { continuationActivation } : {}),
    ...(firstPageRequest.attemptCount ? { firstPageRequest } : {}), httpStatuses, businessStatusCodes,
    finalPageKind: finalPageKind(page, item.secUid), elapsedMs: Math.max(0, Date.now() - startedAt), stopReason,
    resourceObservation: resourceMonitor.snapshot("attempt-return"),
    cdpObservation: resourceMonitor.cdpSnapshot("attempt-return") });
    resourceMonitor.bind(value); return value;
  };
  const observeFirstScreen = async (source = "navigation-return") => {
    if (!active || barrier || successful || !navigationCommitted || Date.now() >= deadline || screenAttempts >= 2 || typeof page.evaluate !== "function") return;
    const screenGeneration = generation;
    const attempt = ++screenAttempts;
    try {
      // Fixed structural projection only, never accepted works. A bound 2xx
      // document is required before the helper may read its embedded JSON.
      const snapshot = await bounded(Promise.resolve().then(() => {
        if (!active || barrier || successful || generation !== screenGeneration || Date.now() >= deadline) return null;
        return page.evaluate(observeBrowserFirstScreen, { secUid: item.secUid, documentStatus });
      }), Math.max(1, Math.min(500, deadline - Date.now())), bodyController.signal);
      if (!active || barrier || successful || generation !== screenGeneration || Date.now() >= deadline
        || attempt < screenAcceptedAttempt || !expectedProfile(page.url(), item.secUid)) return;
      screenAcceptedAttempt = attempt;
      lifecycleDiagnostics.lastAcceptedFirstScreenSource = source;
      firstScreen = snapshot === timedOut ? { observation: "timeout" } : snapshot || { observation: "unavailable" };
      if (firstScreen.observation === "observed" && ["interactive", "complete"].includes(firstScreen.readyState)) activationReadyAt ??= Date.now();
      else activationReadyAt = null;
    } catch {
      if (active && !barrier && !successful && Date.now() < deadline && generation === screenGeneration && attempt >= screenAcceptedAttempt) {
        screenAcceptedAttempt = attempt; lifecycleDiagnostics.lastAcceptedFirstScreenSource = source;
        firstScreen = { observation: "unavailable" };
      }
    }
  };
  const recordLifecycleEvent = (countKey, firstKey, lastKey) => {
    if (!active || Date.now() >= deadline || !navigationCommitted) return;
    try {
      if (!expectedProfile(page.url(), item.secUid)) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      lifecycleDiagnostics[countKey] = Math.min(1_000_000, lifecycleDiagnostics[countKey] + 1);
      lifecycleDiagnostics[firstKey] ??= elapsed;
      lifecycleDiagnostics[lastKey] = elapsed;
    } catch { /* Event payloads, URLs and errors remain private. */ }
  };
  const onDomContentLoaded = () => {
    recordLifecycleEvent("domContentLoadedCount", "firstDomContentLoadedElapsedMs", "lastDomContentLoadedElapsedMs");
    void observeFirstScreen("domcontentloaded");
  };
  // Passive only. A delayed previous-document load must not consume the
  // current document's second existing first-screen observation or act.
  const onLoad = () => { recordLifecycleEvent("loadCount", "firstLoadElapsedMs", "lastLoadElapsedMs"); };
  const canActivateFirstPage = (windowDeadline = deadline) => active && !barrier && !hardGateSeen && !successful && !options.signal?.aborted
    && !navigationFailed && navigationCommitted && targetNavigationObserved && Date.now() < windowDeadline
    && documentStatus >= 200 && documentStatus < 300 && expectedProfile(page.url(), item.secUid)
    && requests.size === 0 && pending.size === 0;
  const canObserveReservedFirstScreen = (windowDeadline = deadline) => {
    try {
      return Boolean(canActivateFirstPage(windowDeadline) && documentRequest && documentRequestGeneration === generation
        && documentRequest.isNavigationRequest() === true && documentRequest.method() === "GET"
        && documentRequest.frame() === page.mainFrame() && expectedProfile(documentRequest.url(), item.secUid));
    } catch { return false; }
  };
  const activateFirstPage = async () => {
    activationGeneration ??= generation;
    const activationDeadline = Math.min(deadline, Date.now() + 1_000);
    let expired = false;
    activationFinished = true;
    qualificationCount++;
    firstPageActivation.attemptCount = 1;
    const allowed = () => !expired && generation === activationGeneration && Date.now() < activationDeadline && canActivateFirstPage();
    const validPoint = value => value?.eligible === true && [value.x, value.y, value.deltaY].every(Number.isSafeInteger)
      && value.x >= 0 && value.y >= 0 && value.x <= 20_000 && value.y <= 20_000 && value.deltaY >= 200 && value.deltaY <= 800;
    try {
      const result = await bounded(Promise.resolve().then(async () => {
        if (!allowed()) return;
        firstPageActivation.probeCount++;
        const point = await page.evaluate(observeFirstPageActivation, { secUid: item.secUid, observeControls: true });
        if (!allowed()) return;
        const structure = sanitizeFirstPageActivationStructure(point?.structure);
        if (structure) firstPageActivation.structure = structure;
        rememberHardGate(structure);
        if (!validPoint(point)) {
          firstPageActivation.state = ["no-container", "blocked"].includes(point?.reason) ? point.reason : "not-eligible";
          // Only a positively identified not-yet-visible region can be read
          // again. This never retries a request, refusal, unknown or action.
          const absent = structure?.reason === "region-absent" && structure.regionCount === 0;
          const notVisible = structure?.reason === "region-not-visible" && structure.regionCount > 0 && structure.regionCount <= 8;
          if (point?.eligible === false && point.reason === "no-container" && (absent || notVisible)
            && structure.visibleRegionCount === 0 && structure.leafRegionCount === 0 && structure.ancestorCount === null
            && qualificationCount < 8 && allowed()) {
            nextQualificationAt = Date.now() + 1_000;
            activationFinished = false;
          }
          return;
        }
        firstPageActivation.actionCount++;
        await page.mouse.move(point.x, point.y);
        if (!allowed()) return;
        // Hover can reveal an overlay, or a natural request can start during
        // movement. Recheck both DOM and event-owned guards before the wheel.
        firstPageActivation.probeCount++;
        const current = await page.evaluate(observeFirstPageActivation, { secUid: item.secUid, observeControls: true });
        if (!allowed()) return;
        const currentStructure = sanitizeFirstPageActivationStructure(current?.structure);
        if (currentStructure) firstPageActivation.structure = currentStructure;
        rememberHardGate(currentStructure);
        if (!validPoint(current) || current.x !== point.x || current.y !== point.y) {
          firstPageActivation.state = current?.reason === "blocked" ? "blocked" : "not-eligible"; return;
        }
        firstPageActivation.state = "attempted";
        await page.mouse.wheel(0, current.deltaY);
      }), Math.max(1, activationDeadline - Date.now()), bodyController.signal);
      if (result === timedOut) firstPageActivation.state = !barrier && generation === activationGeneration
        && Date.now() >= activationDeadline ? "timeout" : "not-eligible";
    } catch { firstPageActivation.state = "unavailable"; }
    finally { expired = true; }
  };
  let firstFailureAt = null;
  const rejectedStatuses = [];
  const recordFailure = () => { sawWorksFailure = true; firstFailureAt ??= Date.now(); };
  const onRequest = (request) => {
    resourceMonitor.onRequest(request);
    try { if (!request.isNavigationRequest() && officialWorksEndpoint(request.url())) sawWorksCandidate = true; }
    catch { /* An unknown request never grants the explicit late fallback. */ sawWorksCandidate = true; }
    if (!active || barrier || Date.now() >= deadline) return;
    try {
      const isNavigation = request.isNavigationRequest();
      const candidate = !isNavigation && officialWorksEndpoint(request.url());
      if (candidate) diagnosticRequests.candidate += 1;
      let mainFrame;
      try { mainFrame = request.frame() === page.mainFrame(); }
      catch { if (candidate) diagnosticRequests.rejected.frameUnavailable += 1; return; }
      if (isNavigation) {
        if (!mainFrame) return;
        if (pagination.pages.length) {
          const code = classifyBrowserWorksFailure({ pageUrl: request.url() }).errorCode;
          stopPaging(code === "login_required" ? "login-required" : officialVerificationUrl(request.url()) ? "verification-required" : "navigation-changed",
            code === "login_required" ? code : officialVerificationUrl(request.url()) ? "blocked" : "collector_error");
          generation += 1;
          navigationCommitted = false; targetNavigationObserved = false;
          requests.clear(); requestCursors.clear();
          provisionalRequests.clear();
          return;
        }
        generation += 1;
        commandedNavigationGeneration ??= generation;
        // A read-only absence qualification spends no mouse action. A real
        // replacement document may use the remaining attempt-wide budget;
        // history events, a refusal, exhausted probes or an action cannot.
        if (!activationFinished && firstPageActivation.actionCount === 0 && qualificationCount > 0 && qualificationCount < 8)
          activationRebindPending = true;
        bodyController.abort();
        bodyController = new AbortController();
        successful = null;
        pagination = new BrowserWorksPagination({ limit: item.limit, maxPages, requestThreshold: item.requestThreshold, startCursor:item.startCursor });
        if (barrier) pagination.stop(barrier.reason, barrier.errorCode);
        nextPageDeadline = null; scrollAttempts = 0; scrolledPageCount = 0;
        firstFailureAt = null;
        invalidBodies = 0;
        rejectedStatuses.length = 0;
        resetDiagnostics();
        navigationCommitted = false;
        targetNavigationObserved = expectedProfile(request.url(), item.secUid);
        documentRequest = targetNavigationObserved ? request : null;
        documentRequestGeneration = documentRequest ? generation : null;
        documentStatus = null;
        requests.clear();
        requestCursors.clear();
        provisionalRequests.clear();
        return;
      }
      if (!candidate) return;
      const reject = (reason) => { diagnosticRequests.rejected[reason] += 1; };
      if (!mainFrame) return reject("nonMainFrame");
      if (!targetNavigationObserved || !navigationCommitted) return reject("beforeCommit");
      if (requests.size >= 32) return reject("capacity");
      if (request.method() !== "GET") return reject("method");
      if (!expectedProfile(request.frame().url(), item.secUid) || !isExpectedDouyinWorksResponseUrl(request.url(), item.secUid)) return reject("accountIdentity");
      const cursor = browserWorksCursor(request.url(), item.secUid);
      // A legitimate natural head remains usable. Before any continuation
      // request/action, explicitly abandon this round's old checkpoint and
      // start independent head evidence under the original source contract.
      // Never splice that head onto a prior run or reset an in-flight chain.
      if (cursor === 0 && pagination.startCursor !== undefined && !pagination.pages.length
        && !requests.size && !firstPageRequest.attemptCount && !barrier) {
        pagination = new BrowserWorksPagination({ limit: item.limit, maxPages, requestThreshold: item.requestThreshold });
      }
      // A same-author head racing an already dispatched continuation cannot
      // contribute rows, but its explicit refusal must remain authoritative.
      // All document/frame/method/origin/account guards above still apply.
      if (cursor === 0 && pagination.startCursor > 0 && cursor !== pagination.expectedCursor) {
        if (!requests.has(request)) diagnosticRequests.matched += 1;
        requests.add(request); requestCursors.set(request, cursor); refusalOnlyRequests.add(request);
        return;
      }
      if (cursor === null || cursor !== pagination.expectedCursor || pagination.stopReason) {
        // This remains rejected unless the actual predecessor later names
        // this exact cursor. Never queue heads, duplicates, old cursors, or
        // candidates without a currently owned predecessor body read.
        if (cursor > 0 && cursor !== pagination.expectedCursor && !pagination.stopReason
          && !pagination.cursors.has(cursor) && provisionalRequests.size < 3
          && ![...provisionalRequests.values()].some(value => value.cursor === cursor)
          && [...pending.values()].some(value => value.generation === generation && value.cursor === pagination.expectedCursor)) {
          provisionalRequests.set(request, {cursor, generation, response:null});
        }
        return reject("firstCursor");
      }
      if (!requests.has(request)) diagnosticRequests.matched += 1;
      requests.add(request);
      requestCursors.set(request, cursor);
    } catch { /* Unbound/service-worker requests are not current-profile proof. */ }
  };
  const onFrameNavigated = (frame) => {
    resourceMonitor.onFrame(frame);
    if (!active || frame !== page.mainFrame()) return;
    if (barrier && pagination.pages.length) { navigationCommitted = false; return; }
    navigationCommitted = targetNavigationObserved && expectedProfile(frame.url(), item.secUid);
    if (!navigationCommitted && pagination.pages.length) {
      const code = classifyBrowserWorksFailure({ pageUrl: frame.url() }).errorCode;
      stopPaging(code === "login_required" ? "login-required" : officialVerificationUrl(frame.url()) ? "verification-required" : "navigation-changed",
        code === "login_required" ? code : officialVerificationUrl(frame.url()) ? "blocked" : "collector_error");
      generation += 1; requests.clear(); requestCursors.clear(); return;
    }
    if (!navigationCommitted) {
      provisionalRequests.clear();
      generation += 1; requests.clear(); requestCursors.clear(); successful = null; bodyController.abort(); resetDiagnostics();
      if (classifyBrowserWorksFailure({ pageUrl: frame.url() }).errorCode === "login_required") stopPaging("login-required", "login_required");
      else if (officialVerificationUrl(frame.url())) stopPaging("verification-required", "blocked");
      // History API route changes do not emit a new document request. Retire
      // the old signal but leave a usable one for newly bound target requests
      // if the same document normally returns, never after a stop barrier.
      if (!barrier && !options.signal?.aborted) bodyController = new AbortController();
    }
    refreshVerifiedDocumentOpportunity();
    // A later profile commit may not emit DOM-ready within this attempt.
    // Probe only once on commit: ordinary same-document history events must
    // leave the second existing observation available for DOM readiness.
    if (navigationCommitted && screenAttempts === 0) void observeFirstScreen("commit");
  };
  const onPageError = (error) => {
    // Page errors do not identify their frame/navigation. After a subsequent
    // navigation we cannot safely attribute a delayed old error; leave unknown.
    if (!active || Date.now() >= deadline || !navigationCommitted || generation !== 1) return;
    try {
      if (!expectedProfile(page.url(), item.secUid)) return;
      runtimeDiagnostics.pageErrorCount = Math.min(1_000_000, runtimeDiagnostics.pageErrorCount + 1);
      const kind = browserRuntimeErrorKind(error);
      if (!runtimeDiagnostics.pageErrorKinds.includes(kind)) runtimeDiagnostics.pageErrorKinds.push(kind);
    } catch { /* No raw browser exception may cross the diagnostics boundary. */ }
  };
  const onRequestFailed = (request) => {
    resourceMonitor.onFailed(request);
    if (!active || Date.now() >= deadline || !navigationCommitted || !requests.has(request) || failedRequests.has(request)) return;
    // Membership is bound to the existing strict identity/frame/navigation
    // guard. The passive adapter retains only an exact fixed error category;
    // do not read/export raw failure text into this works-evidence branch.
    failedRequests.add(request);
    runtimeDiagnostics.boundRequestFailedCount += 1;
    if (pagination.pages.length) stopPaging("request-failed", "network_error");
  };
  const processResponse = (response) => {
    if (!active || barrier || Date.now() >= deadline) return;
    let request;
    let status;
    try {
      request = response.request();
      const provisional = provisionalRequests.get(request);
      if (provisional) {
        if (provisional.generation === generation && !provisional.response
          && browserWorksCursor(response.url(), item.secUid) === provisional.cursor) provisional.response = response;
        return;
      }
      if (request === documentRequest && targetNavigationObserved
        && request.frame() === page.mainFrame() && expectedProfile(response.url(), item.secUid)) {
        status = response.status();
        documentStatus = Number.isInteger(status) ? status : null;
        refreshVerifiedDocumentOpportunity();
        if (Number.isInteger(status) && status >= 400 && status <= 599) {
          rejectedStatuses.push(status);
          if (httpStatuses.length < 100) httpStatuses.push(status);
          const code = [401, 403, 429].includes(status)
            ? classifyBrowserWorksFailure({ httpStatuses: [status] }).errorCode
            : "network_error";
          stopPaging("http-rejection", code);
          barrier.error = `抖音公开主页返回 HTTP ${status}；已停止本次作品读取，未覆盖历史作品`;
          recordFailure();
        }
        return;
      }
      if (!requests.has(request) || consumed.has(request) || !navigationCommitted
        || browserWorksCursor(response.url(), item.secUid) !== requestCursors.get(request)) return;
      status = response.status();
      consumed.add(request);
      diagnosticResponses.matched += 1;
      if (Number.isInteger(status) && status >= 100 && status <= 599 && httpStatuses.length < 100) httpStatuses.push(status);
    } catch { return; }
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      if (refusalOnlyRequests.has(request)) successful = null;
      if (Number.isInteger(status)) rejectedStatuses.push(status);
      // Only the already-bound final works response may supply a wait. This
      // reads one header, never the rejected body or an entire header record.
      if (status >= 400 && status <= 599 && typeof response.headerValues === "function") {
        const observed = Date.now(), hintGeneration = generation;
        const hintRead = (async () => {
          try {
            const values = await bounded(Promise.resolve().then(() => response.headerValues("retry-after")),
              Math.max(1, Math.min(1000, totalDeadline - Date.now())), options.signal);
            if (!active || hintGeneration !== generation || values === timedOut || Date.now() > totalDeadline) return;
            retryAfter = { httpStatus: status, observedAt: new Date(observed).toISOString(), ...parseBrowserRetryAfterValues(values, observed) };
          } catch { /* Unavailable wait metadata does not alter the failure. */ }
        })();
        retryAfterReads.add(hintRead);
        void hintRead.finally(() => retryAfterReads.delete(hintRead));
      }
      stopPaging("http-rejection", classifyBrowserWorksFailure({ httpStatuses: [status] }).errorCode);
      recordFailure();
      return;
    }
    const refusalOnly = refusalOnlyRequests.has(request);
    if ((!refusalOnly && requestCursors.get(request) !== pagination.expectedCursor) || (pagination.stopReason && !refusalOnly)) return;
    const responseGeneration = generation;
    // Strictly bound 2xx headers arrived inside the response opportunity.
    // Let their body use its existing timeout and the absolute account ceiling,
    // just like continuation bodies; a bare request never extends this window.
    deadline = totalDeadline;
    // Event emitters do not await async listeners. Own the promise explicitly,
    // cap its lifetime and invalidate its result after finish/navigation.
    const task = (async () => {
      try {
        const body = await bounded(Promise.resolve().then(() => response.json()), Math.max(1, Math.min(bodyTimeoutMs, deadline - Date.now())), bodyController.signal);
        if (!active || barrier || generation !== responseGeneration) return;
        if (body === timedOut) { if (refusalOnly) successful = null;
          diagnosticResponses.bodyTimeouts += 1; recordFailure();
          if (pagination.pages.length) stopPaging("page-timeout", "network_error"); return; }
        if (Date.now() >= deadline) return;
        if (Number.isSafeInteger(body?.status_code) && body.status_code >= 0 && businessStatusCodes.length < 100) businessStatusCodes.push(body.status_code);
        // This known author-posts refusal is an access requirement, not a
        // missing/changed success schema. Only the bound numeric code is used;
        // messages are private and generic codes never infer authentication.
        if (body?.status_code === 2483) {
          if (refusalOnly) successful = null;
          invalidBodies += 1; diagnosticResponses.invalidBodies += 1;
          stopPaging("login-required", "login_required");
          barrier.error = "抖音公开作品接口要求登录（业务状态 2483）；已停止本次读取，未覆盖历史作品";
          return;
        }
        const access = explicitAccessBarrier(body);
        if (access) { if (refusalOnly) successful = null;
          stopPaging(access === "login_required" ? "login-required" : "verification-required", access); return; }
        if (Number.isSafeInteger(body?.status_code) && body.status_code !== 0) {
          if (refusalOnly) successful = null;
          invalidBodies += 1; diagnosticResponses.invalidBodies += 1;
          stopPaging("invalid-body", "upstream_changed"); return;
        }
        if (refusalOnly) return;
        const normalized = normalizeBrowserWorks(body, item.secUid, item.limit);
        if (pagination.accept({ requestCursor: requestCursors.get(request), body, normalized, observedAt: new Date().toISOString() })) {
          successful = pagination.result(diagnosticRequests.matched);
          if (pagination.stopReason) resourceMonitor.markStop();
          nextPageDeadline = null; scrollAttempts = 0; firstFailureAt = null;
          if (!pagination.stopReason) {
            for (const [candidate, held] of provisionalRequests) {
              if (held.generation !== generation || held.cursor !== pagination.expectedCursor) continue;
              if (requests.size >= 32) break;
              provisionalRequests.delete(candidate);
              requests.add(candidate); requestCursors.set(candidate, held.cursor);
              diagnosticRequests.rejected.firstCursor -= 1; diagnosticRequests.matched += 1;
              // Re-enter every existing response/status/body/identity check,
              // but do not manufacture another passive browser event.
              if (held.response) processResponse(held.response);
              break;
            }
          }
        }
      } catch {
        if (refusalOnly) successful = null;
        if (active && !barrier && generation === responseGeneration) { invalidBodies += 1; diagnosticResponses.invalidBodies += 1; recordFailure();
          if (pagination.pages.length) stopPaging("invalid-body", "upstream_changed"); }
      }
    })();
    pending.set(task, { cursor: requestCursors.get(request), generation: responseGeneration, refusalOnly });
    void task.finally(() => pending.delete(task));
  };
  const onResponse = (response) => {
    resourceMonitor.onResponse(response);
    processResponse(response);
  };
  page.on("request", onRequest);
  page.on("framenavigated", onFrameNavigated);
  page.on("response", onResponse);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("requestfinished", resourceMonitor.onFinished);
  page.on("domcontentloaded", onDomContentLoaded);
  page.on("load", onLoad);
  try {
    if (options.signal?.aborted) throw new Error("cancelled");
    const navigation = await bounded(Promise.resolve().then(() => page.goto(`https://www.douyin.com/user/${encodeURIComponent(item.secUid)}`,
      { waitUntil: "commit", timeout: Math.min(20_000, timeoutMs) })).catch((error) => {
        const kind = browserRuntimeErrorKind(error);
        // An old goto command can reject after another real document has
        // committed. Never let that command overwrite independently verified
        // current-document evidence. Error names do not prove ERR_ABORTED;
        // keep the observed command error as optional, fixed diagnostics.
        const newerVerifiedProfile = kind === "error" && commandedNavigationGeneration !== null
          && generation > commandedNavigationGeneration && !barrier && !options.signal?.aborted
          && navigationCommitted && targetNavigationObserved && Number.isInteger(documentStatus)
          && documentStatus >= 200 && documentStatus < 300 && expectedProfile(page.url(), item.secUid)
          && firstScreen?.observation === "observed" && ["interactive", "complete"].includes(firstScreen.readyState)
          && Date.now() < deadline;
        if (newerVerifiedProfile) {
          runtimeDiagnostics.supersededNavigationError = { version: 1, commandedGeneration: commandedNavigationGeneration,
            generation, errorKind: kind, attribution: "goto-command-not-current-document" };
        } else {
          navigationFailed = true; navigationTimedOut = kind === "timeout";
          runtimeDiagnostics.navigationErrorKind = generation <= 1 ? kind : "unknown";
        }
      }), Math.min(20_000, timeoutMs), options.signal);
    if (navigation === timedOut && !options.signal?.aborted) { navigationFailed = true; navigationTimedOut = true;
      runtimeDiagnostics.navigationErrorKind = generation <= 1 ? "timeout" : "unknown"; }
    const awaitingCurrentBody = [...pending.values()].some(read => read.generation === generation && read.cursor === pagination.expectedCursor);
    deadline = successful || awaitingCurrentBody ? totalDeadline : Math.min(totalDeadline, Date.now() + 25_000);
    responseOpportunityDeadline = deadline;
    if (documentRequest) responseOpportunityRequests.add(documentRequest);
    responseWindowStarted = true;
    if (screenAttempts === 0) void observeFirstScreen();
    while (!barrier && Date.now() < totalDeadline) {
      if (Date.now() >= deadline) {
        // Give the normal document its full existing response opportunity.
        // Only genuine absence throughout this attempt permits one late
        // same-origin first-cursor request. A candidate, failure, refusal or
        // pending response is not absence, even across document replacement.
        const mayRequest = responseOpportunityDeadline !== null && Date.now() >= responseOpportunityDeadline
          && !firstPageRequest.attemptCount && !sawWorksCandidate && !sawWorksFailure
          && firstFailureAt === null && !successful && !requests.size && !pending.size
          && firstScreen?.observation === "observed" && ["interactive", "complete"].includes(firstScreen.readyState)
          && typeof page.evaluate === "function" && typeof page.evaluateHandle === "function"
          && canObserveReservedFirstScreen(totalDeadline);
        if (!mayRequest) break;
        const requestGeneration = generation, requestDocument = documentRequest;
        const requestSignal = bodyController.signal;
        const actionExpiresAt = Math.min(totalDeadline, Date.now() + 500);
        let expectedDocument = null;
        firstPageRequest.attemptCount = 1;
        // The existing owner must be able to bind the helper's actual browser
        // events. Remaining total budget is lent only to this one evaluation;
        // an unissued action cannot silently extend natural waiting.
        deadline = totalDeadline;
        try {
          const result = await bounded(Promise.resolve().then(async () => {
            if (requestSignal.aborted || requestGeneration !== generation || requestDocument !== documentRequest
              || !canObserveReservedFirstScreen(totalDeadline) || sawWorksCandidate || sawWorksFailure) return null;
            // Bind the browser object to the verified document, not just the
            // same URL. Playwright cannot serialize an old-context handle into
            // a replacement execution context. Acquisition shares this single
            // 500ms action opportunity and does not renew it.
            const handle = await page.evaluateHandle(() => document);
            if (requestSignal.aborted || Date.now() >= actionExpiresAt || requestGeneration !== generation
              || requestDocument !== documentRequest || !canObserveReservedFirstScreen(totalDeadline)
              || sawWorksCandidate || sawWorksFailure) {
              void Promise.resolve().then(() => handle?.dispose()).catch(() => {});
              return null;
            }
            expectedDocument = handle;
            return page.evaluate(requestBrowserFirstPage, { secUid: item.secUid, limit: Math.min(35, item.requestThreshold ?? item.limit),
              ...(item.startCursor > 0 ? {continuationCursor:item.startCursor} : {}),
              expiresAt: totalDeadline, actionExpiresAt, expectedDocument: handle });
          }), Math.max(1, actionExpiresAt - Date.now()), requestSignal);
          firstPageRequest.state = result === timedOut ? "timeout"
            : ["issued", "blocked", "not-eligible", "unavailable"].includes(result?.state) ? result.state : "unavailable";
        } catch { firstPageRequest.state = "unavailable"; }
        finally { if (expectedDocument) void Promise.resolve().then(() => expectedDocument.dispose()).catch(() => {}); }
        const acceptedRequest = successful || pending.size > 0;
        if (firstPageRequest.state !== "issued" && !acceptedRequest) {
          deadline = Math.min(totalDeadline, responseOpportunityDeadline);
          break;
        }
        if (barrier || options.signal?.aborted || requestSignal.aborted || requestGeneration !== generation
          || requestDocument !== documentRequest) break;
      }
      if (typeof page.evaluate === "function" && shouldObserveReservedFirstScreen({
        active, barrier: Boolean(barrier), successful: Boolean(successful),
        aborted: Boolean(options.signal?.aborted || bodyController.signal.aborted), navigationFailed,
        currentDocumentVerified: canObserveReservedFirstScreen(), attempted: reservedReadinessAttempted,
        generation, documentGeneration: documentRequestGeneration, documentStatus,
        firstScreenCount: screenAttempts, maxFirstScreenObservations: 2,
        worksRequestCount: requests.size, pendingReadCount: pending.size, firstScreen,
        now: Date.now(), startedAt, deadline, totalDeadline,
      })) {
        reservedReadinessAttempted = true;
        const readinessGeneration = generation, readinessRequest = documentRequest, readinessSignal = bodyController.signal;
        try {
          const snapshot = await bounded(Promise.resolve().then(() => {
            if (readinessSignal.aborted || readinessGeneration !== generation || readinessRequest !== documentRequest
              || !canObserveReservedFirstScreen() || screenAttempts !== 1 || firstScreen?.readyState !== "loading") return null;
            return page.evaluate(observeReservedFirstScreenReadiness, { secUid: item.secUid });
          }), Math.max(1, Math.min(500, deadline - Date.now())), readinessSignal);
          if (!readinessSignal.aborted && readinessGeneration === generation && readinessRequest === documentRequest
            && canObserveReservedFirstScreen() && screenAttempts === 1 && firstScreen?.observation === "observed"
            && firstScreen.readyState === "loading" && isReservedFirstScreenReady(snapshot)) {
            await observeFirstScreen("readiness-recheck");
          }
        } catch { /* Optional current-document structure never grants works acceptance or extends a deadline. */ }
      }
      if (activationRebindPending && firstPageActivation.actionCount === 0 && qualificationCount < 8
        && firstScreen?.observation === "observed" && ["interactive", "complete"].includes(firstScreen.readyState)
        && canObserveReservedFirstScreen()) {
        activationGeneration = null; activationFinished = false;
        nextQualificationAt = null; activationRebindPending = false;
      }
      if (firstPageActivation.attemptCount && ((activationGeneration !== null && generation !== activationGeneration) || !canActivateFirstPage())) activationFinished = true;
      const qualificationDue = firstPageActivation.attemptCount && activationGeneration === generation ? Date.now() >= nextQualificationAt
        : activationReadyAt !== null && Date.now() - activationReadyAt >= 1_000;
      if (!activationFinished && qualificationDue
        && firstScreen?.observation === "observed" && ["interactive", "complete"].includes(firstScreen.readyState)
        && typeof page.evaluate === "function" && page.mouse?.move && page.mouse?.wheel && canActivateFirstPage()) {
        await activateFirstPage();
      }
      // Experimental transport is opt-in only in an explicit development
      // harness: its real 403 must not preempt the normal page's full existing
      // response opportunity. Ordinary batch input cannot enable this option.
      // The natural request/list-region action retains priority. A currently
      // unbound candidate also disqualifies the explicit fallback; it is not
      // proof that another arbitrary first cursor should be requested.
      if (options.enableUnverifiedFirstPageRequest === true && !firstPageRequest.attemptCount
        && firstFailureAt === null && diagnosticRequests.candidate === 0
        && activationReadyAt !== null && Date.now() - activationReadyAt >= 1_000
        && firstScreen?.observation === "observed" && ["interactive", "complete"].includes(firstScreen.readyState)
        && typeof page.evaluate === "function" && canObserveReservedFirstScreen()) {
        const requestGeneration = generation, requestDocument = documentRequest;
        firstPageRequest.attemptCount = 1;
        try {
          const result = await bounded(Promise.resolve().then(() => {
            if (requestGeneration !== generation || requestDocument !== documentRequest
              || !canObserveReservedFirstScreen() || diagnosticRequests.candidate !== 0) return null;
            return page.evaluate(requestBrowserFirstPage, { secUid: item.secUid, limit: Math.min(35, item.requestThreshold ?? item.limit), expiresAt: deadline });
          }), Math.max(1, Math.min(500, deadline - Date.now())), bodyController.signal);
          firstPageRequest.state = result === timedOut ? "timeout"
            : ["issued", "blocked", "not-eligible", "unavailable"].includes(result?.state) ? result.state : "unavailable";
        } catch { firstPageRequest.state = "unavailable"; }
      }
      if (successful) {
        if (pagination.stopReason) {
          if ([...pending.values()].some(read => read.generation === generation && read.refusalOnly)) {
            await sleep(Math.min(20, Math.max(1, deadline - Date.now()))); continue;
          }
          break;
        }
        deadline = totalDeadline;
        if (scrolledPageCount !== pagination.pages.length) {
          scrolledPageCount = pagination.pages.length; nextPageDeadline = Date.now() + pageWaitMs;
          scrollProgress = null; scrollHeld = hardGateSeen; scrollRequalifications = 0;
          scrollWaitingProbeCount = 0; scrollNextQualificationAt = null; scrollNextQualificationKind = null; scrollPageActionCount = 0;
        }
        if (!page.mouse?.wheel || !page.mouse?.move) { pagination.stop("scroll-unavailable"); break; }
        // Once the normal page has returned a bound success response, its body
        // owns the existing body/total deadlines. The short request-wait timer
        // must not discard it or initiate another scroll while it is in flight.
        const awaitingCurrentBody = [...pending.values()].some(read => read.generation === generation && read.cursor === pagination.expectedCursor);
        const requestedCurrentPage = [...requestCursors.values()].includes(pagination.expectedCursor);
        if (!awaitingCurrentBody && nextPageDeadline !== null && Date.now() >= nextPageDeadline) {
          const requestedNextPage = [...requestCursors.values()].includes(pagination.expectedCursor);
          pagination.stop("page-timeout", requestedNextPage ? "network_error" : "collector_error"); break;
        }
        if (!awaitingCurrentBody && !requestedCurrentPage && !scrollHeld && scrollAttempts < 8) {
          if (scrollNextQualificationAt !== null && Date.now() < scrollNextQualificationAt) {
            await sleep(Math.min(20, Math.max(1, scrollNextQualificationAt - Date.now()))); continue;
          }
          const scrollGeneration = generation;
          const scrollDocument = documentRequest, scrollCursor = pagination.expectedCursor;
          const scrollDeadline = Math.min(deadline, nextPageDeadline, Date.now() + 1_000);
          let scrollExpired = false;
          let madeScrollProgress = false;
          const allowed = () => {
            try {
              return !scrollExpired && active && !barrier && !hardGateSeen && !options.signal?.aborted && !bodyController.signal.aborted
                && generation === scrollGeneration && Date.now() < scrollDeadline && successful
                && !pagination.stopReason && pagination.expectedCursor === scrollCursor
                && documentRequest === scrollDocument && scrollDocument && documentRequestGeneration === generation
                && Number.isInteger(documentStatus) && documentStatus >= 200 && documentStatus < 300
                && navigationCommitted && targetNavigationObserved
                && scrollDocument.isNavigationRequest() === true && scrollDocument.method() === "GET"
                && scrollDocument.frame() === page.mainFrame() && expectedProfile(scrollDocument.url(), item.secUid)
                && expectedProfile(page.url(), item.secUid)
                && ![...requestCursors.values()].includes(scrollCursor)
                && ![...pending.values()].some(read => read.generation === generation && read.cursor === scrollCursor);
            } catch { return false; }
          };
          const validPoint = point => point?.eligible === true
            && [point.x, point.y, point.deltaY].every(Number.isSafeInteger)
            && point.x >= 0 && point.y >= 0 && point.x <= 20_000 && point.y <= 20_000
            && point.deltaY >= 200 && point.deltaY <= 800;
          const validScroll = value => Number.isSafeInteger(value?.ownerId) && value.ownerId >= 1 && value.ownerId <= 64
            && [value.top, value.clientHeight, value.scrollHeight, value.remaining].every(n => Number.isFinite(n) && n >= 0 && n <= 100_000_000)
            && value.clientHeight > 0 && value.scrollHeight > value.clientHeight
            && value.top <= value.scrollHeight - value.clientHeight + 1
            && Math.abs(value.remaining - Math.max(0, value.scrollHeight - value.clientHeight - value.top)) <= 0.5;
          try {
            const scrolling = await bounded(Promise.resolve().then(async () => {
              // The actual visible works region owns the wheel, not an arbitrary
              // viewport fraction. This structural projection grants no rows or
              // cursor authority. Natural bound requests always take priority.
              if (!allowed() || typeof page.evaluate !== "function") return;
              if (scrollNextQualificationAt !== null) {
                if (scrollNextQualificationKind === "gate") continuationActivation.gateRecheckCount = (continuationActivation.gateRecheckCount ?? 0) + 1;
                else continuationActivation.renderRecheckCount++;
              }
              scrollNextQualificationAt = null; scrollNextQualificationKind = null;
              const point = await page.evaluate(observeFirstPageActivation, { secUid: item.secUid, trackScrollId });
              if (!allowed()) return;
              continuationActivation.probeCount++;
              const structure = sanitizeFirstPageActivationStructure(point?.structure);
              if (structure) continuationActivation.structure = structure;
              rememberHardGate(structure);
              // Passive uncertainty is not permission to act. The gate helper
              // has scanned later candidates for hard gates; only its bounded
              // complete-scan reasons may be requalified, never projection
              // errors, missing DOM methods, explicit gates or a used action.
              if (!hardGateSeen && point?.eligible === false && point.reason === "blocked"
                && structure?.reason === "visible-gate" && structure.gates?.decision === "unknown"
                && ["navigation-absent", "navigation-not-visible", "works-region-unavailable", "works-overlap",
                  "outside-top-zone", "outside-viewport", "oversize", "control-unrecognized"].includes(structure.gates.detail?.reason)
                && scrollPageActionCount === 0) {
                if (++scrollWaitingProbeCount < 8) {
                  continuationActivation.lastBranch = "gate-wait";
                  scrollNextQualificationAt = Date.now() + 250; scrollNextQualificationKind = "gate"; return;
                }
                continuationActivation.lastBranch = "gate-wait-exhausted"; scrollHeld = true; return;
              }
              // The API body may arrive before the visible list has hydrated.
              // Only a unique, visible, gate-free but not-yet-scrollable list
              // gets bounded read-only requalification, before any mouse action.
              // No new cursor/request or page/total deadline is granted here.
              if (point?.eligible === false && point.reason === "no-container" && structure?.reason === "not-scrollable"
                && structure.regionCount === 1 && structure.visibleRegionCount === 1 && structure.leafRegionCount === 1
                && scrollPageActionCount === 0) {
                if (++scrollWaitingProbeCount < 8) {
                  continuationActivation.lastBranch = "render-wait";
                  scrollNextQualificationAt = Date.now() + 250; scrollNextQualificationKind = "render"; return;
                }
                continuationActivation.lastBranch = "render-wait-exhausted"; scrollHeld = true; return;
              }
              if (point?.eligible === false && point.reason === "no-container" && point.structure?.reason === "region-absent"
                && point.structure.regionCount === 0 && point.structure.visibleRegionCount === 0 && point.structure.leafRegionCount === 0) {
                // A verified API page need not populate the page's application
                // list. Its accepted chain, not absence or helper metadata,
                // owns the next cursor. Reuse the same authorised document and
                // full response owner; never invent a cursor or retry refusal.
                scrollHeld = true;
                continuationActivation.lastBranch = "explicit-request";
                if (!Number.isSafeInteger(scrollCursor) || scrollCursor <= 0 || !pagination.pages.length
                  || explicitContinuationCursors.has(scrollCursor) || typeof page.evaluateHandle !== "function") return;
                explicitContinuationCursors.add(scrollCursor);
                const actionExpiresAt = Math.min(scrollDeadline, Date.now() + 500);
                const canContinue = () => allowed() && diagnosticRequests.candidate === diagnosticRequests.matched;
                let expectedDocument = null;
                try {
                  if (!canContinue() || Date.now() >= actionExpiresAt) return;
                  const handle = await page.evaluateHandle(() => document);
                  expectedDocument = handle;
                  if (!canContinue() || Date.now() >= actionExpiresAt) return;
                  const result = await page.evaluate(requestBrowserFirstPage, { secUid: item.secUid, limit: Math.min(35, item.requestThreshold ?? item.limit),
                    continuationCursor: scrollCursor, expiresAt: totalDeadline, actionExpiresAt, expectedDocument: handle });
                  if (allowed() && result?.state === "blocked") stopPaging("verification-required", "blocked");
                } finally {
                  if (expectedDocument) void Promise.resolve().then(() => expectedDocument.dispose()).catch(() => {});
                }
                return;
              }
              if (!validPoint(point) || !validScroll(point.scroll)
                || (scrollProgress && (point.scroll.ownerId !== scrollProgress.ownerId || point.scroll.top < scrollProgress.top - 0.5))) {
                continuationActivation.lastBranch = point?.reason === "blocked" ? "blocked" : "projection-held";
                scrollHeld = true; return;
              }
              scrollPageActionCount++;
              await page.mouse.move(point.x, point.y);
              if (!allowed()) return;
              const current = await page.evaluate(observeFirstPageActivation, { secUid: item.secUid, trackScrollId });
              if (!allowed()) return;
              continuationActivation.probeCount++;
              const currentStructure = sanitizeFirstPageActivationStructure(current?.structure);
              if (currentStructure) continuationActivation.structure = currentStructure;
              rememberHardGate(currentStructure);
              if (!validPoint(current) || !validScroll(current.scroll)
                || current.scroll.ownerId !== point.scroll.ownerId || Math.abs(current.scroll.top - point.scroll.top) > 0.5) {
                continuationActivation.lastBranch = current?.reason === "blocked" ? "blocked" : "projection-held";
                scrollHeld = true; return;
              }
              if (current.x !== point.x || current.y !== point.y) {
                // One changed viewport point may stabilize, but it needs a new
                // qualification and move. Never reuse this now-retired point.
                continuationActivation.lastBranch = "hover-changed";
                scrollRequalifications += 1; scrollHeld = scrollRequalifications >= 2; return;
              }
              scrollAttempts += 1;
              continuationActivation.actionCount++; continuationActivation.lastBranch = "scroll-issued";
              await page.mouse.wheel(0, current.deltaY);
              // wheel() dispatches, it does not await movement. Confirm bounded
              // physical progress on the same DOM owner before any next action.
              const movementDeadline = Math.min(scrollDeadline, Date.now() + 160);
              while (allowed() && Date.now() < movementDeadline) {
                const after = await page.evaluate(observeFirstPageActivation, { secUid: item.secUid, trackScrollId });
                if (!allowed()) return;
                const afterStructure = sanitizeFirstPageActivationStructure(after?.structure);
                if (afterStructure) continuationActivation.structure = afterStructure;
                rememberHardGate(afterStructure);
                if (!validScroll(after?.scroll) || after.scroll.ownerId !== current.scroll.ownerId
                  || after.scroll.top < current.scroll.top - 0.5) {
                  continuationActivation.lastBranch = after?.reason === "blocked" ? "blocked" : "projection-held";
                  scrollHeld = true; return;
                }
                if (after.scroll.top > current.scroll.top + 0.5) {
                  scrollProgress = after.scroll;
                  madeScrollProgress = true;
                  continuationActivation.lastBranch = "progress";
                  scrollHeld = after.scroll.remaining <= 1 || after.eligible !== true;
                  return;
                }
                await sleep(Math.min(20, Math.max(1, movementDeadline - Date.now())));
              }
              if (allowed()) { continuationActivation.lastBranch = "no-progress"; scrollHeld = true; }
            }), Math.max(1, scrollDeadline - Date.now()), bodyController.signal);
            if (scrolling === timedOut && !barrier) {
              continuationActivation.lastBranch = "scroll-timeout";
              if (nextPageDeadline !== null && Date.now() >= nextPageDeadline)
                pagination.stop("page-timeout", requestedCurrentPage ? "network_error" : "collector_error");
              else stopPaging("scroll-failed", "collector_error");
              break;
            }
          } catch { continuationActivation.lastBranch = "scroll-error"; stopPaging("scroll-failed", "collector_error"); break; }
          finally { scrollExpired = true; }
          if (madeScrollProgress && !scrollHeld && scrollAttempts < 8) continue;
        }
      }
      if ((navigationFailed || firstFailureAt !== null) && !pending.size
        && (navigationFailed || Date.now() - firstFailureAt >= failureGraceMs)) break;
      if (deadline - Date.now() <= 250) void terminalStructure.observe();
      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    // The absolute deadline can win the race against a still-pending refusal
    // body. Do not let an already-read continuation turn that unresolved head
    // into success while cleanup is about to abort the only rejection owner.
    if ([...pending.values()].some(read => read.generation === generation && read.refusalOnly)) {
      successful = null;
      if (!barrier) stopPaging('deadline', 'collector_error');
    }
    if (retryAfterReads.size) await Promise.allSettled([...retryAfterReads]);
    if (!successful) {
      const failureDiagnostics = diagnostics(navigationTimedOut ? "navigation-timeout" : navigationFailed ? "navigation-failed"
        : diagnosticResponses.bodyTimeouts ? "body-timeout" : diagnosticResponses.invalidBodies ? "invalid-body"
          : rejectedStatuses.length ? "http-rejection" : !diagnosticRequests.matched ? "no-bound-request" : "deadline");
      const transport = classifyBrowserWorksFailure({ httpStatuses: rejectedStatuses, pageUrl: page.url(), failureDiagnostics });
      return {
        key: item.key, status: "unavailable", worksCoverage: "unavailable", posts: [],
        failureDiagnostics, pagination: pagination.result(diagnosticRequests.matched).pagination,
        ...(retryAfter ? { retryAfter } : {}),
        ...(barrier ? { errorCode: barrier.errorCode, error: barrier.error || "浏览器作品采集遇到明确拒绝、验证要求或中断；已停止，未覆盖历史作品" }
          : invalidBodies && transport.errorCode === "network_error"
          ? { errorCode: "upstream_changed", error: "公开作品业务状态或正文未通过校验；未将错误响应视为空作品，未覆盖历史作品" }
          : transport),
      };
    }
    if (!pagination.stopReason) pagination.stop(options.signal?.aborted ? "cancelled" : "deadline", "collector_error");
    const normalized = pagination.result(diagnosticRequests.matched);
    // A response without an explicit pagination terminator is not a usable
    // works observation for persistence.  Keep the bounded diagnostics and
    // page evidence for retry/audit, but do not expose the verified rows as a
    // successful limited collection: the missing boundary is an upstream
    // contract break, not proof of an account with no further works.
    if (normalized.pagination.stopReason === "unknown-pagination") {
      return {
        key: item.key, status: "unavailable", worksCoverage: "unavailable", posts: [],
        hasMore: normalized.hasMore, maxCursor: normalized.maxCursor,
        pagination: normalized.pagination,
        errorCode: "upstream_changed",
        error: "公开作品分页边界缺失；未将有限页面写入成功采集结果",
        failureDiagnostics: diagnostics("invalid-body"),
      };
    }
    return {
      key: item.key, status: "ok", worksCoverage: normalized.coverage,
      ...(item.startCursor !== undefined && pagination.startCursor === undefined ? { continuationReset: 'natural-head' } : {}),
      failureDiagnostics: diagnostics(pagination.errorCode
        ? rejectedStatuses.length ? "http-rejection" : diagnosticResponses.invalidBodies ? "invalid-body"
          : diagnosticResponses.bodyTimeouts ? "body-timeout" : "deadline" : "success"),
      posts: normalized.posts, hasMore: normalized.hasMore, maxCursor: normalized.maxCursor,
      pagination: normalized.pagination,
      ...(retryAfter ? { retryAfter } : {}),
      ...(pagination.errorCode ? { errorCode: pagination.errorCode, error: "浏览器续页采集已停止；仅保留本轮已核验作品，未冒充完整历史" } : {}),
      warning: normalized.coverage === "latest-public-window" ? "浏览器仅证明本轮有限公开作品；未冒充完整历史" : null,
    };
  } catch (error) {
    return { key: item.key, status: "unavailable", worksCoverage: "unavailable", posts: [], ...safeBrowserCollectorException(error), failureDiagnostics: diagnostics("collector-exception") };
  } finally {
    resourceMonitor.markStop();
    terminalStructure.close();
    active = false;
    options.signal?.removeEventListener("abort", onAbort);
    generation += 1;
    bodyController.abort();
    requests.clear();
    provisionalRequests.clear();
    page.off("request", onRequest);
    page.off("framenavigated", onFrameNavigated);
    page.off("response", onResponse);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    page.off("requestfinished", resourceMonitor.onFinished);
    page.off("domcontentloaded", onDomContentLoaded);
    page.off("load", onLoad);
    if (options[RESOURCE_MONITOR]) { resourceMonitor.attach(); resourceMonitor.publish("attempt-return"); }
    else resourceMonitor.close("attempt-return");
  }
}

export async function collectBrowserWorks(payload, { executablePath = process.env.DOUYIN_CHROME_PATH || DEFAULT_CHROME, runtime = {}, collectOptions = {} } = {}) {
  // Offline regression adapters must supply all browser operations. The real
  // Playwright fallback has been removed; reject before reading stored state.
  if (typeof runtime.launch !== "function" && !(typeof runtime.launchServer === "function" && typeof runtime.connect === "function")) throw retiredDouyinBrowserError();
  const items = normalizeBrowserCollectorInput(payload);
  const ownership = runtime.ownership ?? null;
  // Only the private hello ACK owns this budget. Uploaded data cannot set it.
  const ownedRemaining = typeof ownership?.remainingExecutionMs === "function"
    ? () => ownership.remainingExecutionMs() : null;
  const ownedCleanupReserveMs = 6_500;
  // Standalone batch ceiling; the one-account provider sets its own parent budget.
  const batchDeadline = Date.now() + Math.min(deadlineOption(collectOptions.batchTimeoutMs, 850_000, 850_000),
    ownedRemaining ? Math.max(0, ownedRemaining() - ownedCleanupReserveMs) : Infinity);
  const workRemaining = () => Math.min(batchDeadline - Date.now(), ownedRemaining ? ownedRemaining() - ownedCleanupReserveMs : Infinity);
  const remaining = maximum => Math.max(1, Math.min(maximum, workRemaining()));
  const requireWorkBudget = () => { if (workRemaining() <= 0) throw new Error("浏览器作品批次已达到时间上限；账号本次缺采"); };
  let ordinaryCleanupDeadlineNs = null;
  const cleanupRemaining = (maximum, kill = false) => {
    if (!ownedRemaining) return maximum;
    if (kill) return Math.max(1, Math.min(maximum, ownedRemaining() - 3_500));
    if (ordinaryCleanupDeadlineNs === null) ordinaryCleanupDeadlineNs = process.hrtime.bigint()
      + BigInt(Math.floor(Math.max(0, Math.min(2_000, ownedRemaining() - 4_500)) * 1_000_000));
    return Math.max(1, Math.min(maximum, Number(ordinaryCleanupDeadlineNs - process.hrtime.bigint()) / 1_000_000,
      ownedRemaining() - 4_500));
  };
  requireWorkBudget();
  const state = await bounded(Promise.resolve().then(() => (runtime.readState ?? readAuthorisedState)()), remaining(10_000));
  if (state === timedOut) throw new Error("浏览器会话读取超时");
  requireWorkBudget();
  const executable = await bounded(Promise.resolve().then(() => (runtime.access ?? access)(executablePath)), remaining(10_000));
  if (executable === timedOut) throw new Error("浏览器可执行文件检查超时");
  let browser, browserServer, registeredPid, context;
  try {
    requireWorkBudget();
    const options = { executablePath, headless: true, timeout: remaining(30_000) };
    if (runtime.launch) browser = await openBoundedResource(() => runtime.launch(options), remaining(30_000));
    else {
      await ownership?.send("launch");
      requireWorkBudget();
      browserServer = await openBoundedResource(() => runtime.launchServer({ ...options, host: "127.0.0.1", port: 0 }), remaining(30_000));
      const processHandle = browserServer.process();
      if (!Number.isSafeInteger(processHandle?.pid) || processHandle.pid <= 1) throw new Error("浏览器未提供私有进程所有权凭证");
      await ownership?.send("register", processHandle.pid);
      registeredPid = processHandle.pid;
      requireWorkBudget();
      browser = await openBoundedResource(() => runtime.connect(browserServer.wsEndpoint(), { timeout: remaining(5_000) }), remaining(5_000));
    }
    requireWorkBudget();
    context = await openBoundedResource(() => browser.newContext({ storageState: state, locale: "zh-CN", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36" }), remaining(10_000));
    const results = [];
    for (const item of items) {
      let page, resourceMonitor, cdpMonitor, workController, workTimer;
      ordinaryCleanupDeadlineNs = null;
      try {
        requireWorkBudget();
        // A fresh page is an account isolation boundary, not a new login or a
        // challenge bypass. It cannot inherit delayed requests from last user.
        page = await openBoundedResource(() => context.newPage(), remaining(10_000));
        requireWorkBudget();
        const accountDeadline = Date.now() + Math.min(remaining(45_000), deadlineOption(collectOptions.timeoutMs, 45_000, 45_000));
        // Never attach to injected/test/browser-user runtimes lacking our registered PID.
        if (registeredPid && typeof context.newCDPSession === 'function') {
          cdpMonitor = await observePrivatePageCdp(context, page, item.secUid, Math.max(1, accountDeadline - Date.now()));
        }
        if (Date.now() >= accountDeadline) throw new Error("浏览器作品账号已达到时间上限；账号本次缺采");
        resourceMonitor = observePageResources(page, item.secUid, cdpMonitor);
        if (ownedRemaining) {
          workController = new AbortController();
          workTimer = setTimeout(() => workController.abort(), remaining(45_000));
        }
        results.push(await collectOne(page, item, { ...collectOptions, [RESOURCE_MONITOR]: resourceMonitor,
          ...(workController ? { signal: collectOptions.signal ? AbortSignal.any([collectOptions.signal, workController.signal]) : workController.signal } : {}),
          timeoutMs: Math.max(1, Math.min(accountDeadline - Date.now(), remaining(45_000))) }));
      }
      catch (error) { results.push({ key: item.key, status: "unavailable", worksCoverage: "unavailable", posts: [], ...safeBrowserCollectorException(error), failureDiagnostics: unknownBrowserWorksDiagnostics() }); }
      finally {
        clearTimeout(workTimer);
        resourceMonitor?.beginCleanup();
        const closing = page ? await bounded(Promise.resolve().then(async () => {
          try { await page.close(); } finally { await cdpMonitor?.close(); }
        }).catch(() => {}), cleanupRemaining(2_000)) : undefined;
        // If page.close never resolves, the sidecar still stops synchronously
        // now; detachment is bounded by the existing context/browser cleanup.
        if (closing === timedOut) void cdpMonitor?.close().catch(() => {});
        resourceMonitor?.close(closing === timedOut ? "page-close-timeout" : "page-close-return");
      }
      if (results.length < items.length && workRemaining() > 0) await sleep(remaining(500));
    }
    return { items: results, provenance: { mode: "douyin-authorised-browser-post-response", sessionLoaded: true,
      authorisedSessionUsed: true, authenticated: null, authenticationStatus: "not-verified", paidAPI: false, runtimeAI: false, noChallengeBypass: true } };
  } finally {
    if (context) await bounded(Promise.resolve().then(() => context.close()).catch(() => {}), cleanupRemaining(2_000));
    if (browser) await bounded(Promise.resolve().then(() => browser.close()).catch(() => {}), cleanupRemaining(2_000));
    if (browserServer) {
      await bounded(Promise.resolve().then(() => browserServer.close()).catch(() => {}), cleanupRemaining(2_000));
      const processHandle = browserServer.process();
      if (processHandle.exitCode === null && processHandle.signalCode === null)
        await bounded(Promise.resolve().then(() => browserServer.kill()).catch(() => {}), cleanupRemaining(1_000, true));
      if (processHandle.exitCode === null && processHandle.signalCode === null) throw new Error("浏览器进程清理未获确认");
      if (registeredPid) await ownership?.send("released", registeredPid);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await reportRetiredDouyinBrowserCommand();
