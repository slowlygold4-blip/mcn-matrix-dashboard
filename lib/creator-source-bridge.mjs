import { readCurrentCreatorSourceLinks } from './creator-source-current-links.mjs';
import { canonicalAccountLocator } from './author-spreadsheet.mjs';
const decode = value => JSON.parse(value);
const asText = value => String(value ?? '').trim();
const unique = values => [...new Set(values.filter(Boolean))];
const currentImport = db => db.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();

/** Source rows are evidence, not platform measurements. This read never writes to
 * targets, posts, post_metrics or snapshots. */
export function readCreatorSourceBridge(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_imports'").get()) return { available: false };
  const imported = currentImport(db);
  if (!imported) return { available: false };
  const id = imported.id;
  const value = sql => Number(db.prepare(sql).get(id).n);
  const authors = value("SELECT COUNT(*) n FROM creator_source_rows WHERE import_id=? AND sheet_id='08'");
  const works = value("SELECT COUNT(*) n FROM creator_source_rows WHERE import_id=? AND sheet_id='09'");
  const currentLinks = readCurrentCreatorSourceLinks(db, { imported });
  const accountLinks = currentLinks.accountLinks.length;
  const identityLinkedWorks = currentLinks.workLinks.length;
  const exactWorkIdOverlap = value(`SELECT COUNT(*) n FROM creator_source_rows s WHERE s.import_id=? AND s.sheet_id='09'
    AND EXISTS(SELECT 1 FROM posts p WHERE p.external_id=json_extract(s.values_json,'$[0]'))`);
  const sourceWorkIds = new Map(db.prepare("SELECT row_number,json_extract(values_json,'$[0]') content_id FROM creator_source_rows WHERE import_id=? AND sheet_id='09'")
    .all(id).map(row => [row.row_number,row.content_id]));
  const targetLocators = new Map(db.prepare("SELECT id,locator FROM targets WHERE type='account'").all()
    .map(target => [target.id, canonicalAccountLocator(target.locator, 'douyin')]));
  const overlappingPost = db.prepare('SELECT author_id,raw_json FROM posts WHERE target_id=? AND external_id=? LIMIT 1');
  const identityAndWorkOverlap = currentLinks.workLinks.filter(link => {
    const contentId = asText(sourceWorkIds.get(link.work_row)), expected = targetLocators.get(link.target_id);
    const post = overlappingPost.get(link.target_id, contentId);
    if (!post || !expected || canonicalAccountLocator(post.author_id, 'douyin') !== expected) return false;
    let raw; try { raw = JSON.parse(post.raw_json); } catch { return false; }
    return asText(raw?.aweme_id) === contentId && canonicalAccountLocator(raw?.author?.sec_uid, 'douyin') === expected;
  }).length;
  const tracks = db.prepare("SELECT values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='05' ORDER BY row_number")
    .all(id).map(row => { const v = decode(row.values_json); return { name: v[0], works: v[1], authors: v[2], knownCumulativePlays: v[3] }; });
  const daily = db.prepare(`SELECT json_extract(values_json,'$[3]') day,COUNT(*) works,
    COUNT(CASE WHEN json_type(values_json,'$[7]') IN ('integer','real') THEN 1 END) playsKnown,
    SUM(CASE WHEN json_type(values_json,'$[7]') IN ('integer','real') THEN json_extract(values_json,'$[7]') END) cumulativePlays,
    COUNT(CASE WHEN json_type(values_json,'$[8]') IN ('integer','real') THEN 1 END) likesKnown,
    SUM(CASE WHEN json_type(values_json,'$[8]') IN ('integer','real') THEN json_extract(values_json,'$[8]') END) cumulativeLikes
    FROM creator_source_rows WHERE import_id=? AND sheet_id='09'
      AND json_extract(values_json,'$[3]') GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'
    GROUP BY day ORDER BY day DESC LIMIT 60`).all(id);
  const metadata = decode(imported.metadata_json);
  const registryAdditionRows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_registry_additions'").get()
    ? db.prepare(`SELECT author_name authorName,account_id accountId,classification_json classifications,
      source_url sourceUrl,source_modified_at sourceModifiedAt
      FROM creator_source_registry_additions ORDER BY observed_at,record_id`).all() : [];
  const registryAdditions = registryAdditionRows.length;
  const externalDeltaRows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_external_deltas'").get()
    ? db.prepare(`SELECT source_url sourceUrl,source_revision sourceRevision,kind,origin_key originKey,
      observed_at observedAt,payload_json payload
      FROM creator_source_external_deltas ORDER BY kind,origin_key`).all()
      .map(row => ({ ...row, payload: decode(row.payload) })) : [];
  const awardDeltaRows = externalDeltaRows.filter(row => row.kind === 'award_missing_from_import');
  const registryCorrectionRows = externalDeltaRows.filter(row => row.kind === 'registry_account_text_difference');
  return { available: true, sourceUrl: imported.source_url, sourceRevision: imported.source_revision,
    sourceModifiedAt: imported.source_modified_at, importedAt: imported.imported_at,
    sourceSha256: imported.source_sha256, sheets: 20, rows: imported.source_row_count,
    authors, works, accountLinks, identityLinkedWorks, exactWorkIdOverlap, identityAndWorkOverlap,
    linkFingerprint: currentLinks.fingerprint, linkReview: currentLinks.stats,
    sourceOnlyWorkIds: works - exactWorkIdOverlap, identityLinkedNotObserved: identityLinkedWorks - identityAndWorkOverlap,
    knownCumulativePlays: metadata.audit?.knownCumulativePlays ?? null,
    sourceRefreshedAt: metadata.audit?.sourceRefreshedAt ?? null, tracks, daily, registryAdditions,
    awardDeltaRows, registryCorrectionRows,
    registryAdditionRows: registryAdditionRows.map(row => ({ ...row, classifications: decode(row.classifications) })),
    semantics: { sourceDates: '来源表“推算日期”只用于作品发布日分布，不是当日播放采样',
      sourcePlays: '来源表累计播放为来源记录，非平台实时核验值，也不能充当每日播放增长',
      overlap: '作品 ID 重合不等于作者身份核验；来源独有作品不等于漏采结论' } };
}

/** Add every source author row to the existing roster read model. A strict
 * account link may enrich an existing target row, but never changes ownership,
 * monitoring state, counters or the historical frozen roster. */
export function extendMasterRosterWithCreatorSource(db, sourceItems) {
  const imported = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='creator_source_imports'").get() ? currentImport(db) : null;
  if (!imported) return { items: sourceItems, summary: null };
  const items = sourceItems.map(item => structuredClone(item));
  const byTarget = new Map();
  for (const item of items) if (item.targetId && !byTarget.has(item.targetId)) byTarget.set(item.targetId, item);
  const normalizedId = value => asText(value).normalize('NFKC').toLowerCase();
  const sourceIdCounts = new Map();
  const authorRows = db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08' ORDER BY row_number").all(imported.id);
  for (const row of authorRows) {
    const id = normalizedId(decode(row.values_json)[1]);
    if (id) sourceIdCounts.set(id, (sourceIdCounts.get(id) || 0) + 1);
  }
  const pendingById = new Map();
  for (const item of items) {
    if (item.targetId || item.monitorStatus !== 'pending' || item.platform !== 'douyin'
      || item.theme?.key !== 'tuantuan' || item.accountIds?.length !== 1 || item.identityCorrection) continue;
    const id = normalizedId(item.accountIds[0]);
    if (!id) continue;
    if (!pendingById.has(id)) pendingById.set(id, []);
    pendingById.get(id).push(item);
  }
  const currentLinks = readCurrentCreatorSourceLinks(db, { imported });
  const links = new Map(currentLinks.accountLinks
    .map(row => [row.author_row, row.target_id]));
  const targets = new Map(db.prepare("SELECT id,label,enabled FROM targets WHERE type='account'").all().map(row => [row.id, row]));
  const sourceUrl = imported.source_url;
  const readAt = imported.source_modified_at;
  let added = 0, enriched = 0, strictlyLinked = 0, pendingIdMerged = 0;
  for (const row of authorRows) {
    const v = decode(row.values_json), targetId = links.get(row.row_number) ?? null;
    const target = targetId ? targets.get(targetId) : null;
    const name = asText(v[0]) || '未填写作者名', accountId = asText(v[1]);
    const labels = [
      [7, 'slice', '切片'], [8, 'original', '原创'], [9, 'ai-remix', 'AI二创'], [10, 'contest', '小团团杯二创大赛'],
    ].filter(([index]) => Number(v[index]) > 0).map(([, key, label]) => ({ key, label }));
    const source = { url: sourceUrl, title: '一条小团团创作者全量来源', fileName: '', sheetName: '08_作者总表',
      revision: imported.source_revision, readAt, observedAt: imported.imported_at, rows: [String(row.row_number)] };
    if (target) strictlyLinked++;
    const pendingMatches = !target && accountId && sourceIdCounts.get(normalizedId(accountId)) === 1
      ? pendingById.get(normalizedId(accountId)) : null;
    const existing = target ? byTarget.get(target.id) : pendingMatches?.length === 1 ? pendingMatches[0] : null;
    if (existing) {
      existing.originalNames = unique([...(existing.originalNames || []), name]);
      // A source handle is searchable evidence, never an edit to a frozen
      // account ID (which may have a signed correction receipt).
      existing.creatorSourceAccountIds = unique([...(existing.creatorSourceAccountIds || []), accountId]);
      existing.sourceLinks = unique([...(existing.sourceLinks || []), sourceUrl]);
      existing.sourceTitles = unique([...(existing.sourceTitles || []), source.title]);
      existing.sources = [...(existing.sources || []), source];
      existing.classifications = [...new Map([...(existing.classifications || []), ...labels].map(label => [label.key, label])).values()];
      existing.creatorSourceRows = [...(existing.creatorSourceRows || []), row.row_number];
      if (!target) pendingIdMerged++;
      if (existing.theme?.key !== 'tuantuan') existing.reviewReasons = unique([...(existing.reviewReasons || []),
        '新来源标注团团，但原经营大主题不同；保留原归属，需复核后再调整。']);
      enriched++; continue;
    }
    const item = { key: `creator-source:${imported.source_sha256}:${row.row_number}`, targetId: target?.id ?? null,
      platform: 'douyin', name: target?.label ?? name, originalNames: [name], accountIds: accountId ? [accountId] : [],
      theme: { key: 'tuantuan', label: '团团' }, classifications: labels,
      monitorStatus: target ? target.enabled ? 'enabled' : 'paused' : 'pending',
      identityStatus: target ? '来源作者与现有监控账号严格对应；采样状态另查' : '来源作者已入主名册；尚未严格对应监控账号',
      profileLinks: [], sourceLinks: [sourceUrl], sourceTitles: [source.title], sources: [source], boards: [], evidenceLinks: [],
      reviewReasons: [target ? '来源数据仅作证据；现有监控数值、身份及启停未改写。' : '来源作者已保留；未凭名称或作品推断账号身份，不纳入经营统计。'],
      verificationAt: '', creatorSource: true, creatorSourceRows: [row.row_number], readOnly: true };
    items.push(item); added++;
    if (target) byTarget.set(target.id, item);
  }
  return { items, summary: { sourceAuthors: authorRows.length, added, enriched, strictlyLinked, pendingIdMerged } };
}
