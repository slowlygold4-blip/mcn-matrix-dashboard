import { withBrowserAccessGate } from './browser-access-gate.mjs';

/**
 * Serialized into the already-authorised current profile document. This is
 * one explicit same-origin GET, not signature construction or HTTP replay.
 * The legacy default is always cursor0. Only the collector's already accepted
 * pagination chain can pass its private, strictly positive continuation cursor.
 * It returns action metadata only. The existing request/response owner must
 * independently verify the response before any business data is accepted.
 */
export const requestBrowserFirstPage = withBrowserAccessGate(function requestBrowserFirstPage({ secUid, limit, expiresAt, actionExpiresAt, expectedDocument, continuationCursor } = {}) {
  /* MCN_FIXED_ACCESS_GATE */
  const unavailable = { state: "not-eligible" };
  try {
    if (!/^MS4wLj[\w-]{12,220}$/.test(secUid ?? "") || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now() || expiresAt - Date.now() > 45_000) return unavailable;
    if (continuationCursor !== undefined && (!Number.isSafeInteger(continuationCursor) || continuationCursor <= 0)) return unavailable;
    // Optional private dispatch guard: a queued evaluation may not start an
    // action after its short owner opportunity, or in a replacement document.
    // The original expiresAt still owns the independently verified response.
    if (actionExpiresAt !== undefined && (!Number.isSafeInteger(actionExpiresAt)
      || actionExpiresAt <= Date.now() || actionExpiresAt > expiresAt
      || actionExpiresAt - Date.now() > 500)) return unavailable;
    if (expectedDocument !== undefined && expectedDocument !== document) return unavailable;
    const profile = new URL(location.href);
    if (profile.origin !== "https://www.douyin.com" || profile.username || profile.password
      || ![`/user/${secUid}`, `/user/${secUid}/`].includes(profile.pathname)
      || !["interactive", "complete"].includes(document.readyState)
      || typeof window.fetch !== "function") return unavailable;
    if (observeBrowserAccessGate().blocked) return { state: "blocked" };
    // Fixed public parameters only; no cookie export, custom headers, signer,
    // arbitrary first cursor, SDK injection, alternate host or credential replay.
    const params = new URLSearchParams({ device_platform: "webapp", aid: "6383",
      channel: "channel_pc_web", sec_user_id: secUid, max_cursor: String(continuationCursor ?? 0),
      count: String(Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 35) : 18) });
    if (Date.now() >= expiresAt || (actionExpiresAt !== undefined && Date.now() >= actionExpiresAt)
      || (expectedDocument !== undefined && expectedDocument !== document) || location.href !== profile.href) return unavailable;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, expiresAt - Date.now()));
    try {
      // Do not consume, cancel, return or reinterpret the response body here.
      // Browser events, the original absolute deadline and page cleanup own it.
      Promise.resolve(window.fetch(`/aweme/v1/web/aweme/post/?${params}`, {
        method: "GET", credentials: "same-origin", redirect: "error", signal: controller.signal,
      })).catch(() => {}).finally(() => clearTimeout(timer));
      return { state: "issued" };
    } catch { clearTimeout(timer); controller.abort(); return { state: "unavailable" }; }
  } catch { return { state: "unavailable" }; }
});
