import { checksum } from './utils.mjs';
import { validatedBrowserPagination, isOfficialDeferredProfileEnvelope, isOfficialMixedProfileEnvelope, isOfficialScheduledProfileEnvelope } from './official-profile-evidence.mjs';
import { normalizePost } from './providers/normalize.mjs';
import { assertPostHistoryIdentity, persistPosts } from './post-persistence.mjs';
import { projectWorksRequestPolicy } from './works-request-policy.mjs';
import { projectWorksOnlyFailure } from './works-only-failure.mjs';
import { readTrustedWorksResume, readWorksSamplingState } from './works-observation.mjs';

const ERRORS = new Set(['blocked', 'login_required', 'rate_limited', 'network_error', 'collector_error', 'upstream_changed']);
function fail() { throw Object.assign(new Error('独立作品证据未通过校验；未写入观察'), { code: 'WORKS_OBSERVATION_INVALID' }); }
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return Date.parse(value);
}

// Importing this module does not open/migrate a database. Initialization is
// explicit, including when the owning MonitorDatabase runs its migrations.
export function initializeWorksOnlyObservations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS works_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER NOT NULL REFERENCES targets(id),
    run_id INTEGER NOT NULL REFERENCES runs(id),
    anchor_snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    anchor_checksum TEXT NOT NULL,
    request_started_at TEXT NOT NULL,
    request_finished_at TEXT NOT NULL,
    observed_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('accepted','unavailable')),
    coverage TEXT NOT NULL CHECK(coverage IN ('limited','unavailable')),
    error_code TEXT,
    source_checksum TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(target_id,request_finished_at)
  );
  CREATE INDEX IF NOT EXISTS works_observations_target_time ON works_observations(target_id,request_finished_at,id);
  CREATE TRIGGER IF NOT EXISTS works_observations_no_update BEFORE UPDATE ON works_observations
    BEGIN SELECT RAISE(ABORT,'immutable works observation'); END;
  CREATE TRIGGER IF NOT EXISTS works_observations_no_delete BEFORE DELETE ON works_observations
    BEGIN SELECT RAISE(ABORT,'immutable works observation'); END;`);
  // Pre-integration experimental ledgers had no run link. Preserve those rows
  // as unproven history; never invent a run for them or accept them in readers.
  const columns = db.prepare('PRAGMA table_info(works_observations)').all();
  if (!columns.some(column => column.name === 'run_id')) db.exec('ALTER TABLE works_observations ADD COLUMN run_id INTEGER REFERENCES runs(id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS works_observations_run ON works_observations(run_id) WHERE run_id IS NOT NULL');
  // Small derived index only: no raw rows, historical timestamps or immutable
  // source payloads are rewritten when introducing independent head/backfill.
  db.exec(`CREATE INDEX IF NOT EXISTS works_observations_sampling_windows ON works_observations(
    target_id, (CASE WHEN json_valid(raw_json) THEN json_type(raw_json,'$.continuation') IS NOT NULL ELSE 0 END),
    julianday(request_finished_at) DESC, id DESC) WHERE status='accepted'`);
}

export function readWorksOnlyAnchor(db, targetId, { now = Date.now() } = {}) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(targetId) || targetId <= 0) fail();
  const target = db.prepare('SELECT type,provider,enabled,locator,metadata_json FROM targets WHERE id=?').get(targetId);
  const anchor = db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1').get(targetId);
  const audit = db.prepare(`SELECT source_checksum,status,provider,created_at FROM audits WHERE target_id=?
    ORDER BY julianday(created_at) DESC,id DESC LIMIT 1`).get(targetId);
  const lifecycle = db.prepare(`SELECT event_json FROM account_events WHERE target_id=? AND event_type='lifecycle'
    ORDER BY julianday(observed_at) DESC,id DESC LIMIT 1`).get(targetId);
  if (!target || !target.enabled || target.type !== 'account' || target.provider !== 'public-web' || !anchor
    || audit?.source_checksum !== anchor.source_checksum || audit.provider !== 'public-web' || !['validated', 'warning'].includes(audit.status)
    || !['validated', 'warning'].includes(anchor.quality_status) || !['available', 'partial'].includes(anchor.account_status)) fail();
  let raw;
  try {
    raw = JSON.parse(anchor.raw_json);
    const platform = JSON.parse(target.metadata_json ?? '{}')?.platform;
    if (platform != null && platform !== 'douyin') fail();
    if (lifecycle && JSON.parse(lifecycle.event_json)?.state === 'deleted') fail();
  } catch { fail(); }
  if (checksum(raw) !== anchor.source_checksum || (!isOfficialDeferredProfileEnvelope(raw) && !isOfficialMixedProfileEnvelope(raw)
    && !isOfficialScheduledProfileEnvelope(raw))) fail();
  const profile = raw.profile?.user;
  const captured = instant(anchor.captured_at);
  if (captured !== instant(raw.capturedAt) || captured > now || now - captured > 8 * 3600_000
    || instant(audit.created_at) < captured || instant(audit.created_at) > now
    || !profile || profile.sec_uid !== target.locator || !/^MS4wLj[\w-]{12,220}$/.test(profile.sec_uid)
    || typeof profile.uid !== 'string' || !/^[1-9]\d{1,24}$/.test(profile.uid)
    || profile.user_deleted === true) fail();
  return { snapshotId: Number(anchor.id), sourceChecksum: anchor.source_checksum, capturedAt: anchor.captured_at,
    secUid: profile.sec_uid, uid: profile.uid };
}

function canonicalEvidence(input, identity, now) {
  const { targetId, runId, anchorSnapshotId, anchorChecksum, requestStartedAt, requestFinishedAt, result, requestedLimit = 30 } = input;
  const start = instant(requestStartedAt), finish = instant(requestFinishedAt);
  if (!Number.isFinite(now) || start > finish || finish > now || finish - start > 45_000
    || ![targetId, runId, anchorSnapshotId].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof anchorChecksum !== 'string' || !/^[a-f\d]{64}$/.test(anchorChecksum)
    || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100
    || typeof identity?.secUid !== 'string' || !/^MS4wLj[\w-]{12,220}$/.test(identity.secUid)
    || typeof identity?.uid !== 'string' || !/^[1-9]\d{1,24}$/.test(identity.uid)) fail();
  const profile = { sec_uid: identity.secUid, uid: identity.uid };
  if (!result || !['ok', 'unavailable'].includes(result.status) || !Array.isArray(result.posts)
    || result.posts.length > requestedLimit || (result.errorCode != null && !ERRORS.has(result.errorCode))) fail();
  const posts = [], ids = new Set();
  for (const post of result.posts) {
    if (!post || !/^\d{15,25}$/.test(post.aweme_id) || typeof post.aweme_id !== 'string'
      || ids.has(post.aweme_id) || post.author?.sec_uid !== profile.sec_uid
      || String(post.author?.uid ?? '') !== String(profile.uid)) fail();
    ids.add(post.aweme_id);
    if (post.statistics != null && (typeof post.statistics !== 'object' || Array.isArray(post.statistics))) fail();
    const statistics = {};
    for (const field of ['digg_count', 'comment_count', 'share_count', 'collect_count', 'play_count']) {
      const value = post.statistics?.[field];
      if (value == null) continue;
      if (!Number.isSafeInteger(value) || value < 0) fail();
      statistics[field] = value;
    }
    // Public work metadata is permitted; request headers, signed URLs, DOM
    // dumps, credentials and unrecognized raw properties are not persisted.
    const projected = { aweme_id: post.aweme_id, author: { sec_uid: profile.sec_uid, uid: String(profile.uid) }, statistics };
    if (post.desc != null) {
      if (typeof post.desc !== 'string') fail();
      projected.desc = post.desc.slice(0, 2000);
    }
    if (post.create_time !== undefined) {
      if (post.create_time !== null && (!Number.isSafeInteger(post.create_time) || post.create_time < 0)) fail();
      projected.create_time = post.create_time;
    }
    const normalized = normalizePost(projected);
    if (normalized.externalId !== post.aweme_id || normalized.authorId !== profile.sec_uid) fail();
    posts.push(projected);
  }
  let pagination = null, observedAt = null;
  const accepted = result.status === 'ok';
  if (accepted) {
    pagination = validatedBrowserPagination(result.pagination, { limit: requestedLimit, posts,
      hasMore: result.hasMore, maxCursor: result.maxCursor, notBefore: requestStartedAt, notAfter: finish,
      startCursor: input.continuation?.cursor });
    if (!pagination || pagination.errorCode !== (result.errorCode ?? null)) fail();
    observedAt = pagination.pages.at(-1).observedAt;
    let offset = 0;
    for (const page of pagination.pages) {
      for (const post of posts.slice(offset, offset + page.acceptedCount)) {
        if (post.create_time != null && post.create_time * 1000 > instant(page.observedAt)) fail();
      }
      offset += page.acceptedCount;
    }
  } else if (posts.length || !ERRORS.has(result.errorCode)) fail();
  const policy = input.worksRequestPolicy === undefined ? undefined : projectWorksRequestPolicy(input.worksRequestPolicy);
  if (policy !== undefined && (!policy || policy.browser?.attempted !== true || policy.browser?.deferred !== false)) fail();
  if (input.continuation && (input.continuation.version !== 1 || !Number.isSafeInteger(input.continuation.cursor)
    || input.continuation.cursor < 0 || !Number.isSafeInteger(input.continuation.depth) || input.continuation.depth < 1
    || input.continuation.depth > 24 || !Number.isSafeInteger(input.continuation.runId) || input.continuation.runId >= runId
    || !Number.isSafeInteger(input.continuation.observationId) || !/^[a-f\d]{64}$/.test(input.continuation.sourceChecksum))) fail();
  return { version: input.continuation ? 2 : 1, ...(input.continuation ? { continuation: input.continuation } : {}), kind: 'works-only-observation', source: 'authorised-browser', targetId, runId,
    anchorSnapshotId, anchorChecksum, requestedLimit, identity: { secUid: profile.sec_uid, uid: String(profile.uid) },
    requestStartedAt, requestFinishedAt, observedAt, status: accepted ? 'accepted' : 'unavailable',
    coverage: accepted ? 'limited' : 'unavailable', errorCode: result.errorCode ?? null, posts, pagination,
    ...(policy ? { worksRequestPolicy: policy } : {}), ...projectWorksOnlyFailure(result) };
}

// Historical readers reuse the canonical contract without requiring an old
// observation's anchor to remain today's latest profile. DB/run checks remain
// the reader's responsibility; this function performs no database operations.
export function validateWorksOnlyEvidence(evidence, { now = Date.now() } = {}) {
  const lastPage = evidence?.pagination?.pages?.at(-1);
  const canonical = canonicalEvidence({ ...evidence, result: {
    status: evidence?.status === 'accepted' ? 'ok' : evidence?.status,
    posts: evidence?.posts, pagination: evidence?.pagination,
    hasMore: lastPage?.response?.has_more, maxCursor: lastPage?.response?.max_cursor,
    errorCode: evidence?.errorCode,
    ...projectWorksOnlyFailure(evidence),
  } }, evidence?.identity, now);
  if (checksum(canonical) !== checksum(evidence)) fail();
  return canonical;
}

export function recordWorksOnlyObservation(db, input, { now = Date.now() } = {}) {
  // Revalidate the actual anchor and current target inside the same transaction
  // as append/idempotency checks. No caller-supplied verified flag is trusted.
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    started = true;
    const anchor = readWorksOnlyAnchor(db, input.targetId, { now: instant(input.requestStartedAt) });
    if (anchor.snapshotId !== input.anchorSnapshotId || anchor.sourceChecksum !== input.anchorChecksum) fail();
    if (input.continuation && checksum(input.continuation) !== checksum(readTrustedWorksResume(db, input.targetId,
      anchor, input.requestStartedAt)) && checksum(input.continuation) !== checksum(readWorksSamplingState(db,
        input.targetId, anchor, input.requestStartedAt).continuation)) fail();
    const evidence = canonicalEvidence(input, { secUid: anchor.secUid, uid: anchor.uid }, now);
    const run = db.prepare('SELECT target_id,trigger_type,status,started_at,finished_at,target_count FROM runs WHERE id=?').get(evidence.runId);
    if (!run || run.target_id !== evidence.targetId || run.trigger_type !== 'works-only' || run.status !== 'running'
      || run.finished_at !== null || run.target_count !== 1 || instant(run.started_at) > instant(evidence.requestStartedAt)) fail();
    const sourceChecksum = checksum(evidence);
    const old = db.prepare('SELECT id,source_checksum FROM works_observations WHERE target_id=? AND request_finished_at=?')
      .get(evidence.targetId, evidence.requestFinishedAt);
    if (old && old.source_checksum !== sourceChecksum) fail();
    const id = old?.id ?? Number(db.prepare(`INSERT INTO works_observations
      (target_id,run_id,anchor_snapshot_id,anchor_checksum,request_started_at,request_finished_at,observed_at,status,coverage,error_code,source_checksum,raw_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(evidence.targetId, evidence.runId, evidence.anchorSnapshotId, evidence.anchorChecksum,
      evidence.requestStartedAt, evidence.requestFinishedAt, evidence.observedAt, evidence.status, evidence.coverage,
      evidence.errorCode, sourceChecksum, JSON.stringify(evidence), new Date(now).toISOString()).lastInsertRowid);
    if (!old && evidence.status === 'accepted') {
      const target = { id: evidence.targetId, type: 'account' };
      const posts = evidence.posts.map(post => normalizePost(post));
      const postTimes = new Map(); let offset = 0;
      for (const page of evidence.pagination.pages) {
        for (const post of posts.slice(offset, offset + page.acceptedCount)) postTimes.set(post.externalId, page.observedAt);
        offset += page.acceptedCount;
      }
      if (offset !== posts.length || postTimes.size !== posts.length) fail();
      assertPostHistoryIdentity(db, target, posts, evidence.identity.secUid);
      persistPosts(db, { target, posts, expectedAuthorId: evidence.identity.secUid, capturedAt: evidence.observedAt, postTimes });
    }
    db.exec('COMMIT');
    return { id, status: evidence.status, coverage: evidence.coverage, observedAt: evidence.observedAt, sourceChecksum, duplicate: Boolean(old) };
  } catch {
    if (started) { try { db.exec('ROLLBACK'); } catch {} }
    fail();
  }
}
