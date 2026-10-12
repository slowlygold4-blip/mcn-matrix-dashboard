const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const WORKS_ORIGIN = "https://www.douyin.com";
const WORKS_PATH = "/aweme/v1/web/aweme/post/";

/**
 * Bind a browser works response to the current account before reading its
 * status or JSON. This validates URL identity only, not payload ownership or
 * complete pagination. No raw URL/query, cookies or signature are returned.
 * Parameter name matches douyin_public_collector.py collect_account params.
 */
export function isExpectedDouyinWorksResponseUrl(value, expectedSecUid) {
  if (typeof value !== "string" || typeof expectedSecUid !== "string"
    || expectedSecUid !== expectedSecUid.trim() || !SEC_UID_RE.test(expectedSecUid)
    || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (!authority || authority.includes("@")) return false;
    const url = new URL(value);
    if (url.origin !== WORKS_ORIGIN || url.protocol !== "https:" || url.username || url.password
      || url.port || url.pathname !== WORKS_PATH || url.hash) return false;
    const identities = url.searchParams.getAll("sec_user_id");
    return identities.length === 1 && identities[0] === expectedSecUid;
  } catch { return false; }
}

export function isExpectedDouyinFirstWorksResponseUrl(value, expectedSecUid) {
  if (!isExpectedDouyinWorksResponseUrl(value, expectedSecUid)) return false;
  const cursors = new URL(value).searchParams.getAll("max_cursor");
  return cursors.length === 1 && cursors[0] === "0";
}
