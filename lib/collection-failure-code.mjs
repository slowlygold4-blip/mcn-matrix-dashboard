// Only persist a bounded diagnostic category, never a raw request URL or token.
const CODES = new Set([
  'login_required', 'rate_limited', 'blocked', 'network_error',
  'upstream_changed', 'collector_error', 'identity_mismatch', 'unknown',
]);

export function collectionFailureCode(error) {
  const code = typeof error?.errorCode === 'string' ? error.errorCode
    : typeof error?.code === 'string' ? error.code : '';
  if (CODES.has(code)) return code;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND'
    || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') return 'network_error';
  return 'unknown';
}
