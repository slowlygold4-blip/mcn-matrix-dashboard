/** Query imported authors/works alongside strictly matched platform snapshots.
 * All operations are read-only; publication cohorts are not observations. */
import { canonicalAccountLocator } from './author-spreadsheet.mjs';
import { readCurrentCreatorSourceLinks } from './creator-source-current-links.mjs';
import { describeWorkPlays } from './work-play-semantics.mjs';
import { readWorkSourceOverlay, workSourceFingerprint } from './work-source-overlay.mjs';

const text = value => String(value ?? '').trim();
const norm = value => text(value).normalize('NFKC').toLowerCase();
const parse = value => JSON.parse(value || '{}');
const knownCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => {
  const candidate = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return '';
  const timestamp = Date.parse(`${candidate}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === candidate ? candidate : '';
};
const positive = (value, fallback, max) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
const trackKeys = { '切片激励': 'slice', '创作激励': 'original', '即梦二创': 'ai-remix', '#小团团杯S1二创大赛': 'contest' };
const labels = { slice: '切片激励', original: '创作激励', 'ai-remix': '即梦二创', contest: '#小团团杯S1二创大赛' };
/** Registration labels are explicit source fields, not guesses from a nickname. */
export function registeredContentTypes(sourceKey, contentType) {
  const source = text(sourceKey), value = text(contentType);
  if (source === 'ai_registry') return ['ai-remix'];
  if (source !== 'slice_registry') return [];
  const result = [];
  if (value.includes('切片')) result.push('slice');
  if (/创作|手书|绘画|meme/i.test(value)) result.push('original');
  if (/\bAI\b|即梦/i.test(value)) result.push('ai-remix');
  return result;
}
const split = value => text(value).split(/\s*\/\s*/).filter(Boolean);
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const cached = new WeakMap();
const sourceMetadata = (imported, data) => {
  const audit = parse(imported.metadata_json).audit || {};
  const days = data?.works.map(work => work.publishedOn).filter(Boolean).sort() || [];
  return { importId: imported.id, url: imported.source_url, revision: imported.source_revision,
    refreshedAt: audit.sourceRefreshedAt ?? null, modifiedAt: imported.source_modified_at, importedAt: imported.imported_at,
    period: { start: date(audit.sourceStart) || days[0] || null, end: date(audit.sourceEnd) || days.at(-1) || null } };
};
const withoutSearch = ({ _search, ...item }) => structuredClone(item);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const beijingDate = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const beijingDay = value => {
  if (!value) return '';
  const parts = Object.fromEntries(beijingDate.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const officialVideoUrl = id => /^\d{16,22}$/.test(id) ? `https://www.douyin.com/video/${id}` : '';

/** Only current one-to-one source author links and canonical post author IDs can
 * contribute platform works. This projection is deliberately not cached by the
 * sheet SHA: a new genuine sampling run must appear without a sheet reimport. */
function strictPlatformPosts(db, source, cutoff) {
  const matched = new Map(), conflicts = new Set();
  if (!tableExists(db, 'posts') || !tableExists(db, 'targets') || !source.currentLinks.accountLinks.length)
    return matched;
  const authorsByRow = new Map(source.authors.map(author => [author.sourceRow, author]));
  const bindings = new Map();
  for (const link of source.currentLinks.accountLinks) {
    const author = authorsByRow.get(link.author_row);
    if (!author || author.targetId !== link.target_id) continue;
    bindings.set(link.target_id, { author, canonicalReceipt: link.origin === 'source-success-receipt',
      matchedId: norm(link.matched_id) });
  }
  const targetIds = [...bindings.keys()];
  for (let offset = 0; offset < targetIds.length; offset += 200) {
    const ids = targetIds.slice(offset, offset + 200);
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT p.id,p.target_id,p.external_id,p.author_id,p.first_seen_at,p.last_seen_at,
      p.published_at,p.caption,p.url,
      t.provider,t.locator,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.platform') END platform,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.identityVerification.accountId') END current_anchor,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.douyinId') END current_handle,
      CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.resolution.publicDouyinId') END resolved_handle,
      CASE WHEN json_valid(p.raw_json) THEN json_extract(p.raw_json,'$.aweme_id') END raw_id,
      CASE WHEN json_valid(p.raw_json) THEN json_extract(p.raw_json,'$.author.sec_uid') END raw_author
      FROM posts p JOIN targets t ON t.id=p.target_id AND t.type='account'
      WHERE p.target_id IN (${placeholders}) AND julianday(p.first_seen_at)<=julianday(?)`;
    for (const row of db.prepare(sql).iterate(...ids, cutoff)) {
      const binding = bindings.get(row.target_id), expected = canonicalAccountLocator(row.locator, 'douyin');
      const firstSeenAt = instant(row.first_seen_at), publishedAt = instant(row.published_at);
      const handles = new Set([row.current_handle, row.resolved_handle].map(norm).filter(Boolean));
      const sourceIdentityMatches = binding && (binding.canonicalReceipt
        || handles.has(norm(binding.author.accountId)) || handles.has(binding.matchedId));
      const id = text(row.external_id);
      if (!binding || !expected || row.provider !== 'public-web' || (row.platform || 'douyin') !== 'douyin'
        || (row.current_anchor != null && row.current_anchor !== row.locator)
        || (row.current_anchor == null && !binding.canonicalReceipt) || !sourceIdentityMatches
        || canonicalAccountLocator(row.author_id, 'douyin') !== expected
        || canonicalAccountLocator(row.raw_author, 'douyin') !== expected
        || text(row.raw_id) !== id || !firstSeenAt || Date.parse(firstSeenAt) > Date.parse(cutoff)
        || publishedAt && Date.parse(publishedAt) > Date.parse(cutoff)) continue;
      if (matched.has(id)) { conflicts.add(id); continue; }
      matched.set(id, { ...row, author: binding.author, firstSeenAt, publishedAt });
    }
  }
  for (const id of conflicts) matched.delete(id);
  return matched;
}

function platformOnlyWorks(source, posts) {
  const sourceIds = new Set(source.works.map(work => work.contentId).filter(Boolean));
  const works = [];
  for (const [id, post] of posts) {
    // A platform ID already in the source is represented by that source row,
    // even when the source author's identity is presently unresolved.
    if (sourceIds.has(id) || !officialVideoUrl(id)) continue;
    const author = post.author;
    works.push({ key: id, contentId: id, sourceRow: null, authorKey: author.key,
      authorName: author.name, accountId: author.accountId, targetId: post.target_id,
      publishedOn: beijingDay(post.publishedAt), publishedAt: post.publishedAt,
      firstSeenAt: post.firstSeenAt, dateSource: post.publishedAt ? 'platform-published-at' : 'unknown',
      contentType: 'video', primaryTrack: '未分类', tracks: [], classifications: [],
      cumulativePlays: null, cumulativeLikes: null, title: text(post.caption),
      url: officialVideoUrl(id), sourceRecordCount: null, sourceReferences: [], sourceUrl: null,
      recordOrigin: 'platform-only', _search: norm([id, author.name, author.accountId, post.caption].join(' ')) });
  }
  return works;
}

/** Shared full corpus for publication counting; no pagination or metric guesses. */
export function readUnifiedPublicationWorks(db, asOf) {
  if (!tableExists(db, 'creator_source_imports')) return [];
  const imported = db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf);
  if (!imported) return [];
  const source = corpus(db, imported, {reference:asOf});
  const posts = strictPlatformPosts(db, source, asOf);
  return [...source.works, ...platformOnlyWorks(source, posts)];
}

function platformMatches(db, source, works, posts, cutoff) {
  const empty = { rows: new Map(), reconciliation: { knownWorkOverlap: 0, newSourceWorks: works.length,
    identityMatchedWorkOverlap: 0, unconfirmedWorkOverlap: 0,
    linkedAuthors: source.authors.filter(author => author.targetId != null).length } };
  if (!tableExists(db, 'posts') || !tableExists(db, 'targets')) return empty;
  const wanted = new Map(works.filter(work => work.contentId).map(work => [work.contentId, work]));
  // A single bounded full scan is cheaper than one unindexed scan for every
  // source row: the production posts index begins with target_id, not external_id.
  const known = new Set();
  for (const row of db.prepare('SELECT external_id FROM posts WHERE julianday(first_seen_at)<=julianday(?)').iterate(cutoff)) {
    const id = text(row.external_id);
    if (wanted.has(id)) known.add(id);
  }
  const matched = new Map();
  for (const [id, work] of wanted) {
    const post = posts.get(id);
    if (post && work.authorKey === post.author.key && work.targetId === post.target_id) matched.set(id, post);
  }
  return { rows: matched, reconciliation: { knownWorkOverlap: known.size, newSourceWorks: works.length - known.size,
    identityMatchedWorkOverlap: matched.size, unconfirmedWorkOverlap: known.size - matched.size,
    linkedAuthors: source.authors.filter(author => author.targetId != null).length } };
}

/** Indexed, bounded post_id batches, including all observations needed to pick
 * the last two valid points independently for likes and plays. No per-work SQL. */
function latestMetricPoints(db, posts, cutoff) {
  const result = new Map();
  if (!posts.length || !tableExists(db, 'post_metrics')) return result;
  const byId = new Map(posts.map(post => [post.id, post]));
  const ids = [...byId.keys()];
  const keep = (list, value, at, id) => {
    const candidate = { id, value, capturedAt: at };
    const previous = list.findIndex(row => row.capturedAt === at);
    if (previous >= 0) {
      if (list[previous].id >= id) return;
      list.splice(previous, 1);
    }
    list.push(candidate);
    list.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || b.id - a.id);
    if (list.length > 2) list.length = 2;
  };
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200), placeholders = chunk.map(() => '?').join(',');
    const sql = `SELECT post_id,id,captured_at,likes,plays FROM post_metrics
      WHERE post_id IN (${placeholders}) AND julianday(captured_at)<=julianday(?)`;
    for (const row of db.prepare(sql).iterate(...chunk, cutoff)) {
      const post = byId.get(row.post_id), at = instant(row.captured_at);
      if (!post || !at || Date.parse(at) < Date.parse(post.firstSeenAt) || Date.parse(at) > Date.parse(cutoff)) continue;
      if (!result.has(row.post_id)) result.set(row.post_id, { likes: [], plays: [] });
      const bucket = result.get(row.post_id);
      if (knownCount(row.likes) != null) keep(bucket.likes, row.likes, at, row.id);
      if (knownCount(row.plays) != null && row.plays > 0) keep(bucket.plays, row.plays, at, row.id);
    }
  }
  return result;
}

function enrichLatest(work, post, source, metricPoints) {
  const hasSourceRow = work.sourceRow != null;
  const fallback = {
    ...work, recordOrigin: post ? hasSourceRow ? 'source-and-platform' : 'platform-only' : 'source-only',
    sourceCumulativePlays: work.cumulativePlays, sourceCumulativeLikes: work.cumulativeLikes,
    sourceRefreshedAt: hasSourceRow ? source.refreshedAt : null, sourceMetricObservedAt: null,
    postId: post?.id ?? null, platformLatest: null,
    latestLikes: work.cumulativeLikes, latestPlays: work.cumulativePlays, latestObservedAt: null,
    metricOrigin: { likes: work.cumulativeLikes == null ? 'unavailable' : 'source', plays: work.cumulativePlays == null ? 'unavailable' : 'source' },
    comparison: { likes: null, plays: null }, sourceComparison: { likes: null, plays: null, notDailyGrowth: true },
    metricProvenance: { source: hasSourceRow ? { kind: 'feishu-source-cumulative', refreshedAt: source.refreshedAt,
      observedAt: null, row: work.sourceRow, url: work.sourceUrl, note: '刷新时间仅代表来源版本；未证明各指标采样时间。' } : null,
      platform: null },
  };
  if (!post) return fallback;
  const likes = metricPoints?.likes || [], plays = metricPoints?.plays || [];
  const newest = [likes[0]?.capturedAt, plays[0]?.capturedAt].filter(Boolean).sort().at(-1) || null;
  const comparison = list => list.length >= 2 ? { current: list[0].value, previous: list[1].value,
    delta: list[0].value - list[1].value, from: list[1].capturedAt, to: list[0].capturedAt,
    basis: 'stored-platform-observations', dailyGrowth: false } : null;
  const sourceComparison = (list, value) => list.length && value != null ? { sourceValue: value, platformValue: list[0].value,
    difference: list[0].value - value, sourceRefreshedAt: source.refreshedAt, platformObservedAt: list[0].capturedAt,
    basis: 'source-versus-platform', chronologicalOrderVerified: false, notDailyGrowth: true } : null;
  return { ...fallback, platformLatest: newest ? { capturedAt: newest, likes: likes[0]?.value ?? null,
      plays: plays[0]?.value ?? null, likesObservedAt: likes[0]?.capturedAt ?? null, playsObservedAt: plays[0]?.capturedAt ?? null,
      playsEvidence: describeWorkPlays(plays[0]?.value ?? null, 'douyin') } : null,
    latestLikes: likes[0]?.value ?? work.cumulativeLikes, latestPlays: plays[0]?.value ?? work.cumulativePlays,
    latestObservedAt: newest,
    metricOrigin: { likes: likes.length ? 'platform' : fallback.metricOrigin.likes, plays: plays.length ? 'platform' : fallback.metricOrigin.plays },
    comparison: { likes: comparison(likes), plays: comparison(plays) },
    sourceComparison: { likes: sourceComparison(likes, work.cumulativeLikes), plays: sourceComparison(plays, work.cumulativePlays), notDailyGrowth: true },
    metricProvenance: { ...fallback.metricProvenance, platform: newest ? { kind: 'stored-platform-observations',
      postId: post.id, identity: 'strict-source-link-canonical-post-author', observedAt: newest,
      latestLikeMetricId: likes[0]?.id ?? null, latestPlayMetricId: plays[0]?.id ?? null,
      note: '仅有真实时间的已存平台记录可对比；公开播放0可能是占位值，保留来源值。' } : null } };
}

function corpus(db, imported, { reference = new Date() } = {}) {
  const cutoff = new Date(reference).toISOString();
  const editionFingerprint = workSourceFingerprint(db, cutoff);
  const currentLinks = readCurrentCreatorSourceLinks(db, { imported, reference });
  const previous = cached.get(db);
  if (previous?.id === imported.id && previous.sha === imported.source_sha256
    && previous.editionFingerprint === editionFingerprint
    && previous.currentLinks.fingerprint === currentLinks.fingerprint) return previous;
  const rows = sheet => db.prepare('SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id=? ORDER BY row_number').all(imported.id, sheet);
  const accountLinks = new Map();
  for (const row of currentLinks.accountLinks) {
    if (!accountLinks.has(row.author_row)) accountLinks.set(row.author_row, []);
    accountLinks.get(row.author_row).push(row.target_id);
  }
  const workLinks = new Map(currentLinks.workLinks.map(row => [row.work_row, row.target_id]));
  const sourceLinks = new Map(rows('02').map(row => { const v = parse(row.values_json); return [text(v[0]), { title: text(v[1]), url: text(v[5]) }]; }));
  const registrations = new Map();
  for (const row of rows('11')) {
    const v = parse(row.values_json), accountId = norm(v[3]);
    const classifications = registeredContentTypes(v[1], v[6]);
    if (!accountId || !classifications.length) continue;
    if (!registrations.has(accountId)) registrations.set(accountId, []);
    registrations.get(accountId).push({ sourceRow: row.row_number, sourceKey: text(v[1]),
      recordId: text(v[0]), classifications });
  }
  const authors = rows('08').map(row => {
    const v = parse(row.values_json), targetIds = [...new Set(accountLinks.get(row.row_number) || [])];
    const tracks = [[7, 'slice'], [8, 'original'], [9, 'ai-remix'], [10, 'contest']].filter(([i]) => Number(v[i]) > 0).map(([, key]) => key);
    return { key: `source-author:${imported.id}:${row.row_number}`, sourceRow: row.row_number,
      name: text(v[0]), accountId: text(v[1]), aliases: split(v[2]), theme: 'tuantuan',
      classifications: tracks, workClassifications: tracks, registeredClassifications: [], registrationEvidence: [],
      targetId: targetIds.length === 1 ? targetIds[0] : null, targetIds,
      monitoringLink: targetIds.length === 1 ? 'linked' : targetIds.length > 1 ? 'ambiguous' : 'unlinked',
      // Screenshot/OCR counts without a measurement date are not current fans.
      sourceFollowers: knownCount(v[14]), sourceFollowersNote: text(v[15]),
      sourceUrl: imported.source_url, _search: norm([v[0], v[1], v[2]].join(' ')) };
  });
  const authorIds = new Map();
  for (const author of authors) {
    const id = norm(author.accountId);
    if (!id) continue;
    if (!authorIds.has(id)) authorIds.set(id, []);
    authorIds.get(id).push(author);
  }
  for (const [id, candidates] of authorIds) {
    // A duplicate public account ID is not enough evidence to assign a
    // registration to one of several source author rows.
    if (candidates.length !== 1) continue;
    const author = candidates[0], evidence = registrations.get(id) || [];
    author.registrationEvidence = evidence;
    author.registeredClassifications = [...new Set(evidence.flatMap(row => row.classifications))];
    author.classifications = [...new Set([...author.workClassifications, ...author.registeredClassifications])];
  }
  const worksById = new Map();
  let duplicateWorkRows = 0;
  for (const row of rows('09')) {
    const v = parse(row.values_json), contentId = text(v[0]);
    // No nickname matching. A nonunique handle leaves this work unassigned.
    const candidates = authorIds.get(norm(v[2])) || [], author = candidates.length === 1 ? candidates[0] : null;
    const allTracks = [...new Set([...split(v[6]), text(v[5])].filter(Boolean))];
    const references = text(v[13]).split(/\s*[;；]\s*|\s*\|\s*/).filter(Boolean).map(reference => {
      const match = reference.match(/^([^:]+):([^:]+)$/), source = match ? sourceLinks.get(match[1]) : null;
      return { reference, key: match?.[1] ?? null, row: /^\d+$/.test(match?.[2] || '') ? Number(match[2]) : null,
        recordId: match?.[2]?.startsWith('rec') ? match[2] : null, url: source?.url || null };
    });
    const key = contentId || `source-row:${row.row_number}`;
    if (worksById.has(key)) { duplicateWorkRows++; continue; }
    worksById.set(key, { key, contentId: contentId || null, sourceRow: row.row_number,
      authorKey: author?.key ?? null, authorName: text(v[1]), accountId: text(v[2]),
      targetId: workLinks.get(row.row_number) ?? null, publishedOn: date(v[3]), dateSource: 'source_inferred_publication_date',
      contentType: text(v[4]), primaryTrack: text(v[5]), tracks: allTracks,
      classifications: allTracks.map(track => trackKeys[track]).filter(Boolean),
      cumulativePlays: knownCount(v[7]), cumulativeLikes: knownCount(v[8]),
      title: text(v[10]), url: text(v[11]), sourceRecordCount: knownCount(v[12]), sourceReferences: references,
      sourceUrl: imported.source_url, recordOrigin: 'source-only', _search: norm([v[0], v[1], v[2], v[10]].join(' ')) });
  }
  const merged = readWorkSourceOverlay(db, { imported, authors, works: [...worksById.values()], asOf: cutoff });
  const result = { id: imported.id, sha: imported.source_sha256, currentLinks, editionFingerprint,
    authors, works: merged.works, sourceEditions: merged.summary, duplicateWorkRows };
  cached.set(db, result);
  return result;
}

function aggregate(works) {
  let cumulativePlays = 0, cumulativeLikes = 0, playsKnown = 0, likesKnown = 0, linkedWorks = 0;
  let sourceWorks = 0, platformOnlyWorks = 0;
  for (const work of works) {
    if (work.sourceRow == null) platformOnlyWorks++; else sourceWorks++;
    if (work.cumulativePlays != null) { cumulativePlays += work.cumulativePlays; playsKnown++; }
    if (work.cumulativeLikes != null) { cumulativeLikes += work.cumulativeLikes; likesKnown++; }
    if (work.targetId != null) linkedWorks++;
  }
  return { works: works.length, cumulativePlays: playsKnown ? cumulativePlays : null,
    cumulativeLikes: likesKnown ? cumulativeLikes : null, playsKnown, likesKnown, linkedWorks,
    sourceWorks, platformOnlyWorks };
}

function sortRows(rows, sort, direction, view, adopted = new Map()) {
  const fields = view === 'works'
    ? { plays: 'cumulativePlays', likes: 'cumulativeLikes', date: 'publishedOn', name: 'authorName', title: 'title' }
    : { plays: 'cumulativePlays', likes: 'cumulativeLikes', works: 'works', name: 'name' };
  const field = fields[sort] || fields.plays, sign = direction === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const value = row => view === 'works' && (sort === 'plays' || sort === 'likes')
      ? adopted.get(row.key)?.[sort] ?? row[field] : row[field];
    const av = value(a), bv = value(b);
    const stable = () => (a.sourceRow ?? Number.MAX_SAFE_INTEGER) - (b.sourceRow ?? Number.MAX_SAFE_INTEGER)
      || String(a.contentId ?? a.key ?? '').localeCompare(String(b.contentId ?? b.key ?? ''));
    if (av == null || av === '') return bv == null || bv === '' ? stable() : 1;
    if (bv == null || bv === '') return -1;
    const comparison = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN');
    return comparison * sign || stable();
  });
}

/** Source cohort statistics and paginated accounts/works for the main dashboard.
 * `start`/`end` filter source publication dates, never observation times. */
export function readCreatorOperatingView(db, query = {}) {
  if (!tableExists(db, 'creator_source_imports')) return { available: false, reason: 'source_not_imported' };
  const requestedAsOf = text(query.asOf), now = new Date().toISOString();
  const asOf = requestedAsOf ? instant(requestedAsOf) : now;
  if (!asOf || Date.parse(asOf) > Date.parse(now)) return { available: true, error: '截止时间无效', statusCode: 400 };
  const imported = db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf);
  if (!imported) return { available: false, reason: 'source_not_imported' };
  const source = corpus(db, imported, { reference: asOf });
  const platformPosts = strictPlatformPosts(db, source, asOf);
  const allWorks = [...source.works, ...platformOnlyWorks(source, platformPosts)];
  const q = norm(query.q ?? query.query).slice(0, 120), theme = text(query.theme) || 'all';
  const board = text(query.board).normalize('NFKC').replace(/\s+/g, ' ');
  const track = text(query.track), classification = text(query.classification) || 'all';
  const primaryTrackKey = text(query.primaryTrack);
  const primaryTrack = labels[primaryTrackKey] || '';
  const start = date(query.start), end = date(query.end);
  if (text(query.start) && !start || text(query.end) && !end || start && end && start > end)
    return { available: true, error: '日期范围无效', statusCode: 400 };
  const view = query.view === 'works' ? 'works' : 'authors', direction = query.direction === 'asc' ? 'asc' : 'desc';
  const sort = text(query.sort) || 'plays', pageSize = positive(query.pageSize, 30, 100);
  const authorKey = text(query.authorKey), targetId = query.targetId == null || query.targetId === '' ? null : positive(query.targetId, null, Number.MAX_SAFE_INTEGER);
  const normalized = { board, theme, classification, track, primaryTrack: primaryTrackKey, start, end, q, view, sort, direction, authorKey, targetId,
    asOf: requestedAsOf ? asOf : null };
  const inTheme = ['', 'all', 'tuantuan', '团团'].includes(theme)
    && ['', 'all', 'tuantuan', '团团', '一条小团团切片矩阵'].includes(board);
  const matchTrack = item => (!primaryTrack || item.primaryTrack === primaryTrack)
    && (!track || item.tracks?.includes(track) || item.classifications.includes(trackKeys[track] || track))
    && (classification === 'all' || item.classifications.includes(classification));
  const authorQuery = new Set(source.authors.filter(author => !q || author._search.includes(q)).map(author => author.key));
  const works = inTheme ? allWorks.filter(work => matchTrack(work)
    && (!authorKey || work.authorKey === authorKey) && (targetId == null || work.targetId === targetId)
    && (!start || work.publishedOn && work.publishedOn >= start) && (!end || work.publishedOn && work.publishedOn <= end)
    && (!q || authorQuery.has(work.authorKey) || work._search.includes(q))) : [];
  const grouped = new Map();
  for (const work of works) {
    if (!work.authorKey) continue;
    if (!grouped.has(work.authorKey)) grouped.set(work.authorKey, []);
    grouped.get(work.authorKey).push(work);
  }
  const authors = inTheme ? source.authors.filter(author => (!authorKey || author.key === authorKey) && (targetId == null || author.targetId === targetId)
    && (grouped.has(author.key) || !start && !end && matchTrack(author) && (!q || author._search.includes(q))))
    .map(author => ({ ...author, ...aggregate(grouped.get(author.key) || []) })) : [];
  const summary = { ...aggregate(works), authors: authors.length, linkedAuthors: authors.filter(author => author.targetId != null).length,
    unassignedWorks: works.filter(work => !work.authorKey).length, duplicateWorkRowsExcluded: source.duplicateWorkRows };
  const globalSummary = { ...aggregate(allWorks), authors: source.authors.length,
    linkedAuthors: source.authors.filter(author => author.targetId != null).length };
  const classificationCoverage = { authors: source.authors.length,
    withWorkCategory: source.authors.filter(author => author.workClassifications.length > 0).length,
    registrationOnly: source.authors.filter(author => !author.workClassifications.length && author.registeredClassifications.length > 0).length,
    withoutExplicitCategory: source.authors.filter(author => !author.classifications.length).length };
  const byDate = new Map(), byTrack = new Map();
  for (const work of works) {
    const day = work.publishedOn || 'unknown';
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(work);
    if (!byTrack.has(work.primaryTrack)) byTrack.set(work.primaryTrack, []);
    byTrack.get(work.primaryTrack).push(work);
  }
  const daily = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, ...aggregate(values) }));
  const tracks = [...byTrack].map(([name, values]) => ({ name, key: trackKeys[name] || name,
    authors: new Set(values.map(work => work.authorKey).filter(Boolean)).size, ...aggregate(values) }));
  const matched = platformMatches(db, source, works.filter(work => work.sourceRow != null), platformPosts, asOf);
  const postFor = work => work.sourceRow == null ? platformPosts.get(work.contentId) : matched.rows.get(work.contentId);
  const sortPoints = view === 'works' && ['plays', 'likes'].includes(sort)
    ? latestMetricPoints(db, works.map(postFor).filter(Boolean), asOf) : null;
  const adopted = new Map();
  if (sortPoints) for (const work of works) {
    const post = postFor(work), points = post && sortPoints.get(post.id);
    adopted.set(work.key, { likes: points?.likes[0]?.value ?? work.cumulativeLikes,
      plays: points?.plays[0]?.value ?? work.cumulativePlays });
  }
  const selected = sortRows(view === 'works' ? [...works] : authors, sort, direction, view, adopted);
  const pages = Math.ceil(selected.length / pageSize), page = Math.min(positive(query.page, 1, 100000), Math.max(pages, 1));
  const pageItems = selected.slice((page - 1) * pageSize, page * pageSize).map(withoutSearch);
  const metadata = sourceMetadata(imported, source);
  const pagePoints = view === 'works' ? sortPoints || latestMetricPoints(db, pageItems.map(postFor).filter(Boolean), asOf) : null;
  const items = view === 'works' ? pageItems.map(work => {
    const post = postFor(work);
    return enrichLatest(work, post, metadata, post && pagePoints.get(post.id));
  }) : pageItems;
  return { available: true, source: metadata,
    query: normalized, summary, globalSummary, classificationCoverage, daily, tracks,
    classificationOptions: Object.entries(labels).map(([key, label]) => ({ key, label })),
    reconciliation: { ...matched.reconciliation, sourceEditions: source.sourceEditions, newPlatformWorks: summary.platformOnlyWorks,
      linkedAuthors: summary.linkedAuthors },
    view, items, page, pageSize, pages, total: selected.length,
    semantics: { metrics: '来源累计播放、累计点赞仅汇总原表有值的作品；平台独有作品的真实指标单独按观测时间展示，空值不补零。',
      date: '按原表推算或平台记录的作品发布日期（北京时间）筛选和分组，不代表该日播放或点赞增长。',
      track: '分类筛选包含跨赛道收录；汇总每条作品只计算一次，赛道分组使用来源主归属。',
      latest: '每条作品优先呈现严格匹配的平台最近有效字段，缺测保留来源值；来源刷新时间不代表指标观测日。',
      comparison: '平台变化仅比较同作品两次已存平台观测；来源对平台差额仅供核对，不能作每日增长。',
      identity: '来源作者与监控账号仅通过已有严格关联对应；未改写监控身份与经营归属。',
      sorting: '作品播放与点赞排序按列表采用值：有有效平台观测时采用平台值，否则保留原表累计值；缺测排最后。作者汇总仍只采用原表累计值。' } };
}

/** Strict account-detail enrichment without applying a page-size cap. */
export function readCreatorSourceWorksForTarget(db, targetId, { asOf } = {}) {
  const id = positive(targetId, null, Number.MAX_SAFE_INTEGER);
  if (id == null || !tableExists(db, 'creator_source_imports')) return { available: false, source: null, items: [], linkedAccountIds: [] };
  const timestamp = asOf == null ? null : Date.parse(asOf);
  if (timestamp != null && !Number.isFinite(timestamp)) return { available: false, source: null, items: [], linkedAccountIds: [] };
  const imported = timestamp == null
    ? db.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get()
    : db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(new Date(timestamp).toISOString());
  if (!imported) return { available: false, source: null, items: [], linkedAccountIds: [] };
  const data = corpus(db, imported, { reference: asOf ?? new Date() }), metadata = sourceMetadata(imported, data);
  if (timestamp != null && metadata.refreshedAt && Date.parse(metadata.refreshedAt) > timestamp)
    return { available: false, source: metadata, items: [], linkedAccountIds: [], reason: 'source_snapshot_after_cutoff' };
  return { available: true, source: metadata,
    linkedAccountIds: [...new Set(data.authors.filter(author => author.targetId === id).map(author => author.accountId).filter(Boolean))],
    items: data.works.filter(work => work.targetId === id).map(withoutSearch) };
}
