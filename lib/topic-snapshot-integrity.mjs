import { checksum, isCalendarDate } from './utils.mjs';

const MODES = new Set([
  'douyin-authenticated-browser-search-and-detail',
  'douyin-official-anonymous-challenge-detail',
  'douyin-public-hashtag-search-and-detail',
]);
const OFFICIAL_DETAIL = 'https://www.douyin.com/aweme/v1/web/challenge/detail/';
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const topicKey = value => typeof value === 'string'
  ? value.normalize('NFKC').trim().replace(/^#+/, '').trim().toLocaleLowerCase()
  : '';

function instant(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !isCalendarDate(value.slice(0, 10))) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.replace(/Z$/, '.000Z'))
    ? parsed : NaN;
}

/**
 * Verify that a saved Douyin topic counter is bound to the exact target,
 * public-web collection, audit, source payload, and sampling time. This is a
 * read-side check: it never repairs or rewrites persisted observations.
 */
export function validateTopicSnapshot(row, target, { asOf = Date.now() } = {}) {
  const fail = reason => ({ valid: false, reason, participants: null, views: null });
  if (!row || !target || target.type !== 'hashtag' || target.provider !== 'public-web') return fail('provider');
  if (row.target_id !== target.id || row.audit_target_id !== target.id
    || row.audit_provider !== 'public-web') return fail('target-audit-binding');
  if (!positive(row.id) || !positive(row.audit_id) || !positive(row.run_id)
    || (row.run_target_id !== null && row.run_target_id !== target.id)) return fail('run-binding');
  if (!['running', 'success', 'partial', 'error', 'interrupted'].includes(row.run_status)
    || (row.run_status === 'running' && row.finished_at !== null)
    || (row.run_status !== 'running' && row.finished_at === null)) return fail('run-state');
  if (!['validated', 'warning'].includes(row.quality_status)
    || row.audit_status !== row.quality_status) return fail('quality');
  if (!/^[a-f0-9]{64}$/i.test(row.source_checksum ?? '') || row.audit_checksum !== row.source_checksum) return fail('checksum-binding');

  const capturedAt = instant(row.captured_at);
  const startedAt = instant(row.started_at);
  const auditAt = instant(row.audit_created_at);
  const finishedAt = row.finished_at === null ? null : instant(row.finished_at);
  if (![capturedAt, startedAt, auditAt].every(Number.isFinite)
    || (row.finished_at !== null && !Number.isFinite(finishedAt))
    || startedAt > capturedAt || capturedAt > auditAt
    || (finishedAt !== null && (auditAt > finishedAt || finishedAt > asOf))
    || auditAt > asOf) return fail('time');

  let raw;
  try { raw = JSON.parse(row.raw_json); } catch { return fail('raw-payload'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('raw-payload');
  const provenance = raw.provenance;
  if (!MODES.has(provenance?.mode) || provenance.runtimeAI !== false || provenance.paidAPI !== false
    || typeof raw.challengeId !== 'string' || !/^\d{8,24}$/.test(raw.challengeId)
    || topicKey(raw.officialName) !== topicKey(target.locator)
    || topicKey(raw.hashtag ?? raw.label) !== topicKey(target.locator)) return fail('source-identity');

  const browser = provenance.mode === 'douyin-authenticated-browser-search-and-detail';
  if (browser ? provenance.authenticated !== true : provenance.authenticated !== false) return fail('source-provenance');
  const hasPayloadTime = Object.hasOwn(raw, 'capturedAt');
  const hasTimeVersion = Object.hasOwn(raw, 'topicTimeContractVersion');
  if (hasTimeVersion && raw.topicTimeContractVersion !== 1) return fail('time-contract-version');
  // The original anonymous-detail writer stored its top-level observation
  // instant in the ledger and hashed its complete raw payload in the audit.
  // It did not include time inside raw. This narrowly recognized legacy
  // contract keeps every ledger/audit/time and full-payload check below; it
  // never claims the payload itself included an observation timestamp.
  // Browser hashes cover only a normalized subset and cannot use this path.
  const legacyTime = !hasPayloadTime && !hasTimeVersion
    && provenance.mode === 'douyin-official-anonymous-challenge-detail';
  if (!legacyTime && instant(raw.capturedAt) !== capturedAt) return fail('time-binding');

  const participants = count(row.hashtag_participants) ? row.hashtag_participants : null;
  const views = count(row.hashtag_views) ? row.hashtag_views : null;
  if ((row.hashtag_participants !== null && participants === null)
    || (row.hashtag_views !== null && views === null)
    || (participants === null && views === null)) return fail('counter');

  if (browser) {
    const expected = checksum({
      tag: raw.hashtag,
      snapshot: {
        followers: null, totalLikes: null, totalPosts: null,
        hashtagParticipants: row.hashtag_participants, hashtagViews: row.hashtag_views,
        hashtagPosts: null, authorCount: null,
      },
      raw: { challengeId: raw.challengeId, officialName: raw.officialName, searchKeyword: raw.searchKeyword },
    });
    if (expected !== row.source_checksum) return fail('source-checksum');
  } else {
    if (provenance.endpoint !== OFFICIAL_DETAIL || raw.scope !== 'douyin-official-challenge-detail'
      || raw.businessStatusCode !== 0
      || (raw.participants ?? null) !== row.hashtag_participants
      || (raw.views ?? null) !== row.hashtag_views
      || checksum(raw) !== row.source_checksum) return fail('source-payload');
  }

  if ((participants === null || views === null) && row.quality_status !== 'warning') return fail('partial-quality');
  return { valid: true, reason: null, participants, views,
    timeBinding: legacyTime ? 'ledger-audit-legacy' : 'payload-observation-time' };
}
