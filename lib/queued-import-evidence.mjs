import { prepareImportAuthorisedDetail } from './import-authorised-detail.mjs';
import { buildAuthorEvidenceRequests } from './author-resolution.mjs';

/** An importer may expand a share link before enqueueing, while keeping its
 * original submitted row unchanged. A canonical queue constraint is NOT proof:
 * retain it as an additional condition for the fresh official work response.
 * The original handle and every submitted work must still match exactly. */
export function bindQueuedImportEvidence(job, sourceRow, queue) {
  const originalInput = prepareImportAuthorisedDetail(job, { sourceRow });
  const original = job.request.rows.find(row => row.sourceRow === sourceRow);
  let request = buildAuthorEvidenceRequests([original])[0];
  const locator = queue.account_locator || '';
  if (request.key !== queue.identity_key && !request.accountLocator
    && !job.request.masterRosterSupplement && /^MS4wLj[\w-]{12,220}$/.test(locator)) {
    request = buildAuthorEvidenceRequests([{ ...original, locator }])[0];
  }
  const videos = JSON.parse(queue.video_ids_json), shares = JSON.parse(queue.share_urls_json);
  const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  if (request.key !== queue.identity_key || (request.accountLocator || '') !== locator
    || originalInput.submittedId !== normalize(queue.douyin_id)
    || JSON.stringify(request.videoIds) !== JSON.stringify(videos)
    || JSON.stringify(request.shareUrls) !== JSON.stringify(shares)) {
    throw new Error('原始账号、作品或队列定位约束不一致');
  }
  return { request, originalInput, input: { ...originalInput, key: request.key,
    ...(locator ? { expectedSecUid: locator } : {}) } };
}
