/** Fixed privacy redaction for public projections, never applied to originals. */
export function publicText(value, locators = [], limit = 2000) {
  return redactText(value, locators, limit);
}

/** One immutable source-read context; no global or cross-request cache. The
 * matcher only proves that a string needs no locator replacement. Strings that
 * match still use the original ordered split loop, including overlap rules. */
export function createPublicTextRedactor(locators = []) {
  const snapshot = [...locators];
  let matcher = null;
  if (snapshot.every(locator => typeof locator === 'string')) {
    const patterns = snapshot.filter(locator => locator.length >= 6)
      .map(locator => locator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Refuse oversized regex compilation; fall back to the exact old loop.
    const source = patterns.join('|');
    if (source && source.length <= 512_000) {
      try { matcher = new RegExp(source); } catch { /* Keep ordered loop. */ }
    }
  }
  return (value, limit = 2000) => redactText(value, snapshot, limit, matcher);
}

function redactText(value, locators, limit, matcher = null) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/[^\s<>]+/gi, '[链接已隐藏]')
    .replace(/<[^>]*>/g, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[凭据已隐藏]')
    .replace(/["']?\b(?:access_token|refresh_token|authorization|cookie|password|secret|client_secret|api_key|token)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '[凭据已隐藏]');
  let needsReplacement = true;
  if (matcher) {
    try { needsReplacement = matcher.test(text); } catch { /* Fall back to old loop. */ }
  }
  if (needsReplacement) for (const locator of locators) if (locator.length >= 6) text = text.split(locator).join('[标识已隐藏]');
  return text.slice(0, limit).trim() || null;
}
