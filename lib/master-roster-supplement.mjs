import { canonicalResolvedAccount as canonical, sameResolvedWorkLink as sameWorkLink, validatedSuccessProof } from './author-resolution-proof.mjs';
import { createHash } from 'node:crypto';
import { parseAuthorSpreadsheet } from './author-spreadsheet.mjs';
import { buildAuthorEvidenceRequests } from './author-resolution.mjs';
import { readMasterRoster, readMasterRosterEntry, rosterLink } from './master-roster.mjs';
import { prepareImportAuthorisedDetail } from './import-authorised-detail.mjs';
import { validateAuthorisedDetailResult } from './douyin-authorised-detail.mjs';

const PURPOSE = 'master-roster-supplement';
const MAX_JOBS = 5_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value, max = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
const accountId = value => clean(value, 120).replace(/^@/, '').toLowerCase();
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return null; } };
const conflict = item => item.accountIds.length > 1 || item.locators.length > 1
  || item.reviewReasons.some(reason => /身份.{0,12}(?:冲突|不一致)|作者.{0,32}(?:不一致|不符)|发布者.{0,40}不一致|多个不同作者|不同.*(?:sec_uid|UID)/i.test(reason));
const contextKeys = ['version', 'purpose', 'workbookSha256', 'entryKey', 'entryPayloadSha256', 'platform', 'evidence', 'requestSha256'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const sameCorrection = (a, b) => a?.originalAccountId === b?.originalAccountId && a?.correctedAccountId === b?.correctedAccountId;
function publicId(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return '';
  const normalized = value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.-]{1,100}$/.test(normalized) && /[a-z0-9]/.test(normalized) && normalized !== '0' ? normalized : '';
}
function validCorrection(correction, item) {
  return correction && typeof correction === 'object' && !Array.isArray(correction)
    && Object.keys(correction).length === 2 && Object.keys(correction).every(key => ['originalAccountId', 'correctedAccountId'].includes(key))
    && item.platform === 'douyin' && !item.targetId && !item.key.startsWith('target:') && item.accountIds.length === 1
    && item.locators.length === 0 && item.profileLinks.length === 0 && !conflict(item)
    && correction.originalAccountId === item.accountIds[0] && publicId(correction.correctedAccountId) === correction.correctedAccountId
    && Boolean(correction.correctedAccountId) && accountId(correction.originalAccountId) !== correction.correctedAccountId;
}
function expectedAccountId(item, context) {
  return context?.version === 2 ? context.correction?.correctedAccountId : item.accountIds[0] || '';
}
function preparedCorrectionInput(request) {
  try {
    if (request.rows?.length !== 1 || !/^https:\/\//.test(request.masterRosterSupplement?.evidence || '')) return null;
    const evidence = request.masterRosterSupplement.evidence, url = new URL(evidence);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || evidence.match(/^https:\/\/([^/?#]*)/i)?.[1]?.toLowerCase() !== url.hostname.toLowerCase()) return null;
    const input = prepareImportAuthorisedDetail({ status: 'completed', request }, { sourceRow: request.rows[0].sourceRow });
    if (input.shareUrl) return sameWorkLink(input.shareUrl, evidence) ? input : null;
    const pathId = ['douyin.com', 'www.douyin.com'].includes(url.hostname)
      ? url.pathname.match(/^\/(?:video|note|share\/video)\/([1-9]\d{14,24})\/?$/)?.[1] : null;
    return pathId === input.videoId && ['aweme_id', 'item_id', 'modal_id'].every(key => url.searchParams.getAll(key).every(id => id === input.videoId)) ? input : null;
  } catch { return null; }
}
function assertUnusedCorrectionEvidence(db, request, { completedReplay = false } = {}) {
  if (completedReplay) return;
  const input = preparedCorrectionInput(request);
  if (!input) fail(400, '更正身份缺少唯一有效的官方作品证据');
  const has = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const row = has('author_resolution_queue')
    ? db.prepare('SELECT status,suspended_target_enabled FROM author_resolution_queue WHERE identity_key=?').get(input.key) : null;
  const oldProof = has('author_resolution_success_receipts')
    && db.prepare('SELECT 1 FROM author_resolution_success_receipts WHERE identity_key=? LIMIT 1').get(input.key);
  if (oldProof || row && (!['pending', 'retry'].includes(row.status) || row.suspended_target_enabled !== null)) {
    fail(409, '这条作品已有终态核验或历史身份凭据。更正抖音号请提供另一条尚未核验的官方作品链接；未恢复旧队列或暂停账号。');
  }
}

/** Stable across parser -> sanitizer -> existing-state hydration, never across identity or membership changes. */
export function masterRosterSupplementRequestSha256(input) {
  const rows = Array.isArray(input) ? input : input?.rows;
  if (!Array.isArray(rows) || rows.length !== 1) return '';
  return hash(rows.map(row => ({
    ...Object.fromEntries(['platform', 'name', 'locator', 'douyinId', 'bilibiliId', 'xiaohongshuId', 'contentId', 'videoId', 'videoLink', 'videoHyperlink', 'shareUrl'].map(key => [key, clean(row[key], key === 'name' ? 120 : 500)])),
    boards: (row.boards || []).map(board => Object.fromEntries(['name', 'organization', 'tier', 'category', 'owner', 'filledDate', 'note'].map(key => [key, clean(board[key])]))),
  })));
}

function evidenceInput(value, platform) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 1_000 || /[\r\n]/.test(raw)) fail(400, '请填写一条官方主页、作品或分享链接，不能一次混入多条');
  if (/^https?:/i.test(raw)) {
    let url; try { url = new URL(raw); } catch { fail(400, '链接格式无效'); }
    const hosts = { douyin: ['douyin.com', 'www.douyin.com', 'v.douyin.com'], bilibili: ['bilibili.com', 'www.bilibili.com', 'space.bilibili.com', 'b23.tv'],
      xiaohongshu: ['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com', 'www.xhslink.com'] };
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts[platform]?.includes(url.hostname.toLowerCase()) || !rosterLink(raw)) {
      fail(400, '只接受该平台的官方 HTTPS 链接；不能跨平台或携带登录凭据');
    }
    url.hash = ''; return url.toString();
  }
  if (/\s/.test(raw) || !/^[\w-]+$/.test(raw)) fail(400, '请提供有效的平台账号 ID 或官方链接');
  return clean(raw, 240);
}


function targetValues(target) {
  const invalid = { platform: '__invalid_metadata__' };
  if (!target || typeof target !== 'object') return invalid;
  let value;
  if (Object.hasOwn(target, 'metadata_json')) {
    if (typeof target.metadata_json !== 'string') return invalid;
    try { value = JSON.parse(target.metadata_json); } catch { return invalid; }
  } else value = target.metadata ?? {};
  // A valid legacy {} can still default to Douyin. Corruption, arrays and
  // JSON scalars must not acquire that default or inherit a success binding.
  return value && typeof value === 'object' && !Array.isArray(value) ? value : invalid;
}
function supplementBoards(values) {
  const output = new Map();
  const fields = [['category', 120], ['tier', 120], ['organization', 200]];
  for (const source of values) {
    const name = clean(source.name, 120), key = name.toLowerCase();
    if (!name) continue;
    const candidate = { name, ...Object.fromEntries(fields.map(([field, max]) => [field, clean(source[field], max)])), sourceRow: 2 };
    const existing = output.get(key);
    if (!existing) { output.set(key, candidate); continue; }
    for (const [field] of fields) {
      if (!existing[field]) existing[field] = candidate[field];
      else if (candidate[field] && existing[field].toLowerCase() !== candidate[field].toLowerCase()) {
        fail(409, '原始同名板块资料存在字段冲突，请先核对；未覆盖原分类或原始资料');
      }
    }
  }
  // The server coalesces board names before persisting a job. Sign this same
  // lossless representation, not repeated empty rows that disappear there.
  // The original duplicate source rows remain protected by entryPayloadSha256.
  return [...output.values()];
}
function existingIdentity(db, item, locator) {
  const targets = db.prepare("SELECT * FROM targets WHERE type='account' AND locator=? LIMIT 3").all(locator)
    .filter(target => (targetValues(target).platform ?? 'douyin') === item.platform);
  if (targets.length !== 1) return null;
  if (item.platform === 'douyin' && item.accountIds.length) {
    // Legacy metadata was editable through generic account APIs. It must not
    // serve as an authority for a submitted handle -> canonical-ID pairing.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_success_receipts'").get()) return null;
    const receipts = db.prepare(`SELECT * FROM author_resolution_success_receipts
      WHERE target_id=? AND canonical_account_id=? AND platform=? ORDER BY id DESC LIMIT 101`).all(targets[0].id, locator, item.platform);
    if (receipts.length > 100 || !receipts.some(saved => {
      const proof = validatedSuccessProof(saved);
      return proof && accountId(proof.resolution.publicDouyinId) === accountId(item.accountIds[0]);
    })) return null;
  }
  return targets[0];
}

export { validatedSuccessProof };
export async function prepareMasterRosterSupplement(db, { workbookSha256, entryKey, evidence, correctedAccountId } = {}) {
  const original = readMasterRosterEntry(db, { workbookSha256, entryKey });
  const { item } = original;
  if (conflict(item)) fail(409, '原始资料存在身份冲突，不能用补充链接覆盖；请先核对原账号 ID 与作品发布者');
  if (!['douyin', 'bilibili', 'xiaohongshu'].includes(item.platform)) fail(400, '该平台暂不支持此补充核验入口');
  const safeEvidence = evidenceInput(evidence, item.platform);
  let correction = null;
  if (correctedAccountId !== undefined) {
    // Do not let URL canonicalisation hide credentials, ports or an escaped
    // authority in an explicit correction request.
    const rawEvidence = typeof evidence === 'string' ? evidence.trim() : '';
    if (!/^https:\/\//i.test(rawEvidence)
      || rawEvidence.match(/^https:\/\/([^/?#]*)/i)?.[1]?.toLowerCase() !== new URL(safeEvidence).hostname.toLowerCase()) {
      fail(400, '更正身份必须提供规范的官方 HTTPS 作品链接');
    }
    correction = { originalAccountId: item.accountIds[0], correctedAccountId: publicId(correctedAccountId) };
    if (!validCorrection(correction, item)) fail(400, '仅可为尚未定位且无身份冲突的抖音原始资料，明确更正为不同的有效抖音号');
    const binding = original.supplementState?.binding;
    const exactReplay = binding && sameCorrection(binding.correction, correction) && binding.evidence === safeEvidence;
    if (!exactReplay && (binding || readMasterRoster(db)?.items.find(value => value.key === item.key)?.targetId)) {
      fail(409, '该资料已经关联账号，不能通过更正入口更换身份');
    }
  }
  if (original.supplementState?.bindingConflict) fail(409, '该条资料已有互相冲突的补充结果，请先核对，不能继续自动绑定');
  if (original.supplementState?.binding && original.supplementState.binding.evidence !== safeEvidence) fail(409, '该条资料已有成功补充绑定；不能通过另一条线索静默更换账号');
  const incomingLocator = canonical(safeEvidence, item.platform);
  const originalLocator = canonical(item.locators[0] || '', item.platform);
  if (incomingLocator && originalLocator && incomingLocator !== originalLocator) fail(409, '补充主页与原表账号定位不一致，未更换原账号');
  if (item.platform !== 'douyin' && incomingLocator && item.accountIds.length) {
    const expected = canonical(item.accountIds[0], item.platform);
    if (expected && expected !== incomingLocator) fail(409, '补充账号 ID 与原表不一致，未更换原账号');
  }
  const locator = incomingLocator || originalLocator;
  const isDirect = Boolean(incomingLocator);
  const isContentId = item.platform === 'douyin' ? /^\d{15,25}$/.test(safeEvidence) : /^BV[0-9A-Za-z]{10}$/.test(safeEvidence);
  const submittedId = correction?.correctedAccountId || item.accountIds[0] || '';
  const headings = ['作者', '平台', '抖音号', 'B站UID', '小红书ID', '主页链接', '作品ID', '视频链接'];
  const values = [item.name, item.platform, item.platform === 'douyin' ? submittedId : '', item.platform === 'bilibili' ? submittedId : '',
    item.platform === 'xiaohongshu' ? submittedId : '', locator, !isDirect && isContentId ? safeEvidence : '', !isDirect && /^https:/.test(safeEvidence) ? safeEvidence : ''];
  const csv = [headings, values].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const fileName = `总表补充-${hash([workbookSha256, entryKey]).slice(0, 12)}.csv`;
  const parsed = await parseAuthorSpreadsheet({ fileName, buffer: Buffer.from(csv) });
  if (parsed.rows.length !== 1) fail(400, '补充资料没有形成唯一作者行');
  const row = parsed.rows[0];
  const boards = supplementBoards(item.boards);
  row.boards = boards; row.board = boards[0]?.name || '';
  row.organization = boards[0]?.organization || ''; row.category = boards[0]?.category || ''; row.tier = boards[0]?.tier || '';
  let canSubmit = ['ready', 'resolvable', 'existing'].includes(row.status);
  let reason = row.reason;
  if (row.status === 'identity_conflict') fail(409, '补充资料与原表身份锚点冲突，未自动更换');
  if (isDirect && item.platform === 'douyin' && submittedId && !existingIdentity(db, item, locator)) {
    canSubmit = false; reason = '原表有抖音号；仅补主页不能证明是同一作者。请提供该账号的一条公开视频或分享链接，用发布者身份核验。';
  }
  if (!isDirect && !isContentId && !/^https:/.test(safeEvidence)) {
    canSubmit = false; reason = '抖音号或昵称不能作为唯一主页定位；请补一条官方主页、公开视频或分享链接。';
  }
  const rows = [row];
  const masterRosterSupplement = { version: correction ? 2 : 1, purpose: PURPOSE, workbookSha256, entryKey, entryPayloadSha256: original.entryPayloadSha256,
    platform: item.platform, evidence: safeEvidence, requestSha256: masterRosterSupplementRequestSha256(rows), ...(correction ? { correction } : {}) };
  if (correction && (isDirect || !preparedCorrectionInput({ rows, masterRosterSupplement }))) {
    fail(400, '更正抖音号必须同时提供唯一的官方公开视频或分享链接，不能仅填写主页或账号 ID');
  }
  if (correction) assertUnusedCorrectionEvidence(db, { rows, masterRosterSupplement }, {
    completedReplay: sameCorrection(original.supplementState?.binding?.correction, correction)
      && original.supplementState.binding.evidence === safeEvidence,
  });
  if (!correction && item.platform === 'douyin' && submittedId && !publicId(submittedId)) {
    canSubmit = false; reason = '原表抖音号格式无效。请明确更正抖音号并提供该账号的作品链接；只补链接无法核验。';
  }
  const previewSha256 = hash(masterRosterSupplement);
  return { rows, fileName, sheetName: parsed.selectedSheet, boardCatalog: boards.map(board => ({ name: board.name })), uploadSha256: previewSha256,
    masterRosterSupplement, preview: { previewSha256, entry: { key: item.key, name: item.name, platform: item.platform, theme: item.theme,
      classifications: item.classifications, sourceTitles: item.sourceTitles, reviewReasons: item.reviewReasons }, evidence: safeEvidence,
    review: { status: canSubmit ? row.status : 'needs_locator', reason, canSubmit },
    ...(correction ? { correction, requiresCorrectionConfirmation: true } : {}) } };
}

function validContext(context, item, snapshot, request) {
  const keys = context?.version === 2 ? [...contextKeys, 'correction'] : contextKeys;
  return context && typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length === keys.length
    && Object.keys(context).every(key => keys.includes(key)) && [1, 2].includes(context.version) && context.purpose === PURPOSE
    && context.workbookSha256 === snapshot.workbook.sha256 && context.entryKey === item.key && context.platform === item.platform
    && context.entryPayloadSha256 === hash(item) && !item.targetId && !conflict(item)
    && typeof context.evidence === 'string' && context.evidence.length > 0 && context.evidence.length <= 1_000
    && request.fileName === `总表补充-${hash([context.workbookSha256, context.entryKey]).slice(0, 12)}.csv` && request.sheetName === 'CSV'
    && context.requestSha256 === masterRosterSupplementRequestSha256(request) && context.requestSha256 !== ''
    && (item.platform !== 'douyin' || accountId(request.rows?.[0]?.douyinId) === accountId(expectedAccountId(item, context)))
    && (context.version !== 2 || validCorrection(context.correction, item) && preparedCorrectionInput(request));
}

/** Recheck before a worker mutates accounts; generic APIs must never accept this context from clients. */
export function assertMasterRosterSupplementJob(db, job) {
  const context = job?.request?.masterRosterSupplement;
  if (!context) fail(409, '缺少专用总表补充凭证');
  const original = readMasterRosterEntry(db, context);
  if (!validContext(context, original.item, { workbook: { sha256: original.workbookSha256 } }, job.request)) fail(409, '总表补充凭证与原始条目或作者资料不一致');
  if (original.supplementState?.bindingConflict) fail(409, '总表补充出现身份冲突，未继续创建账号');
  const existingBinding = original.supplementState?.binding;
  const sameCompletedJob = existingBinding?.jobId === job.id && sameCorrection(existingBinding.correction, context.correction)
    && existingBinding.evidence === context.evidence;
  if (context.version === 2 && !sameCompletedJob && (existingBinding
    || readMasterRoster(db)?.items.find(value => value.key === original.item.key)?.targetId)) {
    fail(409, '该资料已在核验期间关联账号，未以更正覆盖现有身份');
  }
  if (context.version === 2) assertUnusedCorrectionEvidence(db, job.request, { completedReplay: sameCompletedJob });
  if (original.supplementState?.binding && original.supplementState.binding.evidence !== context.evidence) fail(409, '总表条目已绑定其他补充线索，未创建或更换账号');
  return original;
}

/** Only the worker calls this after its strict resolver and import have succeeded. No network or writes. */
export function buildMasterRosterSupplementReceipt(db, job, resolvedRows, result) {
  let original; try { original = assertMasterRosterSupplementJob(db, job); } catch { return null; }
  // Explicit corrections require an immutable source-bound natural work receipt,
  // read below. Editable/legacy job result summaries can never prove a new ID.
  if (job.request.masterRosterSupplement.version === 2) return null;
  if (!Array.isArray(resolvedRows) || resolvedRows.length !== 1 || result?.ok !== true || Number(result.identityConflictCount || 0) > 0) return null;
  const row = resolvedRows[0], request = job.request.rows[0], context = job.request.masterRosterSupplement, item = original.item;
  if (!['ready', 'existing'].includes(row.status) || row.platform !== item.platform) return null;
  const locator = canonical(row.locator, item.platform);
  if (!locator || (item.locators.length && !item.locators.includes(locator)) || (request.locator && request.locator !== locator)) return null;
  const targets = db.prepare("SELECT * FROM targets WHERE type='account' AND locator=? LIMIT 3").all(locator)
    .filter(target => (targetValues(target).platform ?? 'douyin') === item.platform);
  if (targets.length !== 1) return null;
  const target = targets[0];
  const succeeded = (result.created || []).some(value => value.id === target.id && value.locator === locator)
    || (result.skipped || []).some(value => value.status === 'existing' && value.locator === locator && (value.platform ?? item.platform) === item.platform);
  if (!succeeded) return null;
  const hasWork = Boolean(request.videoId || request.shareUrl);
  let proofType = 'user-supplied-canonical-profile', verifiedAt = null;
  if (hasWork) {
    const resolution = row.resolution;
    if (resolution?.mode !== 'public-video-detail' || resolution?.platform !== item.platform || resolution.canonicalAccountId !== locator
      || !Number.isFinite(Date.parse(resolution.resolvedAt)) || Date.parse(resolution.resolvedAt) > Date.now() + 1_000
      || (request.videoId && resolution.evidenceVideoId !== request.videoId)
      || (request.shareUrl && !sameWorkLink(request.shareUrl, resolution.sourceEvidenceUrl))
      || (item.platform === 'douyin' && item.accountIds.length && accountId(resolution.publicDouyinId) !== accountId(item.accountIds[0]))) return null;
    proofType = 'strict-public-work-evidence'; verifiedAt = resolution.resolvedAt;
  } else if (item.platform === 'douyin' && item.accountIds.length && !existingIdentity(db, item, locator)) return null;
  if (original.supplementState?.binding && original.supplementState.binding.targetId !== target.id) return null;
  return { version: 1, jobId: job.id, workbookSha256: context.workbookSha256, entryKey: context.entryKey,
    entryPayloadSha256: context.entryPayloadSha256, requestSha256: context.requestSha256,
    targetId: target.id, platform: item.platform, locator, proofType, verifiedAt };
}

function boardProof(boards) {
  return hash((boards || []).map(board => Object.fromEntries(['name', 'organization', 'tier', 'category', 'owner', 'filledDate', 'note']
    .map(key => [key, clean(board[key])]))));
}

// A correction is not a nickname guess or a legacy import-result assertion.
// Revalidate the stored public projection against this exact completed source.
function correctionNaturalProof(proof, job, request) {
  try {
    const context = request.masterRosterSupplement, natural = proof.resolution.authorisedDetailReceipt;
    const source = natural?.source, original = request.rows[0], input = preparedCorrectionInput(request);
    if (!input || natural.format !== 'mcn-authorised-detail-admission-v1' || natural.scope !== 'one-queue-all-submitted-work-evidence'
      || natural.identityOnly !== true || natural.metricsSampled !== false || natural.allAccountWorksCollected !== false
      || source?.jobId !== job.id || source.fileName !== request.fileName || source.sheetName !== request.sheetName
      || source.sourceRow !== original.sourceRow || source.sourceRowSha256 !== hash(original) || source.evidenceRequestKey !== input.key
      || input.key !== proof.identityKey || input.submittedId !== context.correction.correctedAccountId
      || accountId(proof.evidence.douyinId) !== input.submittedId || accountId(proof.resolution.publicDouyinId) !== input.submittedId
      || natural.queue?.id !== proof.queueId || natural.queue.identityKey !== input.key || natural.queue.evidenceVersion !== proof.evidenceVersion
      || natural.queue.verificationPolicyVersion !== 2 || hash(natural.queue.videoIds) !== hash(proof.evidence.videoIds)
      || hash(natural.queue.shareUrls) !== hash(proof.evidence.shareUrls) || !natural.queue.sourceRows?.includes(source.sourceRow)
      || natural.observedAt !== proof.verifiedAt || ![job.created_at, job.finished_at, natural.requestStartedAt, natural.requestFinishedAt, proof.committedAt]
        .every(value => Number.isFinite(Date.parse(value)))
      || Date.parse(job.created_at) > Date.parse(job.finished_at) || Date.parse(job.finished_at) > Date.parse(natural.requestStartedAt)
      || Date.parse(natural.requestFinishedAt) > Date.parse(proof.committedAt)) return false;
    const evidence = natural.evidence, author = evidence.response.aweme_detail.author, videoId = evidence.response.aweme_detail.aweme_id;
    const result = validateAuthorisedDetailResult(input, {
      status: 'ok', key: input.key, submittedId: input.submittedId, ...(input.shareUrl ? { shareUrl: input.shareUrl, videoId } : { videoId: input.videoId }),
      requestStartedAt: natural.requestStartedAt, requestFinishedAt: natural.requestFinishedAt,
      candidate: { videoId, secUid: author.sec_uid, uid: author.uid, uniqueId: author.unique_id ?? '', shortId: author.short_id ?? '',
        provenance: natural.provenance.mode, observedAt: natural.observedAt, responseSha256: natural.responseSha256,
        responseSha256Scope: natural.responseSha256Scope }, evidence, provenance: natural.provenance,
    }, { startedAt: natural.requestStartedAt, finishedAt: natural.requestFinishedAt });
    return result.status === 'ok' && result.candidate.secUid === proof.canonicalAccountId;
  } catch { return false; }
}

/** The queued worker cannot edit its parent job. Read the strict successful
 * queue plus immutable import receipt instead; never infer identity from a
 * name, a resolved_target_id, or a subsequently added locator alone. */
function queuedSupplementBinding(db, job, request, result, item, targets) {
  const failReview = (reason, status = 'review-required') => ({ status, reason });
  const sourceRow = request.rows[0];
  if (!sourceRow.videoId && !sourceRow.shareUrl) return null;
  const keys = [...new Set([...(result?.queue?.pendingEvidenceRequestKeys || []), ...(result?.queue?.resolvedEvidenceRequestKeys || [])])];
  if (keys.length !== 1 || typeof keys[0] !== 'string') return null; // This endpoint is deliberately single-author/single-evidence.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_queue'").get()
    || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_import_sources'").get()) return null;
  const queue = db.prepare('SELECT * FROM author_resolution_queue WHERE identity_key=?').get(keys[0]);
  // If the foreground worker hydrated an already-known canonical ID, the
  // resulting skipped row is its durable record. Do not accept arbitrary keys.
  const skipped = (result.skipped || []).filter(row => ['unresolved', 'evidence_reused'].includes(row.status)
    && row.evidenceRequestKeys?.includes(keys[0]));
  const originalRequests = buildAuthorEvidenceRequests([sourceRow]);
  const evidenceRequest = originalRequests.find(value => value.key === keys[0]) || skipped.flatMap(row => {
    const withoutHydration = { ...row, locator: sourceRow.locator, boards: sourceRow.boards };
    if (masterRosterSupplementRequestSha256([withoutHydration]) !== masterRosterSupplementRequestSha256([sourceRow])) return [];
    return buildAuthorEvidenceRequests([row]);
  }).find(value => value.key === keys[0]);
  if (!evidenceRequest) return failReview('队列证据与本次补充内容不一致，未绑定账号');
  const sameList = (stored, expected, compare = (a, b) => a === b) => Array.isArray(stored) && stored.length === expected.length
    && expected.every(value => stored.some(saved => compare(saved, value)));
  const hasSuccessReceipts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_success_receipts'").get();
  const successes = hasSuccessReceipts ? db.prepare(`SELECT * FROM author_resolution_success_receipts
    WHERE identity_key=? ORDER BY id ASC LIMIT 21`).all(keys[0]) : [];
  if (successes.length > 20) return failReview('该资料的历史成功凭据超过单次校验上限，请单独审查');
  const bindings = [];
  for (const saved of successes) {
    const proof = validatedSuccessProof(saved), evidence = proof?.evidence, resolution = proof?.resolution;
    // The strict Douyin resolver uses a submitted ID instead of nickname when
    // that ID is present. A later source may legitimately use a renamed author;
    // require the original roster, request and immutable proof to agree on the
    // same public ID before allowing that name-only difference. Nickname-only
    // evidence retains its original equality constraint.
    const submittedId = item.platform === 'douyin' && item.accountIds.length === 1 ? accountId(expectedAccountId(item, request.masterRosterSupplement)) : '';
    const sameSubmittedIdentity = Boolean(submittedId && accountId(sourceRow.douyinId) === submittedId
      && accountId(evidenceRequest.douyinId) === submittedId && accountId(evidence?.douyinId) === submittedId
      && accountId(resolution?.publicDouyinId) === submittedId);
    if (!proof || saved.receipt_sha256 !== hash(proof) || proof.format !== 'mcn-author-resolution-success-v1'
      || proof.queueId !== saved.queue_id || proof.evidenceVersion !== saved.evidence_version || proof.identityKey !== keys[0]
      || proof.targetId !== saved.target_id || proof.platform !== item.platform || saved.platform !== item.platform
      || proof.canonicalAccountId !== saved.canonical_account_id || proof.verifiedAt !== saved.verified_at
      || proof.verificationPolicyVersion !== 2 || !Number.isFinite(Date.parse(proof.committedAt))
      || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > Date.parse(proof.committedAt) + 1_000
      || !evidence || accountId(evidence.douyinId) !== accountId(evidenceRequest.douyinId)
      || (!sameSubmittedIdentity && clean(evidence.name, 120) !== clean(evidenceRequest.name, 120))
      || (evidenceRequest.accountLocator && evidence.accountLocator !== evidenceRequest.accountLocator)
      || !Array.isArray(evidence.videoIds) || !Array.isArray(evidence.shareUrls)
      || !evidenceRequest.videoIds.every(id => evidence.videoIds.includes(id))
      || !evidenceRequest.shareUrls.every(url => evidence.shareUrls.some(savedUrl => sameWorkLink(savedUrl, url)))) continue;
    const target = targets.get(proof.targetId), locator = target?.locator;
    if (!target || (targetValues(target).platform ?? 'douyin') !== item.platform || locator !== proof.canonicalAccountId || !canonical(locator, item.platform)
      || (sourceRow.locator && sourceRow.locator !== locator) || (item.locators.length && !item.locators.includes(locator))
      || resolution?.mode !== 'public-video-detail' || resolution.platform !== item.platform || resolution.canonicalAccountId !== locator
      || resolution.verificationPolicy !== 'all-submitted-evidence-v2' || resolution.verifiedEvidenceTruncated
      || resolution.resolvedAt !== proof.verifiedAt
      || (item.platform === 'douyin' && item.accountIds.length && accountId(resolution.publicDouyinId) !== submittedId)
      || (item.platform === 'bilibili' && item.accountIds.length && locator !== canonical(item.accountIds[0], item.platform))) continue;
    if (request.masterRosterSupplement.version === 2 && !correctionNaturalProof(proof, job, request)) continue;
    const verified = resolution.verifiedEvidence;
    if (!Array.isArray(verified) || verified.length !== resolution.verifiedEvidenceCount || verified.length !== evidence.videoIds.length + evidence.shareUrls.length
      || resolution.verifiedEvidenceSha256 !== hash(verified) || verified.some(value => value.canonicalAccountId !== locator)
      || !evidence.videoIds.every(videoId => verified.some(value => value.videoId === videoId))
      || !evidence.shareUrls.every(shareUrl => verified.some(value => sameWorkLink(value.shareUrl, shareUrl) && sameWorkLink(value.sourceEvidenceUrl, shareUrl)))) continue;
    const receipts = db.prepare(`SELECT receipt_sha256,observed_at,payload_json FROM author_resolution_import_sources
      WHERE (queue_id=? OR queue_id IS NULL) AND queue_identity_key=?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.fileName') END=?
      ORDER BY id DESC LIMIT 21`).all(saved.queue_id, keys[0], request.fileName);
    if (receipts.length > 20) continue;
    const receipt = receipts.find(savedSource => {
      const value = parse(savedSource.payload_json);
      return value && savedSource.receipt_sha256 === hash(value) && value.fileName === request.fileName && value.sheetName === request.sheetName
        && value.sourceMetadata?.sourceType === 'author-spreadsheet' && Number.isFinite(Date.parse(savedSource.observed_at))
        && (request.masterRosterSupplement.version !== 2 || Date.parse(savedSource.observed_at) >= Date.parse(job.created_at)
          && Date.parse(savedSource.observed_at) <= Date.parse(job.finished_at))
        && sameList(value.sourceRows, evidenceRequest.sourceRows) && boardProof(value.boards) === boardProof(evidenceRequest.boards);
    });
    if (!receipt) continue;
    bindings.push({ version: request.masterRosterSupplement.version, jobId: job.id, workbookSha256: request.masterRosterSupplement.workbookSha256, entryKey: item.key,
      entryPayloadSha256: request.masterRosterSupplement.entryPayloadSha256, requestSha256: request.masterRosterSupplement.requestSha256,
      targetId: target.id, platform: item.platform, locator, proofType: 'strict-queue-work-evidence', verifiedAt: resolution.resolvedAt,
      sourceQueueId: saved.queue_id, sourceReceiptSha256: receipt.receipt_sha256, successReceiptSha256: saved.receipt_sha256,
      evidence: request.masterRosterSupplement.evidence, submittedAt: job.created_at,
      ...(request.masterRosterSupplement.version === 2 ? { correction: request.masterRosterSupplement.correction } : {}) });
  }
  if (bindings.length) return { bindings };
  if (!queue) return failReview('补充作品队列记录或持久成功凭据不可用，未绑定账号');
  if (queue.status === 'rejected') return failReview(/不一致|冲突|不符|不同作者/.test(String(queue.last_error || ''))
    ? '补充作品发布者与原账号信息不一致，请核对并换一条作品后重试；原资料未改动'
    : '补充作品核验已终止或未通过，请更换可用作品后重试；原资料未改动');
  if (['pending', 'retry'].includes(queue.status)) return failReview('作品证据仍在后台核验，未绑定账号；不等于已采到数据', 'awaiting-verification');
  return failReview('尚缺与本次补充一致的持久严格成功凭据，未绑定账号');
}

/** Read model overlay only: the workbook rows and their checksum remain immutable. */
export function readMasterRosterSupplementStates(db, snapshot, targets) {
  const output = new Map();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='author_resolution_jobs'").get()) return output;
  // This is a bounded scan of jobs for this workbook, not the large source-receipt or snapshot tables.
  const jobs = db.prepare(`SELECT id,status,request_json,result_json,created_at,finished_at FROM author_resolution_jobs
    WHERE CASE WHEN json_valid(request_json) THEN json_extract(request_json,'$.masterRosterSupplement.workbookSha256') END=?
    ORDER BY created_at DESC,id DESC LIMIT ?`).all(snapshot.workbook.sha256, MAX_JOBS + 1);
  if (jobs.length > MAX_JOBS) return output; // Never let a truncated subset decide identity.
  const items = new Map(snapshot.items.map(item => [item.key, item]));
  const validBindings = new Map();
  for (const job of jobs) {
    const request = parse(job.request_json), context = request?.masterRosterSupplement, item = items.get(context?.entryKey);
    if (!item || !validContext(context, item, snapshot, request)) continue;
    const result = parse(job.result_json);
    if (!output.has(item.key)) {
      const status = job.status === 'completed' ? (Number(result?.queuedEvidenceRequestCount || 0) > 0 ? 'awaiting-verification' : 'review-required') : job.status;
      const reasons = { queued: '补充资料已保存，等待核验', running: '正在核验补充资料', failed: '补充任务未完成，请查看导入记录',
        'awaiting-verification': '作品证据仍在核验，尚未绑定；不等于已采到数据', 'review-required': '尚未形成成功绑定，请核对补充资料或查看导入记录' };
      output.set(item.key, { supplement: { jobId: job.id, status, submittedAt: job.created_at, reason: reasons[status] || '尚未完成补充核验' },
        ...(context.version === 2 ? { identityCorrection: { ...context.correction, status: 'pending' } } : {}) });
    }
    if (job.status === 'completed' && result?.ok === true) {
      const queued = queuedSupplementBinding(db, job, request, result, item, targets);
      if (queued?.bindings?.length) {
        const list = validBindings.get(item.key) || []; list.push(...queued.bindings); validBindings.set(item.key, list);
      } else if (queued && output.get(item.key).supplement.jobId === job.id) {
        output.get(item.key).supplement = { ...output.get(item.key).supplement, status: queued.status, reason: queued.reason };
      }
    }
    if (context.version === 2) continue; // A mutable job-result receipt is never correction proof.
    const receipt = result?.masterRosterSupplementReceipt;
    if (job.status !== 'completed' || result?.ok !== true || !receipt || receipt.version !== 1 || receipt.jobId !== job.id
      || !['user-supplied-canonical-profile', 'strict-public-work-evidence'].includes(receipt.proofType)
      || !['workbookSha256', 'entryKey', 'entryPayloadSha256', 'requestSha256', 'platform'].every(key => receipt[key] === context[key])) continue;
    const target = targets.get(receipt.targetId);
    if (!target || target.locator !== receipt.locator || (targetValues(target).platform ?? 'douyin') !== item.platform
      || !canonical(receipt.locator, item.platform) || (item.locators.length && !item.locators.includes(receipt.locator))
      || (request.rows[0].locator && request.rows[0].locator !== receipt.locator)) continue;
    const hasWork = Boolean(request.rows[0].videoId || request.rows[0].shareUrl);
    if (hasWork && (receipt.proofType !== 'strict-public-work-evidence' || !Number.isFinite(Date.parse(receipt.verifiedAt)))) continue;
    if (!hasWork && item.platform === 'douyin' && item.accountIds.length && !existingIdentity(db, item, receipt.locator)) continue;
    const list = validBindings.get(item.key) || [];
    list.push({ ...receipt, evidence: context.evidence, submittedAt: job.created_at }); validBindings.set(item.key, list);
  }
  for (const [key, bindings] of validBindings) {
    if (new Set(bindings.map(value => value.targetId)).size !== 1
      || new Set(bindings.map(value => hash(value.correction || null))).size !== 1) {
      output.set(key, { bindingConflict: true, supplement: { ...output.get(key).supplement, status: 'conflict', reason: '多次补充指向不同账号，已停止自动绑定；原始资料未改动' } }); continue;
    }
    const binding = bindings[0];
    output.set(key, { binding, supplement: { jobId: binding.jobId, status: 'linked', submittedAt: binding.submittedAt,
      proofType: binding.proofType, ...(binding.sourceQueueId ? { sourceQueueId: binding.sourceQueueId, verifiedAt: binding.verifiedAt } : {}),
      reason: binding.proofType.startsWith('strict-') ? '补充作品已核验并建档；采样结果另见账号详情' : '用户补充主页已建档；非平台身份核验，采样结果另见账号详情' },
      ...(binding.correction ? { identityCorrection: { ...binding.correction, status: 'verified' } } : {}) });
  }
  return output;
}
