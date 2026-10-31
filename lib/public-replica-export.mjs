import {createPublicTextRedactor} from './public-text.mjs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getAccountHistory } from './account-history.mjs';
import { postsAsOf } from './product-insights.mjs';
import { classifyAuthor, AUTHOR_CLASSIFICATION_RULE_VERSION } from './author-classification.mjs';
import { readMasterRoster } from './master-roster.mjs';
import { mergeRosterClassification } from './roster-classification.mjs';
import { businessDateKey, checksum, isCalendarDate, safeJson, shiftCalendarDate } from './utils.mjs';
import { describeWorkPlays } from './work-play-semantics.mjs';
import { selectVerifiedTopicIdentity } from './topic-identity-reuse.mjs';
import { publicAccountCoverage } from './public-account-coverage.mjs';
import { assertCommittedTargetPublication, committedTopicAllowed } from './committed-target-publication.mjs';
import { publicSourceWorkFields } from './public-replica-source-work.mjs';
import { readUnifiedPublicationWorks } from './creator-source-operating-view.mjs';
import { readCurrentCreatorSourceLinks, withCreatorSourceLinkSnapshot,projectCanonicalCreatorLinks } from './creator-source-current-links.mjs';
import { publishingPartitions } from './replica-publishing.mjs';
import { buildPublicationCatalog } from './publication-catalog.mjs';
import { creatorSourcePartitions } from './public-creator-source.mjs';
import {tableFoundationPartitions,readPublicTableFoundation} from './public-table-foundation.mjs';
import {sourcePublicationDateBasis} from './publication-date-basis.mjs';

const TOPICS = ['#一条小团团OvO', '#一条小团团OvO切片激励计划',
  '#一条小团团OvO创作激励计划', '#小团团即梦二创大赛'];
const TOPIC_MODES = new Set(['douyin-authenticated-browser-search-and-detail',
  'douyin-official-anonymous-challenge-detail', 'douyin-public-hashtag-search-and-detail']);
const COUNTERS = ['likes', 'comments', 'shares', 'collects', 'plays'];
const DAILY_FIELDS = ['id', 'date', 'capturedAt', 'sourceChecksum', 'sampleCount',
  'followers', 'likes', 'posts', 'estimatedPlays', 'estimatedPlaysDelta', 'estimatedPlaysProxy',
  ...['followers', 'likes', 'posts'].flatMap(name => [`${name}Delta`, `${name}At`,
    `${name}Checksum`, `${name}BaselineAt`, `${name}BaselineChecksum`])];
const WORK_FIELDS = ['id', 'externalId', 'caption', 'url', 'publishedAt', 'firstSeenAt',
  'lastObservedAt', ...COUNTERS, 'playsEvidence'];
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string' && isCalendarDate(value.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, value[key] ?? null]));
const platformFor = target => ['douyin', 'bilibili', 'xiaohongshu'].includes(safeJson(target.metadata_json, {})?.platform ?? 'douyin')
  ? safeJson(target.metadata_json, {})?.platform ?? 'douyin' : 'unknown';
const exportReceipts = new WeakSet();
export const PUBLIC_REPLICA_EXPORT_REVISION = 'catalog-date-range-v18-registration-work-facts';
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function classificationFor(target, memberships, redact, rosterEntry = null) {
  const result = mergeRosterClassification(classifyAuthor({ target, label: target.label,
    metadata: safeJson(target.metadata_json, {}), memberships }), rosterEntry);
  const labels = result.labels.filter(label => label.sourceConfirmed || result.evidence.some(evidence =>
    evidence.label === label.label && evidence.source !== '作者名称')).map(label => ({
    key: label.key.startsWith('custom:') ? `custom:${hash(label.label).slice(0, 16)}` : label.key,
    label: redact(label.label, 100), confidence: label.confidence,
  })).filter(label => label.label);
  return { theme: { key: result.theme.key, label: result.theme.label,
    confirmed: result.theme.confirmed, mode: result.theme.mode },
  primaryKey: labels[0]?.key ?? 'unclassified', primaryLabel: labels[0]?.label ?? '待分类', labels,
  needsReview: result.needsReview || labels.length === 0, mode: labels.length ? 'source-confirmed-rule' : 'unclassified' };
}

function readAccountCatalogInputs(db, masterRoster) {
  const targets = db.prepare("SELECT id,type,label,provider,locator,metadata_json,enabled FROM targets WHERE type='account' ORDER BY id").all();
  const locators = targets.map(target => String(target.locator ?? '')).filter(Boolean);
  const membershipsByTarget = new Map();
  for (const row of db.prepare('SELECT * FROM target_boards ORDER BY target_id,board_key').all()) {
    const list = membershipsByTarget.get(row.target_id) ?? [];
    list.push(row); membershipsByTarget.set(row.target_id, list);
  }
  const roster = masterRoster === undefined ? readMasterRoster(db) : masterRoster;
  const rosterByTargetId = new Map((roster?.items ?? []).filter(item => Number.isSafeInteger(item.targetId) && item.targetId > 0)
    .map(item => [item.targetId, item]));
  return { targets, locators, redact: createPublicTextRedactor(locators), membershipsByTarget, rosterByTargetId, masterRoster: roster };
}

function accountCatalogBase(target, { redact, membershipsByTarget, rosterByTargetId }) {
  const member = membershipsByTarget.get(target.id) ?? [];
  return { id: target.id, label: redact(target.label, 300) ?? `账号 ${target.id}`,
    platform: platformFor(target), enabled: Boolean(target.enabled),
    boardKeys: [...new Set(member.map(row => redact(row.board_key, 150)).filter(Boolean))],
    classification: classificationFor(target, member, redact, rosterByTargetId.get(target.id)) };
}

/** Current published classification/identity projection, without building daily
 * or work-history partitions. Identity proofs can still require historical
 * reads. The caller owns the SQLite consistency transaction. */
export function readPublicAccountRoster(database, { masterRoster } = {}) {
  const inputs = readAccountCatalogInputs(database?.db ?? database, masterRoster);
  return inputs.targets.map(target => accountCatalogBase(target, inputs));
}

function allHistory(db, id, kind, asOf, committedPublication) {
  const first = getAccountHistory(db, id, { kind, asOf, pageSize: 100, order: 'asc', sort: 'date', committedPublication });
  const items = [...first.items];
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    const next = getAccountHistory(db, id, { kind, asOf, pageSize: 100, page, order: 'asc', sort: 'date', ...first.revision, committedPublication });
    if (next.pagination.total !== first.pagination.total) throw new Error('公开导出历史版本漂移');
    items.push(...next.items);
  }
  if (items.length !== first.pagination.total || new Set(items.map(item => item.id)).size !== items.length) {
    throw new Error('公开导出历史记录不完整或重复');
  }
  return { ...first, items };
}

function verifiedLateMetricIds({ db, metrics, visibleWorks, targets, asOf }) {
  const late = metrics.filter(metric => Date.parse(visibleWorks.get(metric.post_id)?.firstSeenAt) > Date.parse(asOf));
  if (!late.length) return new Set();
  // A visible latest work does not authorize every earlier numeric point.
  // Recover all late-known points in one batch per immutable snapshot cap,
  // retaining the same source/author/time/vector rules as local history.
  const posts = new Map(db.prepare(`SELECT id,target_id,external_id,author_id,caption,url,published_at,first_seen_at,last_seen_at
    FROM posts WHERE julianday(first_seen_at)>julianday(?)`).all(asOf).map(post => [post.id, post]));
  const groups = new Map();
  for (const metric of late) {
    const work = visibleWorks.get(metric.post_id), post = posts.get(metric.post_id);
    if (!post || post.target_id !== work.targetId) continue;
    const rows = groups.get(work.snapshotCap) ?? [];
    rows.push({ ...post, ...metric, id: metric.id, metric_at: metric.captured_at });
    groups.set(work.snapshotCap, rows);
  }
  const verified = new Set();
  for (const [snapshotMaxId, rows] of groups) {
    for (const row of postsAsOf({ db }, rows, asOf, targets, { forceRecovery: true, snapshotMaxId })) verified.add(row.id);
  }
  return verified;
}

// The shared identity-reuse contract requires two counters; history must also
// retain one genuinely witnessed counter without inventing the missing one.
function witnessedPartialTopic(target, rows, asOf) {
  const key = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/^#+/, '').trim().toLowerCase() : '';
  return rows.some(row => {
    if ((row.hashtag_participants === null) === (row.hashtag_views === null)
      || ![row.hashtag_participants, row.hashtag_views].every(value => value === null || count(value))
      || row.target_id !== target.id || row.audit_target_id !== target.id || row.audit_provider !== 'public-web'
      || !['validated', 'warning'].includes(row.quality_status) || !['validated', 'warning'].includes(row.audit_status)
      || !Number.isSafeInteger(row.run_id) || row.run_id <= 0 || !Number.isSafeInteger(row.audit_id) || row.audit_id <= 0
      || row.audit_checksum !== row.source_checksum) return false;
    const times = [row.started_at, row.captured_at, row.audit_created_at, row.finished_at].map(iso);
    if (times.some(time => !time)) return false;
    const [start, sampled, audited, finished] = times.map(Date.parse);
    if (!(start <= sampled && sampled <= audited && audited <= finished && finished <= Date.parse(asOf))) return false;
    try {
      const raw = JSON.parse(row.raw_json), browser = raw.provenance?.mode === 'douyin-authenticated-browser-search-and-detail';
      if (!TOPIC_MODES.has(raw.provenance?.mode) || raw.provenance.runtimeAI !== false || raw.provenance.paidAPI !== false
        || typeof raw.challengeId !== 'string' || !/^\d{8,24}$/.test(raw.challengeId) || key(raw.officialName) !== key(target.locator)
        || key(raw.hashtag ?? raw.label) !== key(target.locator) || (browser && raw.provenance.authenticated !== true)
        || (raw.capturedAt != null && iso(raw.capturedAt) !== times[1])) return false;
      if (!browser && (raw.scope !== 'douyin-official-challenge-detail'
        || (raw.participants ?? null) !== row.hashtag_participants || (raw.views ?? null) !== row.hashtag_views)) return false;
      const expected = browser ? checksum({ tag: raw.hashtag, snapshot: { followers: null, totalLikes: null, totalPosts: null,
        hashtagParticipants: row.hashtag_participants, hashtagViews: row.hashtag_views, hashtagPosts: null, authorCount: null },
        raw: { challengeId: raw.challengeId, officialName: raw.officialName, searchKeyword: raw.searchKeyword } }) : checksum(raw);
      return expected === row.source_checksum;
    } catch { return false; }
  });
}

function topicExport(db, asOf, redact, committedPublication) {
  const topics = db.prepare("SELECT id,type,label,provider,locator,enabled FROM targets WHERE type='hashtag' ORDER BY id").all()
    .filter(target => TOPICS.includes(target.label));
  const items = [];
  for (const topic of topics) {
    const days = new Map();
    const rows = db.prepare(`SELECT s.id,s.target_id,s.captured_at,s.hashtag_participants,s.hashtag_views,
      s.quality_status,s.source_checksum,s.raw_json,a.id audit_id,a.target_id audit_target_id,
      a.provider audit_provider,a.status audit_status,a.source_checksum audit_checksum,
      a.created_at audit_created_at,a.run_id,r.started_at,r.finished_at
      FROM snapshots s LEFT JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum
      AND julianday(a.created_at)>=julianday(s.captured_at)
      LEFT JOIN runs r ON r.id=a.run_id WHERE s.target_id=? AND julianday(s.captured_at)<=julianday(?)
      ORDER BY julianday(s.captured_at),s.id`).all(topic.id, asOf);
    const evidenceBySnapshot = new Map();
    for (const row of rows) {
      const evidence = evidenceBySnapshot.get(row.id) ?? []; evidence.push(row); evidenceBySnapshot.set(row.id, evidence);
    }
    for (const evidence of evidenceBySnapshot.values()) {
      const row = evidence[0];
      const capturedAt = iso(row.captured_at);
      if (!capturedAt) continue;
      const verified = committedTopicAllowed(committedPublication,row)
        || selectVerifiedTopicIdentity(topic, evidence, { now: Date.parse(asOf) }).status === 'verified'
        || witnessedPartialTopic(topic, evidence, asOf);
      const date = businessDateKey(capturedAt, 'Asia/Shanghai');
      days.set(date, { targetId: topic.id, id: row.id, date, capturedAt,
        participants: verified && count(row.hashtag_participants) ? row.hashtag_participants : null,
        views: verified && count(row.hashtag_views) ? row.hashtag_views : null,
        qualityStatus: verified ? row.quality_status : 'unverified',
        sourceChecksum: /^[a-f\d]{64}$/.test(row.source_checksum ?? '') ? row.source_checksum : null,
        metricsEvidence: verified ? 'topic-identity-source-run-time-vector-bound' : 'saved-unverified-closing-observation' });
    }
    for (const point of days.values()) {
      const baseline = days.get(shiftCalendarDate(point.date, -1));
      for (const name of ['participants', 'views']) {
        point[`${name}Delta`] = point[name] === null || baseline?.[name] == null ? null : point[name] - baseline[name];
        point[`${name}BaselineAt`] = point[`${name}Delta`] === null ? null : baseline.capturedAt;
        point[`${name}BaselineChecksum`] = point[`${name}Delta`] === null ? null : baseline.sourceChecksum;
      }
      items.push(point);
    }
  }
  return { topics: topics.map(topic => ({ id: topic.id, label: redact(topic.label), enabled: Boolean(topic.enabled) })), items };
}

/** Caller owns one read transaction. No settings/session/locator/raw/source URLs are projected. */
export function exportPublicReplica(database, options = {}) {
  return withCreatorSourceLinkSnapshot(database?.db ?? database, () => exportReplicaSnapshot(database, options));
}
function exportReplicaSnapshot(database, { asOf = new Date().toISOString(), committedPublication } = {}) {
  if (!iso(asOf) || Date.parse(asOf) > Date.now()) throw new Error('公开导出截止时刻无效');
  asOf = iso(asOf);
  const db = database?.db ?? database;
  if (committedPublication !== undefined) assertCommittedTargetPublication(committedPublication, db, asOf);
  const catalogInputs = readAccountCatalogInputs(db);
  const { targets, redact } = catalogInputs;
  const sourceImport = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_imports'").get()
    ? db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf) : null;
  const creatorSourceLinks = sourceImport ? {
    revision: String(sourceImport.source_revision), modifiedAt: sourceImport.source_modified_at,
    rowCount: sourceImport.source_row_count,
    links: projectCanonicalCreatorLinks(readCurrentCreatorSourceLinks(db, { imported: sourceImport, reference: asOf }).accountLinks),
  } : undefined;
  const accounts = [], partitions = [], visibleWorks = new Map();
  const totals = { accounts: targets.length, enabledAccounts: targets.filter(target => target.enabled).length,
    boards: 0, daily: 0, works: 0, workMetrics: 0, topics: 0, topicDaily: 0, excludedAccountSnapshots: 0 };
  for (const target of targets) {
    const daily = allHistory(db, target.id, 'daily', asOf, committedPublication), works = allHistory(db, target.id, 'works', asOf);
    const dailyItems = daily.items.map(item => ({ targetId: target.id, ...pick(item, DAILY_FIELDS) }));
    const workItems = works.items.map(item => ({ targetId: target.id, ...pick(item, WORK_FIELDS),
      ...publicSourceWorkFields(item, asOf),
      // A source table can establish a publication calendar day, not an exact
      // platform timestamp. Keep that precision separate from publishedAt.
      publishedOn: isCalendarDate(item.publishedOn) ? item.publishedOn : null,
      publicationDateBasis: iso(item.publishedAt) ? 'platform-timestamp'
        : isCalendarDate(item.publishedOn) ? sourcePublicationDateBasis(item) : 'missing',
      caption: redact(item.caption) }));
    for (const work of workItems) visibleWorks.set(work.id, { targetId: target.id, externalId: work.externalId,
      platform: platformFor(target), metricCap: works.revision.postMetricMaxId,
      snapshotCap: works.revision.snapshotMaxId, firstSeenAt: work.firstSeenAt });
    const latest = Object.fromEntries(['followers', 'likes', 'posts'].map(name => {
      const item = dailyItems.findLast(point => point[name] !== null);
      return [name, { value: item?.[name] ?? null, observedAt: item?.[`${name}At`] ?? null,
        sourceChecksum: item?.[`${name}Checksum`] ?? null, date: item?.date ?? null }];
    }));
    accounts.push({ ...accountCatalogBase(target, catalogInputs), historyRevision: daily.revision, latest,
      coverage: publicAccountCoverage(db, target, { asOf, verifiedDaily: daily.items, verifiedWorks: works.items, committedPublication }) });
    if (dailyItems.length) partitions.push({ path: `daily/${target.id}.json`, kind: 'daily', targetId: target.id, items: dailyItems });
    if (workItems.length) partitions.push({ path: `works/${target.id}.json`, kind: 'works', targetId: target.id, items: workItems });
    totals.daily += dailyItems.length; totals.works += workItems.length;
    totals.excludedAccountSnapshots += daily.coverage.excludedCount;
  }
  const metricsByAccount = new Map();
  const metrics = db.prepare(`SELECT m.id,m.post_id,m.captured_at,m.likes,m.comments,m.shares,m.collects,m.plays
    FROM post_metrics m JOIN posts p ON p.id=m.post_id JOIN targets t ON t.id=p.target_id
    WHERE t.type='account' AND julianday(m.captured_at)<=julianday(?) ORDER BY p.target_id,julianday(m.captured_at),m.id`).all(asOf);
  const eligible = metrics.filter(metric => {
    const work = visibleWorks.get(metric.post_id);
    return work && metric.id <= work.metricCap && iso(metric.captured_at)
      && COUNTERS.every(name => metric[name] === null || count(metric[name]));
  });
  const verifiedLate = verifiedLateMetricIds({ db, metrics: eligible, visibleWorks, targets, asOf });
  for (const metric of eligible) {
    const work = visibleWorks.get(metric.post_id), capturedAt = iso(metric.captured_at);
    if (Date.parse(work.firstSeenAt) > Date.parse(asOf) && !verifiedLate.has(metric.id)) continue;
    const list = metricsByAccount.get(work.targetId) ?? [];
    list.push({ targetId: work.targetId, id: metric.id, workId: metric.post_id, externalId: work.externalId,
      capturedAt, ...pick(metric, COUNTERS), playsEvidence: describeWorkPlays(metric.plays, work.platform) });
    metricsByAccount.set(work.targetId, list); totals.workMetrics++;
  }
  for (const [targetId, items] of metricsByAccount) partitions.push({ path: `work-metrics/${targetId}.json`, kind: 'workMetrics', targetId, items });
  const boards = db.prepare('SELECT board_key,board_name,enabled FROM board_catalog ORDER BY board_key').all().map(row => {
    const key = redact(row.board_key, 150), member = accounts.filter(account => account.boardKeys.includes(key));
    return { key, name: redact(row.board_name, 300), enabled: Boolean(row.enabled),
      accountCount: member.length, enabledAccountCount: member.filter(account => account.enabled).length };
  }).filter(board => board.key && board.name);
  totals.boards = boards.length;
  const topics = topicExport(db, asOf, redact, committedPublication); totals.topics = topics.topics.length; totals.topicDaily = topics.items.length;
  const foundation=readPublicTableFoundation(db,asOf,{masterRoster:catalogInputs.masterRoster});
  const accountIds=new Set(accounts.map(account=>account.id));
  const unifiedPublicationWorks = readUnifiedPublicationWorks(db, asOf,{foundation,includeMetrics:true,includeOwnerClassification:true});
  if(creatorSourceLinks){
    const workOwners=unifiedPublicationWorks.filter(work=>(work.sourceOwnershipConflict===true||work.publisherIndependentOfSourceAuthor===true)
      &&Number.isSafeInteger(work.sourceRow)&&work.sourceRow>0&&accountIds.has(work.targetId))
      .map(work=>({workRow:work.sourceRow,contentId:work.contentId,targetId:work.targetId,
        ...(work.sourceOwnershipConflict===false?{sourceClaimMatches:true}:{})}))
      .sort((a,b)=>a.workRow-b.workRow);
    if(workOwners.length)creatorSourceLinks.workOwners=workOwners;
    const foundationIds=new Set(foundation.works.map(work=>work.contentId));
    const foundationWorkOwners=unifiedPublicationWorks.filter(work=>(work.sourceOwnershipConflict===true||work.publisherIndependentOfSourceAuthor===true)
      &&work.sourceSupplement===true&&work.sourceRow==null&&foundationIds.has(work.contentId)&&accountIds.has(work.targetId))
      .map(work=>({contentId:work.contentId,targetId:work.targetId,
        ...(work.sourceOwnershipConflict===false?{sourceClaimMatches:true}:{})})).sort((a,b)=>a.contentId.localeCompare(b.contentId));
    if(foundationWorkOwners.length){creatorSourceLinks.foundationWorkOwners=foundationWorkOwners;creatorSourceLinks.foundationWorkOwnerRevision=foundation.revision;}
  }
  const sourcePublicationRows = unifiedPublicationWorks
    .filter(work=>!work.publishedOn||work.publishedOn>='2026-09-12').map(work=>({
    contentId:work.contentId,date:work.publishedOn||'',author:(redact(work.authorName,300)||'').replace(/[<>]/g,''),
    title:(redact(work.title,300)||'').replace(/[<>]/g,''),targetId:accountIds.has(work.targetId)?work.targetId:null,
    classifications:work.classifications.filter(k=>['slice','original','ai-remix','contest'].includes(k)),
    registeredAuthorClassifications:work.registeredAuthorClassifications,
    origin:work.sourceRow==null&&!work.sourceSupplement?'platform':'source',
    dateBasis:sourcePublicationDateBasis(work),
    metrics:{likes:{value:work.latestLikes,origin:work.metricOrigin.likes},plays:{value:work.latestPlays,origin:work.metricOrigin.plays}},
  }));
  const publication=buildPublicationCatalog({sourceWorks:sourcePublicationRows,accounts,partitions,asOf,withDates:true});
  partitions.push(...publishingPartitions(publication.rows,{withMetrics:true,scopes:publication.scopes,withDates:true}));
  partitions.push(...creatorSourcePartitions(db,asOf,{sanitize:(value,limit)=>redact(String(value??''),limit)||''}));
  partitions.push(...tableFoundationPartitions(db,asOf,{foundation}));
  const result = { version: 1, asOf, timeZone: 'Asia/Shanghai', counts: totals,
    catalog: { accounts, boards, ...(creatorSourceLinks ? { creatorSourceLinks } : {}), classificationRuleVersion: `${AUTHOR_CLASSIFICATION_RULE_VERSION}+master-roster-v1` }, topics, partitions,
    policy: { readOnly: true, platformComplete: false, independentlyVerified: false, missingDatesFilled: false,
      accountDailyEvidence: 'checksum-and-normalized-vector-bound', worksMetricEvidence: 'saved-record-not-independently-verified',
      topicEvidence: 'per-snapshot-topic-identity-source-run-time-vector-bound',
      estimate: '账号估算播放仅点赞×100，不是实测播放；缺日不补零，负变化保留。',
      note: '这是截至导出时刻的全部合格已保存记录，不代表平台完整作品或全天稳定；作品指标是保存记录，未逐条独立核验。',
      textRendering: '所有名称、分类、标题均用textContent渲染，禁止作为HTML解释。' } };
  exportReceipts.add(result);
  return freeze(result);
}

export function serializePublicReplica(replica) {
  if (!exportReceipts.has(replica)) throw new Error('只允许序列化已校验的公开导出');
  const common = { version: replica.version, asOf: replica.asOf, timeZone: replica.timeZone };
  const parts = [{ path: 'catalog.json', kind: 'catalog', count: replica.counts.accounts, ...replica.catalog },
    { path: 'topics.json', kind: 'topics', count: replica.counts.topicDaily, ...replica.topics },
    ...replica.partitions.map(part => ({ ...part, count: part.items?.length ?? part.count }))];
  const files = parts.map(({ path, kind, count: itemCount, targetId, ...payload }) => {
    if (!/^(?:catalog\.json|topics\.json|publishing\.json|publishing\/\d{6}\.json|creator\/(?:index|authors|insights|works-\d{3})\.json|foundation\/(?:index|authors|works|sources|observations|other-authors|other-works|pending-authors)\.json|(?:daily|works|work-metrics)\/[1-9]\d*\.json)$/.test(path)) {
      throw new Error('公开导出分区路径无效');
    }
    const content = `${JSON.stringify({ ...common, ...payload, ...(kind==='publishing'?{count:itemCount}:{}) })}\n`;
    return { path, kind, ...(targetId ? { targetId } : {}), count: itemCount,
      bytes: Buffer.byteLength(content), sha256: hash(content), content };
  });
  const manifest = { ...common, policy: replica.policy, counts: replica.counts,
    files: files.map(({ content, ...entry }) => entry) };
  return { manifest, files };
}

export async function writePublicReplica(directory, replica) {
  const { manifest, files } = serializePublicReplica(replica);
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const path = join(directory, file.path);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, file.content, { flag: 'wx' });
  }
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
  return manifest;
}

// CLI produces generated JSON only. It never initializes the production schema.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = resolve(process.argv[2] ?? 'data/douyin-monitor.sqlite');
  const directory = resolve(process.argv[3] ?? 'data/public-replica-staging', new Date().toISOString().replace(/[:.]/g, '-'));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const started = performance.now();
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const before = db.prepare('SELECT total_changes() n').get().n;
    const replica = exportPublicReplica(db);
    const after = db.prepare('SELECT total_changes() n').get().n;
    if (before !== after) throw new Error('公开导出发生写入');
    db.exec('ROLLBACK');
    const manifest = await writePublicReplica(directory, replica);
    console.log(JSON.stringify({ directory, asOf: replica.asOf, counts: replica.counts, files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0), totalChanges: after - before,
      elapsedMs: Math.round(performance.now() - started) }));
  } finally { try { db.exec('ROLLBACK'); } catch {} db.close(); }
}
