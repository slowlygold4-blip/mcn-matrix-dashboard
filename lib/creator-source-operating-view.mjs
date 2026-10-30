/** Query imported authors/works alongside strictly matched platform snapshots.
 * All operations are read-only; publication cohorts are not observations. */
import { canonicalAccountLocator, validateSubmittedAccountId } from './author-spreadsheet.mjs';
import {corpus,registeredContentTypes,readUnifiedCreatorSourceCorpus} from './creator-source-corpus.mjs';
export {registeredContentTypes,readUnifiedCreatorSourceCorpus} from './creator-source-corpus.mjs';
import { describeWorkPlays } from './work-play-semantics.mjs';
import { explicitWorkTopicEvidence } from './work-topic-classification.mjs';
import {withCreatorSourceLinkSnapshot,readCreatorSourceWorkProjectionSnapshot} from './creator-source-current-links.mjs';
import {readPublicTableFoundation} from './public-table-foundation.mjs';
import {indexWorkObservations,observationsForWork,adoptWorkMetric,summarizeAdoptedWorks} from './work-metric-adoption.mjs';

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
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
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

/** Extend the existing corpus, not another dashboard or another copy of a work.
 * Publication dates stay unknown when the source supplied only a metric date. */
function supplementedCorpus(base,foundation){
  if(!foundation)return base;
  const authors=[...base.authors],byOwner=new Map(),works=[...base.works],ids=new Set(works.map(w=>w.contentId));
  const register=author=>{const key=norm(author.accountId);if(!key)return;const rows=byOwner.get(key)||[];rows.push(author);byOwner.set(key,rows);};
  authors.forEach(register);
  for(const author of foundation.authors){
    const key=norm(author.douyinId);if(!key||byOwner.has(key))continue;
    const targetIds=author.targetIds||[],row={key:`source-supplement-author:${key}`,sourceRow:null,sourceSupplement:true,
      name:author.name,accountId:author.douyinId,aliases:[],theme:'tuantuan',targetIds,targetId:targetIds.length===1?targetIds[0]:null,
      classifications:[],workClassifications:[],registeredClassifications:[],registrationEvidence:[],
      monitoringLink:targetIds.length===1?'linked':targetIds.length?'ambiguous':'unlinked',sourceFollowers:null,sourceFollowersNote:'',
      sourceUrl:null,_search:norm([author.name,author.douyinId].join(' '))};
    authors.push(row);register(row);
  }
  for(const work of foundation.works){
    if(ids.has(work.contentId))continue;ids.add(work.contentId);
    const candidates=byOwner.get(norm(work.douyinId))||[],author=candidates.length===1?candidates[0]:null;
    const slice=work.sourceTitles?.includes('10_切片激励来源观测'),classifications=slice?['slice']:[];
    works.push({key:work.contentId,contentId:work.contentId,sourceRow:null,sourceSupplement:true,
      authorKey:author?.key??null,authorName:work.author||author?.name||'',accountId:work.douyinId,targetId:author?.targetId??null,
      publishedOn:date(work.publishDate),dateSource:date(work.publishDate)?'source-publication-day':'unknown',contentType:work.type||'video',
      primaryTrack:slice?labels.slice:'未分类',tracks:slice?[labels.slice]:[],classifications,
      cumulativeLikes:knownCount(work.likes),cumulativePlays:knownCount(work.plays),title:work.title||'',url:officialVideoUrl(work.contentId),
      sourceRecordCount:work.evidenceRows,sourceReferences:[],sourceUrl:null,recordOrigin:'source-only',
      _search:norm([work.contentId,work.author,work.douyinId,work.title].join(' '))});
  }
  return {...base,authors,works};
}
function sourceWithFoundation(db,imported,asOf,provided){
  const base=corpus(db,imported,{reference:asOf});
  const foundation=provided===undefined?readPublicTableFoundation(db,asOf,{sourceCorpus:base,rosterAccounts:[]}):provided;
  return {source:supplementedCorpus(base,foundation),foundation};
}

/** A native publisher need not already be linked to a workbook author. Only
 * source-overlapping IDs may introduce such an account into this projection;
 * exact native authorship still applies. Never cache this by the sheet SHA. */
function strictPlatformPosts(db, source, cutoff) {
  const matched = new Map(), conflicts = new Set();
  if (!tableExists(db, 'posts') || !tableExists(db, 'targets'))
    return matched;
  const authorsByRow = new Map(source.authors.map(author => [author.sourceRow, author]));
  const bindings = new Map();
  for (const link of source.currentLinks.accountLinks) {
    const author = authorsByRow.get(link.author_row);
    if (!author || author.targetId !== link.target_id) continue;
    bindings.set(link.target_id, { author, canonicalReceipt: ['source-success-receipt','stored-profile-identity-receipt'].includes(link.origin),
      matchedId: norm(link.matched_id) });
  }
  const supplementTargets=new Map();
  for(const author of source.authors.filter(a=>a.sourceSupplement&&a.targetId!=null)){
    const list=supplementTargets.get(author.targetId)||[];list.push(author);supplementTargets.set(author.targetId,list);
  }
  for(const [targetId,authors] of supplementTargets)if(authors.length===1&&!bindings.has(targetId))
    bindings.set(targetId,{author:authors[0],canonicalReceipt:false,matchedId:norm(authors[0].accountId)});
  const sourceIds = new Set(source.works.map(work => work.contentId).filter(id => officialVideoUrl(id)));
  const boundLocators = new Set(db.prepare(`SELECT locator FROM targets
    WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...bindings.keys()]))
    .map(row => canonicalAccountLocator(row.locator, 'douyin')).filter(Boolean));
  // Membership lookup scans only IDs first, not every stored raw response.
  // It also avoids loading an unrelated streamer's entire native inventory.
  const hasLabel = db.prepare('PRAGMA table_info(targets)').all().some(column => column.name === 'label');
  const candidates = sourceIds.size ? db.prepare(`SELECT t.id,t.locator,t.provider,
    ${hasLabel ? 't.label' : 'NULL'} AS label,t.metadata_json FROM targets t
    WHERE t.type='account' AND t.id IN (SELECT DISTINCT p.target_id FROM posts p
      WHERE p.external_id IN (SELECT value FROM json_each(?))
      AND julianday(p.first_seen_at)<=julianday(?))`).all(JSON.stringify([...sourceIds]), cutoff) : [];
  for (const target of candidates) {
    if (bindings.has(target.id)) continue;
    const expected = canonicalAccountLocator(target.locator, 'douyin');
    let metadata; try { metadata = parse(target.metadata_json); } catch { continue; }
    if (!metadata || !expected?.startsWith('secuid:') || boundLocators.has(expected) || target.provider !== 'public-web'
      || (metadata.platform || 'douyin') !== 'douyin' || metadata.identityVerification?.accountId !== target.locator) continue;
    const accountId = validateSubmittedAccountId(metadata.douyinId || metadata.resolution?.publicDouyinId).value;
    const name = text(target.label) || accountId || `账号 #${target.id}`;
    const author = { key: `monitor-account:${target.id}`, sourceRow: null, platformPublisher: true,
      name, accountId, aliases: [], theme: 'tuantuan', targetIds: [target.id], targetId: target.id,
      classifications: [], workClassifications: [], registeredClassifications: [], registrationEvidence: [],
      monitoringLink: 'linked', sourceFollowers: null, sourceFollowersNote: '', sourceUrl: null,
      _search: norm([name, accountId].join(' ')) };
    bindings.set(target.id, { author, canonicalReceipt: false, sourceCollisionOnly: true });
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
      const sourceIdentityMatches = binding && (binding.sourceCollisionOnly || binding.canonicalReceipt
        || handles.has(norm(binding.author.accountId)) || handles.has(binding.matchedId));
      const id = text(row.external_id);
      if (!binding || binding.sourceCollisionOnly && !sourceIds.has(id)
        || !expected || row.provider !== 'public-web' || (row.platform || 'douyin') !== 'douyin'
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

/** These are existing account entities, not new source-author identity links.
 * Attach only actors with effective historical ownership at this cutoff. */
function withPlatformPublisherActors(source, posts, cutoff) {
  const actors = new Map(), works = new Map(source.works.map(work => [work.contentId, work]));
  for (const post of posts.values()) {
    const observedAt = instant(post.last_seen_at);
    if (!post.author.platformPublisher || !observedAt
      || Date.parse(observedAt) < Date.parse(post.firstSeenAt) || Date.parse(observedAt) > Date.parse(cutoff)) continue;
    const actor = actors.get(post.author.key) || { ...post.author, classifications: [], workClassifications: [] };
    const work = works.get(text(post.external_id));
    const categories = new Set([...actor.workClassifications, ...(work?.classifications || []),
      ...explicitWorkTopicEvidence(work?.title).map(hit => hit.key), ...explicitWorkTopicEvidence(post.caption).map(hit => hit.key)]);
    actor.workClassifications = [...categories]; actor.classifications = [...categories];
    actors.set(post.author.key, actor);
  }
  return actors.size ? { ...source, authors: [...source.authors, ...actors.values()] } : source;
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

/** Work-local evidence supplements source labels, never author membership. A
 * mutable current caption cannot prove a hashtag at an earlier query cutoff. */
function unifiedWorks(source, posts, cutoff) {
  return [...source.works, ...platformOnlyWorks(source, posts)].map(work => {
    const post=posts.get(work.contentId);
    // The same immutable work ID has one observed publisher. Apply the same
    // strict-post rule to the original workbook and later supplements, without
    // merging their author identities or editing their original claims.
    const observedAt=instant(post?.last_seen_at);
    if((work.sourceSupplement||work.sourceRow!=null)&&post&&observedAt
      &&Date.parse(observedAt)>=Date.parse(post.firstSeenAt)&&Date.parse(observedAt)<=Date.parse(cutoff)){
      const sameOwner=post.author.key===work.authorKey&&post.target_id===work.targetId
        ||Boolean(norm(work.accountId))&&norm(work.accountId)===norm(post.author.accountId);
      const platformDay=beijingDay(post.publishedAt),sourceDay=work.publishedOn;
      work={...work,sourceAccountId:work.accountId,sourceOwnershipConflict:!sameOwner,
        ...(post.author.platformPublisher?{publisherIndependentOfSourceAuthor:true}:{}),
        ...(!sameOwner?{sourceClaimedCumulativeLikes:work.cumulativeLikes,sourceClaimedCumulativePlays:work.cumulativePlays}:{}),
        authorKey:post.author.key,authorName:post.author.name,accountId:post.author.accountId,targetId:post.target_id,
        cumulativeLikes:sameOwner?work.cumulativeLikes:null,cumulativePlays:sameOwner?work.cumulativePlays:null,
        sourcePublishedOn:sourceDay||null,sourcePublicationDateConflict:Boolean(sourceDay&&platformDay&&sourceDay!==platformDay),
        publishedOn:platformDay||sourceDay,publishedAt:post.publishedAt,firstSeenAt:post.firstSeenAt,
        dateSource:platformDay?'platform-published-at':work.dateSource,title:work.title||text(post.caption)};
    }
    const evidence = work.sourceRow != null ? explicitWorkTopicEvidence(work.title).map(hit => ({
      ...hit, kind: 'source-work-title-hashtag', sourceRow: work.sourceRow,
    })) : [];
    // Source rows only use platform text when both the author and target agree.
    if (post && post.author.key === work.authorKey && post.target_id === work.targetId
      && observedAt && Date.parse(observedAt) >= Date.parse(post.firstSeenAt)
      && Date.parse(observedAt) <= Date.parse(cutoff)) {
      evidence.push(...explicitWorkTopicEvidence(post.caption).map(hit => ({
        ...hit, kind: 'platform-caption-hashtag', postId: post.id, observedAt,
      })));
    }
    if (!evidence.length) return work;
    const classifications = [...new Set([...work.classifications, ...evidence.map(hit => hit.key)])];
    const tracks = [...new Set([...work.tracks, ...classifications.map(key => labels[key]).filter(Boolean)])];
    const primaryTrack = work.primaryTrack && work.primaryTrack !== '未分类' ? work.primaryTrack
      : classifications.length === 1 ? labels[classifications[0]] : '多赛道';
    return { ...work, classifications, tracks, primaryTrack, classificationEvidence: evidence,
      _search:norm([work._search,...evidence.map(hit=>hit.tag)].join(' ')) };
  });
}

export function readUnifiedPublicationWorks(db, asOf, {foundation,includeMetrics=false,includeOwnerClassification=false}={}) {
  asOf=instant(asOf);if(!asOf)throw Error('作品发布截止时间无效');
  if (!tableExists(db, 'creator_source_imports')) return [];
  const imported = db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf);
  if (!imported) return [];
  const {source:initialSource,foundation:resolvedFoundation}=sourceWithFoundation(db,imported,asOf,foundation);
  const posts = strictPlatformPosts(db, initialSource, asOf);
  const source = withPlatformPublisherActors(initialSource, posts, asOf);
  const works=includeMetrics?adoptedWorkModel(db,source,posts,resolvedFoundation,asOf).works:unifiedWorks(source, posts, asOf);
  if(!includeOwnerClassification)return works;
  const authors=new Map(source.authors.map(author=>[author.key,author]));
  // Work hashtags must never become account classifications. Registration
  // evidence is separate; the corpus itself proves Tuantuan membership.
  return works.map(work=>({...work,registeredAuthorClassifications:authors.get(work.authorKey)?.registeredClassifications??[]}));
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
  const hasSourceRow = work.sourceRow != null||work.sourceSupplement===true;
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


function aggregate(works) {
  let linkedWorks = 0;
  let sourceWorks = 0, platformOnlyWorks = 0;
  for (const work of works) {
    if (work.sourceRow == null&&!work.sourceSupplement) platformOnlyWorks++; else sourceWorks++;
    if (work.targetId != null) linkedWorks++;
  }
  const totals=summarizeAdoptedWorks(works.map(work=>({externalId:work.key,adoptedLikes:work.latestLikes,adoptedPlays:work.latestPlays,
    likesOrigin:work.metricOrigin?.likes,playsOrigin:work.metricOrigin?.plays})));
  return { works: works.length, cumulativePlays:totals.plays.value,cumulativeLikes:totals.likes.value,
    playsKnown:totals.plays.known,likesKnown:totals.likes.known,playsConflicts:totals.plays.conflicts,likesConflicts:totals.likes.conflicts,
    playsOverflow:totals.plays.overflow,likesOverflow:totals.likes.overflow,linkedWorks,
    sourceWorks, platformOnlyWorks };
}

function sortRows(rows, sort, direction, view) {
  const fields = view === 'works'
    ? { plays: 'latestPlays', likes: 'latestLikes', date: 'publishedOn', name: 'authorName', title: 'title' }
    : { plays: 'cumulativePlays', likes: 'cumulativeLikes', works: 'works', name: 'name' };
  const field = fields[sort] || fields.plays, sign = direction === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const av = a[field], bv = b[field];
    const stable = () => (a.sourceRow ?? Number.MAX_SAFE_INTEGER) - (b.sourceRow ?? Number.MAX_SAFE_INTEGER)
      || String(a.contentId ?? a.key ?? '').localeCompare(String(b.contentId ?? b.key ?? ''));
    if (av == null || av === '') return bv == null || bv === '' ? stable() : 1;
    if (bv == null || bv === '') return -1;
    const comparison = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN');
    return comparison * sign || stable();
  });
}

function adoptedWorkModel(db,source,platformPosts,foundation,asOf){
  const observations=indexWorkObservations(foundation?.observations||[],asOf);
  const metricPoints=latestMetricPoints(db,[...platformPosts.values()],asOf),adoptions=new Map();
  const works = unifiedWorks(source, platformPosts, asOf).map(work=>{
    const candidate=platformPosts.get(work.contentId),post=candidate?.author.key===work.authorKey&&candidate?.target_id===work.targetId?candidate:null;
    const points=post&&metricPoints.get(post.id),matched=observationsForWork(observations,work.contentId,[work.accountId]);
    const adopt=metric=>{
      const selected=adoptWorkMetric({metric,sourceValue:work[metric==='likes'?'cumulativeLikes':'cumulativePlays'],
        platformValue:points?.[metric]?.[0]?.value??null,platformObservedAt:points?.[metric]?.[0]?.capturedAt??null,observations:matched,asOf});
      // A withheld conflicting claim is different from never having a value.
      // Keep the original scalar evidence and surface the existing conflict
      // state, rather than silently calling the supplied number unavailable.
      const claimed=work[metric==='likes'?'sourceClaimedCumulativeLikes':'sourceClaimedCumulativePlays'];
      return work.sourceOwnershipConflict&&selected.value===null&&knownCount(claimed)!==null
        ?{...selected,origin:'conflict',conflict:true}:selected;
    };
    const likes=adopt('likes'),plays=adopt('plays');adoptions.set(work.key,{likes,plays});
    return {...work,latestLikes:likes.value,latestPlays:plays.value,metricOrigin:{likes:likes.origin,plays:plays.origin}};
  });
  return {works,metricPoints,adoptions};
}

/** Source cohort statistics and paginated accounts/works for the main dashboard.
 * `start`/`end` filter source publication dates, never observation times. */
export function readCreatorOperatingView(db, query = {}) {
  const ownSnapshot=!db.isTransaction;
  if(ownSnapshot)db.exec('BEGIN');
  try{return withCreatorSourceLinkSnapshot(db,()=>readCreatorOperatingViewSnapshot(db,query));}
  finally{if(ownSnapshot)db.exec('ROLLBACK');}
}
function readCreatorOperatingViewSnapshot(db, query) {
  if (!tableExists(db, 'creator_source_imports')) return { available: false, reason: 'source_not_imported' };
  const requestedAsOf = text(query.asOf), now = new Date().toISOString();
  const asOf = requestedAsOf ? instant(requestedAsOf) : now;
  if (!asOf || Date.parse(asOf) > Date.parse(now)) return { available: true, error: '截止时间无效', statusCode: 400 };
  const imported = db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf);
  if (!imported) return { available: false, reason: 'source_not_imported' };
  const {source:initialSource,foundation}=sourceWithFoundation(db,imported,asOf);
  const platformPosts = strictPlatformPosts(db, initialSource, asOf);
  const source = withPlatformPublisherActors(initialSource, platformPosts, asOf);
  const {works:allWorks,metricPoints,adoptions}=adoptedWorkModel(db,source,platformPosts,foundation,asOf);
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
  const matched = platformMatches(db, source, works.filter(work => work.sourceRow != null||work.sourceSupplement), platformPosts, asOf);
  const postFor = work => {const post=platformPosts.get(work.contentId);return post?.author.key===work.authorKey&&post?.target_id===work.targetId?post:null;};
  const selected = sortRows(view === 'works' ? [...works] : authors, sort, direction, view);
  const pages = Math.ceil(selected.length / pageSize), page = Math.min(positive(query.page, 1, 100000), Math.max(pages, 1));
  const pageItems = selected.slice((page - 1) * pageSize, page * pageSize).map(withoutSearch);
  const metadata = sourceMetadata(imported, source);
  const items = view === 'works' ? pageItems.map(work => {
    const post = postFor(work);
    const row=enrichLatest(work, post, metadata, post&&metricPoints.get(post.id)),adopted=adoptions.get(work.key);
    return {...row,latestLikes:adopted.likes.value,latestPlays:adopted.plays.value,
      latestObservedAt:[adopted.likes.observedAt,adopted.plays.observedAt].filter(Boolean).sort().at(-1)||null,
      metricOrigin:{likes:adopted.likes.origin,plays:adopted.plays.origin},metricAdoption:adopted};
  }) : pageItems;
  return { available: true, source: metadata,
    query: normalized, summary, globalSummary, classificationCoverage, daily, tracks,
    classificationOptions: Object.entries(labels).map(([key, label]) => ({ key, label })),
    reconciliation: { ...matched.reconciliation, sourceEditions: source.sourceEditions, newPlatformWorks: summary.platformOnlyWorks,
      linkedAuthors: summary.linkedAuthors },
    view, items, page, pageSize, pages, total: selected.length,
    semantics: { metrics: '作品列表、作者、分类和日期合计使用同一采用值；逐字段选最近有日期的有效观测，缺失保留已知累计。同ID只计一次，空值不补零。',
      date: '按原表推算或平台记录的作品发布日期（北京时间）筛选和分组，不代表该日播放或点赞增长。',
      track: '分类筛选包含跨赛道收录；汇总每条作品只计算一次，赛道分组使用来源主归属。',
      latest: '同一作品与明确作者身份内，逐字段比较平台和已提供的真实观测时间；同时间冲突留空待核，来源刷新时间不代表指标观测日。',
      comparison: '平台变化仅比较同作品两次已存平台观测；来源对平台差额仅供核对，不能作每日增长。',
      identity: '来源作者与监控账号仅通过已有严格关联对应；未改写监控身份与经营归属。',
      sorting: '作品和作者均按列表采用值排序；缺测或同时间冲突排最后。日期分组只表示作品发布日，不表示该日指标增长。' } };
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
  const data = corpus(db, imported, { reference: asOf ?? new Date() });
  const cutoff = timestamp == null ? new Date().toISOString() : new Date(timestamp).toISOString();
  const projection = readCreatorSourceWorkProjectionSnapshot(db, data, cutoff, () => {
    const metadata = sourceMetadata(imported, data), byTarget = new Map(), accountIds = new Map();
    if (metadata.refreshedAt && Date.parse(metadata.refreshedAt) > Date.parse(cutoff))
      return { metadata, byTarget, accountIds, afterCutoff: true };
    const posts = strictPlatformPosts(db, data, cutoff), actors = withPlatformPublisherActors(data, posts, cutoff);
    for (const work of unifiedWorks(actors, posts, cutoff)) {
      if (work.recordOrigin === 'platform-only' || work.targetId == null) continue;
      if (!byTarget.has(work.targetId)) byTarget.set(work.targetId, []);
      byTarget.get(work.targetId).push(work);
    }
    for (const author of actors.authors) {
      if (author.targetId == null || !author.accountId) continue;
      if (!accountIds.has(author.targetId)) accountIds.set(author.targetId, new Set());
      accountIds.get(author.targetId).add(author.accountId);
    }
    return { metadata, byTarget, accountIds, afterCutoff: false };
  });
  if (projection.afterCutoff) return { available: false, source: structuredClone(projection.metadata),
    items: [], linkedAccountIds: [], reason: 'source_snapshot_after_cutoff' };
  return { available: true, source: structuredClone(projection.metadata),
    linkedAccountIds: [...(projection.accountIds.get(id) || [])],
    items: (projection.byTarget.get(id) || []).map(withoutSearch) };
}
