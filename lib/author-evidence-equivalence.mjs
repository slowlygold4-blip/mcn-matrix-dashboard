import { repairDouyinShareLink } from "./douyin-share-link-repair.mjs";

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function exactText(value) {
  return String(value ?? "");
}

function evidenceIdentityUrl(value) {
  const raw = repairDouyinShareLink(value)?.normalizedUrl ?? text(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalSet(value, canonicalize) {
  const values = parseArray(value);
  if (!values || values.some((item) => typeof item !== "string")) return null;
  const canonical = values.map(canonicalize);
  if (canonical.some((item) => !item)) return null;
  return [...new Set(canonical)].sort();
}

function sameSet(left, right, canonicalize) {
  const a = canonicalSet(left, canonicalize);
  const b = canonicalSet(right, canonicalize);
  return Boolean(a && b && a.length === b.length && a.every((value, index) => value === b[index]));
}

/**
 * Compare the immutable identity/work fields of an already resolved author
 * queue row with a re-import.  Share-link spelling is compared with the same
 * identity semantics used by author evidence keys: fragments and a non-root
 * trailing slash do not identify another work; path case and query remain
 * significant.  Malformed JSON fails closed.
 */
export function sameResolvedAuthorEvidence(existing, incoming) {
  if (!existing || !incoming) return false;
  return exactText(existing.douyin_id) === exactText(incoming.douyin_id)
    && exactText(existing.account_locator) === exactText(incoming.account_locator)
    && sameSet(existing.video_ids_json, incoming.video_ids_json, exactText)
    && sameSet(existing.share_urls_json, incoming.share_urls_json, evidenceIdentityUrl);
}

export function canonicalAuthorEvidenceUrlSet(value) {
  return canonicalSet(value, evidenceIdentityUrl);
}
