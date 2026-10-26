#!/usr/bin/env node
/**
 * Anonymous identity-resolution probe for Douyin, Bilibili and Xiaohongshu.
 *
 * This file deliberately does not import or read the monitor's persisted browser
 * state. Browser probes always create a fresh, non-persistent context.
 */
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const DOUYIN_CONTENT_ID_RE = /^\d{15,25}$/;
const BILIBILI_MID_RE = /^\d{2,20}$/;
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const XHS_ID_RE = /^[0-9a-z]{16,40}$/i;
const MAX_REDIRECTS = 8;
const MAX_SEARCH_CANDIDATES = 20;
const REQUEST_TIMEOUT_MS = 30_000;

const PLATFORM_HOSTS = Object.freeze({
  douyin: new Set(["douyin.com", "www.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"]),
  bilibili: new Set(["bilibili.com", "www.bilibili.com", "space.bilibili.com", "b23.tv"]),
  xiaohongshu: new Set(["xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com", "www.xhslink.com"]),
});

function clean(value, max = 1_000) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizedIdentity(value) {
  return clean(value, 180).replace(/^@/, "").toLocaleLowerCase("zh-CN");
}

export function normalizedNickname(value) {
  return clean(value, 180).toLocaleLowerCase("zh-CN");
}

function hostPlatform(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return Object.entries(PLATFORM_HOSTS).find(([, hosts]) => hosts.has(host))?.[0] ?? null;
}

function safeOfficialUrl(value) {
  let parsed;
  try { parsed = new URL(clean(value)); }
  catch { throw new Error("输入不是合法 URL"); }
  if (parsed.protocol !== "https:") throw new Error("只允许 HTTPS 官方链接");
  if (parsed.username || parsed.password) throw new Error("官方链接不得包含 URL 凭据");
  const platform = hostPlatform(parsed.hostname);
  if (!platform) throw new Error(`非允许的平台官方域名：${parsed.hostname}`);
  return { parsed, platform };
}

function redactedEvidenceUrl(value) {
  const parsed = new URL(String(value));
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function canonicalEvidenceFromUrl(value) {
  const { parsed, platform } = safeOfficialUrl(value);
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (platform === "douyin") {
    const secUid = /\/user\/(MS4wLj[\w-]{12,220})/i.exec(path)?.[1]
      ?? parsed.searchParams.get("sec_uid")
      ?? parsed.searchParams.get("sec_user_id");
    if (secUid && SEC_UID_RE.test(secUid)) {
      return { platform, kind: "account", canonicalId: secUid, canonicalUrl: `https://www.douyin.com/user/${secUid}` };
    }
    const contentId = /\/(?:video|note|share\/video)\/(\d{15,25})/i.exec(path)?.[1]
      ?? parsed.searchParams.get("modal_id")
      ?? parsed.searchParams.get("aweme_id")
      ?? parsed.searchParams.get("item_id");
    if (contentId && DOUYIN_CONTENT_ID_RE.test(contentId)) {
      return { platform, kind: "content", canonicalId: contentId, canonicalUrl: `https://www.douyin.com/video/${contentId}` };
    }
  }
  if (platform === "bilibili") {
    const mid = /^\/(\d{2,20})(?:\/|$)/.exec(path)?.[1];
    if (parsed.hostname === "space.bilibili.com" && mid && BILIBILI_MID_RE.test(mid)) {
      return { platform, kind: "account", canonicalId: mid, canonicalUrl: `https://space.bilibili.com/${mid}` };
    }
    const bvid = /\/(?:video\/)?(BV[0-9A-Za-z]{10})(?:\/|$)/.exec(path)?.[1]
      ?? parsed.searchParams.get("bvid");
    if (bvid && BVID_RE.test(bvid)) {
      return { platform, kind: "content", canonicalId: bvid, canonicalUrl: `https://www.bilibili.com/video/${bvid}` };
    }
  }
  if (platform === "xiaohongshu") {
    const userId = /\/user\/profile\/([0-9a-z]{16,40})/i.exec(path)?.[1];
    if (userId && XHS_ID_RE.test(userId)) {
      return { platform, kind: "account", canonicalId: userId.toLowerCase(), canonicalUrl: `https://www.xiaohongshu.com/user/profile/${userId.toLowerCase()}` };
    }
    const noteId = /\/(?:explore|discovery\/item)\/([0-9a-z]{16,40})/i.exec(path)?.[1];
    if (noteId && XHS_ID_RE.test(noteId)) {
      return { platform, kind: "content", canonicalId: noteId.toLowerCase(), canonicalUrl: `https://www.xiaohongshu.com/explore/${noteId.toLowerCase()}` };
    }
  }
  return { platform, kind: "unknown", canonicalId: null, canonicalUrl: null };
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function expandOfficialShortUrl(value, { fetchImpl = globalThis.fetch } = {}) {
  const start = safeOfficialUrl(value);
  if (!["v.douyin.com", "b23.tv", "xhslink.com", "www.xhslink.com"].includes(start.parsed.hostname.toLowerCase())) {
    throw new Error("输入不是受支持的平台官方短链");
  }
  let current = start.parsed;
  const chain = [];
  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    const checked = safeOfficialUrl(current.toString());
    if (checked.platform !== start.platform) throw new Error("短链跨平台跳转，已拒绝");
    const response = await fetchWithTimeout(fetchImpl, current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
        "accept-language": "zh-CN,zh;q=0.9",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      },
    });
    const location = response.headers.get("location");
    chain.push({
      url: redactedEvidenceUrl(current),
      status: response.status,
      location: location ? redactedEvidenceUrl(new URL(location, current)) : null,
    });
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    const final = safeOfficialUrl(current.toString());
    if (final.platform !== start.platform) throw new Error("短链最终落点跨平台，已拒绝");
    return {
      platform: start.platform,
      sourceUrl: redactedEvidenceUrl(start.parsed),
      finalUrl: redactedEvidenceUrl(final.parsed),
      canonical: canonicalEvidenceFromUrl(final.parsed.toString()),
      chain,
      anonymous: true,
      persistentCookiesRead: false,
      persistentCookiesWritten: false,
    };
  }
  throw new Error(`短链跳转超过 ${MAX_REDIRECTS} 次限制`);
}

function publicAuthor(user, provenance) {
  const canonicalId = clean(user?.sec_uid ?? user?.secUid, 240);
  if (!SEC_UID_RE.test(canonicalId)) return null;
  return {
    canonicalId,
    canonicalUrl: `https://www.douyin.com/user/${canonicalId}`,
    nickname: clean(user?.nickname, 180),
    uniqueId: clean(user?.unique_id ?? user?.uniqueId, 180),
    shortId: clean(user?.short_id ?? user?.shortId, 180),
    uid: clean(user?.uid, 180),
    provenance,
  };
}

async function douyinContentAuthor(contentId, { executablePath = DEFAULT_CHROME } = {}) {
  const { chromium } = await import("playwright-core");
  await access(executablePath);
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--disable-background-networking", "--mute-audio"] });
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  await context.route(/\.(?:png|jpe?g|gif|webp|avif|mp4|m4a|woff2?)(?:\?|$)/i, (route) => route.abort());
  const page = await context.newPage();
  try {
    await page.goto(`https://www.douyin.com/video/${contentId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4_000);
    const detail = await page.evaluate(async (id) => {
      const url = new URL("/aweme/v1/web/aweme/detail/", location.origin);
      url.searchParams.set("aweme_id", id);
      url.searchParams.set("device_platform", "webapp");
      url.searchParams.set("aid", "6383");
      try {
        const response = await fetch(url, { credentials: "include" });
        const payload = await response.json();
        const aweme = payload?.aweme_detail ?? null;
        return { httpStatus: response.status, statusCode: payload?.status_code ?? null, awemeId: String(aweme?.aweme_id ?? ""), author: aweme?.author ?? null };
      } catch (error) {
        return { error: String(error?.message ?? error).slice(0, 200) };
      }
    }, contentId);
    const author = detail?.awemeId === contentId ? publicAuthor(detail.author, "douyin-official-public-detail") : null;
    return {
      detail: {
        httpStatus: detail?.httpStatus ?? null,
        statusCode: detail?.statusCode ?? null,
        awemeId: detail?.awemeId ?? "",
        error: detail?.error ?? null,
      },
      author,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function findXhsNoteAuthor(value, noteId, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return null;
  seen.add(value);
  const objectId = clean(value.id ?? value.noteId ?? value.note_id, 80).toLowerCase();
  const card = value.noteCard ?? value.note_card ?? value;
  const cardId = clean(card.noteId ?? card.note_id ?? card.id, 80).toLowerCase();
  if (objectId === noteId || cardId === noteId) {
    const user = card.user ?? value.user ?? card.author ?? value.author ?? {};
    const userId = clean(user.userId ?? user.user_id ?? user.userid ?? user.id, 80).toLowerCase();
    if (XHS_ID_RE.test(userId)) return { canonicalId: userId, canonicalUrl: `https://www.xiaohongshu.com/user/profile/${userId}`, nickname: clean(user.nickname ?? user.nickName ?? user.name, 180), provenance: "xiaohongshu-official-note-initial-state" };
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findXhsNoteAuthor(nested, noteId, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function parseXhsInitialState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  const end = start < 0 ? -1 : html.indexOf("</script>", start);
  if (start < 0 || end <= start) return null;
  const raw = html.slice(start + marker.length, end).trim().replace(/;$/, "").replace(/\bundefined\b/g, "null");
  try { return JSON.parse(raw); } catch { return null; }
}

function unwrapReactive(value) {
  if (!value || typeof value !== "object") return value;
  return value._value ?? value.value ?? value;
}

async function xiaohongshuProfileId(userId, { fetchImpl = globalThis.fetch } = {}) {
  const id = clean(userId, 80).toLowerCase();
  if (!XHS_ID_RE.test(id)) throw new Error("小红书用户 ID 格式无效");
  const canonicalUrl = `https://www.xiaohongshu.com/user/profile/${id}`;
  const response = await fetchWithTimeout(fetchImpl, canonicalUrl, { headers: { "accept-language": "zh-CN,zh;q=0.9", "user-agent": "Mozilla/5.0 Chrome/140 Safari/537.36" } });
  const html = await response.text();
  const state = parseXhsInitialState(html);
  const userState = state?.user ?? {};
  const profile = unwrapReactive(userState.userPageData) ?? {};
  const notes = unwrapReactive(userState.notes);
  const flattened = Array.isArray(notes) ? notes.flatMap((item) => Array.isArray(item) ? item : [item]) : [];
  const returnedIds = new Set([
    ...(Array.isArray(userState.noteQueries) ? userState.noteQueries.map((item) => item?.userId) : []),
    ...flattened.map((item) => (item?.noteCard ?? item)?.user?.userId),
  ].map((value) => clean(value, 80).toLowerCase()).filter(Boolean));
  const identityVerified = returnedIds.size > 0 && [...returnedIds].every((value) => value === id);
  const nickname = clean(profile?.basicInfo?.nickname, 180);
  return {
    platform: "xiaohongshu", queryKind: "id", query: id, canonicalUrl,
    httpStatus: response.status, initialStatePresent: Boolean(state), returnedIds: [...returnedIds], nickname,
    decision: identityVerified
      ? { status: "resolved", reason: "官方主页初始状态中的用户 ID 与提交 ID 严格一致", matches: [{ canonicalId: id, canonicalUrl, nickname }] }
      : { status: "unresolved", reason: state ? "官方主页初始状态没有返回可严格核对的用户 ID" : "官方主页没有返回可解析的公开初始状态", matches: [] },
    anonymous: true,
  };
}

async function resolveContentAuthor(value, options = {}) {
  const source = safeOfficialUrl(value);
  const expanded = ["v.douyin.com", "b23.tv", "xhslink.com", "www.xhslink.com"].includes(source.parsed.hostname.toLowerCase())
    ? await expandOfficialShortUrl(source.parsed.toString(), options)
    : null;
  const canonical = expanded?.canonical ?? canonicalEvidenceFromUrl(source.parsed.toString());
  if (canonical.kind !== "content") throw new Error("链接没有解析为平台作品 canonical ID");
  if (canonical.platform === "douyin") {
    const result = await douyinContentAuthor(canonical.canonicalId, options);
    return { platform: "douyin", source: canonical, expanded, ...result, anonymousFreshBrowserContext: true, persistentCookiesRead: false, persistentCookiesWritten: false };
  }
  if (canonical.platform === "bilibili") {
    const endpoint = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(canonical.canonicalId)}`;
    const response = await fetchWithTimeout(options.fetchImpl ?? globalThis.fetch, endpoint, { headers: { referer: "https://www.bilibili.com/", "user-agent": "Mozilla/5.0 Chrome/140 Safari/537.36" } });
    const payload = await response.json();
    const owner = payload?.data?.owner ?? {};
    const returnedBvid = clean(payload?.data?.bvid, 20);
    const mid = clean(owner.mid, 30);
    const author = returnedBvid === canonical.canonicalId && BILIBILI_MID_RE.test(mid)
      ? { canonicalId: mid, canonicalUrl: `https://space.bilibili.com/${mid}`, nickname: clean(owner.name), provenance: "bilibili-official-view" }
      : null;
    return { platform: "bilibili", source: canonical, expanded, endpoint, httpStatus: response.status, upstreamCode: payload?.code, returnedContentId: returnedBvid, author, anonymous: true };
  }
  const response = await fetchWithTimeout(options.fetchImpl ?? globalThis.fetch, canonical.canonicalUrl, { headers: { "accept-language": "zh-CN,zh;q=0.9", "user-agent": "Mozilla/5.0 Chrome/140 Safari/537.36" } });
  const html = await response.text();
  const state = parseXhsInitialState(html);
  const author = state ? findXhsNoteAuthor(state, canonical.canonicalId) : null;
  return { platform: "xiaohongshu", source: canonical, expanded, httpStatus: response.status, initialStatePresent: Boolean(state), author, anonymous: true };
}

export function decideStrictMatch({ platform, queryKind, query, candidates }) {
  const normalizedQuery = queryKind === "name" ? normalizedNickname(query) : normalizedIdentity(query);
  const unique = new Map();
  for (const candidate of candidates ?? []) {
    const canonicalId = clean(candidate?.canonicalId, 240);
    if (!canonicalId) continue;
    const idValues = [candidate?.uniqueId, candidate?.shortId, candidate?.uid, candidate?.canonicalId]
      .map(normalizedIdentity).filter(Boolean);
    const name = normalizedNickname(candidate?.nickname);
    const matched = queryKind === "name" ? name === normalizedQuery : idValues.includes(normalizedQuery);
    if (matched) unique.set(canonicalId, candidate);
  }
  const matches = [...unique.values()];
  if (queryKind === "name") {
    return {
      status: matches.length ? "candidate-only" : "unresolved",
      reason: matches.length
        ? "昵称不是平台唯一键；即使首屏只有一个同名结果，也不能单独自动确权"
        : "未找到官方资料中昵称严格相等的候选",
      matches,
    };
  }
  return matches.length === 1
    ? { status: "resolved", reason: "官方资料中的唯一 ID 字段严格相等，且仅有一个 canonical 账号", matches }
    : {
        status: "unresolved",
        reason: matches.length > 1 ? "同一 ID 命中多个 canonical 账号，拒绝自动确权" : "没有官方资料中的 ID 字段与输入严格相等",
        matches,
      };
}

export async function douyinSearch(query, queryKind, { headed = false, executablePath = DEFAULT_CHROME } = {}) {
  const { chromium } = await import("playwright-core");
  await access(executablePath);
  const browser = await chromium.launch({ headless: !headed, executablePath, args: ["--disable-background-networking", "--mute-audio"] });
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  await context.route(/\.(?:png|jpe?g|gif|webp|avif|mp4|m4a|woff2?)(?:\?|$)/i, (route) => route.abort());
  const page = await context.newPage();
  const observedSearchResponses = [];
  const responseTasks = [];
  page.on("response", (response) => {
    const responseUrl = response.url();
    if (!/douyin\.com\/aweme\/v\d+\/web\/[^?]*search/i.test(responseUrl) || observedSearchResponses.length + responseTasks.length >= 8) return;
    responseTasks.push((async () => {
      let payload = null;
      try { payload = await response.json(); } catch {}
      const data = Array.isArray(payload?.data) ? payload.data : [];
      observedSearchResponses.push({
        endpoint: new URL(responseUrl).pathname,
        httpStatus: response.status(),
        statusCode: payload?.status_code ?? null,
        topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
        dataCount: data.length,
        itemTypes: [...new Set(data.map((item) => item?.type).filter((value) => value !== undefined))].slice(0, 12),
        userListItems: data.reduce((sum, item) => sum + (Array.isArray(item?.user_list) ? item.user_list.length : 0), 0),
      });
    })());
  });
  try {
    const url = `https://www.douyin.com/search/${encodeURIComponent(query)}?type=user`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6_000);
    await Promise.allSettled(responseTasks);
    const pageState = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      const anchors = [...document.querySelectorAll('a[href*="/user/"]')].slice(0, 100).map((anchor) => ({
        href: anchor.href,
        text: (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
      }));
      return { title: document.title, text: text.slice(0, 2_000), anchors };
    });
    const candidateIds = [...new Set(pageState.anchors.map((item) => /\/user\/(MS4wLj[\w-]{12,220})/.exec(item.href)?.[1]).filter(Boolean))]
      .slice(0, MAX_SEARCH_CANDIDATES);
    const candidates = [];
    for (const secUid of candidateIds) {
      const profile = await page.evaluate(async (id) => {
        const url = new URL("/aweme/v1/web/user/profile/other/", location.origin);
        url.searchParams.set("sec_user_id", id);
        url.searchParams.set("device_platform", "webapp");
        url.searchParams.set("aid", "6383");
        try {
          const response = await fetch(url, { credentials: "include" });
          const payload = await response.json();
          const user = payload?.user ?? payload?.user_info ?? {};
          return {
            profileHttpStatus: response.status,
            profileStatusCode: payload?.status_code ?? null,
            canonicalId: String(user.sec_uid ?? ""), nickname: String(user.nickname ?? ""),
            uniqueId: String(user.unique_id ?? ""), shortId: String(user.short_id ?? ""), uid: String(user.uid ?? ""),
          };
        } catch (error) {
          return { error: String(error?.message ?? error).slice(0, 200) };
        }
      }, secUid);
      if (profile?.profileHttpStatus === 200 && profile.profileStatusCode === 0
        && profile.canonicalId === secUid) candidates.push({ ...profile, canonicalUrl: `https://www.douyin.com/user/${secUid}` });
    }
    return {
      platform: "douyin", query, queryKind, searchUrl: url, pageTitle: pageState.title,
      loginGateObserved: /登录后|扫码登录|验证码/.test(pageState.text),
      observedSearchResponses,
      officialProfileAnchors: candidateIds.length, candidates,
      decision: decideStrictMatch({ platform: "douyin", queryKind, query, candidates }),
      anonymousFreshBrowserContext: true, persistentCookiesRead: false, persistentCookiesWritten: false,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function bilibiliSearch(query, queryKind, { fetchImpl = globalThis.fetch } = {}) {
  if (queryKind === "id" && BILIBILI_MID_RE.test(clean(query))) {
    const mid = clean(query);
    const endpoint = `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}&photo=true`;
    const response = await fetchWithTimeout(fetchImpl, endpoint, {
      headers: { referer: "https://www.bilibili.com/", "user-agent": "Mozilla/5.0 Chrome/140 Safari/537.36" },
    });
    const payload = await response.json();
    const card = payload?.data?.card ?? {};
    const candidates = String(card.mid ?? "") === mid ? [{ canonicalId: mid, uid: mid, nickname: String(card.name ?? ""), canonicalUrl: `https://space.bilibili.com/${mid}` }] : [];
    return { platform: "bilibili", query, queryKind, endpoint, httpStatus: response.status, upstreamCode: payload?.code, candidates, decision: decideStrictMatch({ platform: "bilibili", queryKind, query, candidates }), anonymous: true };
  }
  const endpoint = new URL("https://api.bilibili.com/x/web-interface/search/type");
  endpoint.searchParams.set("search_type", "bili_user");
  endpoint.searchParams.set("keyword", query);
  endpoint.searchParams.set("page", "1");
  const response = await fetchWithTimeout(fetchImpl, endpoint, {
    headers: { referer: "https://search.bilibili.com/", "user-agent": "Mozilla/5.0 Chrome/140 Safari/537.36" },
  });
  const payload = await response.json();
  const candidates = (payload?.data?.result ?? []).slice(0, MAX_SEARCH_CANDIDATES).map((item) => ({
    canonicalId: String(item.mid ?? ""), uid: String(item.mid ?? ""), nickname: clean(item.uname), canonicalUrl: `https://space.bilibili.com/${item.mid}`,
  })).filter((item) => BILIBILI_MID_RE.test(item.canonicalId));
  return { platform: "bilibili", query, queryKind, endpoint: endpoint.toString(), httpStatus: response.status, upstreamCode: payload?.code, candidates, decision: decideStrictMatch({ platform: "bilibili", queryKind, query, candidates }), anonymous: true };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/probes/identity-resolution-probe.mjs expand <official-short-url>",
    "  node scripts/probes/identity-resolution-probe.mjs canonical <official-url>",
    "  node scripts/probes/identity-resolution-probe.mjs resolve-content <official-content-or-short-url>",
    "  node scripts/probes/identity-resolution-probe.mjs douyin-search <id|name> <query> [--headed]",
    "  node scripts/probes/identity-resolution-probe.mjs bilibili-search <id|name> <query>",
    "  node scripts/probes/identity-resolution-probe.mjs xiaohongshu-id <user-id>",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const [operation, ...args] = argv;
  let result;
  if (operation === "expand" && args[0]) result = await expandOfficialShortUrl(args[0]);
  else if (operation === "canonical" && args[0]) result = canonicalEvidenceFromUrl(args[0]);
  else if (operation === "resolve-content" && args[0]) result = await resolveContentAuthor(args[0]);
  else if (operation === "douyin-search" && ["id", "name"].includes(args[0]) && args[1]) {
    result = await douyinSearch(args[1], args[0], { headed: args.includes("--headed") });
  } else if (operation === "bilibili-search" && ["id", "name"].includes(args[0]) && args[1]) {
    result = await bilibiliSearch(args[1], args[0]);
  } else if (operation === "xiaohongshu-id" && args[0]) {
    result = await xiaohongshuProfileId(args[0]);
  } else {
    throw new Error(usage());
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: clean(error?.message ?? error, 800) }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
