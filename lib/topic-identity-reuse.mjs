import { checksum } from "./utils.mjs";
const MODES = new Set(["douyin-authenticated-browser-search-and-detail", "douyin-official-anonymous-challenge-detail", "douyin-public-hashtag-search-and-detail"]);
const topicKey = value => typeof value === "string" ? value.normalize("NFKC").trim().replace(/^#+/, "").trim().toLowerCase() : "";
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === (value.includes(".") ? value : value.replace(/Z$/, ".000Z")) ? ms : NaN;
};
const empty = status => ({ status, challengeId: null, evidence: null });

// Only the topic identity is reusable. No historical counter is returned.
export function selectVerifiedTopicIdentity(target, rows, { now = Date.now() } = {}) {
  if (target?.type !== "hashtag" || target.provider !== "public-web" || !Number.isSafeInteger(target.id)
    || !topicKey(target.locator) || !Array.isArray(rows) || !Number.isFinite(now)) return empty("missing");
  const candidates = [];
  for (const row of rows) {
    if (row.target_id !== target.id || row.audit_target_id !== target.id || row.audit_provider !== "public-web"
      || !["validated", "warning"].includes(row.quality_status) || !["validated", "warning"].includes(row.audit_status)
      || !Number.isSafeInteger(row.run_id) || row.run_id <= 0 || !Number.isSafeInteger(row.audit_id) || row.audit_id <= 0
      || !Number.isSafeInteger(row.id) || row.id <= 0
      || !count(row.hashtag_participants) || !count(row.hashtag_views)
      || !/^[a-f0-9]{64}$/i.test(row.source_checksum ?? "") || row.audit_checksum !== row.source_checksum) continue;
    const start = timestamp(row.started_at), sampled = timestamp(row.captured_at);
    const audited = timestamp(row.audit_created_at), finished = timestamp(row.finished_at);
    if (![start, sampled, audited, finished].every(Number.isFinite)
      || !(start <= sampled && sampled <= audited && audited <= finished && finished <= now)) continue;
    let raw;
    try { raw = JSON.parse(row.raw_json); } catch { continue; }
    if (!raw || !MODES.has(raw.provenance?.mode) || raw.provenance.runtimeAI !== false || raw.provenance.paidAPI !== false || typeof raw.challengeId !== "string"
      || !/^\d{8,24}$/.test(raw.challengeId) || topicKey(raw.officialName) !== topicKey(target.locator)
      || topicKey(raw.hashtag ?? raw.label) !== topicKey(target.locator)) continue;
    if (raw.provenance.mode === "douyin-authenticated-browser-search-and-detail" && raw.provenance.authenticated !== true) continue;
    if (raw.capturedAt != null && timestamp(raw.capturedAt) !== sampled) continue;
    if (raw.provenance.mode !== "douyin-authenticated-browser-search-and-detail"
      && (raw.scope !== "douyin-official-challenge-detail" || raw.participants !== row.hashtag_participants || raw.views !== row.hashtag_views)) continue;
    const expectedHash = raw.provenance.mode === "douyin-authenticated-browser-search-and-detail"
      ? checksum({ tag: raw.hashtag, snapshot: { followers: null, totalLikes: null, totalPosts: null,
        hashtagParticipants: row.hashtag_participants, hashtagViews: row.hashtag_views, hashtagPosts: null, authorCount: null },
        raw: { challengeId: raw.challengeId, officialName: raw.officialName, searchKeyword: raw.searchKeyword } })
      : checksum(raw);
    if (expectedHash !== row.source_checksum) continue;
    candidates.push({ challengeId: raw.challengeId, evidence: { snapshotId: row.id, auditId: row.audit_id,
      runId: row.run_id, capturedAt: row.captured_at, sourceChecksum: row.source_checksum }, sampled });
  }
  if (!candidates.length) return empty("missing");
  if (new Set(candidates.map(item => item.challengeId)).size !== 1) return empty("conflict");
  candidates.sort((a, b) => b.sampled - a.sampled || b.evidence.snapshotId - a.evidence.snapshotId);
  return { status: "verified", challengeId: candidates[0].challengeId, evidence: candidates[0].evidence };
}

export function readVerifiedTopicIdentity(database, target, options) {
  const connection = database?.db ?? database;
  if (typeof connection?.prepare !== "function") return empty("missing");
  // Read-only SELECT. Do not instantiate a database or migrate/backfill evidence.
  const rows = connection.prepare(`SELECT s.id,s.target_id,s.captured_at,s.hashtag_participants,s.hashtag_views,
      s.quality_status,s.source_checksum,s.raw_json,a.id AS audit_id,a.target_id AS audit_target_id,
      a.provider AS audit_provider,a.status AS audit_status,a.source_checksum AS audit_checksum,
      a.created_at AS audit_created_at,a.run_id,r.started_at,r.finished_at
    FROM snapshots s JOIN audits a ON a.target_id=s.target_id AND a.source_checksum=s.source_checksum
    JOIN runs r ON r.id=a.run_id WHERE s.target_id=?
      AND s.hashtag_participants IS NOT NULL AND s.hashtag_views IS NOT NULL`).all(target.id);
  return selectVerifiedTopicIdentity(target, rows, options);
}
