#!/usr/bin/env node
/**
 * Read-only, no-model discovery for a submitted Douyin display ID. This is
 * deliberately not an author admission or a monitoring collector: a search
 * result cannot prove that an imported roster row owns the account.
 */
import { fileURLToPath } from 'node:url';
import { douyinSearch, normalizedIdentity } from './identity-resolution-probe.mjs';

const SEC_UID = /^MS4wLj[\w-]{12,220}$/;
const DISPLAY_ID = /^[a-z0-9_.-]{1,100}$/;
const OFFICIAL_PROFILE = /^https:\/\/www\.douyin\.com\/user\/(MS4wLj[\w-]{12,220})$/;

export function normalizeSubmittedDouyinId(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return '';
  const normalized = normalizedIdentity(value);
  return DISPLAY_ID.test(normalized) && /[a-z0-9]/.test(normalized) && normalized !== '0'
    && !SEC_UID.test(value.trim()) ? normalized : '';
}

function baseResult(id, name, observedAt) {
  return {
    version: 1,
    submittedDouyinId: id,
    submittedName: typeof name === 'string' ? name.normalize('NFKC').trim().slice(0, 120) : '',
    observedAt,
    source: 'douyin-public-search-then-official-profile',
    verificationScope: 'public-display-id-candidate-only',
    sourceRosterOwnershipVerified: false,
    monitoringEnabled: false,
    metricsSampled: false,
    runtimeAI: false,
    paidAPI: false,
    productionDatabaseWritten: false,
  };
}

/** Search candidates must be backed by an HTTP 200, status_code 0 official
 * profile that echoes its own sec_uid and the submitted unique_id/short_id.
 * The displayed name is never used to decide identity. */
export async function resolveDouyinIdOnlyCandidate({ douyinId, name = '' }, {
  search = douyinSearch, now = () => new Date(),
} = {}) {
  const id = normalizeSubmittedDouyinId(douyinId);
  if (!id) throw new Error('抖音号格式无效；不能用昵称或 sec_uid 当作展示号搜索');
  const observedAt = now().toISOString();
  const base = baseResult(id, name, observedAt);
  let observed;
  try { observed = await search(id, 'id', { headed: false }); }
  catch { return { ...base, status: 'unavailable', reason: '公开搜索请求未完成；未将账号判为不存在', candidate: null }; }
  if (observed?.platform !== 'douyin' || observed.queryKind !== 'id'
    || normalizeSubmittedDouyinId(observed.query) !== id
    || observed.anonymousFreshBrowserContext !== true
    || observed.persistentCookiesRead !== false || observed.persistentCookiesWritten !== false) {
    return { ...base, status: 'unavailable', reason: '搜索来源或匿名会话证明不完整', candidate: null };
  }
  if (observed.loginGateObserved === true) {
    return { ...base, status: 'blocked', reason: '平台要求登录或验证；不尝试绕过', candidate: null };
  }
  if ((Array.isArray(observed.observedSearchResponses) ? observed.observedSearchResponses : [])
    .some(item => [401, 403, 429].includes(item?.httpStatus)
      || item?.statusCode != null && item.statusCode !== 0)) {
    return { ...base, status: 'blocked', reason: '公开搜索响应被平台拒绝；不尝试绕过', candidate: null };
  }
  const observedCandidates = Array.isArray(observed.candidates) ? observed.candidates : [];
  const exact = new Map();
  for (const row of observedCandidates) {
    const canonicalId = typeof row?.canonicalId === 'string' ? row.canonicalId : '';
    const match = OFFICIAL_PROFILE.exec(String(row?.canonicalUrl ?? ''));
    if (!SEC_UID.test(canonicalId) || !match || match[1] !== canonicalId
      || row.profileHttpStatus !== 200 || row.profileStatusCode !== 0) continue;
    const matchedField = normalizedIdentity(row.uniqueId) === id ? 'unique_id'
      : normalizedIdentity(row.shortId) === id ? 'short_id' : null;
    if (!matchedField) continue;
    exact.set(canonicalId, {
      secUid: canonicalId,
      profileUrl: row.canonicalUrl,
      observedPublicId: String(matchedField === 'unique_id' ? row.uniqueId : row.shortId).slice(0, 100),
      matchedField,
      observedNickname: String(row.nickname ?? '').slice(0, 120),
    });
  }
  if (exact.size > 1) return { ...base, status: 'ambiguous',
    reason: '多个官方主页严格回显同一展示号；拒绝自动确权', candidate: null,
    matchingProfileCount: exact.size };
  if (exact.size === 1) return { ...base, status: 'candidate-only',
    reason: '官方主页字段与抖音号严格一致；搜索并非全量身份凭证，尚未核验来源名单归属',
    candidate: [...exact.values()][0], matchingProfileCount: 1 };
  return { ...base, status: 'unresolved',
    reason: '未取得严格回显该抖音号的官方主页；不推断账号不存在',
    candidate: null, matchingProfileCount: 0 };
}

function parseCli(argv) {
  let douyinId = '', name = '';
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--id', '--name'].includes(flag) || index + 1 >= argv.length) throw new Error('用法：--id <抖音号> [--name <作者名称>]');
    if (flag === '--id') {
      if (douyinId) throw new Error('不得重复提交抖音号');
      douyinId = argv[++index];
    } else {
      if (name) throw new Error('不得重复提交名称');
      name = argv[++index];
    }
  }
  if (!douyinId) throw new Error('缺少 --id 抖音号');
  return { douyinId, name };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resolveDouyinIdOnlyCandidate(parseCli(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
