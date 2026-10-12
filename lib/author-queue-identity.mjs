const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const BILIBILI_UID_RE = /^\d{2,20}$/;

function identityKey(itemOrKey) {
  if (itemOrKey && typeof itemOrKey === "object") {
    return String(itemOrKey.identity_key ?? itemOrKey.key ?? "").trim();
  }
  return String(itemOrKey ?? "").trim();
}

export function authorQueuePlatform(itemOrKey) {
  const key = identityKey(itemOrKey);
  if (key.startsWith("bilibili:")) return "bilibili";
  if (key.startsWith("xiaohongshu:")) return "xiaohongshu";
  if (itemOrKey && typeof itemOrKey === "object") {
    const explicit = String(itemOrKey.platform ?? "").trim().toLowerCase();
    if (["douyin", "bilibili", "xiaohongshu"].includes(explicit)) return explicit;
  }
  return "douyin";
}

export function explicitAccountLocatorFromIdentityKey(itemOrKey) {
  const key = identityKey(itemOrKey);
  const douyin = key.match(/^douyin:account:(MS4wLj[\w-]{12,220})(?:\||$)/);
  if (douyin && SEC_UID_RE.test(douyin[1])) return { platform: "douyin", locator: douyin[1] };
  const bilibili = key.match(/^bilibili:account:(\d{2,20})(?:\||$)/);
  if (bilibili && BILIBILI_UID_RE.test(bilibili[1])) return { platform: "bilibili", locator: bilibili[1] };
  return null;
}

export function queuedAuthorAccountLocator(item) {
  const platform = authorQueuePlatform(item);
  const stored = String(item?.accountLocator ?? item?.account_locator ?? "").trim();
  if (platform === "douyin" && SEC_UID_RE.test(stored)) return stored;
  if (platform === "bilibili" && BILIBILI_UID_RE.test(stored)) return stored;
  const explicit = explicitAccountLocatorFromIdentityKey(item);
  return explicit?.platform === platform ? explicit.locator : "";
}

export function queuedBilibiliId(item) {
  const locator = queuedAuthorAccountLocator(item);
  if (BILIBILI_UID_RE.test(locator)) return locator;
  const matched = identityKey(item).match(/^bilibili:(\d{2,20})(?:\||$)/);
  return matched?.[1] ?? "";
}
