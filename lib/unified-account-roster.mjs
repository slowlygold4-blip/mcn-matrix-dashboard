import { createHash } from 'node:crypto';
import { readMasterRoster, rosterLink } from './master-roster.mjs';
import { extendMasterRosterWithCreatorSource } from './creator-source-bridge.mjs';
import { mergeRosterClassification } from './roster-classification.mjs';
import { validateSubmittedAccountId } from './author-spreadsheet.mjs';
import { normalizeBoardKey } from './database.mjs';

const text = value => String(value ?? '').trim();
const normalize = value => text(value).normalize('NFKC').toLowerCase();
const unique = values => [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];
const known = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const sumKnown = values => values.some(value => value != null) ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null;
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const nullMetric = () => ({ value: null, knownValue: null, delta: null, percent: null, currentAt: null,
  baselineAt: null, observedInPeriod: false, observedOnEndDate: false, fullPeriodComparable: false,
  comparable: false, reliable: false, deltaReliable: false, dailyComparable: false,
  observedWindow: null, reason: '来源资料已入库；没有该账号对应的真实平台观测，不补零或推算增长。' });

function verifiedSourceRowId(row) {
  const raw = text(row?.accountId);
  const unpacked = raw.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (match, label, link) => {
    try { return new URL(link).hostname.toLowerCase() === label.toLowerCase() ? label : match; }
    catch { return match; }
  });
  const id = validateSubmittedAccountId(unpacked, 'douyin').value;
  const normalized = validateSubmittedAccountId(row?.normalizedId, 'douyin').value;
  return id && normalized && normalize(id) === normalize(normalized) ? normalized : null;
}

function sourceAccountId(entry, source) {
  const rows = unique(entry.creatorSourceRows || []).map(row => source?.authors?.get(row));
  if (!rows.length || rows.some(row => !row)) return null;
  const ids = rows.map(verifiedSourceRowId);
  return ids.every(Boolean) && new Set(ids.map(normalize)).size === 1 ? ids[0] : null;
}

function identity(entry, source) {
  if (entry.identityCorrection || entry.accountIds?.length !== 1) return null;
  const id = validateSubmittedAccountId(entry.accountIds[0], entry.platform).value;
  const sourceId = entry.platform === 'douyin' ? sourceAccountId(entry, source) : null;
  return id || sourceId ? `${entry.platform}:${normalize(id || sourceId)}` : null;
}

function compatibleAnchors(a, b) {
  // Public handles may change. Distinct known profile anchors must never be
  // joined merely because an old submitted public handle happens to match.
  const anchors = item => unique([...(item.locators || []), ...(item.profileLinks || []), item.profileUrl].map(text));
  const left = anchors(a), right = anchors(b);
  return !left.length || !right.length || left.some(value => right.includes(value));
}

function mergeEntry(left, right) {
  const result = { ...left };
  for (const field of ['accountIds', 'originalNames', 'sourceLinks', 'sourceTitles', 'creatorSourceRows']) {
    result[field] = unique([...(left[field] || []), ...(right[field] || [])]);
  }
  for (const field of ['sources', 'boards', 'classifications']) {
    result[field] = [...new Map([...(left[field] || []), ...(right[field] || [])]
      .map(item => [JSON.stringify(item), item])).values()];
  }
  result.rosterKeys = unique([...(left.rosterKeys || [left.key]), ...(right.rosterKeys || [right.key])]);
  return result;
}

function sourceRowCoordinates(entry) {
  return (entry.sources || []).filter(source => rosterLink(source.url) && text(source.sheetName))
    .flatMap(source => (source.rows || []).map(row =>
    [entry.platform, normalize(entry.name), text(source.url), text(source.sheetName), text(row)].join('|')));
}

function collapseRepeatedSourceRows(rosterItems) {
  const items = [...(rosterItems || [])], byCoordinate = new Map();
  for (let index = 0; index < items.length; index++) {
    const entry = items[index];
    if (entry.liveSource || !entry.sources?.length) continue;
    for (const key of sourceRowCoordinates(entry)) {
      if (!byCoordinate.has(key)) byCoordinate.set(key, new Set());
      byCoordinate.get(key).add(index);
    }
  }
  const absorbed = new Set();
  for (let index = 0; index < items.length; index++) {
    const entry = items[index];
    if (!entry.liveSource || entry.targetId || entry.accountIds?.length) continue;
    const matches = new Set(sourceRowCoordinates(entry).flatMap(key => [...(byCoordinate.get(key) || [])]));
    // Same name alone is insufficient. This joins two copies of the exact
    // same source URL + sheet + physical row only when there is one owner.
    if (matches.size !== 1) continue;
    const owner = [...matches][0];
    items[owner] = mergeEntry(items[owner], entry);
    absorbed.add(index);
  }
  return { items: items.filter((_, index) => !absorbed.has(index)), repeatedSourceRowsCollapsed: absorbed.size };
}

function sourceProvenance(entry) {
  return (entry.sources || []).map(value => ({ url: rosterLink(value.url),
    title: text(value.title), sheetName: text(value.sheetName), revision: text(value.revision),
    rows: unique(value.rows || []), readAt: text(value.readAt) || null }));
}

function sourceSummary(entry, source) {
  const facts = unique(entry.creatorSourceRows || []).map(row => source?.authors?.get(row)).filter(Boolean);
  if (!facts.length) return null;
  // Every source row is included at most once. Repeated valid public IDs are
  // overlapping statements, not additive accounts. Without measurement times
  // neither the largest nor the last imported value proves the latest value.
  const groups = new Map();
  for (const fact of facts) {
    const valid = verifiedSourceRowId(fact) || validateSubmittedAccountId(fact.accountId, 'douyin').value;
    const key = valid ? normalize(valid) : `source-row:${fact.row}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fact);
  }
  const conflicts = [];
  const consensus = (rows, field, publicField, accountId) => {
    const values = rows.map(row => known(row[field]));
    if (new Set(values).size <= 1) return values[0] ?? null;
    conflicts.push({ field: publicField, accountId, sourceRows: rows.map(row => row.row), values,
      reason: 'undated-source-conflict' });
    return null;
  };
  const total = (field, publicField) => {
    const values = [...groups].map(([accountId, rows]) => consensus(rows, field, publicField, accountId));
    // Do not present a partial sum as this account's cumulative total when
    // even one overlapping statement conflicts (including known vs missing).
    return conflicts.some(conflict => conflict.field === publicField) ? null : sumKnown(values);
  };
  const works = total('works', 'works');
  const cumulativeLikes = total('likes', 'cumulativeLikes');
  const cumulativePlays = total('plays', 'cumulativePlays');
  const followers = consensus(facts, 'followers', 'followers', null);
  return {
    works, cumulativeLikes, cumulativePlays, followers,
    followersNote: unique(facts.map(fact => fact.followersNote)).join('；') || null,
    authorKeys: facts.map(fact => `source-author:${source.importId}:${fact.row}`),
    sourceRows: facts.map(fact => fact.row), sourceUrl: rosterLink(source.url),
    sourceRevision: source.revision, refreshedAt: source.refreshedAt,
    observedAt: null, metricKind: 'source-cumulative', conflicts, hasConflicts: conflicts.length > 0,
    note: '来源表累计值；来源更新时间不是指标采样时间，不计为日周月增长。'
      + (conflicts.length ? '重复身份的来源字段存在冲突，冲突值留空；全部原始来源仍可查询。' : ''),
  };
}

function sourceAccount(entry, source) {
  const sourceFacts = sourceSummary(entry, source);
  const theme = entry.theme || { key: 'unassigned', label: '待归属' };
  const classification = mergeRosterClassification({ primaryKey: 'unclassified', primaryLabel: '未分类',
    theme: { ...theme, confirmed: theme.key !== 'unassigned' }, labels: [], confidence: 0, mode: 'source-roster' }, entry);
  const boards = (entry.boards || []).map(board => ({ ...board,
    key: normalizeBoardKey(board.key || board.name), name: board.name || board.key })).filter(board => board.key);
  if (theme.key === 'tuantuan' && !boards.some(board => board.key === normalizeBoardKey('一条小团团切片矩阵'))) {
    boards.push({ key: normalizeBoardKey('一条小团团切片矩阵'), name: '一条小团团切片矩阵',
      source: { type: 'source-confirmed-roster', note: '由已登记团团来源归属，未按昵称推断。' } });
  }
  return {
    id: `roster:${createHash('sha256').update(entry.key).digest('hex').slice(0, 32)}`,
    rosterKey: entry.key, rosterKeys: entry.rosterKeys || [entry.key], sourceOnly: true,
    linkedTargetId: Number.isSafeInteger(entry.targetId) ? entry.targetId : null,
    label: entry.name, platform: entry.platform, publicId: entry.accountIds?.[0] || null,
    submittedName: entry.name, submittedAccountId: entry.accountIds?.[0] || null,
    profileUrl: rosterLink(entry.profileLinks?.[0]) || null, enabled: false, boards, classification,
    metrics: Object.fromEntries(['followers', 'likes', 'posts', 'estimatedPlays'].map(key => [key, nullMetric()])),
    trend: [], publishedSamples: { value: 0 }, worksObservation: null,
    status: { key: 'source-only', label: '来源资料已入库', stale: false,
      lastAttemptAt: null, lastSuccessAt: null, error: null,
      provenanceWarning: '没有当前区间平台观测；来源累计值在同一行单独标注。' },
    collection: { status: 'source-only', profile: false, works: false },
    sourceSummary: sourceFacts,
    sourceProvenance: sourceProvenance(entry),
  };
}

/** Pure canonical union. Source rows are visible accounts, never fake monitors. */
export function buildUnifiedAccountRoster(monitoredAccounts, rosterItems, source = null) {
  const accounts = [], byTarget = new Map();
  for (const account of monitoredAccounts || []) {
    if (byTarget.has(account.id)) continue;
    const copy = { ...account };
    byTarget.set(account.id, copy); accounts.push(copy);
  }
  const { items: sourceEntries, repeatedSourceRowsCollapsed } = collapseRepeatedSourceRows(rosterItems);
  const entries = [], targetEntries = new Map(), pendingByIdentity = new Map();
  const identityBuckets = new Map();
  for (const entry of sourceEntries) {
    if (entry.targetId) continue;
    const key = identity(entry, source);
    if (key) identityBuckets.set(key, [...(identityBuckets.get(key) || []), entry]);
  }
  const conflictingIdentities = new Set([...identityBuckets].filter(([, bucket]) => bucket.some((entry, index) =>
    bucket.slice(index + 1).some(other => !compatibleAnchors(entry, other)))).map(([key]) => key));
  let duplicateTargetEntriesCollapsed = 0, pendingIdsMerged = 0;
  for (const entry of sourceEntries) {
    if (Number.isSafeInteger(entry.targetId) && entry.targetId > 0) {
      if (targetEntries.has(entry.targetId)) {
        const index = targetEntries.get(entry.targetId);
        entries[index] = mergeEntry(entries[index], entry); duplicateTargetEntriesCollapsed++;
      } else { targetEntries.set(entry.targetId, entries.length); entries.push(entry); }
      continue;
    }
    const publicIdentity = identity(entry, source);
    const key = conflictingIdentities.has(publicIdentity) ? null : publicIdentity;
    const candidates = key ? pendingByIdentity.get(key) || [] : [];
    // A conflict anywhere in the identity bucket prevents an arbitrary first
    // match. Keep the explicitly distinct anchors visible for review.
    if (candidates.length === 1 && compatibleAnchors(entries[candidates[0]], entry)) {
      const index = candidates[0]; entries[index] = mergeEntry(entries[index], entry); pendingIdsMerged++;
    } else {
      if (key) pendingByIdentity.set(key, [...candidates, entries.length]);
      entries.push(entry);
    }
  }
  const byMonitoredIdentity = new Map();
  for (const target of byTarget.values()) {
    const id = validateSubmittedAccountId(target.publicId, target.platform).value;
    if (!id) continue;
    const key = `${target.platform}:${normalize(id)}`;
    byMonitoredIdentity.set(key, [...(byMonitoredIdentity.get(key) || []), target]);
  }
  let sourceIdentityLinked = 0;
  const targetEvidence = new Map();
  for (const entry of entries) {
    const derived = !entry.targetId && sourceAccountId(entry, source)
      ? byMonitoredIdentity.get(identity(entry, source)) : null;
    const candidate = derived?.length === 1 && compatibleAnchors(entry, derived[0]) ? derived[0] : null;
    const target = byTarget.get(entry.targetId) || candidate;
    if (target) {
      targetEvidence.set(target.id, targetEvidence.has(target.id)
        ? mergeEntry(targetEvidence.get(target.id), entry) : entry);
      if (candidate && !entry.targetId) sourceIdentityLinked++;
      continue;
    }
    accounts.push(sourceAccount(entry, source));
  }
  for (const [targetId, entry] of targetEvidence) {
    const target = byTarget.get(targetId);
    target.rosterKeys = entry.rosterKeys || [entry.key];
    const facts = sourceSummary(entry, source);
    if (facts) target.sourceSummary = facts;
    target.sourceProvenance = sourceProvenance(entry);
  }
  return { accounts, rosterSummary: {
    total: accounts.length, monitored: byTarget.size,
    enabled: [...byTarget.values()].filter(account => account.enabled).length,
    paused: [...byTarget.values()].filter(account => !account.enabled).length,
    sourceOnly: accounts.filter(account => account.sourceOnly).length,
    sourceAuthors: source?.authors?.size || 0,
    sourceLinked: accounts.filter(account => !account.sourceOnly && account.sourceSummary).length,
    duplicateTargetEntriesCollapsed, pendingIdsMerged, repeatedSourceRowsCollapsed, sourceIdentityLinked,
    semantics: '账号名册按稳定身份合并；来源资料可见但不算启用采集或历史增长。',
  } };
}

/** Read-only, bounded source projection: one author-table scan, no work N+1. */
export function mergeUnifiedAccountRoster(db, monitoredAccounts, { roster = readMasterRoster(db) } = {}) {
  const items = roster?.items ?? extendMasterRosterWithCreatorSource(db, []).items;
  let source = null;
  if (hasTable(db, 'creator_source_imports')) {
    const imported = db.prepare('SELECT * FROM creator_source_imports ORDER BY id DESC LIMIT 1').get();
    if (imported) {
      const metadata = JSON.parse(imported.metadata_json || '{}');
      source = { importId: imported.id, url: imported.source_url, revision: imported.source_revision,
        refreshedAt: metadata.audit?.sourceRefreshedAt || null, authors: new Map() };
      for (const row of db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08'").all(imported.id)) {
        const values = JSON.parse(row.values_json);
        source.authors.set(row.row_number, { row: row.row_number, accountId: values[1], normalizedId: values[2], works: known(values[6]),
          likes: known(values[12]), plays: known(values[11]), followers: known(values[14]), followersNote: text(values[15]) });
      }
    }
  }
  return buildUnifiedAccountRoster(monitoredAccounts, items, source);
}
