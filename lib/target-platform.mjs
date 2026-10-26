const hostMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

// One routing decision for both collection and scheduled source checks.
// An explicit but unsupported platform must remain explicit so the provider
// can reject it; silently treating it as Douyin would mix data sources.
export function targetPlatform(target) {
  const explicit = String(target?.metadata?.platform ?? '').trim().toLowerCase();
  if (explicit) return explicit;
  let hostname = '';
  try { hostname = new URL(String(target?.locator ?? '')).hostname.toLowerCase(); }
  catch { /* Stable bare account IDs default to Douyin below. */ }
  if (hostMatches(hostname, 'bilibili.com') || hostMatches(hostname, 'b23.tv')) return 'bilibili';
  if (hostMatches(hostname, 'xiaohongshu.com') || hostMatches(hostname, 'xhslink.com')) return 'xiaohongshu';
  if (hostMatches(hostname, 'kuaishou.com')) return 'kuaishou';
  if (hostname && !hostMatches(hostname, 'douyin.com') && !hostMatches(hostname, 'iesdouyin.com')) return 'unknown';
  return 'douyin';
}
