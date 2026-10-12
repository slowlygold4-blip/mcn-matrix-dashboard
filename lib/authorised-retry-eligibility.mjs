import { createHash } from 'node:crypto';

const EXHAUSTED = /^达到公开核验重试上限[；;:：]\s*/;
const MANUAL_PAUSE = /人工暂停|手动暂停|用户暂停|(?:manual|user)[_ -]?(?:pause[ds]?|stop(?:ped)?)/i;
const TERMINAL = /status_deleted|author_secret|status_self_see|story_25_filter|user_deleted|(?:video|aweme|item|content|author|account|user)[_ -]+(?:is[_ -]+)?(?:deleted|private|unavailable|not[_ -]?(?:found|exist(?:s)?))|\b(?:deleted|private)\b|已删除|被删除|私密|仅(?:自己|好友|粉丝)可见|不可见|(?:账号|用户|作品|视频|内容)不存在|已注销/i;
const IDENTITY = /identity[_ -]?(?:mismatch|conflict)|(?:author|owner|account|profile|video|nickname|name|uid|sec[_ -]?uid|unique[_ -]?id|short[_ -]?id|video[_ -]?id|aweme[_ -]?id)[_ -]?(?:mismatch|conflict)|multi(?:ple)?[_ -]?(?:owner|author)s?|crossEvidenceOwnerConflict|invalid[_ -]?evidence|\bambiguous\b|(?:身份|账号|作者|发布者|归属|昵称|(?:作品|视频|抖音)\s*(?:ID|号)).{0,100}(?:不一致|冲突|不匹配)|(?:多个|不同).{0,40}(?:作者|发布者|归属)|无法唯一确认|未(?:严格)?回显.{0,40}(?:作品|身份)/i;

/** A transport-only retry candidate, never identity proof or an instruction
 * to unpause/revive a queue. The caller must obtain a fresh validated natural
 * response and atomically recheck source, lease, and original queue state.
 * Return no upstream text, URLs, credential fragments, or inferred identity.
 */
export function classifyAuthorisedRetryEligibility(row) {
  const raw = row?.last_error;
  const fingerprint = typeof raw === 'string' && raw.length <= 8000
    ? { errorSha256: createHash('sha256').update(raw, 'utf8').digest('hex') } : {};
  const outcome = (allowed, code) => ({ allowed, code, ...fingerprint });
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.status !== 'rejected') return outcome(false, 'not_rejected');
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 0) return outcome(false, 'invalid_attempts');
  if (row.attempts < 5) return outcome(false, 'not_exhausted');
  if (row.verification_policy_version !== 2) return outcome(false, 'policy_not_strict');
  if (row.resolved_target_id !== null) return outcome(false, 'target_already_linked');
  if (row.suspended_target_enabled !== null) return outcome(false, 'suspended_claim');
  if (typeof raw !== 'string' || !raw || raw.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return outcome(false, 'invalid_error');
  const message = raw.normalize('NFKC').replace(/\s+/g, ' ');
  // Negative identity/lifecycle decisions always win over a simultaneous 403
  // or login marker. Uifid Not Found is an access error, not user-not-found.
  if (MANUAL_PAUSE.test(message)) return outcome(false, 'manual_pause');
  if (TERMINAL.test(message)) return outcome(false, 'terminal_unavailable');
  if (IDENTITY.test(message)) return outcome(false, 'identity_conflict');
  if (!EXHAUSTED.test(message)) return outcome(false, 'missing_exhaustion_prefix');
  const details = message.replace(EXHAUSTED, '');
  for (const [status, code] of [[403, 'exhausted_http_403'], [401, 'exhausted_http_401'], [429, 'exhausted_http_429']]) {
    if (new RegExp(`\\bHTTP(?:\\/\\d(?:\\.\\d)?)?\\s*[:=(]?\\s*${status}(?!\\d)`, 'i').test(details)) return outcome(true, code);
  }
  if (/\bblocked\b/i.test(details)) return outcome(true, 'exhausted_blocked');
  if (/\b(?:login_required|need_login|not_login_module|session_required)\b|需要登录|请先登录|尚未登录|未登录/i.test(details)) return outcome(true, 'exhausted_login');
  if (/\b(?:challenge_required|captcha_required|verify_required|captcha|challenge)\b|验证码|安全验证|人机验证/i.test(details)) return outcome(true, 'exhausted_challenge');
  if (/\b(?:rate[_ -]limit(?:ed)?|too many requests)\b|请求频率过高|访问过于频繁|触发限流/i.test(details)) return outcome(true, 'exhausted_rate_limited');
  return outcome(false, 'unknown_failure');
}
