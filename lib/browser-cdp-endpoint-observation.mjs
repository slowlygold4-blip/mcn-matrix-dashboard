const ORIGIN = 'https://www.douyin.com';
const PATH = '/aweme/v1/web/aweme/post/';
const SCOPES = ['current-document', 'prior-document', 'unbound'];

/**
 * Transient origin/path classification only. Never establishes author identity,
 * request ownership, pagination, a response, or permission to take an action.
 * Call only after the owning CDP reducer's duplicate/capacity/window guards.
 * Retain only the boolean, never the input, parsed URL, query, or exception.
 */
export function isCdpAuthorPostsEndpointUrl(value) {
  if (typeof value !== 'string' || value.length > 4_096
    || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (!authority || authority.includes('@')) return false;
    const url = new URL(value);
    return url.origin === ORIGIN && url.protocol === 'https:' && !url.username && !url.password
      && !url.port && !url.hash && url.pathname === PATH;
  } catch { return false; }
}

/** Optional fixed-count projection: missing old metadata stays missing. */
export function sanitizeCdpEndpointCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const scope of SCOPES) {
    let count;
    try { count = value[scope]; } catch { /* Optional diagnostics must not erase the parent. */ }
    result[scope] = Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000 ? count : null;
  }
  return result;
}
