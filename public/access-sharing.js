// Share-origin policy is deliberately kept separate from the UI.  A LAN
// address is useful to an administrator, but it must never be presented as a
// public invitation endpoint.  Public links are only accepted over HTTPS.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalized(value, { allowHttp = true } = {}) {
  try {
    const url = new URL(String(value || ""));
    if (!["https:", ...(allowHttp ? ["http:"] : [])].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function ipv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function isPrivateHostname(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || LOOPBACK.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const octets = ipv4(host);
  if (octets) {
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // IPv6 loopback, unique-local (fc00::/7), and link-local (fe80::/10).
  return host.includes(":") && (host === "::1" || /^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host));
}

export function isPublicShareOrigin(value) {
  const origin = normalized(value, { allowHttp: false });
  if (!origin) return false;
  return !isPrivateHostname(new URL(origin).hostname);
}

function isQuickTunnel(value) {
  try {
    return /^[a-z0-9-]+\.trycloudflare\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function freshMatchingQuickTunnel(origin, publicEntry, now) {
  const candidate = normalized(origin, { allowHttp: false });
  const entryOrigin = normalized(publicEntry?.url, { allowHttp: false });
  const updatedAt = Date.parse(publicEntry?.updatedAt || "");
  if (!candidate || !isQuickTunnel(candidate) || candidate !== entryOrigin || publicEntry?.status !== "running"
    || !Number.isFinite(updatedAt) || now - updatedAt > 90_000 || updatedAt - now > 30_000) return false;
  return true;
}

export function managementOriginLabel(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "入口待确认";
    if (LOOPBACK.has(url.hostname.toLowerCase())) return "本机后台";
    if (isPrivateHostname(url.hostname)) return "局域网后台（仅同网）";
    return url.protocol === "https:" ? "HTTPS 入口（可达性待验证）" : "HTTP 非安全入口";
  } catch {
    return "入口待确认";
  }
}

/**
 * Prefer the server's freshly read public entry, then the current HTTPS
 * origin.  Local addresses are retained only as an explicit same-network
 * fallback, so the UI can explain why a remote invitation is unavailable.
 */
export function preferredShareOrigin({ currentOrigin = "", publicBaseUrl = "", publicEntry = null, lanUrls = [], now = Date.now() } = {}) {
  const configured = normalized(publicBaseUrl, { allowHttp: false });
  if (configured && isPublicShareOrigin(configured)
    && (!isQuickTunnel(configured) || freshMatchingQuickTunnel(configured, publicEntry, now))) return configured;
  const current = normalized(currentOrigin);
  if (current && isPublicShareOrigin(current)
    && (!isQuickTunnel(current) || freshMatchingQuickTunnel(current, publicEntry, now))) return current;
  for (const candidate of Array.isArray(lanUrls) ? lanUrls : []) {
    const lan = normalized(candidate);
    if (lan) return lan;
  }
  if (current && isQuickTunnel(current)) return null;
  return current;
}

export function shareOriginDescription(origin) {
  const value = normalized(origin);
  if (!value) return { public: false, origin: null, kind: "missing" };
  const publicOrigin = isPublicShareOrigin(value);
  return { public: publicOrigin, origin: value, kind: publicOrigin ? "https" : "lan" };
}

export function shareEntryHint({ origin, publicEntry } = {}) {
  if (!origin) return "本机没有可分享地址；请先从管理员提供的 HTTPS 入口打开。";
  if (!isPublicShareOrigin(origin)) return "当前为局域网地址，仅同一网络可用；请先配置公网 HTTPS 入口再发送邀请。";
  const selected = normalized(origin, { allowHttp: false });
  const entryMatches = selected === normalized(publicEntry?.url, { allowHttp: false });
  if (entryMatches && publicEntry?.status === "configured") {
    return "已配置公网 HTTPS 入口，但尚未验证外网可达性；请先在目标网络确认能够打开并登录。";
  }
  if (entryMatches && publicEntry?.status === "running") {
    return "临时公网入口已连接，依赖本机与隧道持续运行；请在目标网络确认能够打开并登录。";
  }
  return "当前页面使用 HTTPS；其他网络的可达性尚未验证，请在目标网络确认能够打开并登录。";
}
