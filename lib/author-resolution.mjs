import { createHash } from "node:crypto";
import { queuedAuthorAccountLocator } from "./author-queue-identity.mjs";
import { repairDouyinShareLink } from './douyin-share-link-repair.mjs';

const SEC_UID_RE = /^MS4wLj[\w-]{12,220}$/;
const VIDEO_ID_RE = /^\d{15,25}$/;
const BILIBILI_VIDEO_ID_RE = /^BV[0-9A-Za-z]{10}$/;
const BILIBILI_UID_RE = /^\d{2,20}$/;

function clean(value, maxLength = 300) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeIdentifier(value) {
  return clean(value, 180).replace(/^@/, "").toLowerCase();
}

function validSubmittedIdentifier(value, platform) {
  const normalized = normalizeIdentifier(value);
  if (!normalized) return "";
  if (platform === "bilibili") return /^\d{2,20}$/.test(normalized) ? normalized : "";
  if (platform === "xiaohongshu") return /^[0-9a-z]{16,40}$/.test(normalized) ? normalized : "";
  return /^[a-z0-9._-]{1,100}$/.test(normalized) && /[a-z0-9]/.test(normalized) && normalized !== "0"
    ? normalized : "";
}

function normalizeNickname(value) {
  return clean(value, 180).toLowerCase();
}

function canonicalEvidenceUrl(value) {
  const raw = repairDouyinShareLink(value)?.normalizedUrl ?? clean(value, 500);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    // URL normalizes the scheme and hostname while preserving the case-sensitive
    // path and query. Fragments are browser-local and never identify the public
    // evidence requested from the server.
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

// A trailing slash on a Douyin/Bilibili short link does not change the
// evidence destination. Keep the submitted URL intact for provenance, but use
// this identity form when deduplicating queue keys and comparing resolver
// results. This prevents a source revision from creating a second queue item
// for the same work merely because an exporter added '/'.
function evidenceIdentityUrl(value) {
  const canonical = canonicalEvidenceUrl(value);
  if (!canonical) return "";
  try {
    const parsed = new URL(canonical);
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return canonical.replace(/\/+$/, "");
  }
}

function sameEvidenceUrl(left, right) {
  const a = evidenceIdentityUrl(left);
  const b = evidenceIdentityUrl(right);
  return Boolean(a && b && a === b);
}

function normalizeEvidenceKey(value) {
  const key = String(value ?? "").trim();
  if (key.startsWith("share:")) return `share:${evidenceIdentityUrl(key.slice("share:".length))}`;
  if (key.startsWith("bilibili:share:")) return `bilibili:share:${evidenceIdentityUrl(key.slice("bilibili:share:".length))}`;
  return key;
}

function normalizedBoards(source) {
  const values = [source?.board, ...(Array.isArray(source?.boards) ? source.boards : [])];
  const fields = [["organization", 200], ["tier", 120], ["category", 120], ["owner", 120], ["filledDate", 40], ["note", 500]];
  const boards = new Map();
  for (const value of values) {
    const name = clean(value && typeof value === "object" ? value.name : value, 120);
    const key = name.toLowerCase();
    if (!name) continue;
    const candidate = {
      name,
      sourceRow: Math.max(1, Math.trunc(Number(value?.sourceRow ?? value?.source?.sourceRow ?? source?.sourceRow) || 1)),
      source: value?.source && typeof value.source === "object" ? { ...value.source } : null,
      conflicts: [],
    };
    for (const [field, maxLength] of fields) {
      const raw = field === "filledDate"
        ? value?.filledDate ?? value?.filled_date ?? source?.filledDate ?? source?.filled_date
        : field === "note"
          ? value?.note ?? value?.notes ?? value?.remark ?? value?.remarks ?? source?.note ?? source?.notes ?? source?.remark ?? source?.remarks
          : value?.[field] ?? source?.[field];
      candidate[field] = clean(raw, maxLength);
    }
    for (const conflict of Array.isArray(value?.conflicts) ? value.conflicts : []) candidate.conflicts.push(conflict);
    const existing = boards.get(key);
    if (!existing) {
      boards.set(key, candidate);
      continue;
    }
    for (const [field] of fields) {
      if (!existing[field] && candidate[field]) existing[field] = candidate[field];
      else if (existing[field] && candidate[field] && existing[field].toLowerCase() !== candidate[field].toLowerCase()) {
        const fingerprint = `${field}\u0000${existing[field].toLowerCase()}\u0000${candidate[field].toLowerCase()}`;
        if (!existing.conflicts.some((conflict) => `${conflict.field}\u0000${clean(conflict.storedValue, 500).toLowerCase()}\u0000${clean(conflict.incomingValue, 500).toLowerCase()}` === fingerprint)) {
          existing.conflicts.push({ field, storedValue: existing[field], incomingValue: candidate[field], incomingSource: { sourceRow: candidate.sourceRow } });
        }
      }
    }
    existing.conflicts.push(...candidate.conflicts);
    if (!existing.source && candidate.source) existing.source = candidate.source;
  }
  return [...boards.values()];
}

function platformFor(source) {
  const explicit = clean(source?.platform, 40).toLowerCase().replace(/[\s_-]/g, "");
  if (["b站", "哔哩哔哩", "bilibili", "bili"].includes(explicit)) return "bilibili";
  if (["小红书", "xiaohongshu", "rednote", "xhs"].includes(explicit)) return "xiaohongshu";
  const videoId = clean(source?.videoId, 40);
  const shareUrl = clean(source?.shareUrl, 500).toLowerCase();
  if (BILIBILI_VIDEO_ID_RE.test(videoId) || shareUrl.startsWith("https://b23.tv/")) return "bilibili";
  if (shareUrl.includes("xiaohongshu.com") || shareUrl.includes("xhslink.com")) return "xiaohongshu";
  return "douyin";
}

export function authorIdentityKey(row) {
  const platform = platformFor(row);
  if (platform === "bilibili") {
    const bilibiliId = normalizeIdentifier(row?.bilibiliId);
    if (bilibiliId) return `bilibili:${bilibiliId}`;
    const videoId = clean(row?.videoId, 40);
    if (BILIBILI_VIDEO_ID_RE.test(videoId)) return `bilibili:video:${videoId}`;
    const shareUrl = canonicalEvidenceUrl(row?.shareUrl);
    if (shareUrl) return `bilibili:share:${shareUrl}`;
    const name = normalizeNickname(row?.name);
    return name ? `bilibili:name:${name}` : null;
  }
  if (platform === "xiaohongshu") return null;
  const douyinId = normalizeIdentifier(row?.douyinId);
  if (douyinId) return `douyin:${douyinId}`;
  const videoId = clean(row?.videoId, 40);
  if (VIDEO_ID_RE.test(videoId)) return `video:${videoId}`;
  const shareUrl = canonicalEvidenceUrl(row?.shareUrl);
  if (shareUrl) return `share:${shareUrl}`;
  const name = normalizeNickname(row?.name);
  return name ? `name:${name}` : null;
}

function ownershipEvidence(row) {
  return Boolean(clean(row?.videoId, 40) || clean(row?.shareUrl, 500));
}

function strongAccountLocator(row, platform = platformFor(row)) {
  const locator = clean(row?.locator ?? row?.accountLocator, 500);
  if (platform === "bilibili") return BILIBILI_UID_RE.test(locator) ? locator : "";
  if (platform === "xiaohongshu") return locator.match(/\/user\/profile\/([0-9a-z]{16,40})/i)?.[1]?.toLowerCase() ?? "";
  return SEC_UID_RE.test(locator) ? locator : "";
}

/** Count explicit submitted account identities, never nicknames or work URLs.
 * Unknown items may belong to each other or to a known account, so their
 * presence makes the whole distinct-account count unknown rather than N+1.
 */
export function groupSubmittedAuthorIdentities(items) {
  const identities = new Map();
  let unknownIdentityItemCount = 0;
  let ambiguousIdentityItemCount = 0;
  const rows = Array.isArray(items) ? items : [];
  const submittedToCanonical = new Map();
  const canonicalToSubmitted = new Map();
  const remember = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  const records = rows.map((row, index) => {
    const platform = platformFor(row);
    const submittedId = validSubmittedIdentifier(platform === "bilibili" ? row?.bilibiliId
      : platform === "xiaohongshu" ? row?.xiaohongshuId : row?.douyinId, platform);
    const locator = strongAccountLocator(row, platform);
    const submitted = submittedId ? `${platform}:${platform === "bilibili" ? "uid" : "submitted"}:${submittedId}` : null;
    const canonical = locator ? `${platform}:${platform === "bilibili" ? "uid" : "canonical"}:${locator}` : null;
    const conflict = row?.status === "identity_conflict" || Boolean(clean(row?.identityConflict))
      || (platform === "bilibili" && submitted && canonical && submitted !== canonical);
    if (!conflict && submitted && canonical) {
      remember(submittedToCanonical, submitted, canonical);
      remember(canonicalToSubmitted, canonical, submitted);
    }
    return { row, index, platform, submittedId, locator, submitted, canonical, conflict };
  });
  for (const record of records) {
    const { submitted, canonical, conflict } = record;
    const mappings = submittedToCanonical.get(submitted);
    const mappedCanonical = mappings?.size === 1 ? [...mappings][0] : null;
    const mappedSubmitted = canonicalToSubmitted.get(canonical || mappedCanonical);
    if (conflict || mappings?.size > 1 || mappedSubmitted?.size > 1
      || [...(mappedSubmitted ?? [])].some((id) => submittedToCanonical.get(id)?.size > 1)) {
      unknownIdentityItemCount += 1;
      ambiguousIdentityItemCount += 1;
      continue;
    }
    // Only an explicit, unambiguous binding can merge a submitted handle and
    // a canonical-only row. Names, videos and inferred identity never do so.
    const identity = canonical || mappedCanonical || submitted;
    if (identity) {
      if (!identities.has(identity)) identities.set(identity, { key: identity, platform: record.platform,
        submittedId: record.submittedId || record.locator, name: clean(record.row?.name, 240) || record.submittedId || '未填写名称', records: [] });
      identities.get(identity).records.push(record);
    }
    else unknownIdentityItemCount += 1;
  }
  return { groups: [...identities.values()], unknownIdentityItemCount, ambiguousIdentityItemCount, inputItemCount: rows.length };
}

export function summarizeAuthorAccountIdentities(items) {
  const { groups, unknownIdentityItemCount, ambiguousIdentityItemCount, inputItemCount } = groupSubmittedAuthorIdentities(items);
  return {
    knownDistinctSubmittedIdentityCount: groups.length,
    knownDistinctAccountCount: groups.length,
    knownDistinctAccountCountDeprecated: true,
    unknownIdentityItemCount,
    ambiguousIdentityItemCount,
    distinctAccountCount: unknownIdentityItemCount ? null : groups.length,
    inputItemCount,
    basis: "platform-and-explicit-submitted-id-with-unambiguous-canonical-binding-not-nickname-or-person-count",
    scope: "submitted-account-identities-not-verified-account-ownership",
  };
}

/** Snapshot of this enqueue operation, not the database's global queue size. */
export function summarizeQueuedAuthorEvidence(requests, queueResult) {
  const uniqueRequests = [...new Map((Array.isArray(requests) ? requests : []).map((item) => [item.key, item])).values()];
  const requestKeys = new Set(uniqueRequests.map((item) => item.key));
  const ownKeys = (value) => new Set((Array.isArray(value) ? value : []).filter((key) => requestKeys.has(key)));
  const pendingKnown = !uniqueRequests.length || Array.isArray(queueResult?.pendingEvidenceRequestKeys);
  const pendingKeys = ownKeys(queueResult?.pendingEvidenceRequestKeys);
  const reusedKeys = ownKeys(queueResult?.evidenceReusedKeys);
  const verifiedExistingKeys = ownKeys(queueResult?.verifiedExistingEvidenceRequestKeys);
  const resolvedKeys = ownKeys(queueResult?.resolvedEvidenceRequestKeys);
  return {
    submittedEvidenceRequestCount: uniqueRequests.length,
    queuedEvidenceRequestCount: pendingKnown ? pendingKeys.size : null,
    queuedAccountIdentitySummary: pendingKnown ? summarizeAuthorAccountIdentities(uniqueRequests.filter((item) => pendingKeys.has(item.key))) : null,
    evidenceReusedEvidenceRequestCount: Array.isArray(queueResult?.evidenceReusedKeys) || !uniqueRequests.length ? reusedKeys.size : null,
    verifiedExistingEvidenceRequestCount: Array.isArray(queueResult?.verifiedExistingEvidenceRequestKeys) || !uniqueRequests.length ? verifiedExistingKeys.size : null,
    alreadyResolvedEvidenceRequestCount: Array.isArray(queueResult?.resolvedEvidenceRequestKeys) || !uniqueRequests.length
      ? [...resolvedKeys].filter((key) => !reusedKeys.has(key)).length : null,
    scope: "this-enqueue-operation-at-job-completion-not-live-resolution-queue",
  };
}

function authorEvidenceKey(row) {
  const platform = platformFor(row);
  const locator = strongAccountLocator(row, platform);
  const submittedId = normalizeIdentifier(platform === "bilibili" ? row?.bilibiliId : row?.douyinId);
  const accountKey = locator ? `${platform}:account:${locator}` : submittedId ? `${platform}:${submittedId}` : "";
  const videoId = clean(row?.videoId, 40);
  const validVideoId = platform === "bilibili" ? BILIBILI_VIDEO_ID_RE.test(videoId) : VIDEO_ID_RE.test(videoId);
  const shareUrl = canonicalEvidenceUrl(row?.shareUrl);
  const shareIdentity = evidenceIdentityUrl(shareUrl);
  const sharePart = shareIdentity ? `share-sha256:${createHash("sha256").update(shareIdentity).digest("hex").slice(0, 32)}` : "";
  const normalizedLocator = normalizeIdentifier(locator);
  const expectedName = normalizeNickname(row?.name);
  const constraintPart = locator && submittedId && submittedId !== normalizedLocator
    ? `submitted-id-sha256:${createHash("sha256").update(submittedId).digest("hex").slice(0, 24)}`
    : locator && !submittedId && expectedName
      ? `name-sha256:${createHash("sha256").update(expectedName).digest("hex").slice(0, 24)}`
      : "";
  if (accountKey && ownershipEvidence(row)) return [accountKey, constraintPart, validVideoId ? `video:${videoId}` : "", sharePart].filter(Boolean).join("|");
  if (locator) return accountKey;
  const evidenceIdentity = normalizeEvidenceKey(authorIdentityKey(row));
  // authorIdentityKey intentionally prioritizes the direct work ID. Include a
  // share fingerprint as well when both were submitted so a fourth distinct
  // short link can never be merged into—or truncated from—another row's proof.
  return evidenceIdentity && validVideoId && sharePart ? `${evidenceIdentity}|${sharePart}` : evidenceIdentity;
}

export function buildAuthorEvidenceRequests(rows) {
  if (!Array.isArray(rows)) throw new Error("缺少待核验作者行");
  const groups = new Map();
  for (const source of rows) {
    if (source?.status === "identity_conflict") continue;
    if (source?.locator && !ownershipEvidence(source)) continue;
    const platform = platformFor(source);
    if (platform === "xiaohongshu") continue;
    const key = authorEvidenceKey(source);
    const videoId = clean(source?.videoId, 40);
    const shareUrl = canonicalEvidenceUrl(source?.shareUrl);
    const validVideoId = platform === "bilibili" ? BILIBILI_VIDEO_ID_RE.test(videoId) : VIDEO_ID_RE.test(videoId);
    const validShareUrl = platform === "bilibili" ? /^https:\/\/b23\.tv\/[^\s]+$/i.test(shareUrl) : Boolean(shareUrl);
    if (!key || (!validVideoId && !validShareUrl)) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        platform,
        accountLocator: strongAccountLocator(source, platform),
        name: clean(source?.name, 120),
        douyinId: clean(source?.douyinId, 120),
        bilibiliId: clean(source?.bilibiliId, 120),
        organization: clean(source?.organization, 200),
        tier: clean(source?.tier, 120),
        category: clean(source?.category, 120),
        boards: [],
        videoIds: [],
        shareUrls: [],
        sourceRows: [],
      });
    }
    const group = groups.get(key);
    if (!group.organization) group.organization = clean(source?.organization, 200);
    if (!group.tier) group.tier = clean(source?.tier, 120);
    if (!group.category) group.category = clean(source?.category, 120);
    for (const board of normalizedBoards(source)) {
      const existing = group.boards.find((candidate) => candidate.name.toLowerCase() === board.name.toLowerCase());
      if (!existing) {
        group.boards.push(board);
        continue;
      }
      for (const field of ["organization", "tier", "category", "owner", "filledDate", "note"]) {
        if (!existing[field] && board[field]) existing[field] = board[field];
        else if (existing[field] && board[field] && existing[field].toLowerCase() !== board[field].toLowerCase()) {
          const fingerprint = `${field}\u0000${existing[field].toLowerCase()}\u0000${board[field].toLowerCase()}`;
          if (!existing.conflicts.some((conflict) => `${conflict.field}\u0000${clean(conflict.storedValue, 500).toLowerCase()}\u0000${clean(conflict.incomingValue, 500).toLowerCase()}` === fingerprint)) {
            existing.conflicts.push({ field, storedValue: existing[field], incomingValue: board[field], incomingSource: { sourceRow: board.sourceRow } });
          }
        }
      }
      existing.conflicts.push(...board.conflicts);
      if (!existing.source && board.source) existing.source = board.source;
    }
    const sourceRow = Math.max(1, Math.trunc(Number(source?.sourceRow) || 1));
    if (!group.sourceRows.includes(sourceRow)) group.sourceRows.push(sourceRow);
    if (typeof source?.sourceRecordId === "string" && /^rec[A-Za-z0-9_-]{6,120}$/.test(source.sourceRecordId)) {
      group.sourceRecords ??= [];
      if (!group.sourceRecords.some(item => item.sourceRow === sourceRow && item.sourceRecordId === source.sourceRecordId)) {
        group.sourceRecords.push({ sourceRow, sourceRecordId: source.sourceRecordId });
      }
    }
    // Never silently discard submitted proof. Keys normally isolate each
    // distinct work/share pair; retaining every unique value also keeps this
    // fail-closed if grouping rules change later.
    if (validVideoId && !group.videoIds.includes(videoId)) group.videoIds.push(videoId);
    if (validShareUrl && !group.shareUrls.some((existing) => sameEvidenceUrl(existing, shareUrl))) group.shareUrls.push(shareUrl);
  }
  return [...groups.values()];
}

function isOfficialBilibiliEvidence(group, candidate) {
  if (candidate?.platform !== "bilibili" || candidate?.provenance !== "bilibili-official-anonymous-view") return false;
  const videoId = clean(candidate?.videoId, 40);
  if (!BILIBILI_VIDEO_ID_RE.test(videoId)) return false;
  const directEvidence = group.videoIds.includes(videoId);
  const sourceEvidenceUrl = clean(candidate?.sourceEvidenceUrl, 500);
  const shareEvidence = group.shareUrls.some((shareUrl) => sameEvidenceUrl(shareUrl, sourceEvidenceUrl));
  if (!directEvidence && !shareEvidence) return false;
  try {
    const endpoint = new URL(clean(candidate?.endpoint, 500));
    return endpoint.protocol === "https:"
      && endpoint.hostname === "api.bilibili.com"
      && endpoint.pathname === "/x/web-interface/view"
      && endpoint.searchParams.get("bvid") === videoId;
  } catch {
    return false;
  }
}

function verifiedBilibiliCandidate(group, result) {
  const expectedId = normalizeIdentifier(group.bilibiliId);
  const expectedName = normalizeNickname(group.name);
  const evidenceCandidates = [];
  for (const candidate of result?.candidates ?? []) {
    if (!isOfficialBilibiliEvidence(group, candidate)) continue;
    const canonicalId = clean(candidate?.canonicalId ?? candidate?.mid ?? candidate?.uid, 40);
    if (!BILIBILI_UID_RE.test(canonicalId)) continue;
    evidenceCandidates.push({ ...candidate, canonicalId });
  }
  const everyVideoCovered = group.videoIds.every((videoId) => evidenceCandidates.some((candidate) => clean(candidate.videoId, 40) === videoId));
  const everyShareCovered = group.shareUrls.every((shareUrl) => evidenceCandidates.some((candidate) => sameEvidenceUrl(candidate.sourceEvidenceUrl, shareUrl)));
  if (!everyVideoCovered || !everyShareCovered) return {
    incomplete: true,
    invalidEvidence: evidenceCandidates.length === 0
      && (result?.candidates?.length ?? 0) > 0
      && (result?.errors?.length ?? 0) === 0,
  };
  const owners = new Map();
  for (const candidate of evidenceCandidates) {
    if (!owners.has(candidate.canonicalId)) owners.set(candidate.canonicalId, []);
    owners.get(candidate.canonicalId).push(candidate);
  }
  if (owners.size > 1) return { ambiguous: true };
  if (owners.size !== 1) return null;
  const [canonicalId, ownerCandidates] = [...owners.entries()][0];
  if (group.accountLocator && normalizeIdentifier(group.accountLocator) !== normalizeIdentifier(canonicalId)) return null;
  if (expectedId && expectedId !== normalizeIdentifier(canonicalId)) return null;
  let candidate = ownerCandidates[0];
  if (!expectedId && expectedName) {
    candidate = ownerCandidates.find((item) => expectedName === normalizeNickname(item.nickname));
    if (!candidate) return null;
  }
  return {
    candidate,
    matchedBy: expectedId ? "bilibili-id" : expectedName ? "nickname" : "video-evidence",
  };
}

function verifiedDouyinCandidate(group, result) {
  const expectedId = normalizeIdentifier(group.douyinId);
  const expectedName = normalizeNickname(group.name);
  const evidenceCandidates = [];
  for (const candidate of result?.candidates ?? []) {
    const candidateVideoId = clean(candidate?.videoId, 40);
    const sourceEvidenceUrl = clean(candidate?.sourceEvidenceUrl, 500);
    const matchesSubmittedEvidence = Boolean(
      (candidateVideoId && group.videoIds.includes(candidateVideoId))
      || (sourceEvidenceUrl && group.shareUrls.some((shareUrl) => sameEvidenceUrl(shareUrl, sourceEvidenceUrl))),
    );
    if (!matchesSubmittedEvidence) continue;
    const secUid = clean(candidate?.secUid, 240);
    if (!SEC_UID_RE.test(secUid)) continue;
    evidenceCandidates.push({ ...candidate, secUid });
  }
  const everyVideoCovered = group.videoIds.every((videoId) => evidenceCandidates.some((candidate) => clean(candidate.videoId, 40) === videoId));
  const everyShareCovered = group.shareUrls.every((shareUrl) => evidenceCandidates.some((candidate) => sameEvidenceUrl(candidate.sourceEvidenceUrl, shareUrl)));
  if (!everyVideoCovered || !everyShareCovered) return {
    incomplete: true,
    invalidEvidence: evidenceCandidates.length === 0
      && (result?.candidates?.length ?? 0) > 0
      && (result?.errors?.length ?? 0) === 0,
  };
  const owners = new Map();
  for (const candidate of evidenceCandidates) {
    if (!owners.has(candidate.secUid)) owners.set(candidate.secUid, []);
    owners.get(candidate.secUid).push(candidate);
  }
  if (owners.size > 1) return { ambiguous: true };
  if (owners.size !== 1) return null;
  const [secUid, ownerCandidates] = [...owners.entries()][0];
  if (group.accountLocator && secUid !== group.accountLocator) return null;
  let candidate = ownerCandidates[0];
  if (expectedId) {
    candidate = ownerCandidates.find((item) => [item.uniqueId, item.shortId, item.uid].map(normalizeIdentifier).filter(Boolean).includes(expectedId));
    if (!candidate) return null;
  } else if (expectedName) {
    candidate = ownerCandidates.find((item) => expectedName === normalizeNickname(item?.nickname));
    if (!candidate) return null;
  }
  return {
    candidate,
    matchedBy: expectedId ? "douyin-id" : expectedName ? "nickname" : "video-evidence",
  };
}

function verifiedCandidate(group, result) {
  return group.platform === "bilibili"
    ? verifiedBilibiliCandidate(group, result)
    : verifiedDouyinCandidate(group, result);
}

export function applyAuthorEvidence(rows, resolutionData) {
  const requests = buildAuthorEvidenceRequests(rows);
  const resultByKey = new Map((resolutionData?.items ?? []).map((item) => [normalizeEvidenceKey(item?.key), item]));
  const verified = new Map();
  const failures = new Map();
  let matchedById = 0;
  let matchedByName = 0;
  let matchedByEvidence = 0;
  let evidenceErrors = 0;
  let fetchFailedAuthors = 0;
  let deferredEvidenceRequestCount = 0;
  let incompleteEvidenceRequestCount = 0;
  let noResultEvidenceRequestCount = 0;
  let identityMismatchAuthors = 0;
  let ambiguousAuthors = 0;
  let noEvidenceAuthors = 0;

  for (const group of requests) {
    const result = resultByKey.get(group.key);
    if (result?.status === "deferred" && result.networkAttempted === false
      && !(result.candidates?.length) && !(result.errors?.length)) {
      deferredEvidenceRequestCount += 1;
      failures.set(group.key, "本批证据请求已主动排入后台核验队列，尚未请求公开详情，可稍后自动重试");
      continue;
    }
    if (!result) {
      noResultEvidenceRequestCount += 1;
      failures.set(group.key, "未取得该项公开核验的执行结果，不能判定为网络抓取失败，可稍后自动重试");
      continue;
    }
    evidenceErrors += Array.isArray(result?.errors) ? result.errors.length : 0;
    const match = verifiedCandidate(group, result);
    if (match?.candidate) {
      verified.set(group.key, match);
      if (["douyin-id", "bilibili-id"].includes(match.matchedBy)) matchedById += 1;
      else if (match.matchedBy === "nickname") matchedByName += 1;
      else matchedByEvidence += 1;
      continue;
    }
    const candidateCount = Array.isArray(result?.candidates) ? result.candidates.length : 0;
    const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;
    if (match?.ambiguous) {
      ambiguousAuthors += 1;
      failures.set(group.key, "同一线索对应多个不同作者，无法唯一确认，已转入人工核验");
    } else if (match?.invalidEvidence) {
      identityMismatchAuthors += 1;
      failures.set(group.key, group.platform === "bilibili"
        ? "B站公开结果未严格回显每项提交作品证据，已拒绝自动加入"
        : "公开结果未严格回显提交作品身份，已拒绝自动加入");
    } else if (match?.incomplete) {
      if (errorCount) {
        fetchFailedAuthors += 1;
        failures.set(group.key, "公开详情读取失败并返回错误，本次证据尚未核验完整，可稍后自动重试");
      } else if (candidateCount) {
        incompleteEvidenceRequestCount += 1;
        failures.set(group.key, "并非每一项提交作品证据都完成公开核验，本次未写入，可稍后自动重试");
      } else {
        noEvidenceAuthors += 1;
        failures.set(group.key, "公开详情尚未返回可核验作者，本次未写入，可稍后自动重试");
      }
    } else if (candidateCount) {
      identityMismatchAuthors += 1;
      failures.set(group.key, group.platform === "bilibili"
        ? "B站作品发布者与提交的 UID/昵称或原始作品证据不一致，已拒绝自动加入"
        : "公开视频作者与提交的抖音号/昵称不一致，已拒绝自动加入");
    } else if (errorCount) {
      fetchFailedAuthors += 1;
      failures.set(group.key, "公开详情暂时读取失败，本次未写入，可稍后自动重试");
    } else {
      noEvidenceAuthors += 1;
      failures.set(group.key, "公开详情未返回可核验作者，已拒绝自动加入");
    }
  }

  let resolvedRows = 0;
  const updatedRows = rows.map((source) => {
    if (source?.status === "identity_conflict") return source;
    const needsOwnershipCheck = Boolean(source?.locator && ownershipEvidence(source));
    if (source?.locator && !needsOwnershipCheck) return source;
    const platform = platformFor(source);
    if (needsOwnershipCheck && platform === "xiaohongshu") {
      return { ...source, status: "unresolved", reason: "小红书公开匿名数据无法核验该作品发布者与提交账号是否一致，本次未写入" };
    }
    const key = authorEvidenceKey(source);
    const match = key ? verified.get(key) : null;
    if (!match) {
      if (key && failures.has(key) && (source?.videoId || source?.shareUrl)) return { ...source, status: "unresolved", reason: failures.get(key) };
      return source;
    }
    resolvedRows += 1;
    const candidate = match.candidate;
    const isBilibili = platform === "bilibili";
    const locator = clean(source?.locator, 500) || (isBilibili ? clean(candidate.canonicalId, 40) : clean(candidate.secUid, 240));
    return {
      ...source,
      name: clean(source?.name, 120) || clean(candidate.nickname, 120)
        || clean(isBilibili ? source?.bilibiliId : source?.douyinId, 120),
      locator,
      status: "ready",
      reason: needsOwnershipCheck
        ? isBilibili
          ? "已用 B站官方作品详情核验发布者 UID 与提交账号严格一致"
          : "已用公开视频详情核验发布者 sec_uid 与提交账号严格一致"
        : match.matchedBy === "bilibili-id"
        ? "已由 B站官方作品详情反查发布者 UID，并与提交 UID 严格一致"
        : match.matchedBy === "douyin-id"
          ? "已由公开视频反查 sec_uid，并与提交抖音号严格一致"
        : match.matchedBy === "nickname"
          ? isBilibili
            ? "已由 B站官方作品详情反查发布者 UID，并与提交作者昵称严格一致"
            : "已由公开视频反查 sec_uid，并与提交作者昵称严格一致"
          : isBilibili
            ? "已由 B站官方作品详情直接确认发布者，并补全 UID 与作者名称"
            : "已由公开视频直接确认发布作者，并补全 sec_uid 与作者名称",
      resolution: {
        mode: "public-video-detail",
        platform,
        matchedBy: match.matchedBy,
        evidenceVideoId: clean(candidate.videoId, 40),
        publicNickname: clean(candidate.nickname, 120),
        publicDouyinId: isBilibili ? "" : clean(candidate.uniqueId || candidate.shortId || candidate.uid, 120),
        canonicalAccountId: isBilibili ? clean(candidate.canonicalId, 40) : clean(candidate.secUid, 240),
        canonicalAccountUrl: isBilibili ? `https://space.bilibili.com/${clean(candidate.canonicalId, 40)}` : clean(candidate.canonicalUrl, 500),
        evidenceUrl: clean(candidate.evidenceUrl, 500),
        sourceEvidenceUrl: clean(candidate.sourceEvidenceUrl, 500),
        endpoint: clean(candidate.endpoint, 500),
        provenance: clean(candidate.provenance, 80),
        resolvedAt: new Date().toISOString(),
      },
    };
  });

  return {
    rows: updatedRows,
    summary: {
      requestedEvidenceRequestCount: requests.length,
      resolvedEvidenceRequestCount: verified.size,
      deferredEvidenceRequestCount,
      fetchFailedEvidenceRequestCount: fetchFailedAuthors,
      incompleteEvidenceRequestCount,
      noResultEvidenceRequestCount,
      identityMismatchEvidenceRequestCount: identityMismatchAuthors,
      ambiguousEvidenceRequestCount: ambiguousAuthors,
      noEvidenceEvidenceRequestCount: noEvidenceAuthors,
      requestedAccountIdentitySummary: summarizeAuthorAccountIdentities(requests),
      resolvedAccountIdentitySummary: summarizeAuthorAccountIdentities(updatedRows.filter((row) => row?.status === "ready" && row.resolution)),
      legacyCountSemantics: "deprecated-Authors-and-matchedBy-fields-count-evidence-requests-not-distinct-authors;failedAuthors-excludes-deferred",
      requestedAuthors: requests.length,
      resolvedAuthors: verified.size,
      failedAuthors: requests.length - verified.size - deferredEvidenceRequestCount,
      resolvedRows,
      matchedById,
      matchedByName,
      matchedByEvidence,
      evidenceErrors,
      fetchFailedAuthors,
      identityMismatchAuthors,
      ambiguousAuthors,
      noEvidenceAuthors,
    },
  };
}

export function verifyQueuedAuthorEvidence(item, result) {
  const platform = platformFor(item);
  const sourceRows = Array.isArray(item?.sourceRows) && item.sourceRows.length ? item.sourceRows : [1];
  const base = {
    sourceRow: sourceRows[0],
    platform,
    name: clean(item?.name, 120),
    douyinId: platform === "douyin" ? clean(item?.douyinId, 120) : "",
    bilibiliId: platform === "bilibili" ? clean(item?.bilibiliId, 120) : "",
    organization: clean(item?.organization, 200),
    tier: clean(item?.tier, 120),
    category: clean(item?.category, 120),
    boards: Array.isArray(item?.boards) ? item.boards : [],
    locator: queuedAuthorAccountLocator(item) || null,
    status: "resolvable",
  };
  const evidenceRows = [];
  for (const [index, videoId] of (Array.isArray(item?.videoIds) ? item.videoIds : []).entries()) {
    evidenceRows.push({ ...base, sourceRow: sourceRows[index] ?? sourceRows[0], videoId: clean(videoId, 40), shareUrl: "" });
  }
  for (const [index, shareUrl] of (Array.isArray(item?.shareUrls) ? item.shareUrls : []).entries()) {
    evidenceRows.push({ ...base, sourceRow: sourceRows[index] ?? sourceRows[0], videoId: "", shareUrl: canonicalEvidenceUrl(shareUrl) });
  }
  if (!evidenceRows.length) {
    return { status: "invalid", row: null, reason: "后台核验队列缺少可逐项验证的原始作品证据", summary: null };
  }
  const requests = buildAuthorEvidenceRequests(evidenceRows);
  if (requests.length !== evidenceRows.length) {
    return { status: "invalid", row: null, reason: "后台核验队列中的作品证据无效或发生非预期合并，已阻止写入", summary: null };
  }
  const repeatedResult = requests.map((request) => ({
    ...(result && typeof result === "object" ? result : {}),
    key: request.key,
    candidates: Array.isArray(result?.candidates) ? result.candidates : [],
    errors: Array.isArray(result?.errors) ? result.errors : [],
  }));
  const verified = applyAuthorEvidence(evidenceRows, { items: repeatedResult });
  const readyRows = verified.rows.filter((row) => row?.status === "ready" && row?.locator);
  if (readyRows.length !== evidenceRows.length) {
    const reason = [...new Set(verified.rows.map((row) => clean(row?.reason, 760)).filter(Boolean))].join("；")
      || "并非每一项作品证据都完成公开核验，本次未写入";
    const rejected = Boolean(verified.summary.identityMismatchAuthors || verified.summary.ambiguousAuthors);
    return { status: rejected ? "rejected" : "retry", row: null, reason, summary: verified.summary };
  }
  const locators = [...new Set(readyRows.map((row) => row.locator))];
  if (locators.length !== 1) {
    return {
      status: "rejected",
      row: null,
      reason: "多项作品证据分别对应不同作者，已阻止自动加入监控",
      summary: { ...verified.summary, crossEvidenceOwnerConflict: true },
    };
  }
  const verifiedEvidence = readyRows.map((row) => ({
    sourceRow: row.sourceRow,
    videoId: clean(row.videoId, 40),
    shareUrl: canonicalEvidenceUrl(row.shareUrl),
    canonicalAccountId: clean(row.resolution?.canonicalAccountId, 240),
    publicNickname: clean(row.resolution?.publicNickname, 120),
    sourceEvidenceUrl: clean(row.resolution?.sourceEvidenceUrl, 500),
    provenance: clean(row.resolution?.provenance, 80),
  }));
  const aggregateEvidence = verifiedEvidence.slice(0, 100);
  const row = {
    ...readyRows[0],
    sourceRow: sourceRows[0],
    videoId: clean(item?.videoIds?.[0], 40),
    shareUrl: canonicalEvidenceUrl(item?.shareUrls?.[0]),
    boards: Array.isArray(item?.boards) ? item.boards : [],
    reason: `已逐项核验 ${verifiedEvidence.length} 项作品证据，全部确认归属同一作者`,
    resolution: {
      ...readyRows[0].resolution,
      verificationPolicy: "all-submitted-evidence-v2",
      verifiedEvidenceCount: verifiedEvidence.length,
      verifiedEvidenceSha256: createHash("sha256").update(JSON.stringify(verifiedEvidence)).digest("hex"),
      verifiedEvidence: aggregateEvidence,
      ...(aggregateEvidence.length < verifiedEvidence.length ? { verifiedEvidenceTruncated: true } : {}),
    },
  };
  return { status: "ready", row, reason: row.reason, summary: verified.summary };
}
