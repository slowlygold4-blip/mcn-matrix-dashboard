import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeCollection, normalizePost } from "./normalize.mjs";
import { deriveCollectionHealth } from "../collection-health.mjs";
import { verifyDouyinAliasContinuity } from "../identity-continuity.mjs";
import { getDouyinLifecycleEvidence } from "../account-lifecycle.mjs";
import { getSourceWorkIdentityRequest, verifySourceWorkIdentity, verifyHistoricalSourceWorkIdentity } from "../source-work-identity.mjs";
import { validatedBrowserPagination, isOfficialDeferredProfileEnvelope, isOfficialScheduledProfileEnvelope } from "../official-profile-evidence.mjs";
import { identityProxyEnvironment } from "../identity-proxy.mjs";
import { checksum, nowIso, safeJson } from "../utils.mjs";
import { isSupportedAccountPlatform, platformCapabilityError } from "../platform-contract.mjs";
import { WorksRequestPolicy, WORKS_ENDPOINT, worksErrorCode } from "../works-request-policy.mjs";
import { sanitizeBrowserWorksDiagnostics } from "../douyin-browser-diagnostics.mjs";
import { readVerifiedTopicIdentity } from "../topic-identity-reuse.mjs";
import { ownedCollectorExecutor, safeOwnershipFailure } from "../collector-ownership.mjs";
import { projectWorksOnlyFailure } from "../works-only-failure.mjs";
import { readBrowserWorksSettings } from "../browser-works-settings.mjs";
import { readTrustedWorksResume } from "../works-observation.mjs";
import { browserRetryAfterPolicyInput } from "../browser-retry-after.mjs";
import { repairDouyinShareLink } from '../douyin-share-link-repair.mjs';
import { normalizeAuthorisedDetailInput, validateAuthorisedDetailResult } from '../douyin-authorised-detail.mjs';
import { normalizeWorkAuthorCandidateInput, validateWorkAuthorCandidateResult } from '../douyin-work-author-candidate.mjs';

const helperPath = fileURLToPath(new URL("../../scripts/douyin_public_collector.py", import.meta.url));
const browserResolverPath = fileURLToPath(new URL("../../scripts/douyin_browser_resolver.mjs", import.meta.url));
const browserCollectorPath = fileURLToPath(new URL("../../scripts/douyin_browser_collector.mjs", import.meta.url));
const authorisedDetailPath = fileURLToPath(new URL('../../scripts/douyin_authorised_detail.mjs', import.meta.url));
const workAuthorCandidatePath = fileURLToPath(new URL('../../scripts/douyin_work_author_candidate.mjs', import.meta.url));
// Exactly one account. The shared ownership supervisor starts shutdown at
// 147 seconds and reserves 3 seconds for verified cleanup inside this budget.
// Browser launch/connect and ownership handshakes do not extend this deadline.
const BROWSER_WORKS_SINGLE_ITEM_TIMEOUT_MS = 150_000;
const WORKS_ONLY_TIMEOUT_MS = 45_000;
const WORKS_ONLY_ERRORS = new Set(["blocked", "login_required", "rate_limited", "network_error", "collector_error", "upstream_changed"]);
const topicBrowserResolverPath = fileURLToPath(new URL("../../scripts/douyin_topic_browser_resolver.mjs", import.meta.url));
const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const BILIBILI_UID_RE = /^\d{2,20}$/;
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const BILIBILI_VIEW_ENDPOINT = "https://api.bilibili.com/x/web-interface/view";
const BILIBILI_VIDEO_HOSTS = new Set(["bilibili.com", "www.bilibili.com"]);
const B23_HOSTS = new Set(["b23.tv", "www.b23.tv"]);

function boundedSignal(timeoutMs, shutdownSignal = null) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return shutdownSignal ? AbortSignal.any([shutdownSignal, timeoutSignal]) : timeoutSignal;
}

function authorEvidencePlatform(item) {
  const explicit = String(item?.platform ?? item?.metadata?.platform ?? "").trim().toLowerCase();
  if (["douyin", "bilibili", "xiaohongshu"].includes(explicit)) return explicit;
  if (String(item?.key ?? "").startsWith("bilibili:")) return "bilibili";
  if (String(item?.key ?? "").startsWith("xiaohongshu:")) return "xiaohongshu";
  return "douyin";
}

function parseHttpsUrl(value, allowedHosts, label) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error(`${label}不是合法 URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(`${label}必须是无账号信息、无自定义端口的 HTTPS 链接`);
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) throw new Error(`${label}域名不受信任`);
  return url;
}

function bvidFromBilibiliVideoUrl(value) {
  const url = parseHttpsUrl(value, BILIBILI_VIDEO_HOSTS, "B站视频链接");
  const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
  if (!match) throw new Error("B站视频链接未包含合法 BV 号");
  return match[1];
}

function directBilibiliEvidence(value) {
  const text = String(value ?? "").trim();
  const bvid = BVID_RE.test(text) ? text : bvidFromBilibiliVideoUrl(text);
  return {
    bvid,
    sourceEvidenceUrl: `https://www.bilibili.com/video/${bvid}`,
  };
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return response.headers.get(name);
  const headers = response?.headers ?? {};
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

async function parseBoundedJson(response, label) {
  let text;
  if (typeof response?.text === "function") {
    text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error(`${label}响应超过 2MB 安全限制`);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`${label}未返回合法 JSON：${error.message}`);
    }
  }
  if (typeof response?.json === "function") return response.json();
  throw new Error(`${label}响应不可读取`);
}

async function resolveB23Evidence(fetchImpl, value, shutdownSignal = null) {
  const sourceEvidenceUrl = String(value ?? "").trim();
  let currentUrl = parseHttpsUrl(sourceEvidenceUrl, B23_HOSTS, "B站 b23 短链");
  for (let redirectCount = 0; redirectCount < 4; redirectCount += 1) {
    const response = await fetchImpl(currentUrl.href, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      },
      credentials: "omit",
      redirect: "manual",
      signal: boundedSignal(15_000, shutdownSignal),
    });
    const status = Number(response?.status ?? 0);
    if (status < 300 || status >= 400) throw new Error(`B站 b23 短链未返回安全重定向（HTTP ${status || "未知"}）`);
    const location = responseHeader(response, "location");
    if (!location) throw new Error("B站 b23 短链重定向缺少 Location");

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error("B站 b23 短链返回了无效重定向地址");
    }
    if (nextUrl.protocol !== "https:" || nextUrl.username || nextUrl.password || nextUrl.port) {
      throw new Error("B站 b23 短链重定向不是安全 HTTPS 地址");
    }
    const hostname = nextUrl.hostname.toLowerCase();
    if (BILIBILI_VIDEO_HOSTS.has(hostname)) {
      return {
        bvid: bvidFromBilibiliVideoUrl(nextUrl.href),
        sourceEvidenceUrl,
      };
    }
    if (!B23_HOSTS.has(hostname)) throw new Error("B站 b23 短链重定向到了非 bilibili.com 域名，已拒绝");
    currentUrl = nextUrl;
  }
  throw new Error("B站 b23 短链重定向次数超过安全限制");
}

async function fetchBilibiliOwner(fetchImpl, evidence, shutdownSignal = null) {
  const endpoint = `${BILIBILI_VIEW_ENDPOINT}?bvid=${encodeURIComponent(evidence.bvid)}`;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      referer: `https://www.bilibili.com/video/${evidence.bvid}`,
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    },
    credentials: "omit",
    redirect: "error",
    signal: boundedSignal(20_000, shutdownSignal),
  });
  if (!response?.ok) throw new Error(`B站官方 view 接口 HTTP ${response?.status ?? "未知"}`);
  const payload = await parseBoundedJson(response, "B站官方 view 接口");
  if (payload?.code !== 0) throw new Error(`B站官方 view 接口返回 code=${String(payload?.code ?? "缺失")}`);

  const returnedBvid = String(payload?.data?.bvid ?? "").trim();
  if (returnedBvid !== evidence.bvid) {
    throw new Error(`B站官方 view 回显 BVID 与请求不一致（请求 ${evidence.bvid}，回显 ${returnedBvid || "缺失"}）`);
  }
  const canonicalId = String(payload?.data?.owner?.mid ?? "").trim();
  if (!BILIBILI_UID_RE.test(canonicalId)) throw new Error("B站官方 view 未回显 2-20 位数字 owner.mid");

  const evidenceUrl = `https://www.bilibili.com/video/${evidence.bvid}`;
  return {
    platform: "bilibili",
    canonicalId,
    canonicalUrl: `https://space.bilibili.com/${canonicalId}`,
    nickname: String(payload?.data?.owner?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null,
    videoId: evidence.bvid,
    sourceEvidenceUrl: evidence.sourceEvidenceUrl,
    evidenceUrl,
    endpoint,
    provenance: "bilibili-official-anonymous-view",
  };
}

async function resolveBilibiliAuthor(fetchImpl, item, shutdownSignal = null) {
  const key = String(item?.key ?? "").slice(0, 300);
  const directValues = [
    ...(Array.isArray(item?.videoIds) ? item.videoIds : []),
    item?.videoId,
  ].filter((value) => String(value ?? "").trim());
  const shareValues = [
    ...(Array.isArray(item?.shareUrls) ? item.shareUrls : []),
    item?.shareUrl,
  ].filter((value) => String(value ?? "").trim());
  const errors = [];
  const evidenceTasks = [
    ...directValues.map(async (value) => directBilibiliEvidence(value)),
    ...shareValues.map(async (value) => {
      const text = String(value ?? "").trim();
      let parsed;
      try {
        parsed = new URL(text);
      } catch {
        throw new Error("B站分享链接不是合法 URL");
      }
      if (B23_HOSTS.has(parsed.hostname.toLowerCase())) return resolveB23Evidence(fetchImpl, text, shutdownSignal);
      return directBilibiliEvidence(text);
    }),
  ];
  if (!evidenceTasks.length) {
    return { key, candidates: [], errors: [{ error: "缺少 B站 BV 号、官方视频链接或 b23 短链" }] };
  }

  const evidenceResults = await Promise.allSettled(evidenceTasks);
  const evidence = [];
  for (const result of evidenceResults) {
    if (result.status === "fulfilled") evidence.push(result.value);
    else errors.push({ error: String(result.reason?.message ?? result.reason).slice(0, 300) });
  }
  const uniqueEvidence = [...new Map(evidence.map((entry) => [
    `${entry.bvid}\u0000${entry.sourceEvidenceUrl}`,
    entry,
  ])).values()];
  const candidateResults = await Promise.allSettled(uniqueEvidence.map((entry) => fetchBilibiliOwner(fetchImpl, entry, shutdownSignal)));
  const candidates = [];
  for (const result of candidateResults) {
    if (result.status === "fulfilled") candidates.push(result.value);
    else errors.push({ error: String(result.reason?.message ?? result.reason).slice(0, 300) });
  }
  return { key, candidates, errors };
}

function throwIfCancelled(signal, error = null) {
  signal?.throwIfAborted();
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
}

function worksOnlyFailure(code, attempted = false) {
  return Object.assign(new Error(`独立作品采集未完成（${code}）；未重采主页或写入观察`), { code, attempted });
}

function exactInstant(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function compactPublicAuthorIdentity(author) {
  // Keep raw public handle text alongside the validated canonical/uid pair.
  // No numeric conversion, trimming, nickname inference or target binding.
  const identity = {};
  for (const [key, pattern] of [["unique_id", /^[A-Za-z0-9_.-]{1,100}$/], ["short_id", /^[0-9]{1,25}$/]]) {
    const value = author[key];
    if (typeof value === "string" && pattern.test(value)) identity[key] = value;
  }
  return identity;
}

// This is a strict projection, not a second pagination implementation. The
// same ledger validator used by profile merges and DB commits owns that logic.
function worksOnlyResult(item, { key, secUid, uid, limit, requestThreshold, startedAt, finishedAt, startCursor }) {
  const unavailable = (errorCode, failure = { failureStage: "provider-validation" }) => ({ status: "unavailable", posts: [], errorCode,
    ...projectWorksOnlyFailure(failure) });
  if (!item || item.key !== key || !Array.isArray(item.posts) || item.posts.length > limit) return unavailable("upstream_changed");
  const pageDiagnostics = projectWorksOnlyFailure({ failureDiagnostics: item.failureDiagnostics });
  const pageFailure = { ...pageDiagnostics, failureStage: "browser-page" };
  if (item.status === "unavailable" && item.posts.length === 0) {
    return unavailable(WORKS_ONLY_ERRORS.has(item.errorCode) ? item.errorCode : "collector_error", pageFailure);
  }
  if (item.status !== "ok" || (item.errorCode != null && !WORKS_ONLY_ERRORS.has(item.errorCode))) return unavailable("upstream_changed");
  const posts = [], ids = new Set();
  for (const post of item.posts) {
    if (typeof post?.aweme_id !== "string" || !/^\d{15,25}$/.test(post.aweme_id) || ids.has(post.aweme_id)
      || post.author?.sec_uid !== secUid || post.author?.uid !== uid
      || (post.statistics != null && (typeof post.statistics !== "object" || Array.isArray(post.statistics)))) return unavailable("upstream_changed");
    const statistics = {};
    for (const field of ["digg_count", "comment_count", "share_count", "collect_count", "play_count"]) {
      const value = post.statistics?.[field];
      if (value == null) continue;
      if (!Number.isSafeInteger(value) || value < 0) return unavailable("upstream_changed");
      statistics[field] = value;
    }
    ids.add(post.aweme_id);
    posts.push({ aweme_id: post.aweme_id, author: { sec_uid: secUid, uid, ...compactPublicAuthorIdentity(post.author) }, statistics,
      desc: typeof post.desc === "string" ? post.desc.slice(0, 2000) : "",
      create_time: Number.isSafeInteger(post.create_time) && post.create_time >= 0 ? post.create_time : null });
  }
  const pagination = validatedBrowserPagination(item.pagination, { limit, posts,
    hasMore: item.hasMore, maxCursor: item.maxCursor, notBefore: startedAt, notAfter: Date.parse(finishedAt), startCursor });
  const policyVersion = pagination?.version === 3 ? pagination.baseVersion : pagination?.version;
  if (!pagination || pagination.errorCode !== (item.errorCode ?? null)
    || (requestThreshold === undefined ? policyVersion !== 1 : policyVersion !== 2 || pagination.requestThreshold !== requestThreshold)) return unavailable("upstream_changed");
  return { status: "ok", posts, hasMore: item.hasMore, maxCursor: item.maxCursor, pagination,
    worksCoverage: "limited", errorCode: item.errorCode ?? null, ...pageDiagnostics };
}

function safeBrowserWorksExecError(stage, value = null) {
  const ownership = safeOwnershipFailure(value);
  if (ownership) stage = ["BROWSER_COLLECTOR_EXIT", "BROWSER_COLLECTOR_TIMEOUT", "BROWSER_OUTPUT_LIMIT", "BROWSER_SPAWN_FAILED"].includes(ownership.code)
    ? "collector-process" : "collector-ownership";
  return Object.assign(new Error("浏览器作品采集未完成；仅保留固定失败分类"), {
    ...(ownership ? { code: ownership.code } : {}),
    ...(ownership?.ownershipBranch ? { ownershipBranch: ownership.ownershipBranch } : {}),
    worksErrorCode: WORKS_ONLY_ERRORS.has(value?.worksErrorCode) ? value.worksErrorCode : "collector_error",
    ...projectWorksOnlyFailure({ failureStage: stage, failureCode: ownership?.code, failureBranch: ownership?.ownershipBranch,
      failureDiagnostics: value?.failureDiagnostics }),
  });
}

function runExecFile(execFileImpl, file, args, options, input = null, { safeBrowserWorks = false } = {}) {
  throwIfCancelled(options.signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFileImpl(file, args, options, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      try { throwIfCancelled(options.signal, error); } catch (cancelled) { return reject(cancelled); }
      const ownershipError = safeOwnershipFailure(error);
      if (ownershipError) return reject(safeBrowserWorks ? safeBrowserWorksExecError("collector-ownership", ownershipError) : ownershipError);
      const output = String(stdout ?? "").trim();
      let parsed;
      try { parsed = JSON.parse(output); } catch {}
      if (safeBrowserWorks) {
        if (parsed?.ok === false) return reject(safeBrowserWorksExecError("collector-envelope", {
          worksErrorCode: parsed.errorCode, failureDiagnostics: parsed.failureDiagnostics,
        }));
        if (error) return reject(safeBrowserWorksExecError("collector-process"));
        if (parsed?.ok !== true || !parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
          return reject(safeBrowserWorksExecError("collector-protocol"));
        }
        return resolve(parsed.data);
      }
      if (parsed && parsed.ok === false) return reject(new Error(parsed.error || "公开采集器返回失败"));
      if (error) return reject(new Error(parsed?.error || String(stderr ?? "").trim() || `公开采集器退出：${error.message}`));
      if (!parsed?.ok || !parsed.data) return reject(new Error("公开采集器未返回合法结果"));
      resolve(parsed.data);
    });
    if (input !== null && !settled) {
      if (!child?.stdin) {
        settled = true;
        reject(safeBrowserWorks ? safeBrowserWorksExecError("collector-protocol") : new Error("公开采集器无法接收批量核验输入"));
      } else {
        child.stdin.end(input);
      }
    }
  });
}

function hashtagNames(raw) {
  const names = [];
  for (const extra of raw?.text_extra ?? []) {
    if (extra?.hashtag_name) names.push(String(extra.hashtag_name).replace(/^#/, ""));
  }
  return names;
}

function targetPlatform(target) {
  const explicit = String(target?.metadata?.platform ?? "").trim().toLowerCase();
  // Preserve an explicit future/unknown platform so collect() can reject it
  // loudly. Falling back to Douyin here would mix metrics across platforms.
  if (explicit) return explicit;
  const locator = String(target?.locator ?? "").toLowerCase();
  if (locator.includes("bilibili.com")) return "bilibili";
  if (locator.includes("xiaohongshu.com") || locator.includes("xhslink.com")) return "xiaohongshu";
  return "douyin";
}

function bilibiliMidFromLocator(locator) {
  const value = String(locator ?? "").trim();
  if (BILIBILI_UID_RE.test(value)) return value;
  return /space\.bilibili\.com\/(\d{2,20})(?:\/|$)/i.exec(value)?.[1] ?? null;
}

function publicNumber(value) {
  // XHS display abbreviations are not precise observations. Do not expand
  // units, round decimals, coerce objects/booleans, or accept unsafe integers.
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)$/.test(text)) return null;
  const numeric = Number(text.replaceAll(",", ""));
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function xiaohongshuUserId(locator) {
  return /xiaohongshu\.com\/user\/profile\/([0-9a-z]+)/i.exec(String(locator ?? ""))?.[1] ?? null;
}

function verifiedAccountIdentity(target, raw, platform, database = null, sourceEvidenceEvent = null) {
  const profile = raw?.profile?.user ?? raw?.profile?.user_info ?? raw?.user ?? raw?.user_info ?? {};
  const expected = platform === "bilibili"
    ? (/^\d{2,20}$/.test(String(target?.locator ?? "")) ? String(target.locator) : "")
    : platform === "xiaohongshu"
      ? (xiaohongshuUserId(target?.locator) ?? "")
      : (SEC_UID_RE.test(String(target?.locator ?? "")) ? String(target.locator) : "");
  const observed = platform === "douyin"
    ? String(profile?.sec_uid ?? profile?.secUid ?? "").trim()
    : String(profile?.uid ?? profile?.mid ?? profile?.user_id ?? profile?.userId ?? "").trim();
  const platformLabel = platform === "bilibili" ? "B站" : platform === "xiaohongshu" ? "小红书" : "抖音";
  if (expected && !observed) throw new Error(`${platformLabel}公开主页未回显可核验的账号 ID`);
  if (expected && observed !== expected) throw new Error(`${platformLabel}公开主页回显的账号 ID 与提交目标不一致；本次未写入`);

  // Jixuan's roster contains a display ID that can legitimately drift while
  // the canonical sec_uid remains stable. Those imports explicitly declare
  // sec_uid as the identity key and retain the submitted ID only as audit
  // context; do not reject a valid public profile because of that hint.
  let aliasEvent = null;
  if (platform === "douyin" && target?.metadata?.douyinId && target?.metadata?.accountIdMode !== "sec_uid-primary") {
    const expectedDouyinId = String(target.metadata.douyinId).normalize("NFKC").replace(/^@/, "").trim().toLowerCase();
    const observedIds = [profile?.unique_id, profile?.short_id, profile?.uid]
      .map((value) => String(value ?? "").normalize("NFKC").replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean);
    if (!observedIds.includes(expectedDouyinId)) {
      aliasEvent = verifyDouyinAliasContinuity(database, target, raw);
      if (!aliasEvent && !sourceEvidenceEvent) {
        const error = new Error("公开主页回显的抖音号与表格提交值不一致，且缺少完整改号连续性证据；本次未写入");
        error.code = "DOUYIN_SUBMITTED_ID_MISMATCH";
        throw error;
      }
    }
  }

  return {
    platform,
    accountId: observed || expected || null,
    nickname: String(profile?.nickname ?? profile?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null,
    verifiedAt: nowIso(),
    mode: "official-public-profile-identity",
    ...(aliasEvent ? { aliasEvent } : {}),
    ...(sourceEvidenceEvent ? { sourceEvidenceEvent } : {}),
  };
}

function finalizeCollectionHealth(target, collection, raw) {
  const health = deriveCollectionHealth(target, collection.snapshot, collection.warnings, raw);
  return { ...collection, ...health };
}

function replaceUndefinedTokens(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (source.startsWith("undefined", index)) {
      const before = source[index - 1] ?? "";
      const after = source[index + 9] ?? "";
      if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) {
        output += "null";
        index += 8;
        continue;
      }
    }
    output += char;
  }
  return output;
}

function extractXiaohongshuInitialState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("小红书官方主页未包含公开初始数据");
  const start = markerIndex + marker.length;
  const end = html.indexOf("</script>", start);
  if (end < 0) throw new Error("小红书官方主页初始数据不完整");
  const source = html.slice(start, end).trim().replace(/;$/, "");
  try {
    return JSON.parse(replaceUndefinedTokens(source));
  } catch (error) {
    throw new Error(`小红书官方主页初始数据解析失败：${error.message}`);
  }
}

function unwrapReactive(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.prototype.hasOwnProperty.call(value, "_value")) return value._value;
  if (Object.prototype.hasOwnProperty.call(value, "value")) return value.value;
  return value;
}

function flattenXiaohongshuNotes(value) {
  const notes = unwrapReactive(value);
  if (!Array.isArray(notes)) return [];
  return notes.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item && typeof item === "object");
}

export class PublicWebProvider {
  constructor(settings = {}, options = {}) {
    this.settings = Object.freeze({ ...settings });
    const browserPolicy = readBrowserWorksSettings(this.settings);
    this.browserWorksHardLimit = browserPolicy.mode === 'whole-page-v2' ? browserPolicy.hardLimit : undefined;
    this.browserRequestThreshold = browserPolicy.mode === 'whole-page-v2' ? browserPolicy.requestThreshold : undefined;
    this.now = options.now ?? Date.now;
    this.database = options.database;
    this.pythonPath = options.pythonPath || process.env.PYTHON_BIN || "/usr/bin/python3";
    this.execFileImpl = options.execFileImpl || execFile;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    // Automatic author resolution must stay on the same no-browser, anonymous
    // route as daily monitoring. A browser probe remains an explicit opt-in
    // for controlled diagnostics, never an implicit production fallback.
    const requestedResolver = options.authorResolverMode ?? process.env.DOUYIN_AUTHOR_RESOLVER_MODE ?? "signed-only";
    this.authorResolverMode = requestedResolver === "browser-first" ? "browser-first" : "signed-only";
    // Deliberately separate from anonymous resolution and account works. This
    // single-item adapter is not an automatic retry after an access refusal.
    this.authorisedDetailEnabled = options.authorisedDetailEnabled === true;
    this.workAuthorCandidateEnabled = options.workAuthorCandidateEnabled === true;
    // Account works are kept on the anonymous collector by default.  The
    // browser fallback is explicit because it consumes an authorised local
    // session and is much slower than the public HTTP path.  It only runs
    // after a profile succeeded and the works endpoint was unavailable.
    const requestedAccountBrowser = options.accountBrowserFallback ?? process.env.DOUYIN_ACCOUNT_BROWSER_FALLBACK ?? "off";
    this.accountBrowserFallback = ["1", "true", "browser", "browser-fallback"].includes(String(requestedAccountBrowser).toLowerCase());
    // Preserve legacy gate diagnostics; decisions are now endpoint/transport
    // scoped and one account's 403 cannot close the entire browser lane.
    this.accountBrowserGate = null;
    this.accountBrowserGateError = null;
    this.worksRequestPolicy = new WorksRequestPolicy(options.worksRequestPolicyOptions);
    this.restoreWorksRequestPolicy();
    const requestedTopicResolver = options.topicResolverMode ?? process.env.DOUYIN_TOPIC_RESOLVER_MODE ?? "public";
    this.topicResolverMode = ["browser", "browser-first"].includes(requestedTopicResolver) ? requestedTopicResolver : "public";
    this.topicBrowserBatch = options.topicBrowserBatch instanceof Map ? options.topicBrowserBatch : null;
    this.signal = options.signal ?? null;
  }

  // Merge persisted waits before reusing this provider after another lane/run.
  // Do not replace the policy: its recent distinct-target failure evidence is
  // run-local and is intentionally retained by the long-lived works provider.
  restoreWorksRequestPolicy() {
    // Indexed latest-policy lookup per target; project only the tiny policy
    // object, never materialize raw payloads or authentication state. Existing
    // snapshot persistence carries cooldowns across provider/run restarts.
    if (this.database?.db?.prepare) {
      const rows = this.database.db.prepare(`
        SELECT json_extract(s.raw_json,'$.worksRequestPolicy') AS policy
        FROM targets t JOIN snapshots s ON s.id=(
          SELECT id FROM snapshots WHERE target_id=t.id AND json_valid(raw_json)
            AND json_extract(raw_json,'$.worksRequestPolicy.version')=1
            AND json_extract(raw_json,'$.worksRequestPolicy.endpoint')='douyin.author_posts'
            AND json_extract(raw_json,'$.worksRequestPolicy.scope')='endpoint-transport'
          ORDER BY captured_at DESC,id DESC LIMIT 1
        ) WHERE t.type='account' AND t.provider='public-web' AND json_valid(s.raw_json)
      `).all();
      for (const row of rows) this.worksRequestPolicy.restore(safeJson(row.policy, null));
      // New works-only runs must not reset a still-active browser cooldown.
      // Project only policy fields and cap both sources; never load credentials
      // or unbounded historical payloads. Older databases have no ledger yet.
      const hasWorksLedger = this.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'").get();
      if (hasWorksLedger) {
        const saved = this.database.db.prepare(`SELECT json_extract(raw_json,'$.worksRequestPolicy') AS policy
          FROM works_observations WHERE json_valid(raw_json) ORDER BY id DESC LIMIT 1000`).all();
        for (const row of saved) this.worksRequestPolicy.restore(safeJson(row.policy, null));
      }
      const runs = this.database.db.prepare(`SELECT json_extract(details_json,'$[0].requestPolicy') AS policy
        FROM runs WHERE trigger_type='works-only' AND json_valid(details_json) ORDER BY id DESC LIMIT 1000`).all();
      for (const row of runs) this.worksRequestPolicy.restore(safeJson(row.policy, null));
    }
  }

  async run(operation, extraArgs = [], input = null) {
    const identityEnvironment = operation === "identity-work" ? identityProxyEnvironment() : undefined;
    return runExecFile(
      this.execFileImpl,
      this.pythonPath,
      [helperPath, "--operation", operation, ...extraArgs],
      { cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: input === null ? 120_000 : 900_000, maxBuffer: input === null ? 8 * 1024 * 1024 : 24 * 1024 * 1024, signal: this.signal ?? undefined,
        ...(identityEnvironment ? { env: identityEnvironment } : {}) },
      input,
    );
  }

  async runTopicBrowser(labels) {
    const normalized = [...new Set((Array.isArray(labels) ? labels : [labels])
      .map((value) => String(value ?? "").replace(/^#+/, "").trim())
      .filter(Boolean))];
    if (!normalized.length) throw new Error("缺少待读取的话题");
    return runExecFile(
      this.execFileImpl,
      process.execPath,
      [topicBrowserResolverPath],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        timeout: Math.min(900_000, Math.max(120_000, normalized.length * 90_000)),
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          ...(process.env.DATA_DIR ? { DATA_DIR: process.env.DATA_DIR } : {}),
        },
        signal: this.signal ?? undefined,
      },
      JSON.stringify({ labels: normalized }),
    );
  }

  async runBrowserWorks(item, { timeoutMs = BROWSER_WORKS_SINGLE_ITEM_TIMEOUT_MS, signal = this.signal } = {}) {
    return runExecFile(
      this.execFileImpl === execFile ? ownedCollectorExecutor.exec : this.execFileImpl,
      process.execPath,
      [browserCollectorPath],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        timeout: timeoutMs,
        maxBuffer: 24 * 1024 * 1024,
        env: { ...process.env, ...(process.env.DATA_DIR ? { DATA_DIR: process.env.DATA_DIR } : {}) },
        signal: signal ?? undefined,
      },
      JSON.stringify({ items: [item] }),
      { safeBrowserWorks: true },
    );
  }

  async collectWorksOnly(target, anchor) {
    throwIfCancelled(this.signal);
    if (!this.accountBrowserFallback) throw worksOnlyFailure("WORKS_ONLY_DISABLED");
    const started = this.now();
    if (!Number.isFinite(started) || Math.abs(started) > 8.64e15) throw worksOnlyFailure("WORKS_ONLY_TIME_INVALID");
    if (!Number.isSafeInteger(target?.id) || target.id <= 0 || ![true, 1].includes(target.enabled)
      || target.type !== "account" || target.provider !== "public-web" || targetPlatform(target) !== "douyin"
      || !Number.isSafeInteger(anchor?.snapshotId) || anchor.snapshotId <= 0
      || typeof anchor.sourceChecksum !== "string" || !/^[a-f\d]{64}$/.test(anchor.sourceChecksum)
      || typeof anchor.secUid !== "string" || !SEC_UID_RE.test(anchor.secUid) || anchor.secUid !== target.locator
      || typeof anchor.uid !== "string" || !/^[1-9]\d{1,24}$/.test(anchor.uid)
      || !exactInstant(anchor.capturedAt) || Date.parse(anchor.capturedAt) > started
      || started - Date.parse(anchor.capturedAt) > 8 * 3600_000) throw worksOnlyFailure("WORKS_ONLY_ANCHOR_INVALID");
    const key = String(target.id), secUid = anchor.secUid, uid = anchor.uid;
    const configuredLimit = Number(this.settings.publicPostsPerAccount ?? 30);
    const requestedLimit = this.browserWorksHardLimit ?? (Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? Math.min(100, configuredLimit) : 30);
    const wrapPolicy = browser => ({ version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", browser });
    const decision = this.worksRequestPolicy.decision("authorised-browser");
    if (decision.deferred) return { attempted: false, deferred: true, requestPolicy: wrapPolicy(decision),
      requestStartedAt: null, requestFinishedAt: null, requestedLimit, result: null };
    const requestStartedAt = new Date(started).toISOString();
    let continuation = readTrustedWorksResume(this.database?.db, target.id, anchor, requestStartedAt);
    let browserResult, failure = null;
    try {
      browserResult = await this.runBrowserWorks({ key, secUid, limit: requestedLimit,
        ...(continuation ? { startCursor: continuation.cursor } : {}),
        ...(this.browserRequestThreshold === undefined ? {} : {requestThreshold:this.browserRequestThreshold}) },
        { timeoutMs: WORKS_ONLY_TIMEOUT_MS, signal: this.signal });
      throwIfCancelled(this.signal);
    } catch (error) {
      throwIfCancelled(this.signal, error);
      failure = { status: "unavailable", posts: [],
        errorCode: WORKS_ONLY_ERRORS.has(error?.worksErrorCode) ? error.worksErrorCode : "collector_error",
        ...projectWorksOnlyFailure({ ...safeBrowserWorksExecError("collector-process", error), ...projectWorksOnlyFailure(error) }),
      };
    }
    const finished = this.now();
    if (!Number.isFinite(finished) || finished < started || finished - started > WORKS_ONLY_TIMEOUT_MS) {
      this.worksRequestPolicy.record("authorised-browser", { targetKey: secUid, errorCode: "collector_error" });
      throw worksOnlyFailure("WORKS_ONLY_TIME_INVALID", true);
    }
    const requestFinishedAt = new Date(finished).toISOString();
    const item = Array.isArray(browserResult?.items) && browserResult.items.length === 1 ? browserResult.items[0] : null;
    // A natural head is independent new source evidence, never a continuation
    // from the saved cursor. The original validator still requires cursor0.
    if (continuation && item?.continuationReset === 'natural-head') continuation = null;
    const result = failure ?? worksOnlyResult(item,
        { key, secUid, uid, limit: requestedLimit, requestThreshold:this.browserRequestThreshold,
          startedAt: requestStartedAt, finishedAt: requestFinishedAt, startCursor: continuation?.cursor });
    const browser = this.worksRequestPolicy.record("authorised-browser", { targetKey: secUid, errorCode: result.errorCode,
      ...browserRetryAfterPolicyInput(item, { key, startedAt: requestStartedAt, finishedAt: requestFinishedAt, errorCode: result.errorCode }) });
    return { attempted: true, deferred: false, requestPolicy: wrapPolicy(browser), requestStartedAt, requestFinishedAt, requestedLimit, result,
      ...(continuation ? { continuation } : {}) };
  }

  async resolveAuthorisedDetail(payload) {
    throwIfCancelled(this.signal);
    if (!this.authorisedDetailEnabled) throw Object.assign(new Error('授权作品核验尚未启用'), { code: 'AUTHORISED_DETAIL_DISABLED' });
    const input = normalizeAuthorisedDetailInput(payload);
    const startedAt = new Date(this.now()).toISOString();
    let raw;
    try {
      raw = await runExecFile(
        this.execFileImpl === execFile ? ownedCollectorExecutor.exec : this.execFileImpl,
        process.execPath, [authorisedDetailPath], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 45_000,
          maxBuffer: 256 * 1024, signal: this.signal ?? undefined,
          env: { ...process.env, DOUYIN_AUTHORISED_DETAIL_ENABLED: '1' },
        }, JSON.stringify({ items: [input] }), { safeBrowserWorks: true },
      );
      throwIfCancelled(this.signal);
      return validateAuthorisedDetailResult(input, raw, { startedAt, finishedAt: new Date(this.now()).toISOString() });
    } catch (error) {
      throwIfCancelled(this.signal, error);
      const ownership = safeOwnershipFailure(error);
      throw Object.assign(new Error('授权作品核验未完成；未保留错误原文'), {
        code: ownership?.code ?? 'AUTHORISED_DETAIL_UNVERIFIED',
      });
    }
  }

  // Explicit, source-bound discovery only. This does not enter author
  // admission, retry queues, monitoring, or the legacy resolver fallback.
  async resolveWorkAuthorCandidate(payload) {
    throwIfCancelled(this.signal);
    if (!this.workAuthorCandidateEnabled) throw Object.assign(new Error('原作品作者线索读取尚未启用'), { code: 'WORK_AUTHOR_CANDIDATE_DISABLED' });
    const input = normalizeWorkAuthorCandidateInput(payload);
    const startedAt = new Date(this.now()).toISOString();
    try {
      const raw = await runExecFile(
        this.execFileImpl === execFile ? ownedCollectorExecutor.exec : this.execFileImpl,
        process.execPath, [workAuthorCandidatePath], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)), timeout: 45_000,
          maxBuffer: 256 * 1024, signal: this.signal ?? undefined,
          env: { ...process.env, DOUYIN_WORK_AUTHOR_CANDIDATE_ENABLED: '1' },
        }, JSON.stringify({ items: [input] }), { safeBrowserWorks: true },
      );
      throwIfCancelled(this.signal);
      return validateWorkAuthorCandidateResult(input, raw, { startedAt, finishedAt: new Date(this.now()).toISOString() });
    } catch (error) {
      throwIfCancelled(this.signal, error);
      const ownership = safeOwnershipFailure(error);
      throw Object.assign(new Error('原作品作者线索未完成核验；未保留错误原文'), {
        code: ownership?.code ?? 'WORK_AUTHOR_CANDIDATE_UNVERIFIED',
      });
    }
  }

  async resolveDouyinAuthors(items) {
    if (!Array.isArray(items) || !items.length) throw new Error("缺少待核验作者证据");
    if (items.length > 5_000) throw new Error("单次自动核验作者超过 5000 个限制");
    const resolvedItems = [];
    const batchSize = 36;
    for (let start = 0; start < items.length; start += batchSize) {
      throwIfCancelled(this.signal);
      // Normalize only provably repeated identical short links. Keep the queue
      // key and caller's original source untouched; this is not identity proof.
      const batch = items.slice(start, start + batchSize).map(item => ({ ...item,
        ...(Array.isArray(item.shareUrls) ? { shareUrls: item.shareUrls.map(value => repairDouyinShareLink(value)?.normalizedUrl ?? value) } : {}),
      }));
      const input = JSON.stringify({ items: batch });
      if (this.authorResolverMode === "signed-only") {
        try {
          const result = await this.run("resolve-authors", ["--workers", "4"], input);
          throwIfCancelled(this.signal);
          resolvedItems.push(...(result.items ?? []));
        } catch (publicError) {
          throwIfCancelled(this.signal, publicError);
          resolvedItems.push(...batch.map((item) => ({
            key: String(item.key ?? "").slice(0, 300),
            candidates: [],
            errors: [{ error: `公开签名接口未完成：${publicError.message}`.slice(0, 300) }],
          })));
        }
        continue;
      }
      try {
        const result = await runExecFile(
          this.execFileImpl,
          process.execPath,
          [browserResolverPath],
          {
            cwd: fileURLToPath(new URL("../..", import.meta.url)),
            timeout: 240_000,
            maxBuffer: 12 * 1024 * 1024,
            env: { ...process.env, DOUYIN_BROWSER_HEADED: "1" },
            signal: this.signal ?? undefined,
          },
          input,
        );
        throwIfCancelled(this.signal);
        const browserItems = new Map((result.items ?? []).map((item) => [String(item?.key ?? ""), item]));
        const unresolved = batch.filter((item) => {
          const browserItem = browserItems.get(String(item?.key ?? ""));
          return !Array.isArray(browserItem?.candidates) || browserItem.candidates.length === 0;
        });
        if (unresolved.length) {
          try {
            const publicResult = await this.run("resolve-authors", ["--workers", "4"], JSON.stringify({ items: unresolved }));
            throwIfCancelled(this.signal);
            for (const fallback of publicResult.items ?? []) {
              const key = String(fallback?.key ?? "");
              const browserItem = browserItems.get(key) ?? { key, candidates: [], errors: [] };
              browserItems.set(key, {
                ...browserItem,
                candidates: [...(browserItem.candidates ?? []), ...(fallback?.candidates ?? [])],
                errors: [...(browserItem.errors ?? []), ...(fallback?.errors ?? [])],
              });
            }
          } catch (publicError) {
            throwIfCancelled(this.signal, publicError);
            for (const item of unresolved) {
              const key = String(item?.key ?? "");
              const browserItem = browserItems.get(key) ?? { key, candidates: [], errors: [] };
              browserItems.set(key, {
                ...browserItem,
                errors: [...(browserItem.errors ?? []), { error: `公开签名接口补充失败：${publicError.message}`.slice(0, 300) }],
              });
            }
          }
        }
        resolvedItems.push(...batch.map((item) => browserItems.get(String(item?.key ?? "")) ?? ({
          key: String(item?.key ?? "").slice(0, 300),
          candidates: [],
          errors: [{ error: "公开核验未返回结果" }],
        })));
      } catch (browserError) {
        throwIfCancelled(this.signal, browserError);
        try {
          const result = await this.run("resolve-authors", ["--workers", "4"], input);
          throwIfCancelled(this.signal);
          resolvedItems.push(...(result.items ?? []));
        } catch (publicError) {
          throwIfCancelled(this.signal, publicError);
          resolvedItems.push(...batch.map((item) => ({
            key: String(item.key ?? "").slice(0, 300),
            candidates: [],
            errors: [{ error: `公开浏览器与公开接口均未完成：${browserError.message}；${publicError.message}`.slice(0, 300) }],
          })));
        }
      }
    }
    return {
      items: resolvedItems,
      provenance: {
        mode: this.authorResolverMode === "signed-only"
          ? "signed-anonymous-public-detail"
          : "public-browser-with-signed-anonymous-fallback",
        batchSize,
        anonymousSessionOnly: true,
        perItemFallback: true,
        runtimeAI: false,
        paidAPI: false,
      },
    };
  }

  async resolveAuthors(items) {
    if (!Array.isArray(items) || !items.length) throw new Error("缺少待核验作者证据");
    if (items.length > 5_000) throw new Error("单次自动核验作者超过 5000 个限制");

    const resolvedItems = new Array(items.length);
    const douyinEntries = [];
    const bilibiliEntries = [];
    items.forEach((item, index) => {
      const platform = authorEvidencePlatform(item);
      if (platform === "bilibili") {
        bilibiliEntries.push({ item, index });
        return;
      }
      if (platform === "douyin") {
        douyinEntries.push({ item, index });
        return;
      }
      resolvedItems[index] = {
        key: String(item?.key ?? "").slice(0, 300),
        candidates: [],
        errors: [{ error: `${platform || "未知平台"}暂不支持通过作品匿名反查作者` }],
      };
    });

    let douyinProvenance = null;
    if (douyinEntries.length) {
      const douyinResult = await this.resolveDouyinAuthors(douyinEntries.map(({ item }) => item));
      douyinProvenance = douyinResult.provenance;
      douyinEntries.forEach(({ index }, resultIndex) => {
        resolvedItems[index] = douyinResult.items[resultIndex];
      });
    }

    const batchSize = 36;
    for (let start = 0; start < bilibiliEntries.length; start += batchSize) {
      const batch = bilibiliEntries.slice(start, start + batchSize);
      const batchResults = await Promise.all(batch.map(({ item }) => resolveBilibiliAuthor(this.fetchImpl, item, this.signal)));
      batch.forEach(({ index }, resultIndex) => {
        resolvedItems[index] = batchResults[resultIndex];
      });
    }

    const platforms = {
      douyin: douyinEntries.length,
      bilibili: bilibiliEntries.length,
      unsupported: items.length - douyinEntries.length - bilibiliEntries.length,
    };
    const isDouyinOnly = platforms.douyin === items.length;
    const isBilibiliOnly = platforms.bilibili === items.length;
    return {
      items: resolvedItems,
      provenance: {
        ...(isDouyinOnly ? douyinProvenance : {}),
        mode: isDouyinOnly
          ? douyinProvenance.mode
          : isBilibiliOnly
            ? "bilibili-official-anonymous-view"
            : "platform-routed-public-evidence",
        batchSize,
        anonymousSessionOnly: true,
        perItemFallback: platforms.douyin > 0,
        runtimeAI: false,
        paidAPI: false,
        platforms,
      },
    };
  }

  async collectAccount(target, { deferBrowserWorks = false } = {}) {
    const profileRequestStartedAt = nowIso();
    const limit = Math.max(1, Math.min(100, Number(this.settings.publicPostsPerAccount || 30)));
    const browserLimit = this.browserWorksHardLimit ?? limit;
    const anonymousDecision = this.worksRequestPolicy.decision("anonymous-http");
    const args = ["--locator", target.locator, "--limit", String(limit)];
    if (anonymousDecision.deferred) args.push("--works-mode", "deferred");
    let raw = await this.run("account", args);
    const lifecycle = getDouyinLifecycleEvidence(target, raw, {
      provider: "public-web", operation: "account", requestedAccountId: target.locator, observedAt: nowIso(),
    });
    if (lifecycle) return { lifecycle, raw, capturedAt: raw.capturedAt, sourceChecksum: checksum(raw), posts: [] };
    const targetKey = String(raw?.profile?.user?.sec_uid || target.locator);
    const pages = raw?.works?.pagination?.pages;
    const transport = Array.isArray(pages) ? pages.at(-1)?.transport : null;
    const failed = ["retry", "unavailable"].includes(raw?.worksCoverage);
    const anonymous = anonymousDecision.deferred ? anonymousDecision : this.worksRequestPolicy.record("anonymous-http", {
      targetKey, errorCode: failed ? worksErrorCode(raw?.worksErrorCode) : null,
      retryAfterSeconds: transport?.retryAfterSeconds, retryAfterStatus: transport?.retryAfterStatus,
    });
    // The current helper explicitly supplies worksErrorCode (including null).
    // Preserve byte-for-byte legacy/source-identity envelopes when they do not
    // implement that contract and no request-policy intervention took place.
    const policySupported = Object.hasOwn(raw, "worksErrorCode") || anonymousDecision.deferred || this.accountBrowserFallback;
    if (policySupported) raw = { ...raw, worksRequestPolicy: { version: 1, endpoint: WORKS_ENDPOINT, scope: "endpoint-transport", anonymous } };
    const browserDecision = this.worksRequestPolicy.decision("authorised-browser");
    if (policySupported && browserDecision.deferred) raw.worksRequestPolicy.browser = browserDecision;
    this.accountBrowserGate = browserDecision.deferred ? false : null;
    this.accountBrowserGateError = browserDecision.errorCode;
    const deferredBrowserRaw = deferBrowserWorks === true && this.accountBrowserFallback && !browserDecision.deferred
      && raw?.worksCoverage === "unavailable" && raw?.profile?.user?.sec_uid === target.locator
      && typeof raw.profile.user.uid === 'string' && /^[1-9]\d{1,24}$/.test(raw.profile.user.uid)
      ? { ...raw, worksFallbackDeferred: { version: 1, reason: 'scheduled-profile-priority', mode: 'works-only' },
        worksRequestPolicy: { ...raw.worksRequestPolicy, browser: browserDecision },
        warnings: [...(Array.isArray(raw.warnings) ? raw.warnings : []), '本轮优先保存全名单主页；授权浏览器作品由既有顺序补采继续，未标为已采完整'] } : null;
    if (deferredBrowserRaw && (isOfficialDeferredProfileEnvelope(raw) || isOfficialScheduledProfileEnvelope(deferredBrowserRaw))) {
      // This is a scheduling choice, not a platform refusal or transport
      // failure. Keep anonymous posts/error/policy and the original profile
      // body intact; the normal works-only planner requires this saved anchor.
      // If the source cannot enter that strict handoff, keep inline behavior.
      raw = deferredBrowserRaw;
    } else if (this.accountBrowserFallback && !browserDecision.deferred && raw?.worksCoverage === "unavailable" && raw?.profile?.user?.sec_uid) {
      try {
        const sourceRequestStartedAt = new Date(this.now()).toISOString();
        const browserKey = String(target.id ?? target.label ?? target.locator ?? "account").slice(0, 240);
        const browserResult = await this.runBrowserWorks({
          key: browserKey,
          secUid: String(raw.profile.user.sec_uid),
          limit: browserLimit,
          ...(this.browserRequestThreshold === undefined ? {} : {requestThreshold:this.browserRequestThreshold}),
        });
        const sourceRequestFinishedAt = new Date(this.now()).toISOString();
        let item = browserResult?.items?.[0];
        // Keep only the fixed, credential-free observation contract. Capture
        // before validating posts so rejected/malformed successful envelopes
        // retain their diagnostics too, without retaining their raw error.
        const diagnostics = sanitizeBrowserWorksDiagnostics(item?.failureDiagnostics);
        if (diagnostics) raw = { ...raw, worksFallbackDiagnostics: diagnostics };
        if (item?.status === "ok") {
          if (!Array.isArray(item.posts)) {
            item = { status: "unavailable", errorCode: "upstream_changed", error: "浏览器作品响应缺少数组" };
          } else {
            const ids = new Set();
            const posts = item.posts.filter((post) => {
              const id = typeof post?.aweme_id === "string" ? post.aweme_id : "";
              if (!/^\d{15,25}$/.test(id) || post?.author?.sec_uid !== targetKey || ids.has(id)) return false;
              if (raw.profile.user.uid != null && post.author.uid != null && post.author.uid !== '' && String(post.author.uid) !== String(raw.profile.user.uid)) return false;
              if (post.statistics != null && (typeof post.statistics !== "object" || Array.isArray(post.statistics))) return false;
              ids.add(id);
              return true;
            });
            const inventory = raw.profile.user.aweme_count;
            const pagination = item.pagination === undefined ? undefined : validatedBrowserPagination(item.pagination, {
              limit: browserLimit, posts: item.posts, hasMore: item.hasMore, maxCursor: item.maxCursor,
              notBefore: sourceRequestStartedAt, notAfter: Date.parse(sourceRequestFinishedAt),
            });
            const timingValid = typeof raw.capturedAt === 'string' && Number.isFinite(Date.parse(raw.capturedAt))
              && Date.parse(raw.capturedAt) <= Date.parse(sourceRequestStartedAt)
              && sourceRequestStartedAt <= sourceRequestFinishedAt;
            const complete = item.worksCoverage === "complete" && item.hasMore === false && !item.errorCode
              && (pagination === undefined || pagination?.stopReason === "end-of-list")
              && posts.length === item.posts.length && posts.length <= browserLimit
              && Number.isSafeInteger(inventory) && inventory >= 0 && posts.length === inventory;
            const policyMatches = this.browserRequestThreshold === undefined ? pagination?.version !== 2
              : pagination?.version === 2 && pagination.requestThreshold === this.browserRequestThreshold;
            if (!policyMatches || pagination === null || (item.posts.length > 0 && posts.length === 0) || (pagination && (!timingValid || posts.length !== item.posts.length
              || (item.errorCode ?? null) !== pagination.errorCode))) {
              item = { status: "unavailable", errorCode: "upstream_changed", error: "浏览器分页证据不一致" };
            } else item = { ...item, pagination, posts: posts.slice(0, browserLimit), worksCoverage: complete ? "complete" : "latest-public-window" };
          }
        }
        const browserErrorCode = item?.status === "ok" && !item.errorCode ? null : worksErrorCode(item?.errorCode);
        const browser = this.worksRequestPolicy.record("authorised-browser", { targetKey, errorCode: browserErrorCode,
          ...browserRetryAfterPolicyInput(Array.isArray(browserResult?.items) && browserResult.items.length === 1 ? item : null,
            { key: browserKey, startedAt: sourceRequestStartedAt,
            finishedAt: sourceRequestFinishedAt, errorCode: browserErrorCode }) });
        raw.worksRequestPolicy.browser = browser;
        const nextBrowser = this.worksRequestPolicy.decision("authorised-browser");
        this.accountBrowserGate = nextBrowser.deferred ? false : item?.status === "ok" ? true : null;
        this.accountBrowserGateError = nextBrowser.errorCode;
        if (item?.status === "ok") {
          raw = {
            ...raw,
            worksCoverage: item.worksCoverage,
            worksError: null,
            worksErrorCode: null,
            ...(item.errorCode ? { worksFallbackErrorCode: item.errorCode } : {}),
            works: {
              ...(item.pagination ? { observationVersion: 1, observedAt: item.pagination.pages.at(-1).observedAt,
                sourceRequestStartedAt, sourceRequestFinishedAt } : {}),
              aweme_list: Array.isArray(item.posts) ? item.posts : [],
              has_more: item.pagination ? item.hasMore : item.hasMore === true,
              max_cursor: item.maxCursor ?? null,
              public_window_limited: item.worksCoverage !== "complete",
              stopReason: item.worksCoverage === "complete" ? "browser-end-of-list" : "browser-public-window",
              pagination: item.pagination ? {
                ...item.pagination,
                evidenceScope: "browser-response-sanitized", requestedLimit: browserLimit,
                pages: item.pagination.pages.map(page => ({ ...page,
                  endpoint: "https://www.douyin.com/aweme/v1/web/aweme/post/",
                  response: { ...page.response, source: "authorised-browser" },
                })),
              } : {
                evidenceScope: "browser-response-sanitized",
                requestedLimit: browserLimit,
                requestCount: 1,
                collectedCount: Array.isArray(item.posts) ? item.posts.length : 0,
                pages: [{ endpoint: "https://www.douyin.com/aweme/v1/web/aweme/post/", response: { source: "authorised-browser", has_more: item.hasMore === true, max_cursor: item.maxCursor ?? null } }],
              },
            },
            warnings: [...(Array.isArray(raw.warnings) ? raw.warnings : []), "匿名作品接口受限；已使用用户授权浏览器页面响应采集最新公开作品窗口",
              ...(item.errorCode ? [`浏览器续页已停止（${item.errorCode}）；仅保留已核验页面，未覆盖完整历史`] : [])],
            provenance: { ...(raw.provenance ?? {}), worksFallback: browserResult.provenance },
          };
        } else if (item?.error) {
          const code = worksErrorCode(item.errorCode);
          raw = { ...raw, worksFallbackErrorCode: code, warnings: [...(Array.isArray(raw.warnings) ? raw.warnings : []), `授权浏览器作品补采未完成（${code}）；未覆盖历史作品`] };
        }
      } catch (error) {
        throwIfCancelled(this.signal, error);
        raw.worksRequestPolicy.browser = this.worksRequestPolicy.record("authorised-browser", { targetKey, errorCode: "collector_error" });
        raw = { ...raw, worksFallbackErrorCode: "collector_error", warnings: [...(Array.isArray(raw.warnings) ? raw.warnings : []), "授权浏览器作品补采未完成（collector_error）；异常原文未记录，未覆盖历史作品"] };
        if (safeOwnershipFailure(error)) raw.worksFallbackLifecycle = ownedCollectorExecutor.diagnostics();
      }
    } else if (this.accountBrowserFallback && browserDecision.deferred && raw?.worksCoverage === "unavailable") {
      raw.worksRequestPolicy.browser = browserDecision;
      raw = { ...raw, worksFallbackErrorCode: "deferred", warnings: [...(Array.isArray(raw.warnings) ? raw.warnings : []), `授权浏览器作品补采已暂缓（${browserDecision.errorCode}）；本次未请求，保留主页指标和历史作品`] };
    }
    let verifiedIdentity;
    try {
      verifiedIdentity = verifiedAccountIdentity(target, raw, "douyin", this.database);
    } catch (error) {
      if (error.code !== "DOUYIN_SUBMITTED_ID_MISMATCH") throw error;
      const historicalEvidence = verifyHistoricalSourceWorkIdentity(this.database, target, raw, {
        requestStartedAt: profileRequestStartedAt, reference: nowIso(),
      });
      if (historicalEvidence) {
        verifiedIdentity = verifiedAccountIdentity(target, raw, "douyin", this.database, historicalEvidence);
      } else {
        const request = getSourceWorkIdentityRequest(this.database, target, raw);
        if (!request) throw error;
        const sourceIdentityEvidence = await this.run("identity-work", ["--locator", request.sourceVideoId]);
        const augmented = { ...raw, sourceIdentityEvidence };
        const sourceEvidenceEvent = verifySourceWorkIdentity(this.database, target, augmented, {
          provider: "public-web", operation: "identity-work", requestedVideoId: request.sourceVideoId,
          requestedAccountId: target.locator, sourceBindingChecksum: request.sourceBindingChecksum, observedAt: nowIso(),
        });
        if (!sourceEvidenceEvent) throw new Error("原表作品未能与提交账号及当前主页建立严格双 ID 证明；本次未写入");
        raw = augmented;
        verifiedIdentity = verifiedAccountIdentity(target, raw, "douyin", this.database, sourceEvidenceEvent);
      }
    }
    // Source work details are identity evidence only, never a second metrics
    // container. Keep the complete evidence in persisted raw and its checksum.
    const { sourceIdentityEvidence, ...metricsRaw } = raw;
    const collection = normalizeCollection(target, metricsRaw, { capturedAt: raw.capturedAt || nowIso() });
    collection.raw = raw;
    collection.sourceChecksum = checksum(raw);
    const upstreamWarnings = Array.isArray(raw.warnings) ? raw.warnings : [];
    const metricWarnings = [];
    if (collection.snapshot.followers === null) metricWarnings.push("抖音公开主页响应未包含粉丝总数");
    if (collection.snapshot.totalLikes === null) metricWarnings.push("抖音公开主页响应未包含账号获赞总数");
    collection.warnings = [...new Set([...collection.warnings, ...metricWarnings, ...upstreamWarnings])];
    collection.qualityStatus = collection.warnings.length ? "warning" : "validated";
    Object.assign(collection, finalizeCollectionHealth(target, collection, raw));
    collection.verifiedIdentity = verifiedIdentity;
    return collection;
  }

  async collectBilibiliAccount(target) {
    const limit = Math.max(1, Math.min(30, Number(this.settings.publicPostsPerAccount || 30)));
    const raw = await this.run("bilibili-account", ["--locator", target.locator, "--limit", String(limit)]);
    // This helper reads a latest-video window, not a fully paginated archive.
    // An array's presence alone is not evidence of complete account coverage.
    const returnedWorks = Array.isArray(raw.works?.aweme_list) ? raw.works.aweme_list : null;
    const listEvidence = raw.worksListEvidence;
    const confirmedEmpty = raw.profile?.user?.aweme_count === 0 && returnedWorks?.length === 0
      && listEvidence?.status === "success" && listEvidence.statusCode === 0
      && listEvidence.listObserved === true && listEvidence.rawCount === 0
      && ["wbi", "dynamic"].includes(listEvidence.source);
    raw.worksCoverage = confirmedEmpty ? "complete" : returnedWorks?.length ? "latest-public-window" : "unavailable";
    if (!confirmedEmpty) raw.warnings = [...(Array.isArray(raw.warnings) ? raw.warnings : []),
      returnedWorks?.length ? "B站仅取得最新公开作品窗口，未证明全部作品完整覆盖" : "B站未取得有效作品列表，未覆盖历史作品"];
    const collection = normalizeCollection(target, raw, { capturedAt: raw.capturedAt || nowIso() });
    const upstreamWarnings = Array.isArray(raw.warnings) ? raw.warnings : [];
    collection.warnings = [...new Set([...collection.warnings, ...upstreamWarnings])];
    collection.qualityStatus = collection.warnings.length ? "warning" : "validated";
    Object.assign(collection, finalizeCollectionHealth(target, collection, raw));
    collection.verifiedIdentity = verifiedAccountIdentity(target, raw, "bilibili");
    return collection;
  }

  async collectXiaohongshuAccount(target) {
    const userId = xiaohongshuUserId(target.locator);
    if (!userId) throw new Error("小红书账号需要 www.xiaohongshu.com/user/profile/<用户ID> 官方主页");
    const limit = Math.max(1, Math.min(30, Number(this.settings.publicPostsPerAccount || 30)));
    try {
      const response = await this.fetchImpl(`https://www.xiaohongshu.com/user/profile/${userId}`, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "zh-CN,zh;q=0.9",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        },
        redirect: "follow",
        signal: boundedSignal(30_000, this.signal),
      });
      const html = await response.text();
      if (!response.ok) throw new Error(`小红书官方主页 HTTP ${response.status}`);
      if (html.length > 8 * 1024 * 1024) throw new Error("小红书官方主页响应超过 8MB 安全限制");
      const state = extractXiaohongshuInitialState(html);
      const userState = state?.user;
      const profile = unwrapReactive(userState?.userPageData);
      const notes = flattenXiaohongshuNotes(userState?.notes).slice(0, limit);
      if (!profile?.basicInfo || profile?.result?.success === false) throw new Error("小红书官方主页未返回有效作者资料");

      const returnedIds = new Set([
        ...(Array.isArray(userState?.noteQueries) ? userState.noteQueries.map((item) => item?.userId) : []),
        ...notes.map((item) => (item?.noteCard ?? item)?.user?.userId),
      ].map((value) => String(value ?? "").trim()).filter(Boolean));
      if (!returnedIds.size || [...returnedIds].some((value) => value !== userId)) {
        throw new Error("小红书官方主页身份校验失败：页面用户 ID 与提交主页不一致");
      }

      const interactions = Array.isArray(profile.interactions) ? profile.interactions : [];
      const interactionByType = new Map(interactions.map((item) => [String(item?.type ?? ""), item?.count]));
      const followersRaw = interactionByType.get("fans");
      const followers = publicNumber(followersRaw);
      // `interaction` is 获赞与收藏, not independent cumulative likes. No
      // verified standalone account-like contract exists in this adapter.
      const totalLikes = null;
      const nickname = String(profile.basicInfo.nickname ?? "").trim();
      if (!nickname) throw new Error("小红书官方主页未返回作者昵称");

      const noteObservations = [];
      let skippedNoteIds = 0;
      const works = notes.flatMap((item) => {
        const card = item?.noteCard ?? item;
        const observedNoteId = item?.id ?? card?.noteId ?? card?.id ?? null;
        const noteId = typeof observedNoteId === "string" ? observedNoteId.trim().toLowerCase() : "";
        // Same 16..40 hex work-ID contract as author-spreadsheet; never
        // synthesize a persistent platform identity from title/time/cover.
        const validNoteId = /^[0-9a-f]{16,40}$/.test(noteId);
        const likedCount = card?.interactInfo?.likedCount ?? null;
        noteObservations.push({ noteId: observedNoteId, likedCount, metric: "note-likes", accepted: validNoteId });
        if (!validNoteId) { skippedNoteIds += 1; return []; }
        const title = String(card?.displayTitle ?? card?.title ?? "").trim();
        const publishedAt = card?.time ?? item?.time ?? null;
        return [{
          aweme_id: noteId,
          desc: title,
          create_time: publishedAt,
          author: { uid: userId, nickname },
          statistics: { digg_count: publicNumber(likedCount) },
          share_url: `https://www.xiaohongshu.com/explore/${noteId}`,
        }];
      });
      const warnings = [];
      if (followers === null) warnings.push("小红书粉丝数缺失或不是完整精确整数，未按精确值写入；原始观察已保留");
      warnings.push("小红书主页获赞与收藏为合计指标，未作为账号累计获赞写入；未返回已核验的独立累计点赞字段");
      if (skippedNoteIds) warnings.push(`${skippedNoteIds} 条小红书笔记缺少合法平台作品 ID，已跳过作品写入并保留原始观察`);
      if (!works.length) warnings.push("小红书官方主页本次未返回可核验公开笔记；未用 0 覆盖历史");
      else warnings.push("小红书仅取得首屏最新公开作品窗口，未证明全部作品完整覆盖");
      if (works.some((item) => item.statistics.digg_count === null)) warnings.push("部分小红书笔记点赞数缺失或不精确；未按精确值写入");

      const metricsRaw = {
        capturedAt: nowIso(),
        profile: { user: {
          uid: userId,
          nickname,
          follower_count: followers,
          total_favorited: totalLikes,
          aweme_count: null,
        } },
        works: { aweme_list: works },
        worksCoverage: works.length ? "latest-public-window" : "unavailable",
        warnings,
        provenance: {
          mode: "xiaohongshu-official-profile-initial-state",
          userId,
          sourceUrl: `https://www.xiaohongshu.com/user/profile/${userId}`,
          authenticated: false,
          runtimeAI: false,
          paidAPI: false,
        },
      };
      const raw = { ...metricsRaw, publicObservations: {
        version: 1,
        scope: "xiaohongshu-public-display-observations-only",
        observedAt: metricsRaw.capturedAt,
        accountInteractions: interactions.map(item => ({
          type: item?.type ?? null, name: item?.name ?? null, count: item?.count ?? null,
          metric: item?.type === "fans" ? "followers" : item?.type === "interaction" ? "likes-and-collects" : "unmapped",
        })),
        notes: noteObservations,
      } };
      // Audit observations are not a second metrics payload. In particular,
      // generic recursive normalization must never discover aliases or works
      // nested inside unsupported display values. Hash the complete evidence.
      const collection = normalizeCollection(target, metricsRaw, { capturedAt: raw.capturedAt });
      collection.raw = raw;
      collection.sourceChecksum = checksum(raw);
      collection.snapshot.totalPosts = null;
      collection.warnings = [...new Set([...collection.warnings, ...warnings])];
      collection.qualityStatus = collection.warnings.length ? "warning" : "validated";
      Object.assign(collection, finalizeCollectionHealth(target, collection, raw));
      collection.verifiedIdentity = verifiedAccountIdentity(target, raw, "xiaohongshu");
      return collection;
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 360);
      const wallHint = /未返回(?:有效)?作者资料|userPageData|登录|login|冷却|rate.?limit/i.test(message)
        ? "；该公开主页可能触发了匿名登录墙或 IP 冷却，请稍后重试，或提交仍可公开核验的官方笔记链接"
        : "";
      throw new Error(`小红书匿名公开主页读取失败：${message}${wallHint}；未使用个人登录态或持久浏览器会话`);
    }
  }

  async collectHashtag(target) {
    if (!this.database) throw new Error("话题账号池统计缺少本地数据库上下文");
    const tag = String(target.locator || "").replace(/^#/, "").trim();
    const knownIdentity = readVerifiedTopicIdentity(this.database, target);
    if (knownIdentity.status === "verified") {
      try {
        const requestedAt = Date.now();
        const official = await this.run("hashtag-detail", ["--locator", knownIdentity.challengeId, "--label", tag]);
        const normalizedName = value => typeof value === "string" ? value.normalize("NFKC").trim().replace(/^#+/, "").trim().toLowerCase() : "";
        if (official?.raw?.challengeId !== knownIdentity.challengeId
          || normalizedName(official?.raw?.officialName) !== normalizedName(tag)
          || official.raw.scope !== "douyin-official-challenge-detail"
          || official.raw.provenance?.mode !== "douyin-official-anonymous-challenge-detail"
          || official.raw.provenance?.runtimeAI !== false || official.raw.provenance?.paidAPI !== false
          || official.raw.businessStatusCode !== 0) throw new Error("话题当前详情身份未通过复核");
        const observedMs = Date.parse(official.capturedAt);
        if (typeof official.capturedAt !== "string" || !Number.isFinite(observedMs)
          || new Date(observedMs).toISOString() !== official.capturedAt
          || observedMs < requestedAt || observedMs > Date.now()) throw new Error("话题当前详情采样时间无效");
        const participants = official.snapshot?.hashtagParticipants ?? null;
        const views = official.snapshot?.hashtagViews ?? null;
        if ([participants, views].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) throw new Error("话题当前详情指标无效");
        if (official.raw.participants !== participants || official.raw.views !== views) throw new Error("话题当前详情原值与指标不一致");
        const warnings = [...(Array.isArray(official.warnings) ? official.warnings : []),
          ...(participants === null ? ["官方话题详情未返回参与人数"] : []), ...(views === null ? ["官方话题详情未返回播放量"] : [])];
        return { ...official, posts: [], snapshot: { followers: null, totalLikes: null, totalPosts: null,
          hashtagParticipants: participants, hashtagViews: views, hashtagPosts: null, authorCount: null },
        warnings, qualityStatus: warnings.length ? "warning" : "validated", raw: { ...(official.raw ?? {}), identityReuse: {
          scope: "historical-identity-only", ...knownIdentity.evidence,
        } } };
      } catch (error) {
        throwIfCancelled(this.signal, error);
        // One chosen detail attempt only: no search, new session or alternative
        // transport after a refusal. Historical counts never enter this result.
        const fallback = this.collectHashtagPoolFallback(target, tag, this.database.listAccountPostsForPool(10_000));
        return { ...fallback, warnings: ["未获得当前官方双指标；账号池仅作来源证据，不代表全网",
          "已核验话题身份的当前详情读取未完成；本次未改用搜索重试，未复用历史参与人数或播放量"] };
      }
    }
    if (knownIdentity.status === "conflict") {
      const fallback = this.collectHashtagPoolFallback(target, tag, this.database.listAccountPostsForPool(10_000));
      return { ...fallback, warnings: ["未获得当前官方双指标；账号池仅作来源证据，不代表全网",
        "历史官方话题身份存在冲突；未猜选话题 ID，本次未发起详情请求"] };
    }
    let searchWarning = null;
    if (["browser", "browser-first"].includes(this.topicResolverMode)) {
      let browserItem = this.topicBrowserBatch?.get(tag.toLocaleLowerCase())
        || this.topicBrowserBatch?.get(tag)
        || null;
      try {
        if (!browserItem) {
          const browserResult = await this.runTopicBrowser([tag]);
          browserItem = (browserResult?.items ?? []).find((item) => String(item?.label ?? "").toLocaleLowerCase() === tag.toLocaleLowerCase()) ?? null;
        }
        if (browserItem?.status === "ok") {
          // A prefetched topic may wait for other topics before being saved.
          // Keep its actual observation time, not the later persistence time.
          // Legacy resolver payloads have no timestamp; preserve compatibility.
          const observedAt = browserItem.capturedAt;
          const observedMs = observedAt == null ? null : Date.parse(observedAt);
          if (observedAt != null && (typeof observedAt !== "string"
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
            || !Number.isFinite(observedMs) || new Date(observedMs).toISOString() !== observedAt || observedMs > Date.now())) {
            throw new Error("话题采样时间无效或晚于当前时间，未保存该结果");
          }
          const capturedAt = observedMs === null ? nowIso() : new Date(observedMs).toISOString();
          const snapshot = {
            followers: null,
            totalLikes: null,
            totalPosts: null,
            hashtagParticipants: browserItem.snapshot?.hashtagParticipants ?? null,
            hashtagViews: browserItem.snapshot?.hashtagViews ?? null,
            hashtagPosts: null,
            authorCount: null,
          };
          const warnings = Array.isArray(browserItem.warnings) ? browserItem.warnings : [];
          return {
            capturedAt,
            posts: [],
            snapshot,
            warnings,
            qualityStatus: warnings.length ? "warning" : "validated",
            sourceChecksum: checksum({ tag, snapshot, raw: browserItem.raw ?? null }),
            raw: {
              ...(browserItem.raw ?? {}),
              hashtag: tag,
              capturedAt,
              timestampSource: observedMs === null ? "legacy-receive-time" : "resolver-observation-time",
              provenance: browserItem.provenance ?? {
                mode: "douyin-authenticated-browser-search-and-detail",
                authenticated: true,
                runtimeAI: false,
                paidAPI: false,
              },
            },
            provenance: browserItem.provenance,
          };
        }
        searchWarning = browserItem?.error
          ? `抖音登录态话题检索未完成（${browserItem.status || "unknown"}）：${String(browserItem.error).slice(0, 220)}`
          : "抖音专用登录态话题检索未返回官方数据";
        if (this.topicResolverMode === "browser") {
          return this.collectHashtagPoolFallback(target, tag, this.database.listAccountPostsForPool(10_000), searchWarning);
        }
      } catch (error) {
        searchWarning = `抖音专用登录态话题检索未完成：${String(error?.message ?? error).slice(0, 220)}`;
        if (this.topicResolverMode === "browser") {
          return this.collectHashtagPoolFallback(target, tag, this.database.listAccountPostsForPool(10_000), searchWarning);
        }
      }
    }
    try {
      // First follow the same public path a user uses: search the exact #话题,
      // then verify the returned challenge ID through the official detail API.
      // The search endpoint may require login for anonymous traffic; that is a
      // retryable limitation, never a reason to invent a local total.
      const searched = await this.run("hashtag-search", ["--label", tag]);
      if (searched?.snapshot?.hashtagParticipants !== null || searched?.snapshot?.hashtagViews !== null) {
        return {
          ...searched,
          posts: [],
          snapshot: {
            followers: null,
            totalLikes: null,
            totalPosts: null,
            hashtagParticipants: searched.snapshot?.hashtagParticipants ?? null,
            hashtagViews: searched.snapshot?.hashtagViews ?? null,
            hashtagPosts: null,
            authorCount: null,
          },
        };
      }
      searchWarning = "抖音 #话题搜索未返回官方参与人数或播放量";
    } catch (error) {
      searchWarning = `抖音 #话题公开搜索未完成：${String(error?.message ?? error).slice(0, 180)}`;
    }
    const candidates = this.database.listAccountPostsForPool(10_000);
    const candidateChallengeIds = [];
    const seenChallengeIds = new Set();
    for (const row of candidates) {
      const raw = safeJson(row.raw_json, {});
      for (const extra of raw?.text_extra ?? []) {
        const name = String(extra?.hashtag_name ?? "").replace(/^#/, "").trim();
        const challengeId = String(extra?.hashtag_id ?? "").trim();
        if (!name || name.toLocaleLowerCase() !== tag.toLocaleLowerCase() || !/^\d{8,24}$/.test(challengeId) || seenChallengeIds.has(challengeId)) continue;
        seenChallengeIds.add(challengeId);
        candidateChallengeIds.push(challengeId);
      }
    }
    if (candidateChallengeIds.length) {
      try {
        // The ID comes from an official public work's hashtag annotation, so
        // the detail response can be checked against the submitted tag without
        // using login-gated keyword search or a paid API.
        const official = await this.run("hashtag-detail", [
          "--locator", candidateChallengeIds[0], "--label", tag,
        ]);
        return {
          ...official,
          posts: [],
          snapshot: {
            followers: null,
            totalLikes: null,
            totalPosts: null,
            hashtagParticipants: official.snapshot?.hashtagParticipants ?? null,
            hashtagViews: official.snapshot?.hashtagViews ?? null,
            hashtagPosts: null,
            authorCount: null,
          },
          raw: {
            ...(official.raw ?? {}),
            candidateChallengeIds,
            sourceScope: "douyin-official-challenge-detail",
          },
        };
      } catch (error) {
        // Keep the existing bounded local fallback for provenance, but never
        // let its sample counts populate the official topic metrics.
        const fallbackWarning = `官方话题详情读取失败：${String(error?.message ?? error).slice(0, 240)}；未用局部样本替代参与人数或播放量`;
        return this.collectHashtagPoolFallback(target, tag, candidates, [searchWarning, fallbackWarning].filter(Boolean).join("；"));
      }
    }
    return this.collectHashtagPoolFallback(target, tag, candidates, searchWarning);
  }

  collectHashtagPoolFallback(target, tag, candidates, extraWarning = null) {
    const matches = candidates.filter((row) => {
      const raw = safeJson(row.raw_json, {});
      const caption = String(row.caption || "");
      return caption.includes(`#${tag}`) || hashtagNames(raw).includes(tag);
    });
    const deduped = [];
    const seen = new Set();
    for (const row of matches) {
      if (seen.has(row.external_id)) continue;
      seen.add(row.external_id);
      deduped.push(normalizePost({
        aweme_id: row.external_id,
        desc: row.caption,
        create_time: row.published_at,
        author: { sec_uid: row.author_id, nickname: row.author_name },
        statistics: {
          digg_count: row.likes,
          comment_count: row.comments,
          share_count: row.shares,
          collect_count: row.collects,
          play_count: row.plays,
        },
        url: row.url,
      }, `pool-${target.id}`));
    }
    const capturedAt = nowIso();
    const raw = {
      scope: "monitored-account-pool",
      hashtag: tag,
      accountPostCandidates: candidates.length,
      matchedPosts: deduped.length,
      runtimeAI: false,
      paidAPI: false,
    };
    return {
      capturedAt,
      posts: deduped,
      snapshot: {
        followers: null,
        // The bounded account pool is only provenance evidence. It is not an
        // official topic total, so never expose its likes as a topic metric.
        totalLikes: null,
        totalPosts: null,
        hashtagParticipants: null,
        hashtagViews: null,
        hashtagPosts: deduped.length || null,
        authorCount: new Set(deduped.map((post) => post.authorId || post.authorName).filter(Boolean)).size || null,
      },
      warnings: [
        "统计范围仅限已监控账号池；游客态全网话题搜索当前要求登录，未把局部结果冒充全网数据",
        ...(extraWarning ? [extraWarning] : []),
      ],
      qualityStatus: "warning",
      sourceChecksum: checksum(raw),
      raw,
    };
  }

  async collect(target, options = {}) {
    if (target.type !== "account") return this.collectHashtag(target);
    const platform = targetPlatform(target);
    if (!isSupportedAccountPlatform(platform)) throw platformCapabilityError(platform);
    if (platform === "bilibili") return this.collectBilibiliAccount(target);
    if (platform === "xiaohongshu") return this.collectXiaohongshuAccount(target);
    return this.collectAccount(target, options);
  }

  async testConnection() {
    return this.run("selftest", ["--limit", "1"]);
  }

  async testConnectionForPlatform(platform, target) {
    const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
    if (!isSupportedAccountPlatform(normalizedPlatform)) throw platformCapabilityError(normalizedPlatform);
    if (normalizedPlatform === "douyin") return this.testConnection();
    if (normalizedPlatform === "bilibili") {
      const mid = bilibiliMidFromLocator(target?.locator);
      if (!mid) throw new Error("B站公开源自检缺少可用 UID");
      const endpoint = `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}&photo=true`;
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          referer: `https://space.bilibili.com/${mid}`,
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        },
        credentials: "omit",
        redirect: "error",
        signal: boundedSignal(20_000, this.signal),
      });
      if (!response?.ok) throw new Error(`B站官方卡片接口 HTTP ${response?.status ?? "未知"}`);
      const payload = await parseBoundedJson(response, "B站官方卡片接口");
      if (payload?.code !== 0 || !payload?.data?.card) throw new Error(`B站官方卡片接口返回 code=${String(payload?.code ?? "缺失")}`);
      return {
        platform: "bilibili",
        profileEndpoint: true,
        postsEndpoint: null,
        mode: "bilibili-official-anonymous-card",
        endpoint,
        mid,
        nickname: String(payload.data.card.name ?? "").trim() || null,
        runtimeAI: false,
        paidAPI: false,
      };
    }
    if (normalizedPlatform === "xiaohongshu") {
      const userId = xiaohongshuUserId(target?.locator);
      if (!userId) throw new Error("小红书公开源自检缺少可用用户 ID");
      const endpoint = `https://www.xiaohongshu.com/user/profile/${userId}`;
      const response = await this.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "zh-CN,zh;q=0.9",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        },
        credentials: "omit",
        redirect: "follow",
        signal: boundedSignal(30_000, this.signal),
      });
      const html = await response.text();
      if (!response?.ok) throw new Error(`小红书官方主页 HTTP ${response?.status ?? "未知"}`);
      if (html.length > 8 * 1024 * 1024) throw new Error("小红书公开主页响应超过 8MB 安全限制");
      const state = extractXiaohongshuInitialState(html);
      const profile = unwrapReactive(state?.user?.userPageData);
      if (!profile?.basicInfo) throw new Error("小红书公开主页未返回作者资料");
      return {
        platform: "xiaohongshu",
        profileEndpoint: true,
        postsEndpoint: Array.isArray(unwrapReactive(state?.user?.notes)),
        mode: "xiaohongshu-official-profile-initial-state",
        endpoint,
        userId,
        nickname: String(profile.basicInfo.nickname ?? "").trim() || null,
        runtimeAI: false,
        paidAPI: false,
      };
    }
    throw new Error(`不支持的平台公开源自检：${normalizedPlatform || "未指定"}`);
  }
}
