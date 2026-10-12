import { createHash } from 'node:crypto';
import { prepareImportAuthorisedDetail } from './import-authorised-detail.mjs';
import { validateAuthorisedDetailResult } from './douyin-authorised-detail.mjs';

const ACTION = 'author-resolution.authorised-attempt';
const RESOURCE = 'author-resolution-job';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const messages = Object.freeze({
  identity_mismatch: '未取得与提交抖音号一致的作品作者证据；请核对账号与原作品，不能仅凭昵称绑定',
  invalid_evidence: '原作品未返回完整可核验的作者资料；可补充该账号另一条有效作品链接',
  navigation_error: '原作品链接未能进入可核验的作品页；请核对或补充有效链接',
  no_bound_response: '作品页未返回与原作品绑定的作者资料；本次未接入',
  timeout: '本次作品核验超时；尚未取得可验证的作者资料',
  session_required: '需先登录产品采集会话；未自动绕过登录',
  session_permissions: '采集会话文件权限异常；本次未核验',
  session_invalid: '采集会话不可用；需重新登录采集会话',
  login_required: '平台要求登录；本次未核验',
  challenge_required: '平台要求人工验证；未自动处理验证码',
  rate_limited: '平台限制请求频率；已停止本批核验',
  blocked: '平台暂不允许读取该作品；未绕过访问限制',
  cleanup_uncertain: '采集进程未完成安全清理；已停止本批核验',
  cancelled: '本次核验已取消，没有作为成功接入',
  collector_error: '采集过程未完成，本次未接入',
  business_error: '平台未返回可用作品资料；不能据此认定账号不存在',
  disabled: '当前作品核验通道未启用',
  ownership_required: '当前采集进程未通过归属检查',
  browser_unavailable: '产品采集浏览器暂不可用',
  invalid_input: '原行作品或账号信息未通过格式检查',
});

export function authorisedAttemptReason(code, diagnostic) {
  if (code === 'identity_mismatch' && diagnostic?.reason === 'public_id_absent') return '作品作者未公开可匹配的抖音号；不能按昵称猜测归属';
  if (code === 'identity_mismatch' && diagnostic?.reason === 'submitted_id_mismatch') return '作品发布者公开抖音号与本行填写不一致；请核对原表账号或作品链接';
  if (code === 'invalid_evidence' && diagnostic?.reason === 'detail_invalid_shape') return '平台返回的作品详情不完整，无法核验作者；不代表账号已删除或私密';
  return messages[code] || '本次作品核验未完成；未标记为成功接入';
}

/** Restricted, append-only operational evidence. Never an identity proof. */
export function recordImportAuthorisedAttempt(db, job, { sourceRow, result, startedAt, finishedAt,
  recordedAt = new Date().toISOString(), recordingMode = 'live' } = {}) {
  if (!['live', 'retained-local-response'].includes(recordingMode)) throw new TypeError('Invalid attempt origin');
  const input = prepareImportAuthorisedDetail(job, { sourceRow });
  const validated = validateAuthorisedDetailResult(input, result, { startedAt, finishedAt });
  if (validated.status !== 'unavailable') return false; // Success has its own immutable receipt.
  const recorded = Date.parse(recordedAt), end = Date.parse(finishedAt);
  if (!Number.isFinite(recorded) || recorded < end || recorded > Date.now() + 1000) throw new TypeError('Invalid attempt time');
  const original = job.request.rows.find(row => row.sourceRow === sourceRow);
  const stored = db.prepare('SELECT status,request_json,created_at,finished_at FROM author_resolution_jobs WHERE id=?').get(job.id);
  const created = Date.parse(stored?.created_at), completed = Date.parse(stored?.finished_at);
  if (stored?.status !== 'completed' || stored.request_json !== JSON.stringify(job.request)
    || !Number.isFinite(created) || !Number.isFinite(completed) || completed < created
    || Date.parse(validated.requestStartedAt) < completed) throw new TypeError('Stale attempt source');
  const payload = { version: 1, jobId: job.id, sourceRow, sourceRowSha256: hash(original), requestSha256: hash(job.request),
    key: input.key, submittedId: input.submittedId, status: 'unavailable', errorCode: validated.errorCode,
    startedAt: validated.requestStartedAt, finishedAt: validated.requestFinishedAt,
    ...(validated.diagnostic ? { diagnostic: validated.diagnostic } : {}), recordingMode };
  const checksum = hash(payload);
  // Replaying a retained response must not flood the log or invent a fresh attempt.
  const existing = db.prepare(`SELECT 1 FROM activity_log WHERE resource_type=? AND resource_id=? AND action=?
    AND json_valid(details_json) AND json_extract(details_json,'$.sha256')=? LIMIT 1`).get(RESOURCE, job.id, ACTION, checksum);
  if (existing) return false;
  db.prepare(`INSERT INTO activity_log(actor_name,action,resource_type,resource_id,created_at,details_json)
    VALUES('系统',?,?,?,?,?)`).run(ACTION, RESOURCE, job.id, recordedAt, JSON.stringify({ payload, sha256: checksum }));
  return true;
}

/** Source-bound read; bounded log size, no provider errors or arbitrary text. */
export function readImportAuthorisedAttempts(db, job, { now = new Date() } = {}) {
  const result = new Map();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_log'").get()) return result;
  const entries = db.prepare(`SELECT created_at,details_json FROM activity_log WHERE resource_type=? AND resource_id=? AND action=?
    AND length(details_json)<=8192 ORDER BY created_at DESC,id DESC LIMIT 2001`).all(RESOURCE, job.id, ACTION);
  if (entries.length > 2000) return result; // Do not select a possibly incomplete history.
  if (!entries.length) return result;
  const stored = db.prepare('SELECT status,request_json,created_at,finished_at FROM author_resolution_jobs WHERE id=?').get(job.id);
  const created = Date.parse(stored?.created_at), completed = Date.parse(stored?.finished_at);
  if (stored?.status !== 'completed' || stored.request_json !== JSON.stringify(job.request)
    || !Number.isFinite(created) || !Number.isFinite(completed) || completed < created) return result;
  const requestHash = hash(job.request), nowMs = now.getTime();
  const rows = new Map();
  for (const row of job.request?.rows || []) rows.set(row.sourceRow, rows.has(row.sourceRow) ? null : row);
  for (const entry of entries) {
    const saved = parse(entry.details_json), p = saved?.payload, source = rows.get(p?.sourceRow);
    if (!p || saved.sha256 !== hash(p) || p.version !== 1 || p.jobId !== job.id || p.requestSha256 !== requestHash
      || !source || p.sourceRowSha256 !== hash(source) || p.status !== 'unavailable'
      || !Object.hasOwn(messages, p.errorCode) || !['live', 'retained-local-response'].includes(p.recordingMode)) continue;
    let input;
    try { input = prepareImportAuthorisedDetail(job, { sourceRow: p.sourceRow }); } catch { continue; }
    if (p.key !== input.key || p.submittedId !== input.submittedId) continue;
    const start = Date.parse(p.startedAt), end = Date.parse(p.finishedAt), recorded = Date.parse(entry.created_at);
    if (![start, end, recorded].every(Number.isFinite) || start < completed || end < start || end - start > 45000 || recorded < end || recorded > nowMs) continue;
    // Reuse the parent diagnostic whitelist, not whatever a log field claims.
    let validated;
    try { validated = validateAuthorisedDetailResult(input, { ...input, status: 'unavailable', errorCode: p.errorCode,
      diagnostic: p.diagnostic, requestStartedAt: p.startedAt, requestFinishedAt: p.finishedAt }, { startedAt: p.startedAt, finishedAt: p.finishedAt }); }
    catch { continue; }
    const prior = result.get(p.sourceRow);
    if (prior && Date.parse(prior.finishedAt) >= end) continue;
    result.set(p.sourceRow, { status: 'unavailable', errorCode: p.errorCode, reason: authorisedAttemptReason(p.errorCode, validated.diagnostic),
      startedAt: p.startedAt, finishedAt: p.finishedAt, sourceRow: p.sourceRow, origin: 'authorised-work', recordedAt: entry.created_at });
  }
  return result;
}
