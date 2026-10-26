import { canonicalAccountLocator } from './author-spreadsheet.mjs';
import { normalizeCollection } from './providers/normalize.mjs';
import { checksum, safeJson, businessDateKey } from './utils.mjs';
import { browserWorksObservation } from './official-profile-evidence.mjs';
import { describeWorksObservation, loadVerifiedWorksOnlyRows } from './works-observation.mjs';
import { assertCommittedTargetPublication, committedSnapshotAllowed, committedRunningSnapshotIds } from './committed-target-publication.mjs';
import { loadDeferredWorksSnapshotRead } from './works-deferred-read.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0;
const accepted = value => ['validated', 'warning'].includes(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10) ? new Date(value).toISOString() : null;

function checkedSnapshot(row, target, platform, expected, asOf) {
  if (!expected || row.target_id !== target.id || !accepted(row.quality_status)
    || !['available', 'partial'].includes(row.account_status)) return null;
  const at = iso(row.captured_at);
  if (!at || at > asOf) return null;
  try {
    const raw = JSON.parse(row.raw_json), profile = raw.profile?.user ?? raw.user ?? raw.user_info;
    const identity = platform === 'douyin' ? profile?.sec_uid : profile?.uid ?? profile?.mid ?? profile?.user_id;
    if (checksum(raw) !== row.source_checksum || (raw.capturedAt != null && iso(raw.capturedAt) !== at)
      || canonicalAccountLocator(identity, platform) !== expected
      || (platform === 'douyin' && (typeof profile?.uid !== 'string' || !/^[1-9]\d{1,24}$/.test(profile.uid)))) return null;
    const normalized = normalizeCollection(target, raw, { capturedAt: at });
    if (![['followers', 'followers'], ['total_likes', 'totalLikes'], ['total_posts', 'totalPosts']]
      .every(([field, name]) => (row[field] ?? null) === (normalized.snapshot[name] ?? null)
        && (row[field] === null || count(row[field])))) return null;
    return { row, raw, profile, normalized, at };
  } catch { return null; }
}

function worksRow(value, target, platform, expected, verifiedWorks, asOf) {
  const { row, raw, profile, normalized, at } = value;
  const works = raw.works;
  let observedAt = iso(row.works_observed_at) ?? at;
  let attemptedAt = at;
  const list = works?.aweme_list;
  if (!Array.isArray(list)) return { id: row.id, captured_at: at, works_coverage: 'unavailable',
    source_checksum: row.source_checksum, list_type: null, entries_json: '[]', stop_reason: 'missing-list' };
  const ids = new Set(), saved = new Set(verifiedWorks.map(work => work.externalId));
  const idPattern = { douyin: /^\d{15,25}$/, bilibili: /^BV[0-9A-Za-z]{10}$/, xiaohongshu: /^[a-f\d]{24}$/i }[platform];
  let identitiesValid = Boolean(idPattern);
  for (const post of list) {
    const authorId = platform === 'douyin' ? post?.author?.sec_uid : post?.author?.uid ?? post?.author?.user_id;
    if (typeof post?.aweme_id !== 'string' || !idPattern?.test(post.aweme_id)
      || ids.has(post.aweme_id) || !saved.has(post.aweme_id)
      || canonicalAccountLocator(authorId, platform) !== expected
      || (platform === 'douyin' && post.author?.uid != null && post.author.uid !== '' && String(post.author.uid) !== profile.uid)) identitiesValid = false;
    ids.add(post?.aweme_id);
  }
  if (!identitiesValid) {
    return { id: row.id, captured_at: at, works_coverage: 'unavailable', source_checksum: row.source_checksum,
      list_type: null, entries_json: '[]', stop_reason: 'invalid-items' };
  }
  let terminal = false;
  try {
    const browser = browserWorksObservation(raw, { reference: Date.parse(asOf) });
    if (browser) {
      if (iso(row.works_observed_at) !== browser.observedAt || browser.observedAt > asOf) throw new Error('time mismatch');
      observedAt = browser.observedAt;
      attemptedAt = iso(works.sourceRequestFinishedAt);
      terminal = raw.provenance?.worksFallback?.runtimeAI === false
        && raw.provenance?.worksFallback?.paidAPI === false
        && raw.provenance?.worksFallback?.noChallengeBypass === true
        && works.pagination.stopReason === 'end-of-list' && works.pagination.errorCode === null
        && works.has_more === false;
    } else if (works.pagination?.version === 1 || row.works_observed_at != null) throw new Error('missing page observation');
    // Legacy no-page-time arrays remain an observed sample, never promote an
    // arbitrary stored `complete` label to verified pagination completeness.
  } catch {
    return { id: row.id, captured_at: at, works_coverage: 'unavailable', source_checksum: row.source_checksum,
      list_type: null, entries_json: '[]', stop_reason: 'invalid-list' };
  }
  const label = ['complete', 'limited', 'latest-public-window'].includes(normalized.worksCoverage);
  const coverage = !label ? 'unavailable' : terminal && count(row.total_posts)
    && list.length === row.total_posts ? 'complete' : 'limited';
  return { id: row.id, captured_at: observedAt, attempt_at: attemptedAt, works_coverage: coverage, source_checksum: row.source_checksum,
    total_posts: row.total_posts, list_type: coverage === 'unavailable' ? null : 'array', list_count: list.length,
    entries_json: JSON.stringify(list.map(post => ({ id: post.aweme_id, publishedAt: post.create_time ?? null }))),
    stop_reason: terminal ? 'end-of-list' : 'local-limit' };
}

/** Public replica contract: only these three evidence fields may leave the
 * producer. Internal verification reasons stay in the private audit trail. */
export function publicWorksCoverage(observation, { hasCandidates = false, verificationLimited = false } = {}) {
  const usable = ['complete', 'limited'].includes(observation?.coverage) && !observation?.carriedForward;
  const missing = !hasCandidates && !verificationLimited;
  return {
    status: verificationLimited ? 'unavailable' : missing ? 'missing' : usable ? observation.coverage : 'unavailable',
    attemptedAt: verificationLimited || missing ? null : iso(observation?.lastAttemptAt),
    observedAt: missing ? null : iso(observation?.observedAt),
  };
}

/** Caller owns a single read transaction. No constructor, migrations, writes,
 * URLs, raw errors, credentials, private locators or provider strings escape.
 * verifiedDaily/verifiedWorks are the export's existing identity-checked rows.
 * Automatic profile completeness also requires a finished same-source run.
 */
export function publicAccountCoverage(db, target, { asOf, verifiedDaily = [], verifiedWorks = [], committedPublication } = {}) {
  if (committedPublication !== undefined) assertCommittedTargetPublication(committedPublication, db, asOf);
  if (!iso(asOf) || iso(asOf) !== asOf || Date.parse(asOf) > Date.now() || !Number.isSafeInteger(target?.id) || target.id < 1
    || !Array.isArray(verifiedDaily) || !Array.isArray(verifiedWorks)) throw new TypeError('公开覆盖参数无效');
  const empty = { version: 1, profileObservedAt: null,
    works: { status: 'missing', attemptedAt: null, observedAt: null } };
  if (target.type !== 'account' || target.provider !== 'public-web') return empty;
  const platform = safeJson(target.metadata_json, {})?.platform ?? 'douyin';
  const expected = canonicalAccountLocator(target.locator, platform);
  const hasWorksTime = db.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'works_observed_at');
  const rows = db.prepare(`SELECT s.id,s.target_id,s.captured_at,s.followers,s.total_likes,s.total_posts,
      s.quality_status,s.account_status,s.works_coverage,s.source_checksum,s.raw_json,
      ${hasWorksTime ? 's.works_observed_at' : 'NULL AS works_observed_at'}
    FROM snapshots s WHERE s.target_id=? AND julianday(s.captured_at)<=julianday(?)
      AND EXISTS(SELECT 1 FROM audits a JOIN runs r ON r.id=a.run_id
        WHERE a.target_id=s.target_id AND a.provider='public-web' AND a.status IN ('validated','warning')
          AND a.source_checksum=s.source_checksum AND r.status IN ('success','partial')
          AND julianday(r.started_at)<=julianday(s.captured_at)
          AND julianday(s.captured_at)<=julianday(a.created_at)
          AND julianday(${hasWorksTime ? 'COALESCE(s.works_observed_at,s.captured_at)' : 's.captured_at'})<=julianday(a.created_at)
          AND (json_extract(CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END,'$.works.sourceRequestFinishedAt') IS NULL
            OR julianday(json_extract(CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END,'$.works.sourceRequestFinishedAt'))<=julianday(a.created_at))
          AND julianday(a.created_at)<=julianday(r.finished_at) AND julianday(r.finished_at)<=julianday(?))
    ORDER BY julianday(s.captured_at) DESC,s.id DESC`).all(target.id, asOf, asOf);
  const checked = rows.map(row => checkedSnapshot(row, target, platform, expected, asOf)).filter(Boolean);
  const days = new Set(verifiedDaily.map(point => point.date));
  const committedIds = committedRunningSnapshotIds(committedPublication, target.id);
  const committedRows = committedIds.length ? db.prepare(`SELECT s.* FROM snapshots s WHERE s.target_id=?
    AND s.id IN (SELECT value FROM json_each(?)) AND julianday(s.captured_at)<=julianday(?)
    ORDER BY julianday(s.captured_at) DESC,s.id DESC`).all(target.id, JSON.stringify(committedIds), asOf)
    .filter(row => committedSnapshotAllowed(committedPublication, row, { runningOnly: true }))
    .map(row => checkedSnapshot(row, target, platform, expected, asOf)).filter(Boolean) : [];
  const complete = [...checked,...committedRows].sort((a,b)=>b.at.localeCompare(a.at)||b.row.id-a.row.id)
    .find(value => days.has(businessDateKey(value.at, 'Asia/Shanghai'))
    && [value.row.followers, value.row.total_likes, value.row.total_posts].every(count));
  const ledger = loadVerifiedWorksOnlyRows(db, asOf, target.id);
  const latestAttempt = ledger.map(row => row.attempt_at ?? row.captured_at).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const deferredRead = loadDeferredWorksSnapshotRead(db, asOf, target.id, new Map([[target.id, latestAttempt]]));
  const snapshotWorks = checked.filter(value => !deferredRead.ignoredIds.has(value.row.id))
    .map(value => worksRow(value, target, platform, expected, verifiedWorks, asOf));
  const candidates = [...snapshotWorks, ...ledger].sort((a, b) =>
    Date.parse(b.attempt_at ?? b.captured_at) - Date.parse(a.attempt_at ?? a.captured_at)
    || (String(b.id).startsWith('works-only:') ? 1 : 0) - (String(a.id).startsWith('works-only:') ? 1 : 0)
    || (Number(b.observation_id ?? b.id) - Number(a.observation_id ?? a.id)));
  const observation = describeWorksObservation(candidates, asOf);
  const verificationLimited = deferredRead.budgetLimitedSnapshotIds.has(candidates[0]?.id);
  return { version: 1, profileObservedAt: complete?.at ?? null,
    works: publicWorksCoverage(observation, { hasCandidates: candidates.length > 0, verificationLimited }) };
}
