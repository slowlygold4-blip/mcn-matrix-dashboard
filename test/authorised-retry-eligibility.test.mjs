import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classifyAuthorisedRetryEligibility } from '../lib/authorised-retry-eligibility.mjs';

const prefix = '达到公开核验重试上限；';
const row = (message = '公开网页请求失败（HTTP 403）：Blocked by ArgusSecurityPlugin Uifid Not Found') => ({
  status: 'rejected', attempts: 5, verification_policy_version: 2,
  resolved_target_id: null, suspended_target_enabled: null, last_error: prefix + message,
});
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');

test('已枚举旧HTTP403重试耗尽只成为候选，保留原错误字节hash而不输出原文', () => {
  const input = row(), saved = structuredClone(input), result = classifyAuthorisedRetryEligibility(input);
  assert.deepEqual(result, { allowed: true, code: 'exhausted_http_403', errorSha256: sha(input.last_error) });
  assert.deepEqual(input, saved);
  assert.doesNotMatch(JSON.stringify(result), /Argus|Uifid|HTTP|公开网页/);
});

test('严格上限前缀加明确403/401/429或access-gate枚举才允许', () => {
  const cases = [
    ['公开网页请求失败（HTTP 403）：Forbidden', 'exhausted_http_403'],
    ['HTTP/1.1 401 Unauthorized', 'exhausted_http_401'],
    ['请求失败 HTTP:429', 'exhausted_http_429'],
    ['公开视频详情请求未完成（blocked）；未记录错误原文', 'exhausted_blocked'],
    ['login_required', 'exhausted_login'], ['need_login', 'exhausted_login'], ['请先登录后查看', 'exhausted_login'],
    ['challenge_required', 'exhausted_challenge'], ['captcha_required', 'exhausted_challenge'],
    ['出现人机验证', 'exhausted_challenge'], ['rate_limited', 'exhausted_rate_limited'],
    ['rate-limited', 'exhausted_rate_limited'], ['too many requests', 'exhausted_rate_limited'],
  ];
  for (const [message, code] of cases) {
    const result = classifyAuthorisedRetryEligibility(row(message));
    assert.equal(result.allowed, true, message); assert.equal(result.code, code, message);
  }
});

test('未知网络错误、超时、无回显、无正文与普通业务错误不会被当作已枚举access-gate', () => {
  for (const message of ['timeout', '网络返回出错', 'HTTP 500', 'HTTP 4030', '403', '业务错误 401',
    'transport_error', 'no_bound_response', 'collector_error', '未读取到JSON', '未取得该项结果', 'notblocked', 'HTTP 404']) {
    assert.equal(classifyAuthorisedRetryEligibility(row(message)).allowed, false, message);
  }
  for (const last_error of ['HTTP 403', '自定义文字；' + prefix + 'HTTP 403', '达到公开核验重试上限 HTTP 403',
    '其他前缀达到公开核验重试上限；blocked']) {
    assert.equal(classifyAuthorisedRetryEligibility({ ...row(), last_error }).code, 'missing_exhaustion_prefix', last_error);
  }
});

test('身份冲突/不同作者/严格回显失败优先于403或登录，绝不复活identity rejection', () => {
  for (const message of ['identity_mismatch', 'identity conflict', 'author_mismatch', 'owner mismatch', 'multiple owners',
    'multi-owner', 'crossEvidenceOwnerConflict', 'ambiguous', '作者身份与提交信息不一致',
    '同一线索对应多个不同作者，无法唯一确认', '多项作品证据分别对应不同作者', '公开结果未严格回显提交作品身份',
    '作品归属不匹配', '发布者冲突', 'nickname_mismatch', 'video_id_mismatch', 'sec_uid_mismatch',
    'unique_id_conflict', 'invalid_evidence', '作品 ID 不一致', '昵称不匹配']) {
    const result = classifyAuthorisedRetryEligibility(row(`HTTP 403；${message}；login_required`));
    assert.equal(result.allowed, false, message); assert.equal(result.code, 'identity_conflict', message);
  }
});

test('删除私密/注销/明确账号不存在是终局拒绝，Uifid Not Found不误当user_not_found', () => {
  for (const message of ['status_deleted', 'author_secret', 'status_self_see', 'story_25_filter', 'user_deleted',
    'video not found', 'account_not_found', 'author unavailable', 'private', 'deleted', '已删除', '被删除',
    '私密作品', '仅自己可见', '不可见', '用户不存在', '作品不存在', '账号不存在', '已注销']) {
    const result = classifyAuthorisedRetryEligibility(row(`HTTP 403；${message}；blocked`));
    assert.equal(result.allowed, false, message); assert.equal(result.code, 'terminal_unavailable', message);
  }
  assert.equal(classifyAuthorisedRetryEligibility(row()).allowed, true);
});

test('严格原队列状态/策略版本/attempts/目标关联，暂停0与暂停1都拒绝', () => {
  for (const status of ['pending', 'retry', 'resolved', '', undefined]) assert.equal(classifyAuthorisedRetryEligibility({ ...row(), status }).allowed, false);
  for (const attempts of [0, 4, '5', 5.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) assert.equal(classifyAuthorisedRetryEligibility({ ...row(), attempts }).allowed, false);
  for (const verification_policy_version of [1, 3, '2', null, undefined]) assert.equal(classifyAuthorisedRetryEligibility({ ...row(), verification_policy_version }).allowed, false);
  for (const resolved_target_id of [1, 0, '1', undefined]) assert.equal(classifyAuthorisedRetryEligibility({ ...row(), resolved_target_id }).allowed, false);
  for (const suspended_target_enabled of [0, 1, false, true, undefined]) assert.equal(classifyAuthorisedRetryEligibility({ ...row(), suspended_target_enabled }).allowed, false);
  assert.equal(classifyAuthorisedRetryEligibility({ ...row(), attempts: 7 }).allowed, true);
});

test('手动暂停优先禁止，即使原错误包含上限前缀和明确403', () => {
  for (const message of ['手动暂停', '人工暂停', '用户暂停', 'manual_pause', 'user stopped']) {
    assert.equal(classifyAuthorisedRetryEligibility(row(`HTTP 403；${message}`)).code, 'manual_pause');
  }
});

test('原错误中的凭据/URL从不返回，hash覆盖原始字节而不是清洗后消息', () => {
  const input = row('HTTP 403\nCookie: PRIVATE_COOKIE https://example.com/?token=[REDACTED]');
  const output = classifyAuthorisedRetryEligibility(input);
  assert.equal(output.allowed, true);
  assert.equal(output.errorSha256, sha(input.last_error));
  assert.deepEqual(Object.keys(output).sort(), ['allowed', 'code', 'errorSha256']);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|Cookie|example|token|https/);
  assert.notEqual(output.errorSha256, sha(input.last_error.replace(/\s+/g, ' ')));
});

test('格式损坏、超长、非字符串、控制符与非队列输入都fail closed且无异常回显', () => {
  for (const last_error of ['', null, 403, {}, ['HTTP 403'], prefix + 'HTTP 403\u0000identity_mismatch', 'a'.repeat(8001)]) {
    const result = classifyAuthorisedRetryEligibility({ ...row(), last_error });
    assert.equal(result.allowed, false); assert.equal(result.code, 'invalid_error');
    if (typeof last_error !== 'string' || last_error.length > 8000) assert.equal(result.errorSha256, undefined);
  }
  for (const value of [null, undefined, 1, 'HTTP 403', []]) assert.equal(classifyAuthorisedRetryEligibility(value).allowed, false);
});
