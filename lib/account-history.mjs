import { businessDateKey, isCalendarDate, safeJson, shiftCalendarDate } from './utils.mjs';
import { canonicalAccountLocator } from './author-spreadsheet.mjs';
import { validateAccountSnapshot } from './account-snapshot-integrity.mjs';
import { postsAsOf, publicUrl } from './product-insights.mjs';
import { describeWorkPlays } from './work-play-semantics.mjs';
import { assertCommittedTargetPublication, committedSnapshotAllowed } from './committed-target-publication.mjs';

const ZONE = 'Asia/Shanghai';
const COUNTERS = ['likes', 'comments', 'shares', 'collects', 'plays'];
const CAPS = ['snapshotMaxId', 'postMaxId', 'postMetricMaxId'];
const SORTS = {
  works: ['publishedAt', 'lastObservedAt', 'likes', 'comments', 'shares', 'collects', 'plays', 'date'],
  daily: ['date', 'followers', 'likes', 'posts', 'followersDelta', 'likesDelta', 'postsDelta', 'estimatedPlays', 'estimatedPlaysDelta'],
  workMetrics: ['date', 'capturedAt', ...COUNTERS],
};
const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const counter = value => validCount(value) ? value : null;
const iso = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const dateKey = value => value ? businessDateKey(value, ZONE) : null;
function invalid(message) { throw Object.assign(new TypeError(message), { status: 400, code: 'ACCOUNT_HISTORY_INVALID' }); }
function integer(value, fallback, minimum, maximum, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) invalid(`${label}无效`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalid(`${label}超出范围`);
  return number;
}
function instant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
    || !isCalendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) invalid(`${label}必须为有效UTC时刻`);
  return new Date(value).toISOString();
}
function parameters(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) invalid('历史参数无效');
  const kind = options.kind ?? 'works';
  if (!Object.hasOwn(SORTS, kind)) invalid('历史类型无效');
  const asOf = options.asOf === undefined ? new Date().toISOString() : instant(options.asOf, '截止时间');
  if (Date.parse(asOf) > Date.now()) invalid('截止时间不能晚于现在');
  const sort = options.sort ?? (kind === 'works' ? 'publishedAt' : 'date');
  if (!SORTS[kind].includes(sort)) invalid('排序字段无效');
  const order = options.order ?? 'desc';
  if (!['asc', 'desc'].includes(order)) invalid('排序方向无效');
  for (const name of ['startDate', 'endDate']) {
    if (options[name] !== undefined && !isCalendarDate(options[name])) invalid('日期必须为有效YYYY-MM-DD');
    if (options[name] && options[name] > dateKey(asOf)) invalid('日期不能晚于截止日');
  }
  if (options.startDate && options.endDate && options.startDate > options.endDate) invalid('日期范围不能倒序');
  if (kind !== 'workMetrics' && options.workId !== undefined) invalid('只有作品指标历史允许workId');
  const workId = kind === 'workMetrics' ? integer(options.workId, null, 1, Number.MAX_SAFE_INTEGER, '作品编号') : null;
  if (kind === 'workMetrics' && workId === null) invalid('请提供作品编号');
  const suppliedCaps = CAPS.filter(name => options[name] !== undefined);
  if (suppliedCaps.length && suppliedCaps.length !== CAPS.length) invalid('历史版本必须同时提供三项记录上限');
  if (suppliedCaps.length && options.asOf === undefined) invalid('固定历史版本必须提供截止时间');
  return { kind, asOf, sort, order, workId, page: integer(options.page, 1, 1, 100_000, '页码'),
    pageSize: integer(options.pageSize, 20, 1, 100, '每页数量'),
    startDate: options.startDate ?? null, endDate: options.endDate ?? null,
    caps: suppliedCaps.length ? Object.fromEntries(CAPS.map(name => [name,
      integer(options[name], null, 0, Number.MAX_SAFE_INTEGER, '历史版本')])) : null };
}

function revision(db, targetId, requested) {
  const current = {
    snapshotMaxId: db.prepare('SELECT COALESCE(MAX(id),0) n FROM snapshots WHERE target_id=?').get(targetId).n,
    postMaxId: db.prepare('SELECT COALESCE(MAX(id),0) n FROM posts WHERE target_id=?').get(targetId).n,
    postMetricMaxId: db.prepare('SELECT COALESCE(MAX(m.id),0) n FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE p.target_id=?').get(targetId).n,
  };
  if (requested && CAPS.some(name => requested[name] > current[name])) invalid('历史版本超出已保存记录');
  return requested ?? current;
}
function identity(target) {
  const platform = safeJson(target.metadata_json, {})?.platform ?? 'douyin';
  const canonical = canonicalAccountLocator(target.locator, platform);
  return { platform, canonical };
}
function authorBound(row, id) {
  if (!id.canonical || canonicalAccountLocator(row.author_id, id.platform) !== id.canonical) return false;
  return id.platform === 'douyin' ? /^\d{15,25}$/.test(row.external_id)
    : id.platform === 'bilibili' ? /^BV[0-9A-Za-z]{10}$/.test(row.external_id)
      : id.platform === 'xiaohongshu' && /^[a-f\d]{16,40}$/i.test(row.external_id);
}
function safeText(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:Bearer\s+)[^\s,;]+/gi, '[REDACTED]')
    .replace(/\b(?:access_token|refresh_token|authorization|cookie|password|secret|client_secret|api_key)\s*[=:]\s*[^\s,;&]+/gi, '[REDACTED]')
    .slice(0, 2000) || null;
}
function workUrl(value, externalId, platform) {
  const projected = publicUrl(value);
  if (!projected) return null;
  const parsed = new URL(projected);
  const links = {
    douyin: { domain: 'douyin.com', paths: [`/video/${externalId}`, `/share/video/${externalId}`], path: `/video/${externalId}` },
    bilibili: { domain: 'bilibili.com', paths: [`/video/${externalId}`], path: `/video/${externalId}` },
    xiaohongshu: { domain: 'xiaohongshu.com', paths: [`/explore/${externalId}`, `/discovery/item/${externalId}`], path: `/explore/${externalId}` },
  };
  const link = links[platform];
  // A generic public host/query key does not bind an arbitrary path/value to
  // this work. Keep only known official paths containing its exact identity.
  if (!link || !(parsed.hostname === link.domain || parsed.hostname.endsWith(`.${link.domain}`))
    || !link.paths.includes(parsed.pathname.replace(/\/$/, ''))) return null;
  return `https://www.${link.domain}${link.path}`;
}
function workItems(db, target, cutoff, cap, id) {
  const rows = db.prepare(`SELECT p.id,p.target_id,p.external_id,p.author_id,p.caption,p.url,p.published_at,
    p.first_seen_at,p.last_seen_at,m.captured_at metric_at,m.likes,m.comments,m.shares,m.collects,m.plays
    FROM posts p LEFT JOIN post_metrics m ON m.id=(SELECT candidate.id FROM post_metrics candidate
      WHERE candidate.post_id=p.id AND candidate.id<=? AND julianday(candidate.captured_at)<=julianday(?)
      ORDER BY julianday(candidate.captured_at) DESC,candidate.id DESC LIMIT 1)
    WHERE p.target_id=? AND p.id<=? AND (julianday(p.first_seen_at)<=julianday(?)
      OR (julianday(p.first_seen_at)>julianday(?) AND m.id IS NOT NULL))
    ORDER BY p.id`).all(cap.postMetricMaxId, cutoff, target.id, cap.postMaxId, cutoff, cutoff);
  const bound = rows.filter(row => authorBound(row, id) && iso(row.first_seen_at));
  const restored = postsAsOf({ db }, bound, cutoff, [target], { forceRecovery: true, snapshotMaxId: cap.snapshotMaxId });
  return { excludedCount: rows.length - restored.length, items: restored.map(row => ({
    id: row.id, externalId: row.external_id, caption: safeText(row.caption), url: workUrl(row.url, row.external_id, id.platform),
    publishedAt: iso(row.published_at), firstSeenAt: iso(row.first_seen_at), lastObservedAt: iso(row.metric_at),
    ...Object.fromEntries(COUNTERS.map(name => [name, counter(row[name])])),
    playsEvidence: describeWorkPlays(counter(row.plays), id.platform),
  })) };
}
function validSnapshot(row, target, id) {
  return validateAccountSnapshot(row, target, id.platform).valid;
}
function dailyItems(db, target, cutoff, cap, id, publication) {
  const rows = db.prepare(`SELECT id,target_id,captured_at,followers,total_likes,total_posts,
    quality_status,source_checksum,raw_json FROM snapshots WHERE target_id=? AND id<=?
    AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at),id`).all(target.id, cap.snapshotMaxId, cutoff);
  const valid = rows.filter(row => (!publication || target.provider !== 'public-web'
    || committedSnapshotAllowed(publication, row)) && validSnapshot(row, target, id)), days = new Map();
  for (const row of valid) {
    const date = dateKey(row.captured_at), point = days.get(date) ?? { date, sampleCount: 0 };
    Object.assign(point, { id: row.id, capturedAt: iso(row.captured_at), sourceChecksum: row.source_checksum });
    point.sampleCount++;
    for (const [name, field] of [['followers', 'followers'], ['likes', 'total_likes'], ['posts', 'total_posts']]) {
      if (row[field] === null) continue;
      point[name] = row[field]; point[`${name}At`] = iso(row.captured_at); point[`${name}Checksum`] = row.source_checksum;
    }
    days.set(date, point);
  }
  const items = [...days.values()].map(point => {
    const baseline = days.get(shiftCalendarDate(point.date, -1));
    for (const name of ['followers', 'likes', 'posts']) {
      point[name] ??= null; point[`${name}At`] ??= null; point[`${name}Checksum`] ??= null;
      point[`${name}Delta`] = point[name] === null || baseline?.[name] == null ? null : point[name] - baseline[name];
      point[`${name}BaselineAt`] = point[`${name}Delta`] === null ? null : baseline[`${name}At`];
      point[`${name}BaselineChecksum`] = point[`${name}Delta`] === null ? null : baseline[`${name}Checksum`];
    }
    point.estimatedPlays = point.likes !== null && Number.isSafeInteger(point.likes * 100) ? point.likes * 100 : null;
    point.estimatedPlaysDelta = point.likesDelta !== null && Number.isSafeInteger(point.likesDelta * 100) ? point.likesDelta * 100 : null;
    point.estimatedPlaysProxy = true;
    return point;
  });
  return { items, excludedCount: rows.length - valid.length };
}
function metricItems(db, target, cutoff, cap, id, workId) {
  const work = db.prepare('SELECT id,target_id,external_id,author_id,caption,url,published_at,first_seen_at,last_seen_at FROM posts WHERE id=? AND target_id=? AND id<=?')
    .get(workId, target.id, cap.postMaxId);
  if (!work || !authorBound(work, id) || !iso(work.first_seen_at)) return null;
  const rows = db.prepare(`SELECT id,captured_at,likes,comments,shares,collects,plays FROM post_metrics
    WHERE post_id=? AND id<=? AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at),id`)
    .all(workId, cap.postMetricMaxId, cutoff);
  let valid = rows.filter(row => iso(row.captured_at) && COUNTERS.every(name => row[name] === null || validCount(row[name])));
  if (Date.parse(work.first_seen_at) > Date.parse(cutoff)) {
    // Keep insertion time intact. Every late-known metric point must bind to
    // its own eligible source, identity, observation time and numeric vector;
    // one valid latest point cannot authorize an unverified earlier curve.
    // Batch recovery retains the revision caps and does not introduce N+1 reads.
    valid = postsAsOf({ db }, valid.map(row => ({ ...work, ...row, metric_at: row.captured_at })),
      cutoff, [target], { forceRecovery: true, snapshotMaxId: cap.snapshotMaxId });
    if (!valid.length) return null;
  }
  return { excludedCount: rows.length - valid.length, items: valid.map(row => ({ id: row.id, workId,
    externalId: work.external_id, capturedAt: iso(row.captured_at), ...Object.fromEntries(COUNTERS.map(name => [name, counter(row[name])])),
    playsEvidence: describeWorkPlays(counter(row.plays), id.platform),
  })) };
}
function paginate(items, params) {
  const field = params.sort === 'date' ? params.kind === 'works' ? 'lastObservedAt'
    : params.kind === 'workMetrics' ? 'capturedAt' : 'date' : params.sort;
  const sorted = [...items].sort((left, right) => {
    const a = left[field], b = right[field];
    if (a == null || b == null) return a == null && b == null ? left.id - right.id : a == null ? 1 : -1;
    const order = typeof a === 'number' ? a - b : String(a).localeCompare(String(b));
    return (params.order === 'asc' ? order : -order) || left.id - right.id;
  });
  return sorted.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);
}

/** Read-only full saved history. Caller may wrap this in its worker transaction. */
export function getAccountHistory(database, targetId, options = {}) {
  const params = parameters(options), idNumber = integer(targetId, null, 1, Number.MAX_SAFE_INTEGER, '账号编号');
  const db = database?.db ?? database;
  if (options.committedPublication !== undefined) assertCommittedTargetPublication(options.committedPublication, db, params.asOf);
  const target = db.prepare("SELECT id,type,provider,locator,metadata_json FROM targets WHERE id=? AND type='account'").get(idNumber);
  if (!target) return null;
  const cap = revision(db, target.id, params.caps), accountIdentity = identity(target);
  const result = params.kind === 'works' ? workItems(db, target, params.asOf, cap, accountIdentity)
    : params.kind === 'daily' ? dailyItems(db, target, params.asOf, cap, accountIdentity, options.committedPublication)
      : metricItems(db, target, params.asOf, cap, accountIdentity, params.workId);
  if (!result) return null;
  const recordedDates = result.items.map(item => params.kind === 'works'
    ? dateKey(Date.parse(item.firstSeenAt) <= Date.parse(params.asOf) ? item.firstSeenAt : item.lastObservedAt)
    : params.kind === 'workMetrics' ? dateKey(item.capturedAt) : item.date).filter(Boolean).sort();
  const firstRecordedDate = recordedDates[0] ?? null, lastRecordedDate = recordedDates.at(-1) ?? null;
  const filtered = result.items.filter(item => {
    const date = params.kind === 'works' ? dateKey(item.publishedAt) : params.kind === 'workMetrics' ? dateKey(item.capturedAt) : item.date;
    return (!params.startDate && !params.endDate) || Boolean(date
      && (!params.startDate || date >= params.startDate) && (!params.endDate || date <= params.endDate));
  });
  return { version: 1, targetId: target.id, kind: params.kind, asOf: params.asOf, timeZone: ZONE, revision: cap,
    range: { startDate: params.startDate, endDate: params.endDate, firstRecordedDate, lastRecordedDate },
    pagination: { page: params.page, pageSize: params.pageSize, total: filtered.length, totalPages: Math.ceil(filtered.length / params.pageSize) },
    items: paginate(filtered, params), coverage: { scope: 'all-saved-account-history', platformComplete: false,
      missingDatesFilled: false, metadataUnknownCount: params.kind === 'works' ? filtered.filter(item => item.publishedAt === null).length : 0,
      excludedCount: result.excludedCount,
      metricsEvidence: params.kind === 'daily' ? 'checksum-and-normalized-vector-bound' : 'saved-record-not-independently-verified',
      independentlyVerified: false,
      note: params.kind === 'daily'
        ? '已保存且校验原来源哈希、账号身份和指标向量的日观察；仅比较相邻实测日，不补零、不补造缺日。估算播放为点赞×100，不是实测播放。'
        : '全部已保存且符合账号身份和截止边界的作品指标记录，不代表平台完整作品或独立核验指标；作品历史标题和发布时间另需精确时刻、身份及指标向量绑定来源，缺证据留空。作品播放为来源字段，未经独立核验。' } };
}
