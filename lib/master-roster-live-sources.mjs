import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { classifyAuthor } from './author-classification.mjs';
import { normalizeAccountLocator } from './author-spreadsheet.mjs';
import { validatedSuccessProof } from './author-resolution-proof.mjs';
import { buildAuthorEvidenceRequests } from './author-resolution.mjs';

const text = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const normalized = value => text(value, 500).normalize('NFKC').toLowerCase();
const unique = values => [...new Set(values.filter(Boolean))];
const identity = (platform, id) => `${platform}:${normalized(id)}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return null; } };
function sourceIdentity(url, sheet) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}:${sheet || parsed.searchParams.get('sheet') || ''}`;
}

function currentBindingReader(db) {
  const targets = db.prepare("SELECT id,label,locator,metadata_json,enabled FROM targets WHERE type='account'").all()
    .map(target => ({ ...target, metadata: parse(target.metadata_json) }))
    .filter(target => target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata));
  const byTarget = new Map(targets.map(target => [target.id, target]));
  const strict = new Map(), strictProofs = new Map();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_success_receipts'").get()) {
    // Iterate instead of imposing a global count limit: crossing that limit
    // previously erased every verified binding from the derived roster view.
    for (const saved of db.prepare('SELECT * FROM author_resolution_success_receipts ORDER BY id DESC').iterate()) {
      const proof = validatedSuccessProof(saved), target = byTarget.get(proof?.targetId);
      const publicId = proof?.resolution?.publicDouyinId;
      if (!target || proof.platform !== 'douyin' || !publicId || target.locator !== proof.canonicalAccountId
        || (target.metadata.platform ?? 'douyin') !== proof.platform) continue;
      const key = identity(proof.platform, publicId);
      if (!strict.has(key)) strict.set(key, new Set());
      strict.get(key).add(target.id);
      if (!strictProofs.has(key)) strictProofs.set(key, []);
      strictProofs.get(key).push(proof);
    }
  }
  return (row, platform, id, job, readResult) => {
    if (row.identityConflict || ['identity_conflict','skipped','needs_locator'].includes(row.status)) return null;
    const proved = id ? strict.get(identity(platform, id)) : null;
    if (proved?.size === 1) {
      // Existing submitted entries require the same source evidence, not only
      // a coincidentally equal handle in a different import's success receipt.
      let sourceMatched = false, authorisedSourceMatched = false;
      try {
        const requests = buildAuthorEvidenceRequests([row]);
        if (requests.length === 1) for (const proof of strictProofs.get(identity(platform, id))) {
          if (proof.identityKey !== requests[0].key || normalized(proof.evidence?.douyinId) !== normalized(id)) continue;
          const source = proof.resolution?.authorisedDetailReceipt?.source;
          const exactSource = Boolean(source && source.jobId === job.id && source.sourceRow === row.sourceRow
            && source.evidenceRequestKey === requests[0].key && source.sourceRowSha256 === hash(JSON.stringify(row)));
          sourceMatched ||= !source || exactSource;
          authorisedSourceMatched ||= exactSource;
        }
      } catch { /* An unconstructable source request cannot promote an entry. */ }
      return { target: byTarget.get([...proved][0]), kind: 'strict-public-account-proof', jobId: job.id, sourceMatched, authorisedSourceMatched };
    }
    // A submitted handle alone or editable target metadata never establishes
    // ownership. Canonical-only rows additionally need this completed job's
    // explicit create/reuse receipt and an unchanged unique current target.
    if (id || typeof row.locator !== 'string') return null;
    const locator = normalizeAccountLocator(row.locator, platform);
    if (!locator || platform === 'douyin' && !/^MS4wLj[\w-]{12,220}$/.test(locator)) return null;
    const matches = targets.filter(target => target.locator === locator && (target.metadata.platform ?? 'douyin') === platform);
    if (matches.length !== 1) return null;
    const result = readResult();
    if (result?.ok !== true) return null;
    const target = matches[0];
    const created = (result.created || []).some(item => item.id === target.id && item.locator === locator
      && (item.metadata?.platform ?? 'douyin') === platform);
    const reused = (result.skipped || []).some(item => item.status === 'existing' && item.sourceRow === row.sourceRow
      && item.locator === locator && (item.platform ?? 'douyin') === platform);
    return created || reused ? { target, kind: 'completed-job-canonical-target', jobId: job.id } : null;
  };
}

// A read projection of completed source imports, not an identity verification
// or mutation of the signed historical workbook. Never bind by nickname.
export function extendMasterRosterWithLiveSources(db, savedItems, { snapshotAt, safeLink }) {
  const summary = { sourceJobCount: 0, sourceRowCount: 0, addedEntryCount: 0, aliasedEntryCount: 0, noIdentityRowCount: 0, latestSourceAt: null };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_jobs'").get()) return { items: savedItems, summary };
  const jobs = db.prepare(`SELECT id,created_at,finished_at,
    json_extract(request_json,'$.fileName') file_name,
    json_extract(request_json,'$.sheetName') sheet_name,
    json_extract(request_json,'$.sourceUrl') url,
    json_extract(request_json,'$.sourceSheetId') sheet,
    json_extract(request_json,'$.sourceType') source_type,
    json_extract(request_json,'$.uploadSha256') upload_sha256
    FROM author_resolution_jobs WHERE status='completed' AND created_at>=?
    AND CASE WHEN json_valid(request_json) THEN (
      json_extract(request_json,'$.sourceType') IN ('lark-sheet','lark-bitable') OR (
        coalesce(json_extract(request_json,'$.sourceType'),'author-spreadsheet')='author-spreadsheet'
        AND json_extract(request_json,'$.masterRosterSupplement') IS NULL
        AND length(json_extract(request_json,'$.uploadSha256'))=64)) END
    ORDER BY created_at DESC,id DESC`).all(snapshotAt);
  const latest = new Map();
  for (const job of jobs) {
    if ((!job.source_type || job.source_type === 'author-spreadsheet') && /^[a-f0-9]{64}$/.test(job.upload_sha256 || '')
      && /\.(xlsx|xls|xlsm|xlsb|csv|tsv)$/i.test(job.file_name || '')) {
      const key = `upload:${job.upload_sha256}:${job.sheet_name || ''}`;
      if (!latest.has(key)) latest.set(key, { ...job, url: '', sourceKey: key, localUpload: true });
      continue;
    }
    const url = safeLink(job.url);
    if (!url || !/(^|\.)(feishu\.cn|larkoffice\.com)$/.test(new URL(url).hostname)) continue;
    const key = sourceIdentity(url, job.sheet);
    if (!latest.has(key)) latest.set(key, { ...job, url, sourceKey: key });
  }
  if (!latest.size) return { items: savedItems, summary };
  const items = savedItems.map(item => structuredClone(item));
  const byId = new Map(), bySourceRow = new Map(), byTarget = new Map(), aliased = new Set();
  const bindingFor = currentBindingReader(db);
  for (const item of items) {
    if (item.targetId) {
      if (!byTarget.has(item.targetId)) byTarget.set(item.targetId, new Set());
      byTarget.get(item.targetId).add(item);
    }
    for (const id of item.accountIds) {
      const key = identity(item.platform, id);
      if (!byId.has(key)) byId.set(key, new Set());
      byId.get(key).add(item);
    }
  }
  const requestQuery = db.prepare('SELECT request_json FROM author_resolution_jobs WHERE id=?');
  const resultQuery = db.prepare('SELECT result_json FROM author_resolution_jobs WHERE id=?');
  for (const job of latest.values()) {
    const storedJob = requestQuery.get(job.id), request = JSON.parse(storedJob.request_json);
    // Most sources contain submitted IDs, whose strict proofs do not use a
    // mutable job result. Fetch/decode it only for an eligible canonical-only
    // row, once for this job/read. No cache survives a later read or edit.
    let resultRead = false, result;
    const readResult = () => {
      if (!resultRead) { result = parse(resultQuery.get(job.id)?.result_json); resultRead = true; }
      return result;
    };
    if (!Array.isArray(request.rows)) throw new Error('最新来源任务缺少完整登记行，未展示不完整名册');
    summary.sourceJobCount++; summary.sourceRowCount += request.rows.length;
    const readAt = Number.isFinite(Date.parse(request.sourceReadAt)) ? request.sourceReadAt : job.finished_at;
    if (!summary.latestSourceAt || Date.parse(readAt) > Date.parse(summary.latestSourceAt)) summary.latestSourceAt = readAt;
    for (const [index, row] of request.rows.entries()) {
      if (!row || typeof row !== 'object') throw new Error('最新来源任务存在无效登记行');
      const platform = text(row.platform || 'douyin', 40);
      if (!['douyin', 'bilibili', 'xiaohongshu', 'kuaishou'].includes(platform)) throw new Error('最新来源登记平台无法识别');
      const id = text(({ douyin: row.douyinId, bilibili: row.bilibiliId, xiaohongshu: row.xiaohongshuId, kuaishou: row.kuaishouId })[platform], 120);
      const name = text(row.name), sourceRow = text(row.sourceRow ?? index + 1, 40);
      if (!id && !name && !text(row.locator) && !text(row.videoId) && !text(row.contentId)
        && !safeLink(row.videoLink) && !safeLink(row.shareUrl)) { summary.noIdentityRowCount++; continue; }
      // Physical rows can move after insertion or sorting. Without an explicit
      // account ID, retain an independent source record, never an old author.
      const sourceRowKey = `${platform}:${job.sourceKey}:${text(row.sourceRecordId || row.recordId) || `${job.id}:${sourceRow}`}`;
      const key = id ? identity(platform, id) : `${platform}:source-row:${sourceRowKey}`;
      let matches = id ? byId.get(key) : bySourceRow.get(sourceRowKey);
      const binding = bindingFor(row, platform, id, job, readResult);
      if (!matches?.size && binding) matches = byTarget.get(binding.target.id);
      if (!matches?.size) {
        const item = { key: `live-source:${platform}:${hash(key)}`, targetId: null, platform,
          name: name || id || '未填写名称', originalNames: [], accountIds: id ? [id] : [],
          theme: { key: 'unassigned', label: '待归属' }, classifications: [], monitorStatus: 'pending',
          identityStatus: '最新来源已登记；尚未核验接入监控', profileLinks: [], sourceLinks: [], sourceTitles: [], sources: [], boards: [], evidenceLinks: [],
          reviewReasons: ['来源登记不等于已核验账号，不计入经营指标。'], verificationAt: '', liveSource: true, readOnly: true };
        if (binding) {
          item.targetId = binding.target.id;
          item.name = binding.target.label;
          item.monitorStatus = binding.target.enabled ? 'enabled' : 'paused';
          item.identityStatus = binding.kind === 'strict-public-account-proof' ? '已有严格公开账号凭据；监控状态沿用当前账号，采样另查' : '本次完整主页已建档；监控状态沿用当前账号，采样另查';
          item.liveSourceBinding = { kind: binding.kind, targetId: binding.target.id, jobId: job.id };
          item.reviewReasons = ['只读关联已建档账号；未改动启停状态或新增采样。'];
          byTarget.set(item.targetId, new Set([item]));
        }
        items.push(item); matches = new Set([item]); summary.addedEntryCount++;
        if (id) byId.set(key, matches); else bySourceRow.set(sourceRowKey, matches);
      }
      // All duplicate source records must agree before changing any derived
      // item. Do not let the first association hide a conflicting sibling, or
      // make the next identical sibling fail merely because the first changed.
      const canPromoteMatches = binding?.kind === 'strict-public-account-proof' && binding.sourceMatched
        && (matches.size === 1 || binding.authorisedSourceMatched)
        && [...matches].every(item => !item.targetId && !item.key.startsWith('target:') && item.platform === platform
          && !(item.reviewReasons || []).some(reason => /身份.{0,12}(?:冲突|不一致)|作者.{0,32}(?:不一致|不符)|发布者.{0,40}不一致|多个不同作者|不同.*(?:sec_uid|UID)/i.test(reason))
          && item.profileLinks.every(link => link === `https://www.douyin.com/user/${binding.target.locator}`)
          && item.accountIds.length === 1 && identity(platform, item.accountIds[0]) === identity(platform, id));
      for (const item of matches) {
        if (canPromoteMatches) {
          // Derived read view only. The frozen workbook and source rows remain
          // unchanged. Duplicate same-identity sources retain separate entries;
          // existing targets, contradictory anchors and conflicts are not replaced.
          item.targetId = binding.target.id;
          item.name = binding.target.label;
          item.monitorStatus = binding.target.enabled ? 'enabled' : 'paused';
          item.identityStatus = '已有严格公开账号凭据；监控状态沿用当前账号，采样另查';
          item.liveSourceBinding = { kind: binding.kind, targetId: binding.target.id, jobId: job.id };
          item.reviewReasons = unique([...item.reviewReasons, '原提交资料已有同源严格身份凭据；只读关联当前账号，原始资料未改写。']);
          if (!byTarget.has(item.targetId)) byTarget.set(item.targetId, new Set());
          byTarget.get(item.targetId).add(item);
        }
        if (name && !item.originalNames.includes(name)) {
          item.originalNames.push(name); if (!item.liveSource) aliased.add(item.key);
        }
        if (matches.size > 1) item.reviewReasons = unique([...item.reviewReasons, '同一提交账号ID关联多条原始资料；保留原条目，未自动合并或更换监控身份。']);
        item.sourceLinks = unique([...item.sourceLinks, job.url]);
        item.sourceTitles = unique([...item.sourceTitles, text(request.sourceTitle || job.file_name)]);
        let source = item.sources.find(source => source.liveJobId === job.id);
        if (!source) {
          source = { url: job.url, title: text(request.sourceTitle || job.file_name), fileName: basename(text(job.file_name)),
            sheetName: text(request.sheetName || job.sheet_name, 120), revision: text(request.sourceRevision, 120),
            readAt, observedAt: job.finished_at, rows: [], liveJobId: job.id,
            ...(job.localUpload ? { uploadSha256: job.upload_sha256, sourceType: 'author-spreadsheet' } : {}) };
          item.sources.push(source);
        }
        if (!source.rows.includes(sourceRow)) source.rows.push(sourceRow);
        if (item.liveSource) {
          const boards = Array.isArray(row.boards) ? row.boards : [{ name: row.board || request.defaultBoard, category: row.category }];
          for (const board of boards) {
            const value = { name: text(board.name, 120), category: text(board.category, 120), tier: text(board.tier, 120), organization: text(board.organization, 200) };
            if (!item.boards.some(existing => JSON.stringify(existing) === JSON.stringify(value))) item.boards.push(value);
          }
        }
      }
    }
  }
  for (const item of items.filter(item => item.liveSource)) {
    const classification = classifyAuthor({ boards: item.boards });
    item.theme = { key: classification.theme.key, label: classification.theme.label };
    item.classifications = classification.labels.map(({ key, label }) => ({ key, label }));
    if (classification.theme.mode === 'conflicting-source') item.reviewReasons.push('来源大主题存在冲突，未自动选择归属。');
  }
  summary.aliasedEntryCount = aliased.size;
  return { items, summary };
}
