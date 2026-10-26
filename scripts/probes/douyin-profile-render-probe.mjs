#!/usr/bin/env node
// Isolated, read-only one-page investigation. Never imports provider or database.
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { collectorOwnershipClient, createOwnedCollectorExecutor } from "../../lib/collector-ownership.mjs";
import { isExpectedDouyinFirstWorksResponseUrl } from "../../lib/douyin-browser-response-identity.mjs";

const HERE = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FAIL = code => Object.assign(new Error("read-only probe stopped"), { code });
const CODES = new Set(["invalid-input", "state-unavailable", "deadline", "http-rejection", "navigation-changed", "page-gate", "cleanup-unconfirmed", "local-error"]);
export function validateProbeInput(input) {
  if (!input || !/^MS4wLj[\w-]{12,220}$/.test(input.secUid ?? "") || !/^\d{5,25}$/.test(input.uid ?? "")) throw FAIL("invalid-input");
  return { secUid: input.secUid, uid: input.uid };
}
function profileMatches(value, secUid) {
  try {
    if (typeof value !== "string" || value.length > 4_096) return false;
    const u = new URL(value), contentKeys = new Set(["modal_id", "aweme_id", "video_id"]);
    const fragment = u.hash.slice(1), fragmentParams = new URLSearchParams(fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : fragment);
    const changesContent = [...u.searchParams.keys(), ...fragmentParams.keys()]
      .some(key => contentKeys.has(key.replace(/^[/?#]+/, "").toLowerCase()));
    return u.origin === "https://www.douyin.com" && !u.username && !u.password
      && [`/user/${secUid}`, `/user/${secUid}/`].includes(u.pathname) && !changesContent;
  } catch { return false; }
}
export function sanitizeRenderProjection(value) {
  const count = item => Number.isSafeInteger(item) && item >= 0 && item <= 10_000 ? item : null;
  const bool = item => typeof item === "boolean" ? item : null;
  return { gate: ["none", "challenge", "authentication-dialog"].includes(value?.gate) ? value.gate : "unknown",
    renderPresent: bool(value?.renderPresent), renderValid: bool(value?.renderValid),
    schema: ["unknown", "over-limit", "app-uninterpreted", "legacy-user-post"].includes(value?.schema) ? value.schema : "unknown",
    candidateNodes: count(value?.candidateNodes), postCount: count(value?.postCount),
    profileIdentityMatches: bool(value?.profileIdentityMatches), postIdentityMatches: count(value?.postIdentityMatches),
    postIdentityConflicts: count(value?.postIdentityConflicts), worksRegionPresent: bool(value?.worksRegionPresent) };
}

/** Executed in the page. Returns fixed keys only; no JSON/body/ID is returned. */
export function projectRenderEvidence({ secUid, uid }) {
  const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none");
  const anyVisible = selector => [...document.querySelectorAll(selector)].slice(0, 100).some(visible);
  const challenge = anyVisible('[id^="captcha"],[class*="captcha"],iframe[src*="/captcha/"],[data-e2e="verify-dialog"]');
  // An ordinary navigation login button is not a login wall.
  const authDialog = anyVisible('[role="dialog"] input[type="tel"],[role="dialog"] input[type="password"],form[action*="/login"] input');
  const result = { gate: challenge ? "challenge" : authDialog ? "authentication-dialog" : "none",
    renderPresent: false, renderValid: false, schema: "unknown", candidateNodes: 0,
    postCount: null, profileIdentityMatches: null, postIdentityMatches: null, postIdentityConflicts: null,
    worksRegionPresent: anyVisible('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]') };
  if (result.gate !== "none") return result;
  const node = document.querySelector('script#RENDER_DATA[type="application/json"]');
  if (!node) return result;
  result.renderPresent = true;
  const encoded = node.textContent;
  if (typeof encoded !== "string" || encoded.length > 2_000_000) { result.schema = "over-limit"; return result; }
  let value;
  try {
    const decoded = encoded.trim().startsWith("{") ? encoded : decodeURIComponent(encoded);
    if (decoded.length > 2_000_000) { result.schema = "over-limit"; return result; }
    value = JSON.parse(decoded);
  } catch { return result; }
  let visited = 0;
  const queue = [{ value, depth: 0 }];
  while (queue.length) {
    const item = queue.pop();
    if (++visited > 10_000 || item.depth > 14) { result.schema = "over-limit"; return result; }
    if (item.value && typeof item.value === "object") {
      const keys = Object.keys(item.value);
      if (keys.length > 1_000) { result.schema = "over-limit"; return result; }
      for (const key of keys) queue.push({ value: item.value[key], depth: item.depth + 1 });
    }
  }
  if (!value || Array.isArray(value) || typeof value !== "object") return result;
  result.renderValid = true;
  const candidates = Object.entries(value).filter(([key, item]) => /^\d+$/.test(key) && item && typeof item === "object"
    && item.user && item.post && Array.isArray(item.post.data));
  result.candidateNodes = candidates.length;
  if (candidates.length !== 1) { result.schema = value.app && typeof value.app === "object" ? "app-uninterpreted" : "unknown"; return result; }
  result.schema = "legacy-user-post";
  const branch = candidates[0][1], user = branch.user?.user;
  result.postCount = branch.post.data.length;
  result.profileIdentityMatches = Boolean(user && (user.secUid ?? user.sec_uid) === secUid && user.uid === uid);
  let matched = 0, conflicts = 0;
  for (const post of branch.post.data) {
    const author = post?.authorInfo;
    if (author?.secUid === secUid && author?.uid === uid) matched++;
    else conflicts++;
  }
  result.postIdentityMatches = matched; result.postIdentityConflicts = conflicts;
  return result;
}

export async function runReadOnlyProbe(input, runtime = {}) {
  const expected = validateProbeInput(input);
  const started = Date.now(), deadline = started + 34_000;
  const remaining = cap => Math.max(1, Math.min(cap, deadline - Date.now()));
  const bounded = async (promise, ms) => {
    let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(FAIL("deadline")), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const ownership = runtime.ownership ?? collectorOwnershipClient();
  let server, browser, context, page, pid, documentRequest = null, observed = false, committed = false, stopCode = null;
  const statuses = new Set();
  const worksRequests = new Set();
  let observedDocumentStatus = null;
  const stop = code => { stopCode ??= code; if (page) void page.close().catch(() => {}); };
  try {
    const statePath = resolve(process.env.DOUYIN_ACCOUNT_BROWSER_STATE || process.env.DOUYIN_TOPIC_BROWSER_STATE || resolve(ROOT, "data/douyin-topic-browser-state.json"));
    const state = await bounded((runtime.readState ?? (async () => {
      const meta = await stat(statePath);
      if ((meta.mode & 0o077) !== 0 || meta.size > 2_000_000) throw FAIL("state-unavailable");
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      if (!Array.isArray(parsed.cookies) || !parsed.cookies.length) throw FAIL("state-unavailable");
      return parsed;
    }))(), remaining(2_000));
    await ownership?.send("launch");
    const opening = (runtime.launchServer ?? (options => chromium.launchServer(options)))({
      executablePath: process.env.DOUYIN_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true, timeout: remaining(10_000), host: "127.0.0.1", port: 0 });
    try { server = await bounded(opening, remaining(10_000)); }
    catch (error) { void opening.then(late => late.kill().catch(() => {}), () => {}); throw error; }
    pid = server.process()?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) throw FAIL("local-error");
    await ownership?.send("register", pid);
    browser = await bounded((runtime.connect ?? ((endpoint, options) => chromium.connect(endpoint, options)))(server.wsEndpoint(), { timeout: remaining(3_000) }), remaining(3_000));
    context = await bounded(browser.newContext({ storageState: state, locale: "zh-CN", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36" }), remaining(3_000));
    page = await bounded(context.newPage(), remaining(3_000));
    page.on("request", request => {
      try {
        if (request.frame() !== page.mainFrame()) return;
        if (request.isNavigationRequest()) {
          // A server redirect stays in the initial navigation only when its
          // Request links to the previous bound hop. A reload starts a new one.
          if (!profileMatches(request.url(), expected.secUid)
            || (observed && request.redirectedFrom?.() !== documentRequest)) return stop("navigation-changed");
          documentRequest = request; observed = true; return;
        }
        if (committed && request.method() === "GET" && isExpectedDouyinFirstWorksResponseUrl(request.url(), expected.secUid)) worksRequests.add(request);
      } catch { /* Unbound traffic is never evidence. */ }
    });
    page.on("framenavigated", frame => {
      if (frame !== page.mainFrame()) return;
      committed = observed && profileMatches(frame.url(), expected.secUid);
      if (!committed) stop("navigation-changed");
    });
    page.on("response", response => {
      try {
        const request = response.request();
        const isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame() && profileMatches(request.url(), expected.secUid);
        if (!isDocument && !worksRequests.has(request)) return;
        const status = response.status();
        if (Number.isInteger(status) && status >= 100 && status <= 599) statuses.add(status);
        if (isDocument) observedDocumentStatus = status;
        if ([401, 403, 429].includes(status)) stop("http-rejection");
      } catch { /* Never read response bodies, headers or transport error text. */ }
    });
    await bounded(page.goto(`https://www.douyin.com/user/${encodeURIComponent(expected.secUid)}`, { waitUntil: "domcontentloaded", timeout: remaining(18_000) }), remaining(18_000));
    if (stopCode) throw FAIL(stopCode);
    if (!observed || !committed || !profileMatches(page.url(), expected.secUid)) throw FAIL("navigation-changed");
    const result = sanitizeRenderProjection(await bounded(page.evaluate(projectRenderEvidence, expected), remaining(2_000)));
    if (stopCode) throw FAIL(stopCode);
    if (result.gate !== "none") throw FAIL("page-gate");
    return { ok: true, readOnly: true, documentStatus: observedDocumentStatus, profileURLExact: true, domReady: true,
      httpStatuses: [...statuses].slice(0, 10), evidence: result, elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, readOnly: true, code: stopCode || (CODES.has(error?.code) ? error.code : "local-error"),
      documentStatus: observedDocumentStatus, httpStatuses: [...statuses].slice(0, 10), elapsedMs: Date.now() - started };
  } finally {
    if (page) await bounded(page.close().catch(() => {}), 1_000).catch(() => {});
    if (context) await bounded(context.close().catch(() => {}), 1_000).catch(() => {});
    if (browser) await bounded(browser.close().catch(() => {}), 1_000).catch(() => {});
    if (server) {
      await bounded(server.close().catch(() => {}), 1_000).catch(() => {});
      const process = server.process();
      if (process.exitCode === null && process.signalCode === null) await bounded(server.kill().catch(() => {}), 1_000).catch(() => {});
      if (process.exitCode === null && process.signalCode === null) throw FAIL("cleanup-unconfirmed");
      await ownership?.send("released", pid);
    }
  }
}

async function main() {
  let source = "";
  for await (const chunk of process.stdin) { source += chunk; if (source.length > 2_048) throw FAIL("invalid-input"); }
  const input = validateProbeInput(JSON.parse(source));
  if (process.argv.includes("--child")) {
    const ownership = collectorOwnershipClient();
    await ownership?.send("hello");
    const result = await runReadOnlyProbe(input, { ownership });
    await ownership?.send("complete");
    process.stdout.write(JSON.stringify(result));
    if (process.connected) process.disconnect();
    return;
  }
  const executor = createOwnedCollectorExecutor();
  const result = await new Promise(resolve => {
    const child = executor.exec(process.execPath, [HERE, "--child"], { timeout: 45_000, cleanupTimeoutMs: 3_000, maxBuffer: 32_000 }, (error, stdout) => {
      if (error) return resolve({ ok: false, code: "ownership-or-process-failure", cleanup: executor.state() });
      try { resolve({ ...JSON.parse(stdout), cleanup: executor.state(), cleanupConfirmed: true }); }
      catch { resolve({ ok: false, code: "invalid-probe-output", cleanup: executor.state() }); }
    });
    child?.stdin?.end(JSON.stringify(input));
  });
  process.stdout.write(JSON.stringify(result));
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, code: "probe-stopped", readOnly: true }));
  if (process.connected) process.disconnect();
  process.exitCode = 1;
});
