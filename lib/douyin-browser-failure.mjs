// Failure evidence is deliberately limited to HTTP status and an official
// login URL. Never accept response bodies, headers, cookies or raw exceptions
// as output: a browser exception may include a signed request URL.
function isOfficialLoginUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.hostname !== "douyin.com" && !url.hostname.endsWith(".douyin.com")) return false;
    return /^(?:login|passport)\./i.test(url.hostname) || /\/(?:login|passport)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

export function classifyBrowserWorksFailure({ httpStatuses = [], pageUrl = "", failureDiagnostics } = {}) {
  const statuses = Array.isArray(httpStatuses) ? httpStatuses.filter(Number.isInteger) : [];
  // Explicit authentication rejection wins over other failed attempts. The
  // remaining order preserves the existing provider's global-gate contract.
  if (statuses.includes(401)) return {
    errorCode: "login_required",
    error: "抖音浏览器会话已失效或被要求登录（HTTP 401）；请重新完成抖音授权",
  };
  if (statuses.includes(403)) return {
    errorCode: "blocked",
    error: "抖音公开作品请求被平台拒绝（HTTP 403）；稍后自动重试，未覆盖历史作品",
  };
  if (statuses.includes(429)) return {
    errorCode: "rate_limited",
    error: "抖音公开作品请求触发限流（HTTP 429）；稍后自动重试，未覆盖历史作品",
  };
  if (isOfficialLoginUrl(pageUrl)) return {
    errorCode: "login_required",
    error: "抖音浏览器会话已失效或被要求登录；请重新完成抖音授权",
  };
  // No bound request is an observation failure, not evidence of a failed
  // network connection. Keep collector_error's existing transient cooldown.
  if (!statuses.length && failureDiagnostics?.version === 1
    && failureDiagnostics.stopReason === "no-bound-request"
    && failureDiagnostics.requests?.matched === 0
    && failureDiagnostics.navigation?.failed === false
    && failureDiagnostics.navigation?.timedOut === false) return {
    errorCode: "collector_error",
    error: failureDiagnostics.requests.candidate > 0
      ? "抖音浏览器作品候选请求未通过当前账号首屏归属校验；未取得作品证据，未覆盖历史作品"
      : "抖音浏览器未观察到当前账号的公开作品请求；原因尚未确认，未覆盖历史作品",
  };
  return {
    errorCode: "network_error",
    error: "抖音浏览器公开作品请求未返回可读取响应；连接或响应异常，稍后自动重试，未覆盖历史作品",
  };
}

const SAFE_LOCAL_ERRORS = new Map([
  ["浏览器作品采集缺少账号", "collector_error"],
  ["浏览器作品采集单批不能超过 32 个账号", "collector_error"],
  ["浏览器作品采集需要合法 sec_uid", "collector_error"],
  ["未配置抖音浏览器会话；请先在本机完成抖音授权", "login_required"],
  ["抖音浏览器会话文件权限过宽；仅允许当前用户读取", "collector_error"],
  ["抖音浏览器会话文件不可读取；请重新授权", "login_required"],
  ["抖音浏览器会话为空；请重新授权", "login_required"],
  ["浏览器公开作品响应缺少 aweme_list；未将其视为空作品", "collector_error"],
]);

export function safeBrowserCollectorException(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (SAFE_LOCAL_ERRORS.has(message)) return { errorCode: SAFE_LOCAL_ERRORS.get(message), error: message };
  return {
    errorCode: "collector_error",
    error: "抖音浏览器采集未完成；内部异常详情未输出，未覆盖历史作品",
  };
}
