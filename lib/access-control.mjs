import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";

const SESSION_COOKIE = "douyin_monitor_session";
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };
const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message, code = "request_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashSecret(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeInviteCode(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function makeInviteCode() {
  const compact = randomBytes(16).toString("hex").toUpperCase();
  return compact.match(/.{1,4}/g).join("-");
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return cookies;
}

export function clientIp(request) {
  return String(request.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

function joinRateLimitIp(request) {
  // Only the explicitly configured local Cloudflare tunnel is allowed to
  // identify visitors. Arbitrary forwarded headers must never split a bucket.
  if (process.env.TRUST_PROXY === "cloudflare" && isLoopbackRequest(request) && request.headers?.["cf-ray"]) {
    const forwarded = String(request.headers?.["cf-connecting-ip"] ?? "").trim();
    if (isIP(forwarded)) return forwarded;
  }
  return clientIp(request);
}

export function isLoopbackRequest(request) {
  const address = clientIp(request);
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function isLocalHostHeader(host) {
  const value = String(host ?? "").trim();
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

// A tunnel terminates on the same loopback socket as a local browser. Never
// infer that such a request is the owner just from the socket address: public
// proxy headers must opt it out, otherwise every anonymous tunnel visitor
// would inherit the local admin session.
function hasProxyHeaders(request) {
  const headers = request.headers ?? {};
  return [
    "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    "x-real-ip", "true-client-ip", "cf-ray", "cf-connecting-ip", "cf-visitor",
  ].some((name) => String(headers[name] ?? "").trim() !== "");
}

function isDirectLocalOwnerRequest(request) {
  return isLoopbackRequest(request) && isLocalHostHeader(request.headers?.host) && !hasProxyHeaders(request);
}

function trustedCloudflareScheme(request) {
  // The app normally runs directly over HTTP on localhost/LAN. When it is
  // intentionally published behind Cloudflare Tunnel, the browser speaks
  // HTTPS to Cloudflare while the tunnel speaks HTTP to this process. Only
  // accept forwarded protocol headers when the request also carries the
  // Cloudflare identity headers; never trust arbitrary proxy headers.
  // cloudflared is expected to be the immediate peer. Requiring a loopback
  // peer prevents a remote client from forging Cloudflare headers to alter
  // cookie security or same-origin decisions.
  if (process.env.TRUST_PROXY !== "cloudflare" || !isLoopbackRequest(request)) return null;
  if (!request.headers?.["cf-ray"] || !request.headers?.["cf-connecting-ip"]) return null;
  const forwarded = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  try {
    const visitor = JSON.parse(String(request.headers["cf-visitor"] ?? ""));
    if (visitor?.scheme === "https" || visitor?.scheme === "http") return visitor.scheme;
  } catch {}
  return null;
}

export function requestProtocol(request) {
  return request.socket?.encrypted ? "https" : (trustedCloudflareScheme(request) || "http");
}

function isHttps(request) {
  return requestProtocol(request) === "https";
}

function setCookie(response, value, request) {
  const secure = isHttps(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ABSOLUTE_MS / 1000)}${secure}`);
}

function clearCookie(response, request) {
  const secure = isHttps(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function sessionTimes(now = new Date()) {
  return {
    createdAt: now.toISOString(),
    idleExpiresAt: new Date(now.getTime() + IDLE_MS).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_MS).toISOString(),
  };
}

function createSession(database, user, request, response) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const times = sessionTimes();
  database.createSession({
    tokenHash: hashSecret(token), userId: user.id, csrfToken, ...times,
    clientIp: clientIp(request), userAgent: request.headers["user-agent"],
  });
  setCookie(response, token, request);
  return { user, csrfToken, absoluteExpiresAt: times.absoluteExpiresAt };
}

function permissionsFor(role) {
  return {
    view: ROLE_LEVEL[role] >= ROLE_LEVEL.viewer,
    edit: ROLE_LEVEL[role] >= ROLE_LEVEL.editor,
    administer: ROLE_LEVEL[role] >= ROLE_LEVEL.admin,
  };
}

export function privateLanUrls(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const ip = entry.address;
      if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) urls.push(`http://${ip}:${port}/`);
    }
  }
  return [...new Set(urls)];
}

export class AccessControl {
  constructor(database, { port }) {
    this.database = database;
    this.port = port;
    this.joinAttempts = new Map();
  }

  cleanAttempts(now = Date.now()) {
    for (const [ip, attempts] of this.joinAttempts) {
      const current = attempts.filter((time) => time > now - 10 * 60_000);
      if (current.length) this.joinAttempts.set(ip, current);
      else this.joinAttempts.delete(ip);
    }
  }

  rateLimitJoin(request) {
    this.cleanAttempts();
    const ip = joinRateLimitIp(request);
    const attempts = this.joinAttempts.get(ip) ?? [];
    if (attempts.length >= 10) throw new HttpError(429, "邀请码尝试过多，请 10 分钟后再试", "rate_limited");
    attempts.push(Date.now());
    this.joinAttempts.set(ip, attempts);
  }

  assertSameOrigin(request) {
    const fetchSite = String(request.headers["sec-fetch-site"] ?? "");
    if (fetchSite === "cross-site") throw new HttpError(403, "已拒绝跨站请求", "cross_site");
    const origin = request.headers.origin;
    if (!origin) return;
    const protocol = requestProtocol(request);
    const expected = `${protocol}://${request.headers.host}`;
    if (origin !== expected) throw new HttpError(403, "请求来源不匹配", "origin_mismatch");
  }

  getToken(request) {
    return parseCookies(request.headers.cookie)[SESSION_COOKIE] ?? null;
  }

  getSession(request) {
    const token = this.getToken(request);
    if (!token) return null;
    const now = new Date();
    return this.database.getSession(hashSecret(token), {
      now: now.toISOString(), idleExpiresAt: new Date(now.getTime() + IDLE_MS).toISOString(),
    });
  }

  authenticate(request, response, { allowLocalOwner = true } = {}) {
    let session = this.getSession(request);
    // A local-owner cookie is only valid for a direct local browser request.
    // In particular, reject stale owner cookies arriving through a tunnel.
    if (session?.user?.authSource === "local-owner" && !isDirectLocalOwnerRequest(request)) session = null;
    if (!session && allowLocalOwner && isDirectLocalOwnerRequest(request)) {
      const owner = this.database.ensureLocalOwner();
      session = createSession(this.database, owner, request, response);
      this.database.recordActivity({
        userId: owner.id, actorName: owner.displayName, action: "session.local", resourceType: "session", clientIp: clientIp(request),
      });
    }
    if (!session) throw new HttpError(401, "需要邀请码才能访问此工作台", "authentication_required");
    request.auth = session;
    return session;
  }

  requireRole(request, role) {
    const actual = ROLE_LEVEL[request.auth?.user?.role] ?? 0;
    if (actual < ROLE_LEVEL[role]) throw new HttpError(403, "当前账号没有执行此操作的权限", "insufficient_role");
  }

  verifyMutation(request) {
    this.assertSameOrigin(request);
    const csrf = String(request.headers["x-csrf-token"] ?? "");
    if (!csrf || csrf !== request.auth?.csrfToken) throw new HttpError(403, "安全校验失败，请刷新页面后重试", "csrf_failed");
  }

  sessionPayload(session) {
    return {
      authenticated: true,
      user: session.user,
      permissions: permissionsFor(session.user.role),
      csrfToken: session.csrfToken,
      absoluteExpiresAt: session.absoluteExpiresAt,
      localOwner: session.user.authSource === "local-owner",
    };
  }

  sessionInfo(request, response) {
    return this.sessionPayload(this.authenticate(request, response));
  }

  join(request, response, { code, displayName }) {
    this.rateLimitJoin(request);
    this.assertSameOrigin(request);
    const normalized = normalizeInviteCode(code);
    const name = String(displayName ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (normalized.length !== 32) throw new HttpError(401, "邀请码无效或已失效", "invalid_invite");
    if (name.length < 2) throw new HttpError(400, "请输入至少 2 个字的显示名称", "invalid_name");
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const times = sessionTimes();
    const user = this.database.consumeInvite({
      codeHash: hashSecret(normalized), displayName: name, tokenHash: hashSecret(token), csrfToken, ...times,
      clientIp: clientIp(request), userAgent: request.headers["user-agent"],
    });
    if (!user) throw new HttpError(401, "邀请码无效、已过期或使用次数已满", "invalid_invite");
    setCookie(response, token, request);
    this.database.recordActivity({ userId: user.id, actorName: user.displayName, action: "invite.join", resourceType: "session", clientIp: clientIp(request) });
    return this.sessionPayload({ user, csrfToken, absoluteExpiresAt: times.absoluteExpiresAt });
  }

  logout(request, response) {
    const token = this.getToken(request);
    if (token) this.database.revokeSession(hashSecret(token));
    clearCookie(response, request);
  }

  createInvite(request, { role, label, hours = 24, maxUses = 1 }) {
    if (!['viewer', 'editor'].includes(role)) throw new HttpError(400, "邀请码权限必须是查看者或编辑者", "invalid_role");
    const duration = Math.min(168, Math.max(1, Math.trunc(Number(hours) || 24)));
    const uses = Math.min(20, Math.max(1, Math.trunc(Number(maxUses) || 1)));
    const code = makeInviteCode();
    const normalized = normalizeInviteCode(code);
    const createdAt = new Date();
    const id = this.database.createInvite({
      codeHash: hashSecret(normalized), role, label: String(label ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      createdBy: request.auth.user.id, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + duration * 60 * 60_000).toISOString(), maxUses: uses,
    });
    return { id, code, role, hours: duration, maxUses: uses };
  }

  accessOverview() {
    this.database.purgeExpiredAccess();
    const access = this.database.listAccess();
    return { ...access, lanUrls: privateLanUrls(this.port), onlineCount: access.members.filter((member) => member.activeSessionCount > 0).length };
  }
}
