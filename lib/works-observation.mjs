import { createHash } from 'node:crypto';
import { checksum } from './utils.mjs';
import { validateWorksOnlyEvidence } from './works-only-observation.mjs';
import { isOfficialDeferredProfileEnvelope, isOfficialMixedProfileEnvelope, isOfficialScheduledProfileEnvelope } from './official-profile-evidence.mjs';
import { loadDeferredWorksSnapshotRead } from './works-deferred-read.mjs';

const verifiedLedgerRows = new WeakSet();
function evidenceTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}
// This is an in-process read receipt, never a caller-supplied `verified` flag.
export function isVerifiedWorksOnlyRow(row) { return verifiedLedgerRows.has(row); }

/** Read legacy databases without migrations; only completed, DB-bound evidence
 * can enter the read model. Decode latest attempt + two accepted windows per
 * target, not the whole immutable ledger. Explicit runIds is a batch history
 * lookup of caller-selected runs and leaves the default window unchanged.
 * No profile values are projected. */
export function loadVerifiedWorksOnlyRows(db, asOf, targetId = null, options = {}) {
  return loadVerifiedWorksOnlyRowsInRead(db, asOf, targetId, options);
}

function loadVerifiedWorksOnlyRowsInRead(db, asOf, targetId, { runId = null, runIds = null, acceptedPerTarget = 2 } = {}, receipt = null) {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error('作品观察截止时间无效');
  if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0)) throw new Error('账号编号无效');
  if (runId !== null && (!Number.isSafeInteger(runId) || runId <= 0)) throw new Error('采集编号无效');
  if (![1, 2].includes(acceptedPerTarget)) throw new Error('每个账号的已接受作品观察数无效');
  if (runIds !== null && (!Array.isArray(runIds) || runId !== null
    || runIds.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new Error('历史采集编号无效');
  if (runIds?.length === 0) return [];
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'").get()) return [];
  if (!db.prepare('PRAGMA table_info(works_observations)').all().some(column => column.name === 'run_id')) return [];
  const filter = (targetId === null ? '' : ' AND w.target_id=?') + (runId === null ? '' : ' AND w.run_id=?')
    + (runIds === null ? '' : ' AND w.run_id IN (SELECT value FROM json_each(?))');
  const boundedDefaultSelection = runId === null && runIds === null;
  // The default read needs at most three ledger nodes per target (latest
  // attempt plus two accepted observations). Window-ranking the complete
  // immutable ledger made SQLite sort/materialize every raw_json payload on
  // every monitoring-status request. Keep the same ordering and cutoff, but
  // use target-scoped indexed lookups so the evidence verifier sees only the
  // bounded candidate set. Explicit run/runIds history reads retain their
  // caller-selected semantics below.
  const selectionSql = boundedDefaultSelection
    ? `scoped_targets AS (SELECT id FROM targets${targetId === null ? '' : ' WHERE id=?'}), selected AS (
      SELECT latest.id FROM scoped_targets t JOIN works_observations latest ON latest.id=(
        SELECT w.id FROM works_observations w WHERE w.target_id=t.id AND julianday(w.request_finished_at)<=julianday(?)
        ORDER BY julianday(w.request_finished_at) DESC,w.id DESC LIMIT 1)
      UNION
      SELECT accepted.id FROM scoped_targets t JOIN works_observations accepted ON accepted.id IN (
        SELECT candidate.id FROM works_observations candidate WHERE candidate.target_id=t.id
          AND candidate.status='accepted' AND julianday(candidate.request_finished_at)<=julianday(?)
        ORDER BY julianday(candidate.observed_at) DESC,candidate.id DESC LIMIT ${acceptedPerTarget}))`
    : `ranked AS (
      SELECT w.id,w.target_id,w.run_id,w.status,
        ROW_NUMBER() OVER(PARTITION BY w.target_id ORDER BY julianday(w.request_finished_at) DESC,w.id DESC) latest_rank,
        ROW_NUMBER() OVER(PARTITION BY w.target_id ORDER BY CASE WHEN w.status='accepted' THEN 0 ELSE 1 END,
          julianday(w.observed_at) DESC,w.id DESC) accepted_rank
      FROM works_observations w WHERE julianday(w.request_finished_at)<=julianday(?)${filter}
    ), selected AS (SELECT id FROM ranked WHERE ${runIds === null ? 'latest_rank=1 OR (status=\'accepted\' AND accepted_rank<=2)' : '1=1'})`;
  const selectionParams = boundedDefaultSelection
    ? [...(targetId === null ? [] : [targetId]), asOf, asOf]
    : [asOf, ...(targetId === null ? [] : [targetId]), ...(runId === null ? [] : [runId]),
      ...(runIds === null ? [] : [JSON.stringify([...new Set(runIds)])])];
  // One SQL statement owns the entire bounded graph snapshot. JSON references
  // only discover candidates here: every node and edge is independently checked
  // below. Reuse never survives its owning synchronous SQLite read snapshot.
  const rows = db.prepare(`WITH ${selectionSql}, chain(id,depth) AS (
    SELECT id,0 FROM selected
    UNION
    SELECT p.id,c.depth+1 FROM chain c JOIN works_observations child ON child.id=c.id
      JOIN works_observations p ON p.target_id=child.target_id
        AND p.run_id=json_extract(CASE WHEN json_valid(child.raw_json) THEN child.raw_json ELSE '{}' END,'$.continuation.runId')
      WHERE c.depth<24 AND p.run_id<child.run_id
  ), included AS (SELECT DISTINCT id FROM chain)
  SELECT w.*,EXISTS(SELECT 1 FROM selected chosen WHERE chosen.id=w.id) selected_row,
      t.locator current_locator,t.type target_type,t.provider target_provider,
      r.trigger_type run_trigger,r.target_id run_target,r.target_count run_target_count,r.processed_count run_processed_count,
      r.started_at run_started_at,r.finished_at run_finished_at,r.status run_status,
      EXISTS(SELECT 1 FROM runs intervening WHERE intervening.trigger_type='works-only'
        AND intervening.target_id=w.target_id
        AND intervening.id>json_extract(CASE WHEN json_valid(w.raw_json) THEN w.raw_json ELSE '{}' END,'$.continuation.runId')
        AND intervening.id<w.run_id AND intervening.finished_at IS NOT NULL
        AND julianday(intervening.finished_at)<=julianday(w.request_started_at)) intervening_finished_works_run,
      s.target_id anchor_target,s.captured_at anchor_at,s.source_checksum anchor_hash,s.total_posts anchor_total_posts,s.raw_json anchor_raw,
      s.quality_status anchor_quality,s.account_status anchor_status,
      EXISTS(SELECT 1 FROM audits a WHERE a.target_id=w.target_id AND a.source_checksum=w.anchor_checksum
        AND a.provider='public-web' AND a.status IN ('validated','warning')
        AND julianday(a.created_at)>=julianday(s.captured_at)
        AND julianday(a.created_at)<=julianday(w.request_started_at)) anchor_audited
    FROM included i JOIN works_observations w ON w.id=i.id
      JOIN targets t ON t.id=w.target_id JOIN runs r ON r.id=w.run_id
      JOIN snapshots s ON s.id=w.anchor_snapshot_id
    ORDER BY w.target_id,julianday(w.request_finished_at) DESC,w.id DESC`).all(...selectionParams);
  const byRun = new Map(rows.map(row => [`${row.target_id}:${row.run_id}`, row]));
  const checked = new Map();
  const verifiedById = receipt?.verifiedById ?? new Map();
  const parentById = receipt?.parentById ?? new Map();
  const anchorSourceById = receipt?.anchorSourceById ?? new Map();
  function verify(row, depth = 0) {
    if (!row || depth > 24) return null;
    if (checked.has(row.id)) return checked.get(row.id);
    // Only successful source nodes are shared; depth-dependent failures stay
    // local to this graph traversal. Promoted read models are never receipts.
    if (receipt && depth + receipt.heightById.get(row.id) <= 24 && verifiedById.has(row.id)) {
      return verifiedById.get(row.id);
    }
    // A failed or cyclic node cannot acquire a trusted receipt through reuse.
    checked.set(row.id, null);
    try {
      const raw = JSON.parse(row.raw_json);
      // Several independent work observations can reference one large profile
      // payload. Reuse only its immutable source projection inside this SQL
      // snapshot, never the per-observation audit, identity or age verdict.
      const anchorSource = anchorSourceById.get(row.anchor_snapshot_id) ?? (() => {
        const anchor = JSON.parse(row.anchor_raw);
        return Object.freeze({ checksum: checksum(anchor), capturedAtMs: evidenceTime(anchor.capturedAt),
          secUid: anchor.profile?.user?.sec_uid, uid: anchor.profile?.user?.uid,
          inventory: safeCount(anchor.profile?.user?.aweme_count),
          officialEnvelope: isOfficialDeferredProfileEnvelope(anchor) || isOfficialMixedProfileEnvelope(anchor)
            || isOfficialScheduledProfileEnvelope(anchor) });
      })();
      const evidence = validateWorksOnlyEvidence(raw, { now });
      let parent = null;
      if (evidence.continuation) {
        parent = verify(byRun.get(`${row.target_id}:${evidence.continuation.runId}`), depth + 1);
        // A node validated at the outer cutoff is not automatically valid at
        // its child's earlier start. Canonical page/body times are <= its own
        // request finish; the completed run must also precede this edge cutoff.
        if (!parent || hasBoundedNextPageWaitEvidence(parent.raw) && row.intervening_finished_works_run
          || evidenceTime(parent.run_finished_at) > evidenceTime(evidence.requestStartedAt)
          || evidenceTime(parent.request_finished_at) > evidenceTime(evidence.requestStartedAt)
          || checksum(resumeFromRow(parent, evidence.identity, evidence.requestStartedAt)) !== checksum(evidence.continuation)) return null;
      }
      const start = evidenceTime(row.run_started_at), finish = evidenceTime(row.run_finished_at), created = evidenceTime(row.created_at);
      const requested = evidenceTime(evidence.requestStartedAt), ended = evidenceTime(evidence.requestFinishedAt), anchorAt = evidenceTime(row.anchor_at);
      const accepted = evidence.status === 'accepted';
      if (checksum(raw) !== row.source_checksum || checksum(evidence) !== row.source_checksum
        || evidence.runId !== row.run_id || evidence.targetId !== row.target_id
        || evidence.anchorSnapshotId !== row.anchor_snapshot_id || evidence.anchorChecksum !== row.anchor_checksum
        || evidence.requestStartedAt !== row.request_started_at || evidence.requestFinishedAt !== row.request_finished_at
        || evidence.observedAt !== row.observed_at || evidence.status !== row.status || evidence.coverage !== row.coverage
        || evidence.errorCode !== row.error_code || row.target_type !== 'account' || row.target_provider !== 'public-web'
        || row.run_trigger !== 'works-only' || row.run_target !== row.target_id || row.run_target_count !== 1 || row.run_processed_count !== 1
        || !(accepted ? ['success', 'partial'] : ['success', 'partial', 'error', 'interrupted']).includes(row.run_status)
        || ![start, finish, created, anchorAt].every(Number.isFinite)
        || start > requested || ended > created || created > finish || finish > now
        || row.anchor_target !== row.target_id || row.anchor_hash !== row.anchor_checksum || anchorSource.checksum !== row.anchor_checksum
        || !row.anchor_audited || !['validated', 'warning'].includes(row.anchor_quality) || !['available', 'partial'].includes(row.anchor_status)
        || anchorSource.capturedAtMs !== anchorAt || anchorAt > requested || requested - anchorAt > 8 * 3600_000
        || !anchorSource.officialEnvelope
        || evidence.identity.secUid !== row.current_locator || evidence.identity.secUid !== anchorSource.secUid
        || evidence.identity.uid !== anchorSource.uid) return null;
      anchorSourceById.set(row.anchor_snapshot_id, anchorSource);
      const anchorInventory = safeCount(row.anchor_total_posts);
      const profileInventory = anchorSource.inventory;
      const inventoryMatches = anchorInventory !== null && profileInventory !== null && anchorInventory === profileInventory;
      const projected = { id: `works-only:${row.id}`, observation_id: row.id, target_id: row.target_id, run_id: row.run_id,
        run_finished_at: row.run_finished_at,
        status: row.status, coverage: row.coverage, observed_at: row.observed_at, request_finished_at: row.request_finished_at, raw: evidence,
        captured_at: evidence.observedAt ?? evidence.requestFinishedAt, attempt_at: evidence.requestFinishedAt,
        works_coverage: evidence.coverage, source_checksum: row.source_checksum, total_posts: inventoryMatches ? anchorInventory : null,
        list_type: accepted ? 'array' : null, list_count: accepted ? evidence.posts.length : null,
        entries_json: JSON.stringify(accepted ? evidence.posts.map(post => ({ id: post.aweme_id, publishedAt: post.create_time ?? null })) : []),
        stop_reason: evidence.pagination?.stopReason ?? 'request-failed' };
      if (receipt) freezeEvidence(evidence);
      Object.freeze(projected);
      verifiedLedgerRows.add(projected); checked.set(row.id, projected); verifiedById.set(row.id, projected);
      if (parent) parentById.set(row.id, parent.observation_id);
      if (receipt) receipt.heightById.set(row.id, parent ? receipt.heightById.get(parent.observation_id) + 1 : 0);
      return projected;
    } catch { /* malformed or unbound ledger data never becomes accepted evidence */ }
    return null;
  }
  const selectedRows = rows.filter(row => row.selected_row).map(row => verify(row)).filter(Boolean);
  return selectedRows.map(row => promoteVerifiedCompleteChain(row, verifiedById, parentById));
}

function freezeEvidence(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeEvidence(child);
  return Object.freeze(value);
}

/** Share source verification only inside one fixed DB/asOf read. The callback
 * receives readers, never an injectable trusted-row cache. Same-connection
 * writes invalidate the scope; callers cannot retain readers after return. */
export function withWorksObservationRead(database, asOf, callback) {
  const db = database.db;
  const receipt = { verifiedById: new Map(), parentById: new Map(), heightById: new Map(), anchorSourceById: new Map() };
  const changesQuery = db.prepare('SELECT total_changes() AS changes');
  const changes = changesQuery.get().changes;
  let active = true;
  const guard = () => {
    if (!active) throw new Error('作品读取作用域已结束');
    const current = changesQuery.get().changes;
    if (current !== changes) {
      receipt.verifiedById.clear(); receipt.parentById.clear(); receipt.heightById.clear();
      receipt.anchorSourceById.clear();
      throw new Error('作品读取作用域内数据库已变更');
    }
  };
  const loadVerified = (targetId = null, options = {}) => {
    guard();
    return loadVerifiedWorksOnlyRowsInRead(db, asOf, targetId, options, receipt);
  };
  const loadObservations = (targetId = null) => {
    guard();
    return loadWorksObservationsInSnapshot({ db }, asOf, targetId, loadVerified);
  };
  db.exec('SAVEPOINT works_observation_read');
  try {
    const result = callback(Object.freeze({ loadVerified, loadObservations }));
    if (result && typeof result.then === 'function') throw new Error('作品读取作用域只支持同步回调');
    guard();
    return result;
  } catch (error) {
    // A rejected read must not commit an accidental callback write when the
    // outermost SAVEPOINT is released. Preserve any pre-existing outer work.
    db.exec('ROLLBACK TO works_observation_read');
    throw error;
  } finally {
    active = false; receipt.verifiedById.clear(); receipt.parentById.clear(); receipt.heightById.clear();
    receipt.anchorSourceById.clear();
    db.exec('RELEASE works_observation_read');
  }
}

function safeCount(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/** Promote only a verified public cursor chain whose stable profile inventory
 * agrees with its deduplicated IDs. The DB's immutable source rows stay
 * `limited`; completeness exists only in this evidence-derived read model. */
function promoteVerifiedCompleteChain(finalRow, verifiedById, parentById) {
  if (!finalRow || finalRow.status !== 'accepted' || finalRow.raw.errorCode !== null
    || finalRow.raw.pagination?.stopReason !== 'end-of-list') return finalRow;
  const reverse = [], seen = new Set();
  let current = finalRow;
  while (current) {
    if (seen.has(current.observation_id) || reverse.length >= 24 || current.status !== 'accepted'
      || current.raw.errorCode !== null) return finalRow;
    seen.add(current.observation_id);
    reverse.push(current);
    const parentId = parentById.get(current.observation_id);
    if (parentId === undefined) break;
    current = verifiedById.get(parentId);
    if (!current) return finalRow;
  }
  const chain = reverse.reverse(), head = chain[0];
  const partialStops = ['item-limit', 'page-limit', 'filtered-rows'];
  if (chain.some((item, index) => index === chain.length - 1
    ? item.raw.pagination?.stopReason !== 'end-of-list'
      || item.raw.pagination?.pages?.at(-1)?.response?.has_more !== false
    : index === 0
      ? Boolean(item.raw.continuation) || item.raw.pagination?.pages?.[0]?.requestCursor !== 0
        || !partialStops.includes(item.raw.pagination?.stopReason)
      : !item.raw.continuation || !partialStops.includes(item.raw.pagination?.stopReason))) return finalRow;
  const inventory = head.total_posts;
  if (inventory === null || chain.some(item => item.total_posts !== inventory)) return finalRow;
  const unique = new Map();
  for (const item of chain) {
    for (const post of item.raw.posts) {
      const old = unique.get(post.aweme_id), createTime = post.create_time ?? null;
      if (old && old.createTime !== null && createTime !== null && old.createTime !== createTime) return finalRow;
      if (!old || old.createTime === null && createTime !== null) unique.set(post.aweme_id, { createTime });
    }
  }
  if (unique.size !== inventory) return finalRow;
  const entries = [...unique].map(([id, item]) => ({ id, publishedAt: item.createTime }));
  const publicPostIdsChecksum = createHash('sha256').update(JSON.stringify([...unique.keys()].sort())).digest('hex');
  const proof = {
    kind: 'verified-public-cursor-chain', targetId: finalRow.target_id,
    inventory, uniquePublicPosts: unique.size, publicPostIdsChecksum,
    segments: chain.map(item => ({ observationId: item.observation_id, runId: item.run_id,
      sourceChecksum: item.source_checksum, anchorInventory: item.total_posts,
      startedAt: item.raw.requestStartedAt, finishedAt: item.raw.requestFinishedAt })),
    note: '跨多个真实采样时刻连续读取；不是同一时点快照，也不证明私密、删除或不可见作品。',
  };
  const projected = Object.freeze({ ...finalRow, works_coverage: 'complete', list_count: entries.length,
    entries_json: JSON.stringify(entries), coverage_evidence: Object.freeze({ ...proof, checksum: checksum(proof) }) });
  verifiedLedgerRows.add(projected);
  return projected;
}

// A checkpoint is derived only from an immutable, fully verified observation.
// A truncated page is re-read from its REQUEST cursor: its unseen tail was
// never persisted and must not be skipped. Chains reset after 24 safe hops.
function hasBoundedNextPageWaitEvidence(raw) {
  const pagination = raw.pagination, diagnostics = raw.failureDiagnostics;
  const requests = diagnostics?.requests, responses = diagnostics?.responses;
  const cdp = diagnostics?.cdpObservation;
  const continuation = diagnostics?.continuationActivation;
  // This proves only that the retained listener evidence has no further bound
  // request/response, not that the platform never dispatched any request.
  // A later ordinary run still owns its current anchor, policy and response
  // checks; this historical receipt grants only the already returned cursor.
  return raw.errorCode === 'collector_error' && pagination.stopReason === 'page-timeout'
    && raw.failureCode === undefined
    && [undefined, 'browser-page'].includes(raw.failureStage)
    && diagnostics?.version === 1 && diagnostics.stopReason === 'deadline'
    && diagnostics.finalPageKind === 'profile'
    && diagnostics.navigation?.observed === true && diagnostics.navigation.committed === true
    && diagnostics.navigation.failed === false && diagnostics.navigation.timedOut === false
    && pagination.requestCount === pagination.pages.length
    && requests?.candidate === pagination.pages.length && requests.matched === pagination.pages.length
    && requests.rejected && Object.values(requests.rejected).every(value => value === 0)
    && responses?.matched === pagination.pages.length && responses.invalidBodies === 0 && responses.bodyTimeouts === 0
    && diagnostics.runtime?.boundRequestFailedCount === 0 && diagnostics.runtime.navigationErrorKind === 'none'
    // New optional DOM diagnostics can disprove the timeout-only exception.
    // A visible gate, obscured/ambiguous list or unknown projection must not
    // grant a later cursor. Legacy records keep their original interpretation.
    && (!continuation || Number.isSafeInteger(continuation.probeCount) && continuation.probeCount > 0
      && ['render-wait', 'render-wait-exhausted', 'scroll-issued', 'progress', 'no-progress', 'explicit-request'].includes(continuation.lastBranch)
      && ['eligible', 'not-scrollable', 'at-bottom', 'region-absent'].includes(continuation.structure?.reason))
    && (!diagnostics.resourceObservation || diagnostics.resourceObservation.captureBoundary === 'page-close-return'
      && diagnostics.resourceObservation.phase === 'closed')
    && (!cdp || cdp.captureBoundary === 'page-close-return' && cdp.phase === 'closed' && cdp.state === 'closed'
      && ['beforeStop', 'afterStop', 'cleanup'].every(phase => ['authorPosts', 'authorPostsEndpoint'].every(kind =>
        ['current-document', 'prior-document', 'unbound'].every(scope => cdp.failuresByPhase?.[phase]?.[kind]?.[scope] === 0))))
    && Array.isArray(diagnostics.httpStatuses) && diagnostics.httpStatuses.length > 0
    && diagnostics.httpStatuses.every(status => Number.isSafeInteger(status) && status >= 200 && status < 300)
    && Array.isArray(diagnostics.businessStatusCodes) && diagnostics.businessStatusCodes.length > 0
    && diagnostics.businessStatusCodes.every(code => code === 0)
    && pagination.pages.every(page => page.filteredCount === 0 && page.duplicateCount === 0
      && page.truncated === false && page.rawCount === page.acceptedCount);
}

function resumeFromRow(row, identity, asOf) {
  if (!row || !isVerifiedWorksOnlyRow(row) || row.status !== 'accepted'
    || row.raw.errorCode !== null && !hasBoundedNextPageWaitEvidence(row.raw)
    || row.raw.identity.secUid !== identity.secUid || row.raw.identity.uid !== identity.uid
    || Date.parse(asOf) - Date.parse(row.request_finished_at) > 7 * 86400_000) return null;
  const pagination = row.raw.pagination, page = pagination.pages.at(-1);
  const depth = (row.raw.continuation?.depth ?? 0) + 1;
  if (depth > 24 || !page || pagination.pages.some(p => p.filteredCount || p.duplicateCount)
    || !['item-limit', 'page-limit', 'filtered-rows'].includes(pagination.stopReason)
      && !hasBoundedNextPageWaitEvidence(row.raw)) return null;
  // A single page that already consumed the entire configured hard limit
  // cannot expose its missing tail by replaying that identical request. Keep
  // it limited and restart normal head sampling; do not claim resume progress.
  if (page.truncated && page.acceptedCount === row.raw.requestedLimit) return null;
  const cursor = page.truncated ? page.requestCursor : page.response.has_more === true ? page.response.max_cursor : null;
  if (!Number.isSafeInteger(cursor) || cursor < 0
    || (!page.truncated && pagination.pages.some(p => p.requestCursor === cursor))) return null;
  return { version: 1, observationId: row.observation_id, runId: row.run_id,
    sourceChecksum: row.source_checksum, cursor, depth };
}

export function readTrustedWorksResume(db, targetId, identity, asOf) {
  if (!db) return null;
  const rows = loadVerifiedWorksOnlyRows(db, asOf, targetId);
  const row = rows.find(item => item.status === 'accepted');
  // The new timeout-only exception cannot skip a subsequent failed, denied,
  // cancelled or uncommitted attempt. Leave legacy successful checkpoints'
  // original interpretation untouched; the exception grants no retry policy.
  if (row && row.raw.errorCode !== null && hasBoundedNextPageWaitEvidence(row.raw)
    && (row !== rows[0] || db.prepare(`SELECT 1 FROM runs WHERE trigger_type='works-only' AND target_id=?
      AND id>? AND finished_at IS NOT NULL AND julianday(finished_at)<=julianday(?) LIMIT 1`)
      .get(targetId, row.run_id, asOf))) return null;
  return resumeFromRow(row, identity, asOf);
}

const COVERAGES = new Set(['complete', 'limited', 'retry', 'unavailable', 'unknown']);
const STOP_REASONS = new Set(['anonymous-window', 'local-limit', 'end-of-list', 'missing-list',
  'invalid-list', 'missing-has-more', 'invalid-has-more', 'empty-page-with-more', 'no-new-items',
  'missing-or-invalid-cursor', 'cursor-repeated', 'request-failed', 'invalid-items']);
const SAMPLE_REASON = '仅说明已返回的公开作品样本；采集时间不等于最新发布时间，0条样本不等于没有发布';

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function publishedTime(value, asOf) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  const timestamp = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > Date.parse(asOf)) return null;
  return new Date(timestamp).toISOString();
}

function windowOf(row) {
  if (!row || row.list_type !== 'array' || !['complete', 'limited', 'latest-public-window'].includes(row.works_coverage)) return null;
  let entries;
  try { entries = JSON.parse(row.entries_json); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const ids = entries.map((entry) => entry?.id);
  const exactIds = ids.every((id) => typeof id === 'string' && /^(?:\d{15,25}|BV[0-9A-Za-z]{10}|[a-f\d]{16,40})$/i.test(id))
    && new Set(ids).size === ids.length;
  const dates = entries.map((entry) => publishedTime(entry?.publishedAt, row.captured_at)).filter(Boolean).sort();
  return {
    id: row.id, observedAt: row.captured_at, sampleCount: count(row.list_count),
    latestPublishedAt: dates.at(-1) ?? null, inventory: count(row.total_posts),
    coverageEvidence: row.coverage_evidence ?? null,
    fingerprint: exactIds ? createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex') : null,
    sourceChecksum: typeof row.source_checksum === 'string' && /^[a-f\d]{64}$/.test(row.source_checksum) ? row.source_checksum : null,
  };
}

export function describeWorksObservation(rows = [], asOf) {
  const latest = rows[0];
  const coverageValue = latest?.works_coverage === 'latest-public-window' ? 'limited' : latest?.works_coverage;
  let coverage = COVERAGES.has(coverageValue) ? coverageValue : 'unknown';
  const windows = rows.map(windowOf).filter(Boolean).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const observed = windows[0] ?? null;
  const previous = windows[1] ?? null;
  if (['complete', 'limited'].includes(coverage) && !windowOf(latest)) coverage = 'unknown';
  const carriedForward = Boolean(observed && observed.id !== latest.id);
  // A provider's "complete" label is not sufficient when the same snapshot
  // says that more works exist than it actually returned. Correct only this
  // read model; preserve the original snapshot, inventory and sample window.
  // In particular, an explicit empty list with inventory 0 remains complete.
  const integrity = coverage === 'complete' && !carriedForward
    && observed?.inventory !== null && observed?.sampleCount !== null
    && observed?.inventory > observed?.sampleCount
    ? { key: 'partial-inventory', reportedCoverage: 'complete', inventory: observed.inventory,
      sampleCount: observed.sampleCount,
      reason: `本次返回 ${observed.sampleCount} 条作品，少于同次主页作品总量 ${observed.inventory}；只能确认部分作品覆盖` }
    : null;
  if (integrity) coverage = 'limited';
  let signal = null;
  if (!carriedForward && observed?.sampleCount > 0 && previous?.sampleCount > 0
    && observed.fingerprint && observed.fingerprint === previous.fingerprint
    && observed.inventory !== null && previous.inventory !== null && observed.inventory !== previous.inventory) {
    signal = {
      key: 'inventory-changed-window-unchanged', inventoryBefore: previous.inventory,
      inventoryAfter: observed.inventory, inventoryDelta: observed.inventory - previous.inventory,
      previousObservedAt: previous.observedAt, observedAt: observed.observedAt,
      reason: '主页作品数有变化，返回样本未体现该变化；不能据此计算实际新发布数量',
    };
  }
  return {
    coverage, observedAt: observed?.observedAt ?? null, lastAttemptAt: latest?.attempt_at ?? latest?.captured_at ?? null,
    latestPublishedAt: observed?.latestPublishedAt ?? null, sampleCount: observed?.sampleCount ?? null,
    coverageEvidence: latest?.coverage_evidence?.kind === 'verified-public-cursor-chain' ? latest.coverage_evidence : null,
    carriedForward, asOf, sourceChecksum: observed?.sourceChecksum ?? null,
    evidenceScope: 'stored-public-sample',
    stopReason: typeof latest?.stop_reason === 'string'
      && (STOP_REASONS.has(latest.stop_reason) || isVerifiedWorksOnlyRow(latest)) ? latest.stop_reason : null,
    integrity,
    signal, reason: carriedForward ? `本次未取得有效作品列表，以下保留较早样本及原采集时间；${SAMPLE_REASON}`
      : integrity ? `${integrity.reason}；${SAMPLE_REASON}`
        : latest?.coverage_evidence?.kind === 'verified-public-cursor-chain'
          ? `已校验公开分页从头至末端，去重 ${latest.coverage_evidence.uniquePublicPosts} 条与主页锚点作品总量一致。跨多个真实采样时刻，非同一时点快照；不保证包含私密、删除或不可见作品。`
          : SAMPLE_REASON,
  };
}

// Bounded projections for all accounts: three snapshot candidates plus three
// ledger candidates per account. A separately bounded strict deferral read
// excludes only proven zero-request prefixes, never an unknown or real failure.
// Original works-list raw is projected in SQL; ledger/anchor evidence is decoded
// only for selected rows.
export function loadWorksObservations(database, asOf, targetId = null) {
  database.db.exec('SAVEPOINT works_observation_read');
  try { return loadWorksObservationsInSnapshot(database, asOf, targetId); }
  finally { database.db.exec('RELEASE works_observation_read'); }
}

function loadWorksObservationsInSnapshot(database, asOf, targetId,
  loadVerified = id => loadVerifiedWorksOnlyRows(database.db, asOf, id)) {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error('作品观察截止时间无效');
  if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0)) throw new Error('账号编号无效');
  const clause = targetId === null ? "t.type='account'" : "t.type='account' AND t.id=?";
  const ledger = loadVerified(targetId);
  const latestAttemptByTarget = new Map();
  for (const row of ledger) if (isVerifiedWorksOnlyRow(row)) {
    const at = row.attempt_at ?? row.captured_at;
    if (Date.parse(at) > (Date.parse(latestAttemptByTarget.get(row.target_id)) || 0)) latestAttemptByTarget.set(row.target_id, at);
  }
  const deferredRead = loadDeferredWorksSnapshotRead(database.db, asOf, targetId, latestAttemptByTarget);
  const deferredIds = JSON.stringify([...deferredRead.ignoredIds]);
  const args = targetId === null ? [asOf, deferredIds, asOf] : [targetId, asOf, deferredIds, asOf];
  const hasWorksTime = database.db.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'works_observed_at');
  const worksTime = hasWorksTime ? 'COALESCE(s.works_observed_at,s.captured_at)' : 's.captured_at';
  const rows = database.db.prepare(`
    WITH scoped_targets AS (SELECT t.id FROM targets t WHERE ${clause}), selected AS (
      SELECT latest.id FROM scoped_targets t JOIN snapshots latest ON latest.id=(
        SELECT s.id FROM snapshots s WHERE s.target_id=t.id AND s.quality_status!='rejected'
          AND julianday(${worksTime})<=julianday(?)
          AND s.id NOT IN (SELECT value FROM json_each(?))
        ORDER BY julianday(${worksTime}) DESC,s.id DESC LIMIT 1)
      UNION
      SELECT accepted.id FROM scoped_targets t JOIN snapshots accepted ON accepted.id IN (
        SELECT s.id FROM snapshots s WHERE s.target_id=t.id AND s.quality_status!='rejected'
          AND s.works_coverage IN ('complete','limited','latest-public-window')
          AND julianday(${worksTime})<=julianday(?)
        ORDER BY julianday(${worksTime}) DESC,s.id DESC LIMIT 2)
    ), chosen AS (
      SELECT s.id,s.target_id,${worksTime} AS captured_at,s.total_posts,s.works_coverage,s.source_checksum,
        CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END AS source_json
      FROM selected pick JOIN snapshots s ON s.id=pick.id
    )
    SELECT c.id,c.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',c.captured_at) AS captured_at,
      c.total_posts,c.works_coverage,c.source_checksum,
      json_type(c.source_json,'$.works.aweme_list') AS list_type,
      CASE WHEN json_type(c.source_json,'$.works.aweme_list')='array'
        THEN json_array_length(c.source_json,'$.works.aweme_list') END AS list_count,
      CASE WHEN json_type(c.source_json,'$.works.stopReason')='text'
        THEN json_extract(c.source_json,'$.works.stopReason') END AS stop_reason,
      (SELECT json_group_array(json_object(
        'id',CASE WHEN j.type='object' AND json_type(j.value,'$.aweme_id')='text'
          THEN json_extract(j.value,'$.aweme_id') END,
        'publishedAt',CASE WHEN j.type='object' AND json_type(j.value,'$.create_time') IN ('text','integer','real')
          THEN json_extract(j.value,'$.create_time') END))
       FROM json_each(CASE WHEN json_type(c.source_json,'$.works.aweme_list')='array'
         THEN json_extract(c.source_json,'$.works.aweme_list') ELSE '[]' END) j) AS entries_json
    FROM chosen c ORDER BY c.target_id,julianday(c.captured_at) DESC,c.id DESC
  `).all(...args);
  const grouped = new Map();
  for (const row of [...rows, ...ledger]) {
    if (!grouped.has(row.target_id)) grouped.set(row.target_id, []);
    grouped.get(row.target_id).push(row);
  }
  return new Map([...grouped].map(([id, samples]) => {
    samples.sort((a, b) => Date.parse(b.attempt_at ?? b.captured_at) - Date.parse(a.attempt_at ?? a.captured_at)
      || Number(isVerifiedWorksOnlyRow(b)) - Number(isVerifiedWorksOnlyRow(a)) || Number(b.id) - Number(a.id));
    const observation = describeWorksObservation(samples, asOf);
    if (deferredRead.budgetLimitedSnapshotIds.has(samples[0]?.id)) return [id, { ...observation,
      coverage: 'unknown', lastAttemptAt: null, stopReason: null, signal: null,
      verificationReason: 'verification-budget-limit',
      reason: '本次读取达到作品来源核验预算，最新占位尚未核验，不能视为一次采集失败；较早作品样本保留原观察时间。',
    }];
    return [id, observation];
  }));
}

export function aggregateWorksObservations(accounts, asOf) {
  const enabled = accounts.filter((account) => account.enabled);
  const active = enabled.filter((account) => account.lifecycle?.state !== 'deleted');
  const observations = active.map((account) => account.worksObservation ?? describeWorksObservation([], asOf));
  const observed = observations.filter((observation) => observation.observedAt !== null);
  const dates = observed.map((observation) => observation.observedAt).sort();
  const publishedDates = observed.map((observation) => observation.latestPublishedAt).filter(Boolean).sort();
  return {
    total: enabled.length, observedCount: observed.length,
    completeCount: observations.filter((item) => item.coverage === 'complete').length,
    limitedCount: observations.filter((item) => item.coverage === 'limited').length,
    retryCount: observations.filter((item) => ['retry', 'unavailable'].includes(item.coverage)).length,
    unknownCount: observations.filter((item) => item.coverage === 'unknown').length,
    inactiveCount: enabled.length - active.length,
    signalCount: observations.filter((item) => item.signal !== null).length,
    latestObservedAt: dates.at(-1) ?? null, oldestObservedAt: dates[0] ?? null,
    latestPublishedAt: publishedDates.at(-1) ?? null, asOf,
    reason: '统计启用账号；样本内最新发布日期不是所有账号的新鲜度，也不能证明完整每日发布量',
  };
}
