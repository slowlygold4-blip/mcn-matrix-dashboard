import { buildAuthorEvidenceRequests } from './author-resolution.mjs';
import { normalizeAuthorisedDetailInput } from './douyin-authorised-detail.mjs';

const VIDEO = /^[1-9]\d{14,24}$/;
const SEC_UID = /^MS4wLj[\w-]{12,220}$/;
const HANDLE = /^[a-z0-9_.-]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const HOSTS = new Set(['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === undefined || value === null || value === '';
function invalid(message) {
  return Object.assign(new TypeError(message), { code: 'IMPORT_DETAIL_INVALID_INPUT', statusCode: 400 });
}

// Older imports passed an entire URL-leading share cell through URL.toString(),
// encoding the four copy-share adornments into the path. The separately saved
// shareUrl must already identify this exact complete token; do not truncate an
// unknown URL or decode arbitrary text into evidence. This only prepares the
// original share URL for a fresh exact author check, never proves ownership.
export function sameShareWithEncodedAdornments(value, shareUrl) {
  if (typeof value !== 'string' || value.length > 4000 || CONTROL.test(value)
    || !value.startsWith(`${shareUrl}%20`)) return false;
  const tokens = value.slice(shareUrl.length + 3).split('%20');
  const patterns = [/^(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])$/, /^:[0-9]pm$/, /^[A-Za-z]{3}:\/$/, /^[A-Za-z]@[A-Za-z]\.[A-Za-z]{2}$/];
  return tokens.length === patterns.length && patterns.every(pattern => tokens.filter(token => pattern.test(token)).length === 1);
}

// This intentionally does not resolve short links or infer their destination.
// Every extra source URL must itself name the same one official public work.
export function requireSameWork(value, videoId, { allowBareId = false } = {}) {
  if (empty(value)) return;
  if (typeof value !== 'string' || value.length > 4000 || CONTROL.test(value)) throw invalid('原行作品证据格式无效');
  if (allowBareId && VIDEO.test(value)) {
    if (value !== videoId) throw invalid('原行包含互相冲突的作品 ID');
    return;
  }
  const urls = value.match(/https?:\/\/[^\s，。；;,<>"']+/gi) ?? [];
  if (!urls.length) throw invalid('原行包含尚未能独立确认的额外作品证据');
  for (const raw of urls) {
    const candidate = raw.replace(/[。；，,;!！)）\]】}>]+$/g, '');
    let url;
    try { url = new URL(candidate); } catch { throw invalid('原行作品链接无效'); }
    const authority = candidate.match(/^https:\/\/([^/?#]*)/i)?.[1];
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port
      || authority?.toLowerCase() !== url.hostname.toLowerCase() || /\\/.test(candidate)) throw invalid('原行包含非受信任的官方作品链接');
    const legacy = url.hostname.toLowerCase().endsWith('iesdouyin.com');
    let pathId = url.pathname.match(legacy ? /^\/share\/video\/([1-9]\d{14,24})\/?$/
      : /^\/(?:video|note|share\/video)\/([1-9]\d{14,24})\/?$/)?.[1];
    // /user/self describes page context, not the submitted author's identity.
    // A unique modal ID can only locate the same already parsed public work.
    if (!legacy && /^\/user\/self\/?$/.test(url.pathname)) {
      const modalIds = url.searchParams.getAll('modal_id');
      if (urls.length !== 1 || modalIds.length !== 1 || !VIDEO.test(modalIds[0]) || url.hash
        || ['aweme_id', 'item_id'].some(key => url.searchParams.getAll(key).length > 1)) {
        throw invalid('原行作品弹窗参数不唯一或无效');
      }
      pathId = modalIds[0];
    }
    if (!pathId || pathId !== videoId) throw invalid('单次核验无法覆盖原行的额外或冲突作品证据');
    for (const key of ['aweme_id', 'item_id', 'modal_id']) {
      if (url.searchParams.getAll(key).some(id => id !== videoId)) throw invalid('原行作品路径与查询参数不一致');
    }
    // uid/sec_uid/device/tracking query parameters are not identity proof.
  }
}

/** Prepare one source-bound work identity check, not monitoring onboarding.
 * No network, persistence, queue mutation, or target enabling occurs here.
 * Authentication and owner/editor authorization remain the caller's job.
 * Return a single item for provider.resolveAuthorisedDetail({ items: [item] }).
 */
export function prepareImportAuthorisedDetail(job, options = {}) {
  if (!object(options) || Object.keys(options).some(key => key !== 'sourceRow')
    || !Number.isSafeInteger(options.sourceRow) || options.sourceRow <= 0) throw invalid('只允许选择原始表格的整数行号');
  if (!object(job) || job.status !== 'completed' || !object(job.request) || !Array.isArray(job.request.rows)
    || job.request.rows.length > 10000) throw invalid('只能核验已完成导入任务的原始记录');
  if (job.request.rows.some(row => !object(row) || !Number.isSafeInteger(row.sourceRow) || row.sourceRow <= 0)) {
    throw invalid('导入记录的源行号格式不完整，不能唯一选择证据');
  }
  const matching = job.request.rows.filter(row => row.sourceRow === options.sourceRow);
  if (matching.length !== 1) throw invalid('原始行不存在或行号存在歧义');
  const row = matching[0];
  if (row.platform !== 'douyin' || !empty(row.bilibiliId) || !empty(row.xiaohongshuId)) throw invalid('此入口只核验明确的抖音账号');
  if (['identity_conflict', 'rejected', 'skipped'].includes(row.status) || !empty(row.identityConflict) || !empty(row.rejectedLink)) {
    throw invalid('原行有身份冲突或未通过的链接，不能绕过原始审查');
  }
  if (typeof row.douyinId !== 'string' || CONTROL.test(row.douyinId)) throw invalid('原行缺少明确的抖音账号 ID');
  const submittedId = row.douyinId.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  if (!HANDLE.test(submittedId) || !/[a-z0-9]/.test(submittedId) || submittedId === '0') throw invalid('原行抖音账号 ID 格式无效');
  let shortInput = null;
  if (empty(row.videoId)) {
    try { shortInput = normalizeAuthorisedDetailInput({items:[{key:'source-check',shareUrl:row.shareUrl,submittedId}]}); }
    catch { throw invalid('原行必须有明确作品 ID 或唯一官方短链接'); }
    if (!empty(row.contentId)) throw invalid('短链接行有未能独立核对的作品 ID');
    for(const field of ['videoLink','videoHyperlink']) {
      if(empty(row[field]) || row[field]===shortInput.shareUrl) continue;
      if(sameShareWithEncodedAdornments(row[field],shortInput.shareUrl)) continue;
      const links=typeof row[field]==='string' ? row[field].match(/https?:\/\/[^\s，。；;,<>"']+/gi) ?? [] : [];
      if(links.length!==1 || links[0].replace(/[!！)）\]】}>]+$/g,'')!==shortInput.shareUrl) {
        throw invalid('单次核验不能覆盖额外链接或未识别的证据文本');
      }
    }
  } else if (typeof row.videoId !== 'string' || !VIDEO.test(row.videoId)) throw invalid('原行必须有一个无精度损失的明确作品 ID');
  for (const field of ['videoIds', 'shareUrls']) {
    if (!empty(row[field]) && (!Array.isArray(row[field]) || row[field].length !== 0)) throw invalid('单次核验不能覆盖多条作品证据');
  }
  const canonicals = [];
  for (const field of ['locator', 'accountLocator', 'secUid']) {
    if (empty(row[field])) continue;
    if (typeof row[field] !== 'string' || !SEC_UID.test(row[field])) throw invalid('原行账号定位信息不是合法 canonical sec_uid');
    canonicals.push(row[field]);
  }
  if (new Set(canonicals).size > 1) throw invalid('原行包含冲突的 canonical 账号身份');
  if(!shortInput) {
    requireSameWork(row.contentId, row.videoId, { allowBareId: true });
    for (const field of ['videoLink', 'videoHyperlink', 'shareUrl']) requireSameWork(row[field], row.videoId);
  }

  const requests = buildAuthorEvidenceRequests([row]);
  const uniqueEvidence = requests.length === 1 && (shortInput
    ? requests[0].videoIds.length===0 && requests[0].shareUrls.length===1 && requests[0].shareUrls[0]===shortInput.shareUrl
    : requests[0].videoIds.length === 1 && requests[0].videoIds[0] === row.videoId);
  if (!uniqueEvidence
    || typeof requests[0].key !== 'string' || requests[0].key.length > 300 || CONTROL.test(requests[0].key)) {
    throw invalid('原行无法唯一生成单作品核验请求');
  }
  return { key: requests[0].key, ...(shortInput ? {shareUrl:shortInput.shareUrl} : {videoId:row.videoId}), submittedId,
    ...(canonicals.length ? { expectedSecUid: canonicals[0] } : {}) };
}
