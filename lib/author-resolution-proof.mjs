/** Pure receipt verification. No database access, roster reads, browser or job side effects. */
import { createHash } from 'node:crypto';
import { normalizeAccountLocator } from './author-spreadsheet.mjs';
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return null; } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function canonicalResolvedAccount(value, platform) {
  const locator = normalizeAccountLocator(value, platform);
  if (!locator || (platform === 'douyin' && !/^MS4wLj[\w-]{12,220}$/.test(locator))) return '';
  return locator;
}

export function sameResolvedWorkLink(left, right) {
  const normalize = value => {
    try { const url = new URL(value); url.hash = ''; url.pathname = url.pathname.replace(/\/+$/, '') || '/'; return url.toString(); }
    catch { return ''; }
  };
  const a = normalize(left), b = normalize(right);
  return Boolean(a && b && a === b);
}

export function validatedSuccessProof(saved) {
  const proof = parse(saved?.payload_json), evidence = proof?.evidence, resolution = proof?.resolution;
  if (!proof || saved.receipt_sha256 !== hash(proof) || proof.format !== 'mcn-author-resolution-success-v1'
    || !Number.isSafeInteger(proof.queueId) || proof.queueId < 1 || !Number.isSafeInteger(proof.evidenceVersion) || proof.evidenceVersion < 1
    || proof.queueId !== saved.queue_id || proof.evidenceVersion !== saved.evidence_version || proof.identityKey !== saved.identity_key
    || proof.targetId !== saved.target_id || proof.platform !== saved.platform || proof.canonicalAccountId !== saved.canonical_account_id
    || !canonicalResolvedAccount(proof.canonicalAccountId, proof.platform) || proof.verifiedAt !== saved.verified_at || proof.verificationPolicyVersion !== 2
    || !Number.isFinite(Date.parse(proof.committedAt)) || Date.parse(proof.committedAt) > Date.now() + 1_000
    || !Number.isFinite(Date.parse(proof.verifiedAt)) || Date.parse(proof.verifiedAt) > Date.parse(proof.committedAt) + 1_000
    || resolution?.mode !== 'public-video-detail' || resolution.platform !== proof.platform || resolution.canonicalAccountId !== proof.canonicalAccountId
    || resolution.verificationPolicy !== 'all-submitted-evidence-v2' || resolution.verifiedEvidenceTruncated || resolution.resolvedAt !== proof.verifiedAt
    || !evidence || !Array.isArray(evidence.videoIds) || !Array.isArray(evidence.shareUrls)
    || evidence.videoIds.length + evidence.shareUrls.length < 1
    || new Set(evidence.videoIds).size !== evidence.videoIds.length || new Set(evidence.shareUrls).size !== evidence.shareUrls.length) return null;
  const verified = resolution.verifiedEvidence;
  if (!Array.isArray(verified) || verified.length !== resolution.verifiedEvidenceCount || verified.length !== evidence.videoIds.length + evidence.shareUrls.length
    || resolution.verifiedEvidenceSha256 !== hash(verified) || verified.some(value => value.canonicalAccountId !== proof.canonicalAccountId)
    || !evidence.videoIds.every(videoId => verified.some(value => value.videoId === videoId))
    || !evidence.shareUrls.every(shareUrl => verified.some(value => sameResolvedWorkLink(value.shareUrl, shareUrl) && sameResolvedWorkLink(value.sourceEvidenceUrl, shareUrl)))) return null;
  return proof;
}
