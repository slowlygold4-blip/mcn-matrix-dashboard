#!/usr/bin/env node
/**
 * Resolve Douyin authors through the public website in a real local browser.
 *
 * The browser performs Douyin's own anonymous page bootstrap and request
 * signing. No login, API key, paid API, or account-session cookie is used.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STATE_PATH = fileURLToPath(new URL("../data/douyin-public-browser-state.json", import.meta.url));
const VIDEO_ID_RE = /^\d{15,25}$/;
const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const DOUYIN_SHORT_HOST = "v.douyin.com";
const ANONYMOUS_COOKIE_NAMES = new Set([
  "ttwid", "mstoken", "uifid", "uifid_temp", "s_v_web_id", "tt_scid",
  "__ac_nonce", "__ac_signature", "__ac_referer", "odin_tt", "webid",
  "strategyabtestkey", "bd_ticket_guard_client_data", "hevc_supported",
  "volume_info", "isdouyinactive", "search_result_list_type",
  "stream_player_status_params", "device_web_cpu_core", "device_web_memory_size",
  "dy_swidth", "dy_sheight",
]);

function clean(value, max = 300) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

export function isAllowedAnonymousCookie(cookie) {
  const name = clean(cookie?.name, 120).toLowerCase();
  const domain = clean(cookie?.domain, 240).replace(/^\./, "").toLowerCase();
  return ANONYMOUS_COOKIE_NAMES.has(name)
    && (domain === "douyin.com" || domain.endsWith(".douyin.com") || domain === "bytedance.com" || domain.endsWith(".bytedance.com"));
}

export function filterAnonymousState(state) {
  return {
    cookies: (state?.cookies ?? []).filter(isAllowedAnonymousCookie),
    origins: [],
  };
}

function officialShortShareUrl(value) {
  try {
    const parsed = new URL(clean(value, 500));
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== DOUYIN_SHORT_HOST) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function classifyDouyinDestination(value) {
  try {
    const parsed = new URL(clean(value, 1_000));
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !["douyin.com", "www.douyin.com"].includes(hostname)) return null;
    const pathVideoId = parsed.pathname.match(/\/(?:video|note)\/(\d{15,25})(?:\/|$)/i)?.[1];
    const queryVideoId = parsed.searchParams.get("modal_id") || parsed.searchParams.get("aweme_id") || parsed.searchParams.get("item_id");
    const videoId = pathVideoId || (VIDEO_ID_RE.test(queryVideoId ?? "") ? queryVideoId : "");
    if (VIDEO_ID_RE.test(videoId)) return { kind: "video", videoId };
    const pathSecUid = parsed.pathname.match(/\/user\/(MS4wLj[\w-]{12,220})(?:\/|$)/)?.[1];
    const querySecUid = parsed.searchParams.get("sec_uid");
    const secUid = pathSecUid || (SEC_UID_RE.test(querySecUid ?? "") ? querySecUid : "");
    if (SEC_UID_RE.test(secUid)) return { kind: "profile", secUid };
  } catch {}
  return null;
}

function decodeEscaped(value) {
  try { return JSON.parse(`"${String(value).replaceAll('"', '\\"')}"`); }
  catch { return String(value).replaceAll("\\u0026", "&").replaceAll("\\/", "/"); }
}

function authorFromRenderedPage(html, videoId) {
  const marker = `awemeId\\\":\\\"${videoId}\\\"`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const section = html.slice(start, start + 12_000);
  const authorStart = section.indexOf("authorInfo\\\":{");
  if (authorStart < 0) return null;
  const author = section.slice(authorStart, authorStart + 5_000);
  const secUid = /secUid\\\":\\\"(MS4wLj[\w-]{12,220})\\\"/.exec(author)?.[1] ?? "";
  const nicknameValue = /nickname\\\":\\\"((?:\\.|[^"\\])*)\\\"/.exec(author)?.[1] ?? "";
  const uid = /uid\\\":\\\"(\d{2,25})\\\"/.exec(author)?.[1] ?? "";
  if (!SEC_UID_RE.test(secUid)) return null;
  return { videoId, secUid, nickname: decodeEscaped(nicknameValue), uniqueId: "", shortId: "", uid, provenance: "public-rendered-video-page" };
}

async function profileIdentity(page, candidate) {
  if (!SEC_UID_RE.test(candidate.secUid)) return candidate;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const profile = await page.evaluate(async (secUid) => {
      const url = new URL("/aweme/v1/web/user/profile/other/", location.origin);
      url.searchParams.set("sec_user_id", secUid);
      url.searchParams.set("device_platform", "webapp");
      url.searchParams.set("aid", "6383");
      const response = await fetch(url, { credentials: "include" });
      const payload = await response.json();
      const user = payload?.user ?? payload?.user_info ?? {};
      return {
        secUid: user.sec_uid ?? "",
        nickname: user.nickname ?? "",
        uniqueId: user.unique_id ?? "",
        shortId: user.short_id ?? "",
        uid: user.uid ?? "",
      };
      }, candidate.secUid);
      if (profile?.secUid === candidate.secUid) return { ...candidate, ...profile };
    } catch {}
    await page.waitForTimeout(450 * (attempt + 1));
  }
  return candidate;
}

async function fetchDetailBatch(page, tasks) {
  return page.evaluate(async (input) => {
    const one = async ({ key, videoId }) => {
      let finalError = "公开详情未返回作者";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25_000);
        try {
          const url = new URL("/aweme/v1/web/aweme/detail/", location.origin);
          url.searchParams.set("aweme_id", videoId);
          url.searchParams.set("device_platform", "webapp");
          url.searchParams.set("aid", "6383");
          const response = await fetch(url, { credentials: "include", signal: controller.signal });
          const text = await response.text();
          let payload;
          try { payload = JSON.parse(text); }
          catch { throw new Error(text.slice(0, 120) || `HTTP ${response.status}`); }
          const detail = payload?.aweme_detail ?? null;
          const author = detail?.author ?? null;
          const returnedVideoId = String(detail?.aweme_id ?? "").trim();
          if (!returnedVideoId || returnedVideoId !== videoId) {
            finalError = "公开视频身份校验失败：公开响应未严格回显提交内容 ID";
            continue;
          }
          if (author?.sec_uid) {
            return {
              key,
              videoId,
              candidate: {
                videoId: returnedVideoId,
                secUid: String(author.sec_uid ?? ""),
                nickname: String(author.nickname ?? ""),
                uniqueId: String(author.unique_id ?? ""),
                shortId: String(author.short_id ?? ""),
                uid: String(author.uid ?? ""),
                provenance: "public-browser-detail",
              },
              error: null,
            };
          }
          finalError = payload?.filter_detail?.filter_reason || "公开详情未返回作者";
        } catch (error) {
          finalError = String(error?.message ?? error).slice(0, 260);
        } finally {
          clearTimeout(timer);
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 550 * (attempt + 1)));
      }
      return { key, videoId, candidate: null, error: finalError };
    };
    const results = new Array(input.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < input.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await one(input[index]);
      }
    };
    await Promise.all([worker(), worker()]);
    return results;
  }, tasks);
}

async function fetchStableDetailBatch(page, tasks) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetchDetailBatch(page, tasks);
    } catch (error) {
      lastError = error;
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(900 * (attempt + 1));
    }
  }
  throw lastError;
}

async function loadAnonymousState() {
  const candidates = [process.env.DOUYIN_BROWSER_SEED_STATE, STATE_PATH].filter(Boolean);
  for (const path of candidates) {
    try {
      const state = JSON.parse(await readFile(path, "utf8"));
      const filtered = filterAnonymousState(state);
      if ((state?.cookies ?? []).length !== filtered.cookies.length || (state?.origins ?? []).length !== filtered.origins.length) {
        await writeFile(path, JSON.stringify(filtered), { encoding: "utf8", mode: 0o600 }).catch(() => {});
      }
      if (filtered.cookies.length) return filtered;
    } catch {}
  }
  return undefined;
}

async function saveAnonymousState(context) {
  const state = await context.storageState();
  const filtered = filterAnonymousState(state);
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(filtered), { encoding: "utf8", mode: 0o600 });
}

async function resolveRenderedFallback(page, item, videoId) {
  try {
    await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForFunction((id) => document.documentElement.innerHTML.includes(id), videoId, { timeout: 20_000 }).catch(() => {});
    const candidate = authorFromRenderedPage(await page.content(), videoId);
    return candidate ? await profileIdentity(page, candidate) : null;
  } catch {
    return null;
  }
}

export function normalizeAuthorResolverItems(payload) {
  if (!Array.isArray(payload?.items) || !payload.items.length) throw new Error("浏览器核验缺少作者证据");
  if (payload.items.length > 5_000) throw new Error("单次浏览器核验作者超过 5000 个限制");
  return payload.items.map((item) => {
    const videoIds = [...new Set((Array.isArray(item?.videoIds) ? item.videoIds : []).map((value) => clean(value, 40)).filter((value) => VIDEO_ID_RE.test(value)))];
    const shareUrls = [...new Set((Array.isArray(item?.shareUrls) ? item.shareUrls : []).map(officialShortShareUrl).filter(Boolean))];
    if (videoIds.length > 5_000 || shareUrls.length > 5_000) {
      throw new Error("单个作者的作品 ID 或分享链接超过 5000 条限制");
    }
    return {
      key: clean(item?.key),
      name: clean(item?.name, 120),
      douyinId: clean(item?.douyinId, 120),
      videoIds,
      shareUrls,
      shareEvidenceByVideoId: {},
    };
  });
}

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return normalizeAuthorResolverItems(JSON.parse(text));
}

async function main() {
  const items = await readInput();
  const executablePath = process.env.DOUYIN_CHROME_PATH || DEFAULT_CHROME;
  await access(executablePath);
  const headed = process.env.DOUYIN_BROWSER_HEADED === "1";
  const browser = await chromium.launch({
    headless: !headed,
    executablePath,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-background-networking",
      "--mute-audio",
      ...(headed ? ["--window-position=-32000,-32000", "--window-size=900,700"] : []),
    ],
  });
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    storageState: await loadAnonymousState(),
  });
  await context.route(/\.(?:png|jpe?g|gif|webp|avif|mp4|m4a|woff2?)(?:\?|$)/i, (route) => route.abort());
  const page = await context.newPage();
  const output = new Map(items.map((item) => [item.key, { key: item.key, candidates: [], errors: [] }]));
  try {
    const pending = new Map(items.map((item) => [item.key, item]));
    for (const item of items) {
      const target = output.get(item.key);
      for (const shareUrl of item.shareUrls) {
        if (!pending.has(item.key)) break;
        try {
          await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
          const destination = classifyDouyinDestination(page.url());
          if (destination?.kind === "video") {
            if (!item.videoIds.includes(destination.videoId)) item.videoIds.push(destination.videoId);
            if (!Array.isArray(item.shareEvidenceByVideoId[destination.videoId])) item.shareEvidenceByVideoId[destination.videoId] = [];
            if (!item.shareEvidenceByVideoId[destination.videoId].includes(shareUrl)) item.shareEvidenceByVideoId[destination.videoId].push(shareUrl);
            continue;
          }
          if (destination?.kind === "profile") {
            const candidate = await profileIdentity(page, {
              videoId: "",
              secUid: destination.secUid,
              nickname: "",
              uniqueId: "",
              shortId: "",
              uid: "",
              provenance: "public-short-link-profile",
            });
            const sourcedCandidate = { ...candidate, sourceEvidenceUrl: shareUrl };
            target.candidates.push(sourcedCandidate);
            continue;
          }
          target.errors.push({ shareUrl, error: "官方分享链接未展开为可核验的作品或作者主页", channel: "public-short-link" });
        } catch (error) {
          target.errors.push({ shareUrl, error: clean(error?.message ?? error), channel: "public-short-link" });
        }
      }
    }

    const firstVideoId = [...pending.values()].flatMap((item) => item.videoIds)[0];
    if (firstVideoId) {
      await page.goto(`https://www.douyin.com/video/${firstVideoId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(4_000);
    }

    const maxVideoEvidence = Math.max(0, ...[...pending.values()].map((item) => item.videoIds.length));
    for (let videoIndex = 0; videoIndex < maxVideoEvidence && pending.size; videoIndex += 1) {
      const tasks = [...pending.values()]
        .map((item) => ({ key: item.key, videoId: item.videoIds[videoIndex] }))
        .filter((task) => VIDEO_ID_RE.test(task.videoId));
      for (let start = 0; start < tasks.length; start += 10) {
        const batch = tasks.slice(start, start + 10);
        const fetched = await fetchStableDetailBatch(page, batch);
        for (const result of fetched) {
          const item = pending.get(result.key);
          const target = output.get(result.key);
          if (!item || !target) continue;
          if (result.candidate && SEC_UID_RE.test(result.candidate.secUid)) {
            const sourceUrls = item.shareEvidenceByVideoId[result.videoId] ?? [];
            if (sourceUrls.length) target.candidates.push(...sourceUrls.map((sourceEvidenceUrl) => ({ ...result.candidate, sourceEvidenceUrl })));
            else target.candidates.push(result.candidate);
          } else if (result.error) {
            target.errors.push({ videoId: result.videoId, error: clean(result.error), channel: "public-browser-detail" });
          }
        }
        if (start + 10 < tasks.length) await page.waitForTimeout(180);
      }
    }

    // Image-note detail responses can be filtered even though the public page
    // is readable. Navigate those cases and verify the returned sec_uid.
    const renderedFallbackItems = [...pending.values()].filter((item) => {
      const errors = output.get(item.key)?.errors ?? [];
      return errors.some((entry) => ["images_base", "image_base"].includes(String(entry.error ?? "").toLowerCase()));
    }).slice(0, 16);
    for (const item of renderedFallbackItems) {
      const target = output.get(item.key);
      for (const videoId of item.videoIds) {
        const candidate = await resolveRenderedFallback(page, item, videoId);
        if (!candidate) continue;
        const sourceUrls = item.shareEvidenceByVideoId[videoId] ?? [];
        if (sourceUrls.length) target.candidates.push(...sourceUrls.map((sourceEvidenceUrl) => ({ ...candidate, sourceEvidenceUrl })));
        else target.candidates.push(candidate);
      }
    }
  } finally {
    await saveAnonymousState(context).catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      items: items.map((item) => output.get(item.key)),
      provenance: { mode: "public-browser-anonymous-author-resolution", anonymousSessionOnly: true, cookiePersisted: true, runtimeAI: false, paidAPI: false },
    },
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: clean(error?.message ?? error, 800) }));
    process.exitCode = 1;
  });
}
