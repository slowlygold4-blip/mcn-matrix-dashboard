/** Official source work locators are candidates, never author identity proof. */
export function creatorSourceWorkEvidence(values, rowNumber) {
  const videoId = String(values?.[0] ?? '').trim();
  if (!/^\d{15,25}$/.test(videoId)) return null;
  let url;
  try { url = new URL(String(values[11] ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  if ([...url.searchParams.keys()].some(key => /token|cookie|secret|signature|credential|a_bogus|x-bogus/i.test(key))) return null;
  const host = url.hostname.toLowerCase();
  const direct = host === 'www.douyin.com' && url.pathname.match(/^\/(?:share\/)?video\/(\d{15,25})\/?$/);
  if (direct && direct[1] === videoId) return { videoId, shareUrl: `https://www.douyin.com/video/${videoId}`,
    workRow: rowNumber, evidenceType: 'direct-work-url', priority: 0 };
  if (host === 'v.douyin.com' && /^\/[A-Za-z0-9_-]{3,100}\/?$/.test(url.pathname)) return { videoId,
    shareUrl: `https://v.douyin.com${url.pathname.replace(/\/$/, '')}/`, workRow: rowNumber,
    evidenceType: 'short-work-url-pending-redirect-verification', priority: 1 };
  return null;
}
