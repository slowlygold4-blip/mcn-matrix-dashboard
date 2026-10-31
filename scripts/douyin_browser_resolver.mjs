#!/usr/bin/env node
// Historical pure parsers remain available; the live browser command is retired.
import { fileURLToPath } from "node:url";
import { reportRetiredDouyinBrowserCommand } from "../lib/retired-douyin-browser-command.mjs";

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

if (process.argv[1] === fileURLToPath(import.meta.url)) await reportRetiredDouyinBrowserCommand();
