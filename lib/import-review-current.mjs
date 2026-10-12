import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { validatedSuccessProof } from './master-roster-supplement.mjs';
import { buildAuthorEvidenceRequests } from './author-resolution.mjs';
import { normalizeAccountLocator } from './author-spreadsheet.mjs';
import { authorQueuePlatform, queuedAuthorAccountLocator, queuedBilibiliId } from './author-queue-identity.mjs';

export const CURRENT_RESOLUTION_SCOPE = 'current-source-bound-evidence-resolution-not-account-monitoring';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const emptyCounts = () => ({ total: 0, linked: 0, pending: 0, retry: 0, processing: 0, rejected: 0, resolved: 0, unknown: 0 });
const state = (status, reason, extra = {}) => ({ status, reason, updatedAt: null, nextRetryAt: null, counts: emptyCounts(), ...extra });
const normalized = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const nickname = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function matchesSubmittedConstraints(row, queue, { checkName = true } = {}) {
  const platform = row.platform || 'douyin';
  if (platform !== authorQueuePlatform(queue)) return false;
  const locator = normalizeAccountLocator(row.locator || row.accountLocator || '', platform);
  const id = normalized(platform === 'bilibili' ? row.bilibiliId : row.douyinId);
  if (locator && locator !== queuedAuthorAccountLocator(queue)) return false;
  if (id && id !== normalized(platform === 'bilibili' ? queuedBilibiliId(queue) : queue.douyin_id)) return false;
  // A shared work key alone does not preserve a name-only ownership constraint.
  if (!locator && !id && checkName && nickname(row.name) && nickname(row.name) !== nickname(queue.name)) return false;
  const evidence = buildAuthorEvidenceRequests([row]);
  const videos = parse(queue.video_ids_json), shares = parse(queue.share_urls_json);
  return evidence.length === 1 && Array.isArray(videos) && Array.isArray(shares)
    && evidence[0].videoIds.every(value => videos.includes(value)) && evidence[0].shareUrls.every(value => shares.includes(value));
}

// Mirror the importer's source envelope, not mutable queue.source_metadata_json.
function sourceContext(request) {
  const result = { sourceType: ['lark-bitable', 'lark-sheet'].includes(request.sourceType) ? request.sourceType : 'author-spreadsheet' };
  for (const [key, limit] of Object.entries({ sourceUrl: 1000, sourceTitle: 200, sourceSheetId: 80, sourceRange: 80, sourceReadAt: 40 })) {
    if (request[key]) result[key] = String(request[key]).slice(0, limit);
  }
  if (request.sourceType === 'lark-bitable' || Number(request.sourceRevision) > 0) result.sourceRevision = Math.trunc(Number(request.sourceRevision));
  for (const key of ['sourceSha256', 'sourceExportSha256']) if (/^[a-f0-9]{64}$/i.test(String(request[key] ?? ''))) result[key] = request[key].toLowerCase();
  return result;
}

function verifiedSource(saved, queue, job, nowMs) {
  const source = parse(saved.payload_json), observed = Date.parse(saved.observed_at), finished = Date.parse(job.finishedAt);
  const request = job.request || {}, expected = sourceContext(request);
  const valid = source && saved.queue_id === queue.id && saved.queue_identity_key === queue.identity_key
    && saved.receipt_sha256 === hash(source) && Number.isFinite(observed) && observed <= nowMs
    && Number.isFinite(finished) && observed <= finished + 1000
    && source.fileName === basename(String(request.fileName ?? job.fileName ?? '未命名表格'))
    && source.sheetName === String(request.sheetName ?? job.sheetName ?? '').slice(0, 120)
    && Array.isArray(source.sourceRows)
    && source.sourceMetadata && Object.keys(source.sourceMetadata).length === Object.keys(expected).length
    && Object.keys(expected).every(key => source.sourceMetadata[key] === expected[key]);
  return valid ? { rows: new Set(source.sourceRows), records: new Set((Array.isArray(source.sourceRecords) ? source.sourceRecords : [])
    .map(record => JSON.stringify([record?.sourceRow, record?.sourceRecordId]))) } : null;
}

function safeFailure(message) {
  // Never echo arbitrary provider URLs, cookies, headers or credentials.
  const text = String(message || '');
  if (/403/.test(text)) return '公开接口返回 HTTP 403，当前证据核验未通过';
  if (/身份|作者.*不一致|发布者.*不一致|conflict/i.test(text)) return '提交的账号与作品发布者存在身份冲突，需要核对原始资料';
  if (/验证码|captcha/i.test(text)) return '平台要求验证码，未自动处理';
  if (/登录|login|blocked|access.?gate/i.test(text)) return '平台访问或登录受限，未完成证据核验';
  if (/timeout|timed.?out|超时/i.test(text)) return '公开数据请求超时，未完成证据核验';
  if (/network|fetch|网络|ECONN|ENOTFOUND/i.test(text)) return '网络请求失败，未完成证据核验';
  return '当前证据核验未通过；历史回执保留在左侧';
}

function queueState(db, queue, nowMs) {
  const updatedAt = iso(queue.updated_at);
  if (!updatedAt || Date.parse(updatedAt) > nowMs) return state('unknown', '当前核验记录时间无效，未标记为已通过');
  if (queue.lease_owner && Date.parse(queue.lease_until) > nowMs && ['pending', 'retry'].includes(queue.status)) {
    return state('processing', '后台正在核验这条证据', { updatedAt });
  }
  if (queue.status === 'pending') return state('pending', '等待后台核验；不代表已加入监控', { updatedAt });
  if (queue.status === 'retry') return state('retry', safeFailure(queue.last_error), { updatedAt, nextRetryAt: iso(queue.next_attempt_at) });
  if (queue.status === 'rejected') return state('rejected', safeFailure(queue.last_error), { updatedAt });
  if (queue.status !== 'resolved') return state('unknown', '未识别的当前核验状态', { updatedAt });
  const saved = db.prepare(`SELECT * FROM author_resolution_success_receipts WHERE queue_id=? AND evidence_version=? AND length(payload_json)<=524288`).get(queue.id, queue.evidence_version);
  const proof = saved && validatedSuccessProof(saved);
  const target = proof && db.prepare('SELECT id,type,provider,locator,metadata_json FROM targets WHERE id=?').get(queue.resolved_target_id);
  const metadata = target && parse(target.metadata_json);
  const videos = parse(queue.video_ids_json), shares = parse(queue.share_urls_json);
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every(value => b.includes(value));
  if (!proof || proof.identityKey !== queue.identity_key || proof.targetId !== queue.resolved_target_id
    || queue.verification_policy_version !== 2 || Date.parse(proof.verifiedAt) > nowMs
    || !same(proof.evidence.videoIds, videos) || !same(proof.evidence.shareUrls, shares)
    || proof.evidence.name !== queue.name || proof.evidence.douyinId !== queue.douyin_id || proof.evidence.accountLocator !== queue.account_locator
    || !target || target.type !== 'account' || target.provider !== 'public-web' || target.locator !== proof.canonicalAccountId
    || !metadata || typeof metadata !== 'object' || Array.isArray(metadata) || (metadata.platform ?? 'douyin') !== proof.platform) {
    return state('unknown', '旧队列曾记为成功，但缺少匹配当前证据版本的可信凭据，不能确认为已通过', { updatedAt });
  }
  return state('resolved', '当前证据身份核验已通过；账号是否启用、采样是否完整请查看账号详情', { updatedAt });
}

/** Page-only, source-bound and read-only. Historical result/counts remain immutable. */
export function enrichImportReviewCurrent(db, job, page, { now = new Date() } = {}) {
  const checkedAt = now.toISOString(), nowMs = now.getTime();
  const result = { ...page, checkedAt, currentResolutionScope: CURRENT_RESOLUTION_SCOPE };
  const unavailable = () => ({ ...result, items: page.items.map(row => ({ ...row, currentResolution: state('unavailable', '当前证据状态暂时不可读取；历史回执仍可查看') })) });
  if (page.items.length > 500) return unavailable();
  let active = false, bytes = 0, keysRead = 0;
  const cache = new Map();
  try {
    db.exec('SAVEPOINT import_review_current'); active = true;
    const getQueue = db.prepare(`SELECT id,identity_key,name,status,updated_at,next_attempt_at,last_error,lease_owner,lease_until,
      evidence_version,verification_policy_version,resolved_target_id,douyin_id,account_locator,
      CASE WHEN length(video_ids_json)+length(share_urls_json)<=524288 THEN video_ids_json END AS video_ids_json,
      CASE WHEN length(video_ids_json)+length(share_urls_json)<=524288 THEN share_urls_json END AS share_urls_json
      FROM author_resolution_queue WHERE identity_key=?`);
    const getSources = db.prepare(`SELECT queue_id,queue_identity_key,receipt_sha256,observed_at,payload_json
      FROM author_resolution_import_sources WHERE queue_identity_key=? AND length(payload_json)<=524288
      AND json_valid(payload_json) AND json_extract(payload_json,'$.fileName')=? AND json_extract(payload_json,'$.sheetName')=? ORDER BY id DESC LIMIT 51`);
    const context = job.request || {};
    const originalRows = new Map();
    for (const row of Array.isArray(context.rows) ? context.rows : []) {
      if (!row || !Number.isSafeInteger(row.sourceRow)) continue;
      const previous = originalRows.get(row.sourceRow);
      originalRows.set(row.sourceRow, previous === undefined ? row : null);
    }
    result.items = page.items.map(row => {
      let current;
      if (row.status === 'identity_conflict' || row.identityConflict) current = state('conflict', '原始行存在身份冲突，不按昵称或新队列结果自动替换');
      else {
        const keys = row.evidenceRequestKeys;
        if (!Array.isArray(keys) || !keys.length) current = state('unlinked', '这条历史行没有可绑定的证据请求，未按同名账号猜测当前状态');
        else if (keys.length > 20 || keys.some(key => typeof key !== 'string' || !key.length || key.length > 1000) || new Set(keys).size !== keys.length) {
          current = state('unknown', '证据请求数量或格式超出本页安全读取范围');
        } else {
          const states = keys.map(key => {
            if (!cache.has(key)) {
              if (++keysRead > 2000 || bytes > 8 * 1024 * 1024) return { linked: false, ...state('unknown', '本页证据读取达到安全上限，请缩小页数') };
              const queue = getQueue.get(key);
              const sources = []; let read = 0, exceeded = false;
              if (queue) {
                bytes += Buffer.byteLength(queue.video_ids_json || '') + Buffer.byteLength(queue.share_urls_json || '');
                exceeded = queue.video_ids_json === null || queue.share_urls_json === null || bytes > 8 * 1024 * 1024;
              }
              if (queue && !exceeded) for (const saved of getSources.iterate(key, basename(String(context.fileName ?? job.fileName ?? '未命名表格')), String(context.sheetName ?? job.sheetName ?? '').slice(0, 120))) {
                bytes += Buffer.byteLength(saved.payload_json);
                if (++read > 50 || bytes > 8 * 1024 * 1024) { exceeded = true; break; }
                const source = verifiedSource(saved, queue, job, nowMs); if (source) sources.push(source);
              }
              cache.set(key, { queue, sources, exceeded });
            }
            const cached = cache.get(key), { queue, sources, exceeded } = cached;
            if (exceeded) return { linked: false, ...state('unknown', '当前证据来源过多，未做不完整关联') };
            if (!queue || !Number.isSafeInteger(row.sourceRow) || row.sourceRow < 1 || !sources.some(source => source.rows.has(row.sourceRow)
              && (!row.sourceRecordId || source.records.has(JSON.stringify([row.sourceRow, row.sourceRecordId]))))) {
              return { linked: false, ...state('unlinked', '未找到与本次文件、工作表、源行一致的可信证据来源') };
            }
            const original = originalRows.get(row.sourceRow);
            if (!original || !matchesSubmittedConstraints(original, queue)
              || !matchesSubmittedConstraints(row, queue, { checkName: Boolean(nickname(original.name)) })) {
              return { linked: false, ...state('conflict', '当前队列的作者或作品约束与本次原始提交不一致，不能将其他提交的结果套用到这一行') };
            }
            cached.current ??= queueState(db, queue, nowMs);
            return { linked: true, ...cached.current };
          });
          const counts = emptyCounts(); counts.total = states.length;
          for (const item of states) { if (item.linked) counts.linked++; counts[Object.hasOwn(counts, item.status) ? item.status : 'unknown']++; }
          const statuses = new Set(states.map(item => item.status));
          current = state(statuses.size === 1 ? states[0].status : 'mixed', [...new Set(states.map(item => item.reason))].slice(0, 3).join('；'), {
            counts, updatedAt: states.map(item => item.updatedAt).filter(Boolean).sort().at(-1) ?? null,
            nextRetryAt: states.map(item => item.nextRetryAt).filter(Boolean).sort()[0] ?? null,
          });
        }
      }
      return { ...row, currentResolution: current };
    });
    db.exec('RELEASE import_review_current'); active = false;
    return result;
  } catch {
    if (active) { db.exec('ROLLBACK TO import_review_current'); db.exec('RELEASE import_review_current'); }
    return unavailable();
  }
}
