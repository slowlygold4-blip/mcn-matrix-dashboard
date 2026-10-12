import { canonicalAccountLocator } from './author-spreadsheet.mjs';
import { normalizeCollection, normalizeManualCollection } from './providers/normalize.mjs';
import { asNonNegativeInteger, checksum, isCalendarDate } from './utils.mjs';

const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const iso = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const instant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
  && isCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function findValue(source, keys, depth = 0, seen = new Set()) {
  if (!source || typeof source !== 'object' || depth > 5 || seen.has(source)) return undefined;
  seen.add(source);
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findValue(value, keys, depth + 1, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function normalizeAccountMetrics(target, raw) {
  if (target.provider === 'manual') {
    return {
      followers: asNonNegativeInteger(raw.snapshot?.followers),
      totalLikes: asNonNegativeInteger(raw.snapshot?.totalLikes),
      totalPosts: asNonNegativeInteger(raw.snapshot?.totalPosts),
    };
  }
  const profile = raw?.user ?? raw?.user_info ?? raw?.profile ?? raw?.creator ?? raw;
  return {
    followers: asNonNegativeInteger(findValue(profile, ['follower_count', 'followers', 'fans_count'])),
    totalLikes: asNonNegativeInteger(findValue(profile, ['total_favorited', 'total_likes', 'liked_count'])),
    totalPosts: asNonNegativeInteger(findValue(profile, ['aweme_count', 'video_count', 'post_count', 'works_count'])),
  };
}

export function isManualImportSnapshot(row, target) {
  if (!row || !target || target.provider === 'manual') return false;
  try {
    const raw = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json;
    return Boolean(raw && typeof raw === 'object' && (raw.codexObservation?.source === 'manual-import'
      // Older imports used this exact envelope before the explicit source
      // marker existed. It is not the shape returned by public platform APIs.
      || Object.hasOwn(raw, 'snapshot')));
  } catch { return false; }
}

/**
 * A profile snapshot is usable as an account observation only when its saved
 * payload, platform identity, collection timestamp, and normalized counters
 * all bind to the same persisted row. Manual-provider targets intentionally
 * use the manual input contract; manual input attached to a public-web target
 * must not masquerade as a public platform observation.
 */
export function validateAccountSnapshot(row, target, platform = null, { metricsOnly = false } = {}) {
  const fail = reason => ({ valid: false, reason });
  if (!row || !target || !['validated', 'warning'].includes(row.quality_status)) return fail('quality');
  const capturedAt = iso(row.captured_at);
  if (!capturedAt) return fail('captured-at');
  try {
    const raw = JSON.parse(row.raw_json);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('raw-payload');
    if (checksum(raw) !== row.source_checksum) return fail('checksum');
    if (isManualImportSnapshot({ raw_json: raw }, target)) return fail('manual-source');
    if (raw.capturedAt !== undefined && instant(raw.capturedAt) !== capturedAt) return fail('captured-at-mismatch');
    const selectedPlatform = platform ?? (() => {
      try { return JSON.parse(target.metadata_json ?? '{}')?.platform ?? 'douyin'; } catch { return 'douyin'; }
    })();
    if (target.provider !== 'manual') {
      const profile = raw.profile?.user ?? raw.user ?? raw.user_info;
      const profileId = selectedPlatform === 'douyin' ? profile?.sec_uid : profile?.uid ?? profile?.mid ?? profile?.user_id;
      const expected = canonicalAccountLocator(target.locator, selectedPlatform);
      if (!expected || canonicalAccountLocator(profileId, selectedPlatform) !== expected
        || (selectedPlatform === 'douyin' && !/^[1-9]\d{1,24}$/.test(String(profile?.uid ?? '')))) return fail('identity');
    }
    const sourceSnapshot = metricsOnly
      ? normalizeAccountMetrics(target, raw)
      : (target.provider === 'manual'
        ? normalizeManualCollection(target, raw)
        : normalizeCollection(target, raw, { capturedAt: row.captured_at })).snapshot;
    const pairs = [['followers', 'followers'], ['total_likes', 'totalLikes'], ['total_posts', 'totalPosts']];
    if (!pairs.every(([stored, normalized]) => (row[stored] ?? null) === (sourceSnapshot[normalized] ?? null)
      && (row[stored] === null || validCount(row[stored])))) return fail('metric-vector');
    return { valid: true, reason: null };
  } catch {
    return fail('malformed');
  }
}
