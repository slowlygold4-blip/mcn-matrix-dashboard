import { readMasterRoster } from './master-roster.mjs';
import { buildAuthorEvidenceRequests, groupSubmittedAuthorIdentities, summarizeAuthorAccountIdentities } from './author-resolution.mjs';
import { canonicalAccountLocator } from './author-spreadsheet.mjs';
import { validateAccountSnapshot } from './account-snapshot-integrity.mjs';
import { readImportAuthorisedAttempts } from './import-authorised-attempts.mjs';

export const IMPORT_MONITORING_SCOPE = 'current-import-account-monitoring';
const clean = (value, limit = 180) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, limit);
const idText = value => clean(value).replace(/^@/, '').toLowerCase();
const statuses = ['enabled', 'paused', 'pending', 'conflict', 'unknown'];
const resolutionStates = ['retrying', 'evidence_exhausted', 'evidence_missing'];
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function currentResolutionStates(db, groups) {
  const requestsByGroup = new Map(), ownersByRequest = new Map();
  for (const group of groups) {
    // Match the ingestion contract exactly: a needs-locator row was never
    // admitted to the evidence queue, even if it happened to contain a work
    // URL in another field. Keys are derived only from this job's immutable
    // submitted rows, so another author's queue state cannot leak in by name.
    const requests = buildAuthorEvidenceRequests(group.records
      .map(record => record.row)
      .filter(row => row?.status !== 'needs_locator'));
    requestsByGroup.set(group.key, requests.map(request => request.key));
    for (const request of requests) {
      if (!ownersByRequest.has(request.key)) ownersByRequest.set(request.key, new Set());
      ownersByRequest.get(request.key).add(group.key);
    }
  }
  const queueStates = new Map(), keys = [...ownersByRequest.keys()];
  const queueTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_queue'").get();
  if (queueTable && keys.length) {
    for (const row of db.prepare(`SELECT identity_key,status FROM author_resolution_queue
      WHERE identity_key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys))) {
      if (ownersByRequest.has(row.identity_key) && ['pending', 'retry', 'rejected', 'resolved'].includes(row.status)) {
        queueStates.set(row.identity_key, row.status);
      }
    }
  }
  return new Map(groups.map(group => {
    const keys = requestsByGroup.get(group.key) || [];
    const states = keys.map(key => queueStates.get(key));
    if (states.some(state => state === 'pending' || state === 'retry')) return [group.key, 'retrying'];
    if (keys.length && states.length === keys.length && states.every(state => state === 'rejected')) {
      return [group.key, 'evidence_exhausted'];
    }
    // No admissible evidence, an absent exact queue key, or an impossible
    // resolved-without-target projection all require new source evidence.
    // Never describe any of them as an automatic retry.
    return [group.key, 'evidence_missing'];
  }));
}

function submittedBoardNames(job) {
  const names = new Set();
  const remember = value => {
    const name = clean(typeof value === 'object' && value ? value.name : value, 120);
    if (name) names.add(name);
  };
  remember(job.request?.defaultBoard);
  for (const row of Array.isArray(job.request?.rows) ? job.request.rows : []) {
    remember(row?.board);
    for (const board of Array.isArray(row?.boards) ? row.boards : []) remember(board);
  }
  return [...names];
}

function currentSubmittedBoardScope(db, job) {
  const boardNames = submittedBoardNames(job);
  if (!boardNames.length) return { available: false, boardNames: [], boardCount: 0,
    reason: '本任务没有明确板块，不能推断合并矩阵总量。' };
  if (boardNames.length > 100) return { available: false, boardNames: boardNames.slice(0, 100), boardCount: boardNames.length,
    reason: '本任务涉及的板块过多，当前结果不合并展示总量。' };
  const placeholders = boardNames.map(() => '?').join(',');
  const row = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled,
      SUM(CASE WHEN enabled=0 THEN 1 ELSE 0 END) AS paused
    FROM (SELECT DISTINCT target.id,target.enabled FROM target_boards membership
      JOIN targets target ON target.id=membership.target_id AND target.type='account'
      WHERE membership.board_name IN (${placeholders}))`).get(...boardNames);
  return {
    available: true,
    boardNames,
    boardCount: boardNames.length,
    totalAccounts: Number(row?.total ?? 0),
    enabledAccounts: Number(row?.enabled ?? 0),
    pausedAccounts: Number(row?.paused ?? 0),
    scope: 'current-union-of-submitted-board-account-memberships-not-this-job-only',
  };
}

function profileState(db, target, nowMs) {
  if (!target.enabled) return { profileStatus: 'not_enabled', sampledAt: null };
  // Equivalent ISO instants can have offsets or omit milliseconds. Sort actual
  // time, not text. A malformed timestamp fails closed rather than disappearing.
  const snapshot = db.prepare(`SELECT * FROM snapshots WHERE target_id=? ORDER BY
    CASE WHEN julianday(captured_at) IS NULL THEN 0 ELSE 1 END,
    julianday(captured_at) DESC,id DESC LIMIT 1`).get(target.id);
  if (!snapshot) return { profileStatus: 'missing', sampledAt: null };
  const time = Date.parse(snapshot.captured_at);
  if (!Number.isFinite(time) || time > nowMs || !['available', 'partial'].includes(snapshot.account_status)
    || ![snapshot.followers, snapshot.total_likes, snapshot.total_posts].every(count)
    || !validateAccountSnapshot(snapshot, target, null, { metricsOnly: true }).valid) return { profileStatus: 'invalid', sampledAt: null };
  const raw = JSON.parse(snapshot.raw_json), user = raw.profile?.user ?? raw.user ?? raw.user_info;
  const blocked = value => value && ['need_login', 'login_required', 'captcha_required', 'verify_required', 'not_login_module']
    .some(key => Boolean(value[key]));
  if (user?.user_deleted === true || ['failed', 'identity_mismatch', 'unavailable'].includes(raw.accountStatus)
    || [raw, raw.profile, raw.profileResponse, user].some(blocked)) return { profileStatus: 'invalid', sampledAt: null };
  return { profileStatus: nowMs - time <= 8 * 3600_000 ? 'fresh' : 'stale', sampledAt: new Date(time).toISOString() };
}

/** Read-only, current state; never rewrites a completed import's receipt. */
export function readImportMonitoringStatus(db, job, { now = new Date(), offset = 0, limit = 20, status = 'all' } = {}) {
  if (!statuses.includes(status) && status !== 'all') throw new TypeError('不支持的监控接入状态');
  const pageOffset = Number(offset), pageLimit = Number(limit);
  if (!Number.isSafeInteger(pageOffset) || pageOffset < 0 || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) throw new TypeError('分页范围无效');
  const rows = Array.isArray(job.request?.rows) ? job.request.rows : [];
  const identitySummary = summarizeAuthorAccountIdentities(rows), { groups } = groupSubmittedAuthorIdentities(rows);
  if (groups.length !== identitySummary.knownDistinctSubmittedIdentityCount) throw new Error('提交身份统计不一致，未展示不完整结果');
  db.exec('SAVEPOINT import_monitoring_read');
  try {
    const roster = readMasterRoster(db), items = roster?.items || [];
    const sourceItems = items.flatMap(item => (item.sources || []).filter(source => source.liveJobId === job.id)
      .map(source => ({ item, rows: new Set(source.rows.map(String)) })));
    const sourceAvailable = job.status === 'completed' && sourceItems.length > 0;
    const sourceReason = sourceAvailable ? null : '当前名册未保留本任务的最新来源投影，无法确认接入状态；历史导入回执仍保留。';
    const sourceRowIndex = new Map();
    for (const entry of sourceItems) for (const row of entry.rows) {
      const key = `${entry.item.platform}:${row}`;
      if (!sourceRowIndex.has(key)) sourceRowIndex.set(key, []);
      sourceRowIndex.get(key).push(entry.item);
    }
    const resolutionByGroup = currentResolutionStates(db, groups);
    const targetQuery = db.prepare("SELECT id,type,provider,locator,metadata_json,enabled FROM targets WHERE id=? AND type='account'");
    const targets = new Map(), profiles = new Map();
    const sourceGroups = new Map(groups.map(group => [group.key, group]));
    const supplementCandidates = new Map();
    const result = groups.map(group => {
      const base = { key: group.key, platform: group.platform, submittedId: group.submittedId, name: group.name,
        sourceRows: group.records.length, targetId: null, sampledAt: null, profileStatus: 'not_enabled' };
      if (!sourceAvailable) return { ...base, status: 'unknown', reason: sourceReason };
      const matches = [...new Set(group.records.flatMap(record => (sourceRowIndex.get(`${group.platform}:${record.row.sourceRow ?? record.index + 1}`) || []).filter(item => {
        if (record.submittedId) return item.accountIds.some(value => idText(value) === record.submittedId);
        // Source-row + canonical-only completed-job binding. No name fallback.
        if (!record.locator) return false;
        if (!item.targetId) return true; // Source record only; remains pending.
        if (!targets.has(item.targetId)) targets.set(item.targetId, targetQuery.get(item.targetId));
        return canonicalAccountLocator(targets.get(item.targetId)?.locator, group.platform) === canonicalAccountLocator(record.locator, group.platform);
      })))];
      if (!matches.length) return { ...base, status: 'unknown', reason: '未找到与本任务提交身份和源行同时匹配的当前资料' };
      // Overlay the corrected identity without replacing or recounting source rows.
      const corrections = matches.map(item => item.identityCorrection).filter(Boolean);
      const correction = corrections[0];
      if (correction && group.platform === 'douyin'
        && idText(correction.originalAccountId) === group.submittedId
        && corrections.every(value => JSON.stringify(value) === JSON.stringify(correction))) {
        base.identityCorrection = { originalAccountId: correction.originalAccountId,
          correctedAccountId: correction.correctedAccountId, status: correction.status };
      }
      const boundIds = new Set(matches.map(item => item.targetId).filter(Boolean));
      if (boundIds.size > 1) return { ...base, status: 'conflict', reason: '同一提交身份关联多个监控账号，未选择其中一个' };
      if (!boundIds.size) {
        if (matches.length === 1 && !matches[0].liveSource && !matches[0].readOnly
          && ['douyin','bilibili','xiaohongshu'].includes(matches[0].platform)
          && !['queued','running','awaiting-verification','conflict'].includes(matches[0].supplement?.status)) supplementCandidates.set(group.key, matches[0].key);
        return { ...base, status: 'pending', resolutionState: resolutionByGroup.get(group.key), reason: base.identityCorrection?.status === 'pending'
          ? '更正账号 ID 已提交；仍待本次作品身份核验，尚未加入监控'
          : '原始资料已保存，尚未建立可核验的监控账号关联' };
      }
      const targetId = [...boundIds][0];
      if (!targets.has(targetId)) targets.set(targetId, targetQuery.get(targetId));
      const target = targets.get(targetId);
      if (!target) return { ...base, status: 'unknown', reason: '关联账号不存在或已不是作者账号' };
      if (group.records.some(record => record.locator && canonicalAccountLocator(record.locator, group.platform) !== canonicalAccountLocator(target.locator, group.platform))) {
        return { ...base, status: 'conflict', reason: '提交的完整主页与当前关联账号不一致' };
      }
      if (!profiles.has(targetId)) profiles.set(targetId, profileState(db, target, now.getTime()));
      return { ...base, ...profiles.get(targetId), targetId, status: target.enabled ? 'enabled' : 'paused',
        reason: target.enabled ? '已启用监控；主页采样和完整作品覆盖分别核对' : '账号已建档但当前暂停，未自动改变启停设置' };
    });
    const counts = { submittedIdentities: groups.length, enabled: 0, paused: 0, pending: 0, conflict: 0, unknown: 0,
      freshProfiles: 0, staleProfiles: 0, missingProfiles: 0, invalidProfiles: 0 };
    for (const item of result) {
      counts[item.status]++;
      if (item.status === 'enabled') counts[`${item.profileStatus}Profiles`]++;
    }
    const resolutionCounts = Object.fromEntries(resolutionStates.map(state => [state, 0]));
    for (const item of result) if (item.status === 'pending') resolutionCounts[item.resolutionState]++;
    const filtered = status === 'all' ? result : result.filter(item => item.status === status);
    const effectiveOffset = Math.min(pageOffset, Math.max(0, Math.ceil(filtered.length / pageLimit) - 1) * pageLimit);
    const attempts = readImportAuthorisedAttempts(db, job, { now });
    const frozenEntry = roster ? db.prepare(`SELECT payload_json FROM master_roster_entries WHERE
      import_id=(SELECT id FROM master_roster_imports ORDER BY id DESC LIMIT 1) AND entry_key=? AND target_id IS NULL`) : null;
    const pageItems = filtered.slice(effectiveOffset, effectiveOffset + pageLimit).map(item => {
      let rosterEntryKey = null;
      const candidate = supplementCandidates.get(item.key);
      if (candidate && item.status === 'pending') {
        let original; try { original = JSON.parse(frozenEntry?.get(candidate)?.payload_json); } catch { /* No editable frozen item. */ }
        const reasons = original?.reviewReasons;
        if (original?.key === candidate && original.platform === item.platform && !original.targetId
          && original.accountIds?.length === 1 && idText(original.accountIds[0]) === item.submittedId
          && Array.isArray(original.locators) && original.locators.length <= 1 && Array.isArray(reasons)
          && !reasons.some(reason => /身份.{0,12}(?:冲突|不一致)|作者.{0,32}(?:不一致|不符)|发布者.{0,40}不一致|多个不同作者|不同.*(?:sec_uid|UID)/i.test(reason))) rosterEntryKey = candidate;
      }
      const groupAttempts = item.status === 'pending' ? (sourceGroups.get(item.key)?.records || [])
        .map(record => attempts.get(record.row.sourceRow)).filter(Boolean) : [];
      const resolutionAttempt = groupAttempts.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0] ?? null;
      return { ...item, rosterEntryKey, resolutionAttempt };
    });
    db.exec('RELEASE import_monitoring_read');
    return { jobId: job.id, scope: IMPORT_MONITORING_SCOPE, checkedAt: now.toISOString(), sourceAvailable, sourceReason,
      inputRows: rows.length, identitySummary, matrixScope: currentSubmittedBoardScope(db, job), counts, resolutionCounts, items: pageItems,
      pagination: { offset: effectiveOffset, limit: pageLimit, total: filtered.length, hasMore: effectiveOffset + pageLimit < filtered.length },
      notes: ['人数按明确提交的账号身份去重，不按作品登记行计数。', '近 8 小时主页三项是粉丝、获赞、作品总数；不代表所有作品均已采集。',
        '更正账号 ID 保留原始提交记录；只有本次作品身份核验成功后才建立监控关联。',
        '此处只读取当前接入状态，不启动采集，也不改写历史导入结果。',
        ...(identitySummary.unknownIdentityItemCount ? [`另有 ${identitySummary.unknownIdentityItemCount} 条登记缺少明确身份或存在身份冲突，未冒充独立账号计数。`] : [])] };
  } catch (error) { db.exec('ROLLBACK TO import_monitoring_read'); db.exec('RELEASE import_monitoring_read'); throw error; }
}
