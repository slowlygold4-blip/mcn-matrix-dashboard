#!/usr/bin/env node
/**
 * Authenticated Douyin topic adapter.
 *
 * This is intentionally separate from the anonymous HTTP collector. It uses
 * an app-owned storageState file created by connect-douyin-topics.mjs, reuses
 * one browser context for a batch, and returns only sanitized challenge data.
 * Cookies, headers, raw responses and page HTML never reach stdout or the DB.
 */
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const GENERAL_SEARCH_PATH = "/aweme/v1/web/general/search/single/";
const CHALLENGE_DETAIL_PATH = "/aweme/v1/web/challenge/detail/";
const MAX_LABELS = 64;
const MAX_LABEL_LENGTH = 160;
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL("../data", import.meta.url));
const STATE_PATH = resolve(process.env.DOUYIN_TOPIC_BROWSER_STATE || `${DATA_DIR}/douyin-topic-browser-state.json`);

function clean(value, max = 300) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeTopicLabel(value) {
  return clean(value, MAX_LABEL_LENGTH).replace(/^#+/, "").trim();
}

function topicKey(value) {
  return normalizeTopicLabel(value).replace(/\s+/g, "").toLocaleLowerCase();
}

function isChallengeId(value) {
  return /^\d{8,24}$/.test(String(value ?? "").trim());
}

export function nonNegativeInteger(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = String(value).trim();
  if (!text || !/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizeSearchStatus(payload) {
  const raw = payload?.status_code ?? payload?.statusCode;
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  const text = String(raw ?? "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

const NAME_KEYS = ["cha_name", "challenge_name", "hashtag_name", "tag_name", "word", "text", "name"];
const ID_KEYS = ["cid", "challenge_id", "hashtag_id", "tag_id", "id"];

export function extractExactChallengeIds(payload, expectedLabel) {
  const wanted = topicKey(expectedLabel);
  if (!wanted) return [];
  const result = [];
  const seen = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const names = NAME_KEYS.map((key) => node[key]).filter((value) => value !== null && value !== undefined).map(topicKey);
    if (names.includes(wanted)) {
      for (const key of ID_KEYS) {
        const candidate = clean(node[key], 40);
        if (isChallengeId(candidate) && !seen.has(candidate)) {
          seen.add(candidate);
          result.push(candidate);
        }
      }
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(payload);
  return result.slice(0, 8);
}

function safeStateHash(state) {
  return createHash("sha256").update(JSON.stringify(state ?? {})).digest("hex").slice(0, 16);
}

async function readState() {
  const fileStat = await stat(STATE_PATH).catch(() => null);
  if (!fileStat || (fileStat.mode & 0o077) !== 0) {
    if (fileStat) await chmod(STATE_PATH, 0o600).catch(() => {});
    throw new Error("抖音登录会话文件权限过宽或不存在；请重新授权并确保仅当前用户可读");
  }
  let state;
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    throw new Error("未配置抖音专用登录会话；请先运行 npm run connect:douyin-topics");
  }
  if (!Array.isArray(state?.cookies) || !state.cookies.length) throw new Error("抖音专用登录会话为空，请重新授权");
  return { state, stateHash: safeStateHash(state) };
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("抖音官方响应超时")), ms));
}

async function browserFetch(page, path, params = {}) {
  const result = await Promise.race([
    page.evaluate(async ({ path: requestPath, params: requestParams }) => {
      const url = new URL(requestPath, location.origin);
      for (const [key, value] of Object.entries(requestParams)) url.searchParams.set(key, String(value));
      const response = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      return { httpStatus: response.status, payload, contentType: response.headers.get("content-type") || "" };
    }, { path, params }),
    timeout(35_000),
  ]);
  if (result.httpStatus < 200 || result.httpStatus >= 400) throw new Error(`抖音官方请求 HTTP ${result.httpStatus}`);
  if (!result.payload || typeof result.payload !== "object") throw new Error("抖音官方响应为空或不是 JSON");
  return result.payload;
}

function commonParams() {
  return { device_platform: "webapp", aid: "6383", channel: "channel_pc_web", pc_client_type: "1", version_code: "170400", version_name: "17.4.0", cookie_enabled: "true", platform: "PC", downlink: "10", round_trip_time: "50", webid: "" };
}

async function collectOne(page, requestedLabel, stateHash) {
  const label = normalizeTopicLabel(requestedLabel);
  if (!label) return { label, status: "invalid", error: "缺少话题名称" };
  const keyword = `#${label}`;
  const searchParams = {
    ...commonParams(), search_channel: "aweme_general", enable_history: "1", keyword,
    search_source: "tab_search", query_correct_type: "1", is_filter_search: "0",
    offset: "0", count: "15", need_filter_settings: "1", list_type: "multi", search_id: "",
  };
  const search = await browserFetch(page, GENERAL_SEARCH_PATH, searchParams);
  const statusCode = normalizeSearchStatus(search);
  if (statusCode === 2483) return { label, status: "auth_expired", error: "抖音要求重新登录" };
  if (statusCode !== 0) return { label, status: "search_failed", error: clean(search?.status_msg || `搜索返回状态 ${statusCode ?? "缺失"}`, 220) };
  const challengeIds = extractExactChallengeIds(search, label);
  if (!challengeIds.length) return { label, status: "challenge_not_found", error: "已登录但搜索结果未返回可复核的官方话题 ID" };
  const errors = [];
  const verified = [];
  for (const challengeId of challengeIds) {
    try {
      const detail = await browserFetch(page, CHALLENGE_DETAIL_PATH, { ...commonParams(), ch_id: challengeId, query_type: "0" });
      const info = detail?.ch_info && typeof detail.ch_info === "object" ? detail.ch_info : {};
      const returnedId = clean(info.cid, 40);
      const officialName = normalizeTopicLabel(info.cha_name);
      if (returnedId !== challengeId) throw new Error("官方详情未回显相同 challenge ID");
      if (topicKey(officialName) !== topicKey(label)) throw new Error("官方详情名称与请求话题不一致");
      const participants = nonNegativeInteger(info.user_count);
      const views = nonNegativeInteger(info.view_count);
      verified.push({
        label,
        challengeId,
        officialName,
        capturedAt: new Date().toISOString(),
        snapshot: { hashtagParticipants: participants, hashtagViews: views },
        raw: { challengeId, officialName, searchKeyword: keyword },
        provenance: { mode: "douyin-authenticated-browser-search-and-detail", authenticated: true, paidAPI: false, runtimeAI: false, stateHash },
        warnings: [
          ...(participants === null ? ["官方话题详情未返回参与人数"] : []),
          ...(views === null ? ["官方话题详情未返回播放量"] : []),
        ],
      });
    } catch (error) {
      errors.push(clean(error?.message ?? error, 180));
    }
  }
  if (verified.length > 1) return { label, status: "ambiguous", error: "搜索返回多个同名官方话题，已拒绝猜选" };
  if (verified.length === 1) return { status: "ok", ...verified[0] };
  return { label, status: "detail_failed", error: errors.join("；") || "官方话题详情未通过严格核验" };
}

export async function resolveTopics(labels, { executablePath = process.env.DOUYIN_CHROME_PATH || DEFAULT_CHROME, headed = process.env.DOUYIN_TOPIC_BROWSER_HEADED === "1" } = {}) {
  if (!Array.isArray(labels) || !labels.length) throw new Error("缺少待读取的话题");
  if (labels.length > MAX_LABELS) throw new Error(`单批话题不能超过 ${MAX_LABELS} 个`);
  const normalizedLabels = [...new Set(labels.map(normalizeTopicLabel).filter(Boolean))];
  const { state, stateHash } = await readState();
  const browser = await chromium.launch({ executablePath, headless: !headed });
  const context = await browser.newContext({ storageState: state, locale: "zh-CN", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36" });
  const page = await context.newPage();
  try {
    await page.goto("https://www.douyin.com/search/%23%E4%B8%80%E6%9D%A1%E5%B0%8F%E5%9B%A2%E5%9B%A2ovo", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    const items = [];
    for (const label of normalizedLabels) {
      try {
        items.push(await collectOne(page, label, stateHash));
      } catch (error) {
        items.push({ label, status: "search_failed", error: clean(error?.message ?? error, 220) });
      }
      await page.waitForTimeout(700);
    }
    const refreshed = await context.storageState();
    await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
    await writeFile(STATE_PATH, JSON.stringify(refreshed), { encoding: "utf8", mode: 0o600 });
    await chmod(STATE_PATH, 0o600).catch(() => {});
    return { items, provenance: { mode: "douyin-authenticated-browser-batch", authenticated: true, paidAPI: false, runtimeAI: false, stateHash, batchSize: items.length } };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input || "{}");
  const result = await resolveTopics(payload.labels);
  process.stdout.write(JSON.stringify({ ok: true, data: result }, null, 0));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: clean(error?.message ?? error, 500) }));
    process.exitCode = 1;
  });
}
