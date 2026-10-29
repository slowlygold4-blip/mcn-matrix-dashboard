/** Fixed privacy redaction for public projections, never applied to originals. */
export function publicText(value, locators = [], limit = 2000) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/https?:\/\/[^\s<>]+/gi, '[链接已隐藏]')
    .replace(/<[^>]*>/g, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[凭据已隐藏]')
    .replace(/["']?\b(?:access_token|refresh_token|authorization|cookie|password|secret|client_secret|api_key|token)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '[凭据已隐藏]');
  for (const locator of locators) if (locator.length >= 6) text = text.split(locator).join('[标识已隐藏]');
  return text.slice(0, limit).trim() || null;
}
