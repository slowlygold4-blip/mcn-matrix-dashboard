import { asIsoDate, asNonNegativeInteger, checksum, clampText, nowIso } from "../utils.mjs";
import { deriveCollectionHealth } from "../collection-health.mjs";

function unwrapObject(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of ["aweme_info", "item", "video", "post", "aweme", "data"]) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) return value[key];
  }
  return value;
}

function findValue(source, keys, depth = 0, seen = new Set()) {
  if (!source || typeof source !== "object" || depth > 5 || seen.has(source)) return undefined;
  seen.add(source);
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const found = findValue(value, keys, depth + 1, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findArray(source, preferredKeys, depth = 0, seen = new Set()) {
  if (!source || typeof source !== "object" || depth > 6 || seen.has(source)) return [];
  seen.add(source);
  for (const key of preferredKeys) {
    if (Array.isArray(source[key])) return source[key];
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === "object") {
      const found = findArray(value, preferredKeys, depth + 1, seen);
      if (found.length) return found;
    }
  }
  return [];
}

export function unwrapMcpToolResult(response) {
  const result = response?.result ?? response;
  if (result?.structuredContent) return result.structuredContent;
  const textParts = (result?.content ?? []).filter((item) => item?.type === "text").map((item) => item.text);
  if (!textParts.length) return result;
  const combined = textParts.join("\n");
  try { return JSON.parse(combined); } catch { return { text: combined }; }
}

export function normalizePost(input, fallbackPrefix = "post") {
  const item = unwrapObject(input) ?? {};
  const author = item.author ?? item.user ?? item.creator ?? item;
  const stats = item.statistics ?? item.stats ?? item.metrics ?? item;
  const rawId = findValue(item, ["aweme_id", "item_id", "video_id", "id"]);
  const publishedAt = asIsoDate(findValue(item, ["published_at", "publish_time", "create_time", "created_at"]));
  const caption = clampText(findValue(item, ["desc", "title", "caption", "description", "content"]) ?? "", 2000);
  const externalId = String(rawId ?? `${fallbackPrefix}-${checksum([caption, publishedAt, findValue(author, ["sec_uid", "uid", "id", "nickname"])]).slice(0, 24)}`);
  return {
    externalId,
    authorId: String(findValue(author, ["sec_uid", "sec_user_id", "uid", "user_id", "id"]) ?? "") || null,
    authorName: clampText(findValue(author, ["nickname", "name", "display_name", "author_name"]) ?? "", 200) || null,
    caption,
    publishedAt,
    likes: asNonNegativeInteger(findValue(stats, ["digg_count", "like_count", "likes", "liked_count"])),
    comments: asNonNegativeInteger(findValue(stats, ["comment_count", "comments"])),
    shares: asNonNegativeInteger(findValue(stats, ["share_count", "shares"])),
    collects: asNonNegativeInteger(findValue(stats, ["collect_count", "collects", "favorite_count"])),
    plays: asNonNegativeInteger(findValue(stats, ["play_count", "view_count", "views", "plays"])),
    url: String(findValue(item, ["share_url", "url", "web_url", "video_url"]) ?? (rawId ? `https://www.douyin.com/video/${rawId}` : "")) || null,
    raw: input,
  };
}

export function normalizeCollection(target, raw, { capturedAt = nowIso() } = {}) {
  const warnings = [];
  const list = findArray(raw, ["aweme_list", "video_list", "videos", "items", "works", "posts", "result_list", "data_list"]);
  const worksKeys = ["aweme_list", "video_list", "videos", "items", "works", "posts", "result_list", "data_list"];
  const hasWorksContainer = worksKeys.some((key) => Object.prototype.hasOwnProperty.call(raw ?? {}, key))
    || Object.values(raw ?? {}).some((value) => value && typeof value === "object" && !Array.isArray(value)
      && worksKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key)));
  const posts = [];
  const seenIds = new Set();
  for (const item of list) {
    const post = normalizePost(item, `${target.type}-${target.id}`);
    if (seenIds.has(post.externalId)) continue;
    seenIds.add(post.externalId);
    posts.push(post);
  }
  const profile = raw?.user ?? raw?.user_info ?? raw?.profile ?? raw?.creator ?? raw;
  const authors = new Set(posts.map((post) => post.authorId || post.authorName).filter(Boolean));
  const snapshot = target.type === "account"
      ? {
        followers: asNonNegativeInteger(findValue(profile, ["follower_count", "followers", "fans_count"])),
        totalLikes: asNonNegativeInteger(findValue(profile, ["total_favorited", "total_likes", "liked_count"])),
        // A public page can return only a sampled works window. Its length is
        // never evidence for the account's cumulative publication count.
        totalPosts: asNonNegativeInteger(findValue(profile, ["aweme_count", "video_count", "post_count", "works_count"])),
        hashtagParticipants: null,
        hashtagViews: null,
        hashtagPosts: null,
        authorCount: posts.length ? 1 : null,
      }
      : {
        followers: null,
        // Topic metrics are only valid when the official topic endpoint
        // returns them. Likes summed from a local account sample are not the
        // topic's cumulative likes and must never enter account reports.
        totalLikes: null,
        totalPosts: null,
        // Only accept an explicit public topic participant field.  The number
        // of authors in a local sample is not the topic's official participant
        // count and must never be used as a substitute.
        hashtagParticipants: asNonNegativeInteger(findValue(raw, [
          "participant_count", "participate_count", "participation_count",
          "participants", "participant_num", "user_count", "users_count",
        ])),
        hashtagViews: asNonNegativeInteger(findValue(raw, ["view_count", "views", "play_count"])),
        hashtagPosts: asNonNegativeInteger(findValue(raw, ["video_count", "aweme_count", "post_count"])),
      authorCount: authors.size || null,
    };
  if (!posts.length && !(target.type === "account" && hasWorksContainer && snapshot.totalPosts === 0)) {
    warnings.push("本次响应未识别到作品列表；未用 0 覆盖历史数据");
  }
  if (target.type === "account" && snapshot.followers === null) warnings.push("响应未包含粉丝总数");
  if (target.type === "account" && snapshot.totalPosts === null) warnings.push("响应未包含账号作品总数；已保留缺失，不用作品样本条数替代");
  if (posts.some((post) => post.likes === null)) warnings.push("部分作品缺少点赞数");
  const normalizedWarnings = [...new Set([...warnings, ...(Array.isArray(raw?.warnings) ? raw.warnings : [])])];
  const health = deriveCollectionHealth(target, snapshot, normalizedWarnings, raw);
  return {
    capturedAt,
    posts,
    snapshot,
    warnings: normalizedWarnings,
    qualityStatus: normalizedWarnings.length ? "warning" : "validated",
    ...health,
    sourceChecksum: checksum(raw),
    raw,
  };
}

export function normalizeManualCollection(target, body) {
  if (!body || typeof body !== "object") throw new Error("导入内容必须是 JSON 对象");
  const rawPosts = Array.isArray(body.posts) ? body.posts : [];
  const posts = rawPosts.map((item) => normalizePost(item, `manual-${target.id}`));
  // Preserve submitted fields while attaching a server-owned source marker.
  // This lets readers keep imported records without presenting them as a
  // verified platform observation when they were uploaded to a public target.
  const raw = { ...body, codexObservation: { version: 1, source: "manual-import" } };
  const warnings = ["此记录来自手工导入；未经平台来源核验，不计入公开平台趋势、增长与覆盖"];
  if (!body.capturedAt) warnings.push("未提供 capturedAt，已使用服务器接收时间");
  const snapshot = {
    followers: asNonNegativeInteger(body.snapshot?.followers),
    totalLikes: asNonNegativeInteger(body.snapshot?.totalLikes),
    totalPosts: asNonNegativeInteger(body.snapshot?.totalPosts),
    hashtagParticipants: asNonNegativeInteger(body.snapshot?.hashtagParticipants),
    hashtagViews: asNonNegativeInteger(body.snapshot?.hashtagViews),
    hashtagPosts: asNonNegativeInteger(body.snapshot?.hashtagPosts),
    authorCount: asNonNegativeInteger(body.snapshot?.authorCount, new Set(posts.map((post) => post.authorId || post.authorName).filter(Boolean)).size || null),
  };
  if (!posts.length && !(target.type === "account" && snapshot.totalPosts === 0)) warnings.push("本次导入没有作品记录");
  if (target.type === "account" && snapshot.totalPosts === null) warnings.push("导入未包含账号作品总数；已保留缺失，不用作品样本条数替代");
  const health = deriveCollectionHealth(target, snapshot, warnings, body);
  return {
    capturedAt: asIsoDate(body.capturedAt, nowIso()),
    posts,
    snapshot,
    warnings,
    qualityStatus: warnings.length ? "warning" : "validated",
    ...health,
    sourceChecksum: checksum(raw),
    raw,
  };
}
