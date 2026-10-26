import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitorDatabase } from '../lib/database.mjs';
import { normalizeCollection, normalizePost } from '../lib/providers/normalize.mjs';
import { persistPosts } from '../lib/post-persistence.mjs';
import { checksum } from '../lib/utils.mjs';
import { BrowserWorksPagination } from '../lib/browser-works-pagination.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from '../lib/works-only-observation.mjs';
import * as works from '../lib/works-observation.mjs';
import { postsAsOf, getAccountInsight, getProductInsights } from '../lib/product-insights.mjs';

const ORIGINAL_WORKS_SOURCE = [
  "import { createHash } from 'node:crypto';",
  "import { checksum } from './utils.mjs';",
  "import { validateWorksOnlyEvidence } from './works-only-observation.mjs';",
  "import { isOfficialDeferredProfileEnvelope, isOfficialMixedProfileEnvelope, isOfficialScheduledProfileEnvelope } from './official-profile-evidence.mjs';",
  "",
  "const verifiedLedgerRows = new WeakSet();",
  "function evidenceTime(value) {",
  "  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) return NaN;",
  "  const time = Date.parse(value);",
  "  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;",
  "}",
  "// This is an in-process read receipt, never a caller-supplied `verified` flag.",
  "export function isVerifiedWorksOnlyRow(row) { return verifiedLedgerRows.has(row); }",
  "",
  "/** Read legacy databases without migrations; only completed, DB-bound evidence",
  " * can enter the read model. Decode latest attempt + two accepted windows per",
  " * target, not the whole immutable ledger. Explicit runIds is a batch history",
  " * lookup of caller-selected runs and leaves the default window unchanged.",
  " * No profile values are projected. */",
  "export function loadVerifiedWorksOnlyRows(db, asOf, targetId = null, { runId = null, runIds = null, acceptedPerTarget = 2 } = {}) {",
  "  const now = Date.parse(asOf);",
  "  if (!Number.isFinite(now)) throw new Error('作品观察截止时间无效');",
  "  if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0)) throw new Error('账号编号无效');",
  "  if (runId !== null && (!Number.isSafeInteger(runId) || runId <= 0)) throw new Error('采集编号无效');",
  "  if (![1, 2].includes(acceptedPerTarget)) throw new Error('每个账号的已接受作品观察数无效');",
  "  if (runIds !== null && (!Array.isArray(runIds) || runId !== null",
  "    || runIds.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new Error('历史采集编号无效');",
  "  if (runIds?.length === 0) return [];",
  "  if (!db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'\").get()) return [];",
  "  if (!db.prepare('PRAGMA table_info(works_observations)').all().some(column => column.name === 'run_id')) return [];",
  "  const filter = (targetId === null ? '' : ' AND w.target_id=?') + (runId === null ? '' : ' AND w.run_id=?')",
  "    + (runIds === null ? '' : ' AND w.run_id IN (SELECT value FROM json_each(?))');",
  "  const boundedDefaultSelection = runId === null && runIds === null;",
  "  // The default read needs at most three ledger nodes per target (latest",
  "  // attempt plus two accepted observations). Window-ranking the complete",
  "  // immutable ledger made SQLite sort/materialize every raw_json payload on",
  "  // every monitoring-status request. Keep the same ordering and cutoff, but",
  "  // use target-scoped indexed lookups so the evidence verifier sees only the",
  "  // bounded candidate set. Explicit run/runIds history reads retain their",
  "  // caller-selected semantics below.",
  "  const selectionSql = boundedDefaultSelection",
  "    ? `scoped_targets AS (SELECT id FROM targets${targetId === null ? '' : ' WHERE id=?'}), selected AS (",
  "      SELECT latest.id FROM scoped_targets t JOIN works_observations latest ON latest.id=(",
  "        SELECT w.id FROM works_observations w WHERE w.target_id=t.id AND julianday(w.request_finished_at)<=julianday(?)",
  "        ORDER BY julianday(w.request_finished_at) DESC,w.id DESC LIMIT 1)",
  "      UNION",
  "      SELECT accepted.id FROM scoped_targets t JOIN works_observations accepted ON accepted.id IN (",
  "        SELECT candidate.id FROM works_observations candidate WHERE candidate.target_id=t.id",
  "          AND candidate.status='accepted' AND julianday(candidate.request_finished_at)<=julianday(?)",
  "        ORDER BY julianday(candidate.observed_at) DESC,candidate.id DESC LIMIT ${acceptedPerTarget}))`",
  "    : `ranked AS (",
  "      SELECT w.id,w.target_id,w.run_id,w.status,",
  "        ROW_NUMBER() OVER(PARTITION BY w.target_id ORDER BY julianday(w.request_finished_at) DESC,w.id DESC) latest_rank,",
  "        ROW_NUMBER() OVER(PARTITION BY w.target_id ORDER BY CASE WHEN w.status='accepted' THEN 0 ELSE 1 END,",
  "          julianday(w.observed_at) DESC,w.id DESC) accepted_rank",
  "      FROM works_observations w WHERE julianday(w.request_finished_at)<=julianday(?)${filter}",
  "    ), selected AS (SELECT id FROM ranked WHERE ${runIds === null ? 'latest_rank=1 OR (status=\\'accepted\\' AND accepted_rank<=2)' : '1=1'})`;",
  "  const selectionParams = boundedDefaultSelection",
  "    ? [...(targetId === null ? [] : [targetId]), asOf, asOf]",
  "    : [asOf, ...(targetId === null ? [] : [targetId]), ...(runId === null ? [] : [runId]),",
  "      ...(runIds === null ? [] : [JSON.stringify([...new Set(runIds)])])];",
  "  // One SQL statement owns the entire bounded graph snapshot. JSON references",
  "  // only discover candidates here: every node and edge is independently checked",
  "  // below. Per-call reuse never survives a mutable database read boundary.",
  "  const rows = db.prepare(`WITH ${selectionSql}, chain(id,depth) AS (",
  "    SELECT id,0 FROM selected",
  "    UNION",
  "    SELECT p.id,c.depth+1 FROM chain c JOIN works_observations child ON child.id=c.id",
  "      JOIN works_observations p ON p.target_id=child.target_id",
  "        AND p.run_id=json_extract(CASE WHEN json_valid(child.raw_json) THEN child.raw_json ELSE '{}' END,'$.continuation.runId')",
  "      WHERE c.depth<24 AND p.run_id<child.run_id",
  "  ), included AS (SELECT DISTINCT id FROM chain)",
  "  SELECT w.*,EXISTS(SELECT 1 FROM selected chosen WHERE chosen.id=w.id) selected_row,",
  "      t.locator current_locator,t.type target_type,t.provider target_provider,",
  "      r.trigger_type run_trigger,r.target_id run_target,r.target_count run_target_count,r.processed_count run_processed_count,",
  "      r.started_at run_started_at,r.finished_at run_finished_at,r.status run_status,",
  "      EXISTS(SELECT 1 FROM runs intervening WHERE intervening.trigger_type='works-only'",
  "        AND intervening.target_id=w.target_id",
  "        AND intervening.id>json_extract(CASE WHEN json_valid(w.raw_json) THEN w.raw_json ELSE '{}' END,'$.continuation.runId')",
  "        AND intervening.id<w.run_id AND intervening.finished_at IS NOT NULL",
  "        AND julianday(intervening.finished_at)<=julianday(w.request_started_at)) intervening_finished_works_run,",
  "      s.target_id anchor_target,s.captured_at anchor_at,s.source_checksum anchor_hash,s.total_posts anchor_total_posts,s.raw_json anchor_raw,",
  "      s.quality_status anchor_quality,s.account_status anchor_status,",
  "      EXISTS(SELECT 1 FROM audits a WHERE a.target_id=w.target_id AND a.source_checksum=w.anchor_checksum",
  "        AND a.provider='public-web' AND a.status IN ('validated','warning')",
  "        AND julianday(a.created_at)>=julianday(s.captured_at)",
  "        AND julianday(a.created_at)<=julianday(w.request_started_at)) anchor_audited",
  "    FROM included i JOIN works_observations w ON w.id=i.id",
  "      JOIN targets t ON t.id=w.target_id JOIN runs r ON r.id=w.run_id",
  "      JOIN snapshots s ON s.id=w.anchor_snapshot_id",
  "    ORDER BY w.target_id,julianday(w.request_finished_at) DESC,w.id DESC`).all(...selectionParams);",
  "  const byRun = new Map(rows.map(row => [`${row.target_id}:${row.run_id}`, row]));",
  "  const checked = new Map();",
  "  const verifiedById = new Map();",
  "  const parentById = new Map();",
  "  function verify(row, depth = 0) {",
  "    if (!row || depth > 24) return null;",
  "    if (checked.has(row.id)) return checked.get(row.id);",
  "    // A failed or cyclic node cannot acquire a trusted receipt through reuse.",
  "    checked.set(row.id, null);",
  "    try {",
  "      const raw = JSON.parse(row.raw_json), anchor = JSON.parse(row.anchor_raw);",
  "      const evidence = validateWorksOnlyEvidence(raw, { now });",
  "      let parent = null;",
  "      if (evidence.continuation) {",
  "        parent = verify(byRun.get(`${row.target_id}:${evidence.continuation.runId}`), depth + 1);",
  "        // A node validated at the outer cutoff is not automatically valid at",
  "        // its child's earlier start. Canonical page/body times are <= its own",
  "        // request finish; the completed run must also precede this edge cutoff.",
  "        if (!parent || hasBoundedNextPageWaitEvidence(parent.raw) && row.intervening_finished_works_run",
  "          || evidenceTime(parent.run_finished_at) > evidenceTime(evidence.requestStartedAt)",
  "          || evidenceTime(parent.request_finished_at) > evidenceTime(evidence.requestStartedAt)",
  "          || checksum(resumeFromRow(parent, evidence.identity, evidence.requestStartedAt)) !== checksum(evidence.continuation)) return null;",
  "      }",
  "      const start = evidenceTime(row.run_started_at), finish = evidenceTime(row.run_finished_at), created = evidenceTime(row.created_at);",
  "      const requested = evidenceTime(evidence.requestStartedAt), ended = evidenceTime(evidence.requestFinishedAt), anchorAt = evidenceTime(row.anchor_at);",
  "      const accepted = evidence.status === 'accepted';",
  "      if (checksum(raw) !== row.source_checksum || checksum(evidence) !== row.source_checksum",
  "        || evidence.runId !== row.run_id || evidence.targetId !== row.target_id",
  "        || evidence.anchorSnapshotId !== row.anchor_snapshot_id || evidence.anchorChecksum !== row.anchor_checksum",
  "        || evidence.requestStartedAt !== row.request_started_at || evidence.requestFinishedAt !== row.request_finished_at",
  "        || evidence.observedAt !== row.observed_at || evidence.status !== row.status || evidence.coverage !== row.coverage",
  "        || evidence.errorCode !== row.error_code || row.target_type !== 'account' || row.target_provider !== 'public-web'",
  "        || row.run_trigger !== 'works-only' || row.run_target !== row.target_id || row.run_target_count !== 1 || row.run_processed_count !== 1",
  "        || !(accepted ? ['success', 'partial'] : ['success', 'partial', 'error', 'interrupted']).includes(row.run_status)",
  "        || ![start, finish, created, anchorAt].every(Number.isFinite)",
  "        || start > requested || ended > created || created > finish || finish > now",
  "        || row.anchor_target !== row.target_id || row.anchor_hash !== row.anchor_checksum || checksum(anchor) !== row.anchor_checksum",
  "        || !row.anchor_audited || !['validated', 'warning'].includes(row.anchor_quality) || !['available', 'partial'].includes(row.anchor_status)",
  "        || evidenceTime(anchor.capturedAt) !== anchorAt || anchorAt > requested || requested - anchorAt > 8 * 3600_000",
  "        || (!isOfficialDeferredProfileEnvelope(anchor) && !isOfficialMixedProfileEnvelope(anchor) && !isOfficialScheduledProfileEnvelope(anchor))",
  "        || evidence.identity.secUid !== row.current_locator || evidence.identity.secUid !== anchor.profile?.user?.sec_uid",
  "        || evidence.identity.uid !== anchor.profile?.user?.uid) return null;",
  "      const anchorInventory = safeCount(row.anchor_total_posts);",
  "      const profileInventory = safeCount(anchor.profile?.user?.aweme_count);",
  "      const inventoryMatches = anchorInventory !== null && profileInventory !== null && anchorInventory === profileInventory;",
  "      const projected = { id: `works-only:${row.id}`, observation_id: row.id, target_id: row.target_id, run_id: row.run_id,",
  "        run_finished_at: row.run_finished_at,",
  "        status: row.status, coverage: row.coverage, observed_at: row.observed_at, request_finished_at: row.request_finished_at, raw: evidence,",
  "        captured_at: evidence.observedAt ?? evidence.requestFinishedAt, attempt_at: evidence.requestFinishedAt,",
  "        works_coverage: evidence.coverage, source_checksum: row.source_checksum, total_posts: inventoryMatches ? anchorInventory : null,",
  "        list_type: accepted ? 'array' : null, list_count: accepted ? evidence.posts.length : null,",
  "        entries_json: JSON.stringify(accepted ? evidence.posts.map(post => ({ id: post.aweme_id, publishedAt: post.create_time ?? null })) : []),",
  "        stop_reason: evidence.pagination?.stopReason ?? 'request-failed' };",
  "      Object.freeze(projected);",
  "      verifiedLedgerRows.add(projected); checked.set(row.id, projected); verifiedById.set(row.id, projected);",
  "      if (parent) parentById.set(row.id, parent.observation_id);",
  "      return projected;",
  "    } catch { /* malformed or unbound ledger data never becomes accepted evidence */ }",
  "    return null;",
  "  }",
  "  const selectedRows = rows.filter(row => row.selected_row).map(row => verify(row)).filter(Boolean);",
  "  return selectedRows.map(row => promoteVerifiedCompleteChain(row, verifiedById, parentById));",
  "}",
  "",
  "function safeCount(value) {",
  "  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;",
  "  if (typeof value === 'string' && /^\\d{1,16}$/.test(value)) {",
  "    const parsed = Number(value);",
  "    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;",
  "  }",
  "  return null;",
  "}",
  "",
  "/** Promote only a verified public cursor chain whose stable profile inventory",
  " * agrees with its deduplicated IDs. The DB's immutable source rows stay",
  " * `limited`; completeness exists only in this evidence-derived read model. */",
  "function promoteVerifiedCompleteChain(finalRow, verifiedById, parentById) {",
  "  if (!finalRow || finalRow.status !== 'accepted' || finalRow.raw.errorCode !== null",
  "    || finalRow.raw.pagination?.stopReason !== 'end-of-list') return finalRow;",
  "  const reverse = [], seen = new Set();",
  "  let current = finalRow;",
  "  while (current) {",
  "    if (seen.has(current.observation_id) || reverse.length >= 24 || current.status !== 'accepted'",
  "      || current.raw.errorCode !== null) return finalRow;",
  "    seen.add(current.observation_id);",
  "    reverse.push(current);",
  "    const parentId = parentById.get(current.observation_id);",
  "    if (parentId === undefined) break;",
  "    current = verifiedById.get(parentId);",
  "    if (!current) return finalRow;",
  "  }",
  "  const chain = reverse.reverse(), head = chain[0];",
  "  const partialStops = ['item-limit', 'page-limit', 'filtered-rows'];",
  "  if (chain.some((item, index) => index === chain.length - 1",
  "    ? item.raw.pagination?.stopReason !== 'end-of-list'",
  "      || item.raw.pagination?.pages?.at(-1)?.response?.has_more !== false",
  "    : index === 0",
  "      ? Boolean(item.raw.continuation) || item.raw.pagination?.pages?.[0]?.requestCursor !== 0",
  "        || !partialStops.includes(item.raw.pagination?.stopReason)",
  "      : !item.raw.continuation || !partialStops.includes(item.raw.pagination?.stopReason))) return finalRow;",
  "  const inventory = head.total_posts;",
  "  if (inventory === null || chain.some(item => item.total_posts !== inventory)) return finalRow;",
  "  const unique = new Map();",
  "  for (const item of chain) {",
  "    for (const post of item.raw.posts) {",
  "      const old = unique.get(post.aweme_id), createTime = post.create_time ?? null;",
  "      if (old && old.createTime !== null && createTime !== null && old.createTime !== createTime) return finalRow;",
  "      if (!old || old.createTime === null && createTime !== null) unique.set(post.aweme_id, { createTime });",
  "    }",
  "  }",
  "  if (unique.size !== inventory) return finalRow;",
  "  const entries = [...unique].map(([id, item]) => ({ id, publishedAt: item.createTime }));",
  "  const publicPostIdsChecksum = createHash('sha256').update(JSON.stringify([...unique.keys()].sort())).digest('hex');",
  "  const proof = {",
  "    kind: 'verified-public-cursor-chain', targetId: finalRow.target_id,",
  "    inventory, uniquePublicPosts: unique.size, publicPostIdsChecksum,",
  "    segments: chain.map(item => ({ observationId: item.observation_id, runId: item.run_id,",
  "      sourceChecksum: item.source_checksum, anchorInventory: item.total_posts,",
  "      startedAt: item.raw.requestStartedAt, finishedAt: item.raw.requestFinishedAt })),",
  "    note: '跨多个真实采样时刻连续读取；不是同一时点快照，也不证明私密、删除或不可见作品。',",
  "  };",
  "  const projected = Object.freeze({ ...finalRow, works_coverage: 'complete', list_count: entries.length,",
  "    entries_json: JSON.stringify(entries), coverage_evidence: Object.freeze({ ...proof, checksum: checksum(proof) }) });",
  "  verifiedLedgerRows.add(projected);",
  "  return projected;",
  "}",
  "",
  "// A checkpoint is derived only from an immutable, fully verified observation.",
  "// A truncated page is re-read from its REQUEST cursor: its unseen tail was",
  "// never persisted and must not be skipped. Chains reset after 24 safe hops.",
  "function hasBoundedNextPageWaitEvidence(raw) {",
  "  const pagination = raw.pagination, diagnostics = raw.failureDiagnostics;",
  "  const requests = diagnostics?.requests, responses = diagnostics?.responses;",
  "  const cdp = diagnostics?.cdpObservation;",
  "  // This proves only that the retained listener evidence has no further bound",
  "  // request/response, not that the platform never dispatched any request.",
  "  // A later ordinary run still owns its current anchor, policy and response",
  "  // checks; this historical receipt grants only the already returned cursor.",
  "  return raw.errorCode === 'collector_error' && pagination.stopReason === 'page-timeout'",
  "    && raw.failureCode === undefined",
  "    && [undefined, 'browser-page'].includes(raw.failureStage)",
  "    && diagnostics?.version === 1 && diagnostics.stopReason === 'deadline'",
  "    && diagnostics.finalPageKind === 'profile'",
  "    && diagnostics.navigation?.observed === true && diagnostics.navigation.committed === true",
  "    && diagnostics.navigation.failed === false && diagnostics.navigation.timedOut === false",
  "    && pagination.requestCount === pagination.pages.length",
  "    && requests?.candidate === pagination.pages.length && requests.matched === pagination.pages.length",
  "    && requests.rejected && Object.values(requests.rejected).every(value => value === 0)",
  "    && responses?.matched === pagination.pages.length && responses.invalidBodies === 0 && responses.bodyTimeouts === 0",
  "    && diagnostics.runtime?.boundRequestFailedCount === 0 && diagnostics.runtime.navigationErrorKind === 'none'",
  "    && (!diagnostics.resourceObservation || diagnostics.resourceObservation.captureBoundary === 'page-close-return'",
  "      && diagnostics.resourceObservation.phase === 'closed')",
  "    && (!cdp || cdp.captureBoundary === 'page-close-return' && cdp.phase === 'closed' && cdp.state === 'closed'",
  "      && ['beforeStop', 'afterStop', 'cleanup'].every(phase => ['authorPosts', 'authorPostsEndpoint'].every(kind =>",
  "        ['current-document', 'prior-document', 'unbound'].every(scope => cdp.failuresByPhase?.[phase]?.[kind]?.[scope] === 0))))",
  "    && Array.isArray(diagnostics.httpStatuses) && diagnostics.httpStatuses.length > 0",
  "    && diagnostics.httpStatuses.every(status => Number.isSafeInteger(status) && status >= 200 && status < 300)",
  "    && Array.isArray(diagnostics.businessStatusCodes) && diagnostics.businessStatusCodes.length > 0",
  "    && diagnostics.businessStatusCodes.every(code => code === 0)",
  "    && pagination.pages.every(page => page.filteredCount === 0 && page.duplicateCount === 0",
  "      && page.truncated === false && page.rawCount === page.acceptedCount);",
  "}",
  "",
  "function resumeFromRow(row, identity, asOf) {",
  "  if (!row || !isVerifiedWorksOnlyRow(row) || row.status !== 'accepted'",
  "    || row.raw.errorCode !== null && !hasBoundedNextPageWaitEvidence(row.raw)",
  "    || row.raw.identity.secUid !== identity.secUid || row.raw.identity.uid !== identity.uid",
  "    || Date.parse(asOf) - Date.parse(row.request_finished_at) > 7 * 86400_000) return null;",
  "  const pagination = row.raw.pagination, page = pagination.pages.at(-1);",
  "  const depth = (row.raw.continuation?.depth ?? 0) + 1;",
  "  if (depth > 24 || !page || pagination.pages.some(p => p.filteredCount || p.duplicateCount)",
  "    || !['item-limit', 'page-limit', 'filtered-rows'].includes(pagination.stopReason)",
  "      && !hasBoundedNextPageWaitEvidence(row.raw)) return null;",
  "  // A single page that already consumed the entire configured hard limit",
  "  // cannot expose its missing tail by replaying that identical request. Keep",
  "  // it limited and restart normal head sampling; do not claim resume progress.",
  "  if (page.truncated && page.acceptedCount === row.raw.requestedLimit) return null;",
  "  const cursor = page.truncated ? page.requestCursor : page.response.has_more === true ? page.response.max_cursor : null;",
  "  if (!Number.isSafeInteger(cursor) || cursor < 0",
  "    || (!page.truncated && pagination.pages.some(p => p.requestCursor === cursor))) return null;",
  "  return { version: 1, observationId: row.observation_id, runId: row.run_id,",
  "    sourceChecksum: row.source_checksum, cursor, depth };",
  "}",
  "",
  "export function readTrustedWorksResume(db, targetId, identity, asOf) {",
  "  if (!db) return null;",
  "  const rows = loadVerifiedWorksOnlyRows(db, asOf, targetId);",
  "  const row = rows.find(item => item.status === 'accepted');",
  "  // The new timeout-only exception cannot skip a subsequent failed, denied,",
  "  // cancelled or uncommitted attempt. Leave legacy successful checkpoints'",
  "  // original interpretation untouched; the exception grants no retry policy.",
  "  if (row && row.raw.errorCode !== null && hasBoundedNextPageWaitEvidence(row.raw)",
  "    && (row !== rows[0] || db.prepare(`SELECT 1 FROM runs WHERE trigger_type='works-only' AND target_id=?",
  "      AND id>? AND finished_at IS NOT NULL AND julianday(finished_at)<=julianday(?) LIMIT 1`)",
  "      .get(targetId, row.run_id, asOf))) return null;",
  "  return resumeFromRow(row, identity, asOf);",
  "}",
  "",
  "const COVERAGES = new Set(['complete', 'limited', 'retry', 'unavailable', 'unknown']);",
  "const STOP_REASONS = new Set(['anonymous-window', 'local-limit', 'end-of-list', 'missing-list',",
  "  'invalid-list', 'missing-has-more', 'invalid-has-more', 'empty-page-with-more', 'no-new-items',",
  "  'missing-or-invalid-cursor', 'cursor-repeated', 'request-failed', 'invalid-items']);",
  "const SAMPLE_REASON = '仅说明已返回的公开作品样本；采集时间不等于最新发布时间，0条样本不等于没有发布';",
  "",
  "function count(value) {",
  "  return Number.isSafeInteger(value) && value >= 0 ? value : null;",
  "}",
  "",
  "function publishedTime(value, asOf) {",
  "  if (value === null || value === undefined || value === '') return null;",
  "  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\\d+(?:\\.\\d+)?$/.test(value));",
  "  const timestamp = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);",
  "  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > Date.parse(asOf)) return null;",
  "  return new Date(timestamp).toISOString();",
  "}",
  "",
  "function windowOf(row) {",
  "  if (!row || row.list_type !== 'array' || !['complete', 'limited', 'latest-public-window'].includes(row.works_coverage)) return null;",
  "  let entries;",
  "  try { entries = JSON.parse(row.entries_json); } catch { return null; }",
  "  if (!Array.isArray(entries)) return null;",
  "  const ids = entries.map((entry) => entry?.id);",
  "  const exactIds = ids.every((id) => typeof id === 'string' && /^(?:\\d{15,25}|BV[0-9A-Za-z]{10}|[a-f\\d]{16,40})$/i.test(id))",
  "    && new Set(ids).size === ids.length;",
  "  const dates = entries.map((entry) => publishedTime(entry?.publishedAt, row.captured_at)).filter(Boolean).sort();",
  "  return {",
  "    id: row.id, observedAt: row.captured_at, sampleCount: count(row.list_count),",
  "    latestPublishedAt: dates.at(-1) ?? null, inventory: count(row.total_posts),",
  "    coverageEvidence: row.coverage_evidence ?? null,",
  "    fingerprint: exactIds ? createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex') : null,",
  "    sourceChecksum: typeof row.source_checksum === 'string' && /^[a-f\\d]{64}$/.test(row.source_checksum) ? row.source_checksum : null,",
  "  };",
  "}",
  "",
  "export function describeWorksObservation(rows = [], asOf) {",
  "  const latest = rows[0];",
  "  const coverageValue = latest?.works_coverage === 'latest-public-window' ? 'limited' : latest?.works_coverage;",
  "  let coverage = COVERAGES.has(coverageValue) ? coverageValue : 'unknown';",
  "  const windows = rows.map(windowOf).filter(Boolean).sort((a, b) => b.observedAt.localeCompare(a.observedAt));",
  "  const observed = windows[0] ?? null;",
  "  const previous = windows[1] ?? null;",
  "  if (['complete', 'limited'].includes(coverage) && !windowOf(latest)) coverage = 'unknown';",
  "  const carriedForward = Boolean(observed && observed.id !== latest.id);",
  "  // A provider's \"complete\" label is not sufficient when the same snapshot",
  "  // says that more works exist than it actually returned. Correct only this",
  "  // read model; preserve the original snapshot, inventory and sample window.",
  "  // In particular, an explicit empty list with inventory 0 remains complete.",
  "  const integrity = coverage === 'complete' && !carriedForward",
  "    && observed?.inventory !== null && observed?.sampleCount !== null",
  "    && observed?.inventory > observed?.sampleCount",
  "    ? { key: 'partial-inventory', reportedCoverage: 'complete', inventory: observed.inventory,",
  "      sampleCount: observed.sampleCount,",
  "      reason: `本次返回 ${observed.sampleCount} 条作品，少于同次主页作品总量 ${observed.inventory}；只能确认部分作品覆盖` }",
  "    : null;",
  "  if (integrity) coverage = 'limited';",
  "  let signal = null;",
  "  if (!carriedForward && observed?.sampleCount > 0 && previous?.sampleCount > 0",
  "    && observed.fingerprint && observed.fingerprint === previous.fingerprint",
  "    && observed.inventory !== null && previous.inventory !== null && observed.inventory !== previous.inventory) {",
  "    signal = {",
  "      key: 'inventory-changed-window-unchanged', inventoryBefore: previous.inventory,",
  "      inventoryAfter: observed.inventory, inventoryDelta: observed.inventory - previous.inventory,",
  "      previousObservedAt: previous.observedAt, observedAt: observed.observedAt,",
  "      reason: '主页作品数有变化，返回样本未体现该变化；不能据此计算实际新发布数量',",
  "    };",
  "  }",
  "  return {",
  "    coverage, observedAt: observed?.observedAt ?? null, lastAttemptAt: latest?.attempt_at ?? latest?.captured_at ?? null,",
  "    latestPublishedAt: observed?.latestPublishedAt ?? null, sampleCount: observed?.sampleCount ?? null,",
  "    coverageEvidence: latest?.coverage_evidence?.kind === 'verified-public-cursor-chain' ? latest.coverage_evidence : null,",
  "    carriedForward, asOf, sourceChecksum: observed?.sourceChecksum ?? null,",
  "    evidenceScope: 'stored-public-sample',",
  "    stopReason: typeof latest?.stop_reason === 'string'",
  "      && (STOP_REASONS.has(latest.stop_reason) || isVerifiedWorksOnlyRow(latest)) ? latest.stop_reason : null,",
  "    integrity,",
  "    signal, reason: carriedForward ? `本次未取得有效作品列表，以下保留较早样本及原采集时间；${SAMPLE_REASON}`",
  "      : integrity ? `${integrity.reason}；${SAMPLE_REASON}`",
  "        : latest?.coverage_evidence?.kind === 'verified-public-cursor-chain'",
  "          ? `已校验公开分页从头至末端，去重 ${latest.coverage_evidence.uniquePublicPosts} 条与主页锚点作品总量一致。跨多个真实采样时刻，非同一时点快照；不保证包含私密、删除或不可见作品。`",
  "          : SAMPLE_REASON,",
  "  };",
  "}",
  "",
  "// Bounded projections for all accounts: three snapshot candidates plus three",
  "// ledger candidates per account. Original snapshot raw is projected in SQL;",
  "// canonical ledger and anchor evidence are decoded only for selected rows.",
  "export function loadWorksObservations(database, asOf, targetId = null) {",
  "  database.db.exec('SAVEPOINT works_observation_read');",
  "  try { return loadWorksObservationsInSnapshot(database, asOf, targetId); }",
  "  finally { database.db.exec('RELEASE works_observation_read'); }",
  "}",
  "",
  "function loadWorksObservationsInSnapshot(database, asOf, targetId) {",
  "  if (!Number.isFinite(Date.parse(asOf))) throw new Error('作品观察截止时间无效');",
  "  if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0)) throw new Error('账号编号无效');",
  "  const clause = targetId === null ? \"t.type='account'\" : \"t.type='account' AND t.id=?\";",
  "  const args = targetId === null ? [asOf] : [targetId, asOf];",
  "  const hasWorksTime = database.db.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'works_observed_at');",
  "  const worksTime = hasWorksTime ? 'COALESCE(s.works_observed_at,s.captured_at)' : 's.captured_at';",
  "  const rows = database.db.prepare(`",
  "    WITH ranked AS (",
  "      SELECT s.id,s.target_id,${worksTime} AS captured_at,s.total_posts,s.works_coverage,s.source_checksum,",
  "        ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY julianday(${worksTime}) DESC,s.id DESC) AS latest_rank,",
  "        ROW_NUMBER() OVER (PARTITION BY s.target_id ORDER BY",
  "          CASE WHEN s.works_coverage IN ('complete','limited','latest-public-window') THEN 0 ELSE 1 END,",
  "          julianday(${worksTime}) DESC,s.id DESC) AS window_rank",
  "      FROM snapshots s JOIN targets t ON t.id=s.target_id",
  "      WHERE ${clause} AND s.quality_status!='rejected' AND julianday(${worksTime})<=julianday(?)",
  "    ), chosen AS (",
  "      SELECT r.*,CASE WHEN json_valid(s.raw_json) THEN s.raw_json ELSE '{}' END AS source_json",
  "      FROM ranked r JOIN snapshots s ON s.id=r.id",
  "      WHERE r.latest_rank=1 OR (r.window_rank<=2 AND r.works_coverage IN ('complete','limited','latest-public-window'))",
  "    )",
  "    SELECT c.id,c.target_id,strftime('%Y-%m-%dT%H:%M:%fZ',c.captured_at) AS captured_at,",
  "      c.total_posts,c.works_coverage,c.source_checksum,",
  "      json_type(c.source_json,'$.works.aweme_list') AS list_type,",
  "      CASE WHEN json_type(c.source_json,'$.works.aweme_list')='array'",
  "        THEN json_array_length(c.source_json,'$.works.aweme_list') END AS list_count,",
  "      CASE WHEN json_type(c.source_json,'$.works.stopReason')='text'",
  "        THEN json_extract(c.source_json,'$.works.stopReason') END AS stop_reason,",
  "      (SELECT json_group_array(json_object(",
  "        'id',CASE WHEN j.type='object' AND json_type(j.value,'$.aweme_id')='text'",
  "          THEN json_extract(j.value,'$.aweme_id') END,",
  "        'publishedAt',CASE WHEN j.type='object' AND json_type(j.value,'$.create_time') IN ('text','integer','real')",
  "          THEN json_extract(j.value,'$.create_time') END))",
  "       FROM json_each(CASE WHEN json_type(c.source_json,'$.works.aweme_list')='array'",
  "         THEN json_extract(c.source_json,'$.works.aweme_list') ELSE '[]' END) j) AS entries_json",
  "    FROM chosen c ORDER BY c.target_id,julianday(c.captured_at) DESC,c.id DESC",
  "  `).all(...args);",
  "  const grouped = new Map();",
  "  for (const row of [...rows, ...loadVerifiedWorksOnlyRows(database.db, asOf, targetId)]) {",
  "    if (!grouped.has(row.target_id)) grouped.set(row.target_id, []);",
  "    grouped.get(row.target_id).push(row);",
  "  }",
  "  return new Map([...grouped].map(([id, samples]) => [id, describeWorksObservation(samples.sort((a, b) =>",
  "    Date.parse(b.attempt_at ?? b.captured_at) - Date.parse(a.attempt_at ?? a.captured_at)",
  "      || Number(isVerifiedWorksOnlyRow(b)) - Number(isVerifiedWorksOnlyRow(a)) || Number(b.id) - Number(a.id)), asOf)]));",
  "}",
  "",
  "export function aggregateWorksObservations(accounts, asOf) {",
  "  const enabled = accounts.filter((account) => account.enabled);",
  "  const active = enabled.filter((account) => account.lifecycle?.state !== 'deleted');",
  "  const observations = active.map((account) => account.worksObservation ?? describeWorksObservation([], asOf));",
  "  const observed = observations.filter((observation) => observation.observedAt !== null);",
  "  const dates = observed.map((observation) => observation.observedAt).sort();",
  "  const publishedDates = observed.map((observation) => observation.latestPublishedAt).filter(Boolean).sort();",
  "  return {",
  "    total: enabled.length, observedCount: observed.length,",
  "    completeCount: observations.filter((item) => item.coverage === 'complete').length,",
  "    limitedCount: observations.filter((item) => item.coverage === 'limited').length,",
  "    retryCount: observations.filter((item) => ['retry', 'unavailable'].includes(item.coverage)).length,",
  "    unknownCount: observations.filter((item) => item.coverage === 'unknown').length,",
  "    inactiveCount: enabled.length - active.length,",
  "    signalCount: observations.filter((item) => item.signal !== null).length,",
  "    latestObservedAt: dates.at(-1) ?? null, oldestObservedAt: dates[0] ?? null,",
  "    latestPublishedAt: publishedDates.at(-1) ?? null, asOf,",
  "    reason: '统计启用账号；样本内最新发布日期不是所有账号的新鲜度，也不能证明完整每日发布量',",
  "  };",
  "}",
].join('\n');

const ORIGINAL_POSTS_SOURCE = [
  "// posts contains the latest metadata, while post_metrics retains dated values.",
  "// Recover changed metadata only from a stored source bound to the selected",
  "// metric observation. Without that evidence the historical fields are unknown.",
  "function historyObservationTime(value) {",
  "  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$/.test(value)",
  "    || shiftCalendarDate(value.slice(0, 10), 0) !== value.slice(0, 10)) return NaN;",
  "  return Date.parse(value);",
  "}",
  "",
  "export function postsAsOf(database, rows, asOf, targets, { forceRecovery = false, snapshotMaxId = null } = {}) {",
  "  const cutoff = Date.parse(asOf);",
  "  const lateKnown = row => Date.parse(row.first_seen_at) > cutoff;",
  "  const changed = rows.filter(row => forceRecovery || lateKnown(row) || Date.parse(row.last_seen_at) > cutoff);",
  "  if (!changed.length) return rows;",
  "  const db = database.db, recovered = new Map();",
  "  const targetsById = new Map(targets.map(target => [Number(target.id), target]));",
  "  const wanted = new Map(changed.map(row => [`${row.target_id}:${row.external_id}:${Date.parse(row.metric_at)}`, row]));",
  "  const times = new Map();",
  "  for (const row of changed) {",
  "    if (!Number.isFinite(Date.parse(row.metric_at))) continue;",
  "    const metricAt = new Date(row.metric_at).toISOString();",
  "    times.set(`${row.target_id}:${metricAt}`, { targetId: Number(row.target_id), metricAt });",
  "  }",
  "  const wantedTimes = JSON.stringify([...times.values()]);",
  "  const metrics = ['likes', 'comments', 'shares', 'collects', 'plays'];",
  "  const identityCache = new Map();",
  "  const canonicalIdentity = (value, platform) => {",
  "    const key = `${platform}:${String(value ?? '')}`;",
  "    if (!identityCache.has(key)) identityCache.set(key, canonicalAccountLocator(value, platform));",
  "    return identityCache.get(key);",
  "  };",
  "  const accept = (targetId, posts, timeFor, profile) => {",
  "    const target = targetsById.get(Number(targetId));",
  "    if (!target) return;",
  "    const platform = safeJson(target.metadata_json, {})?.platform ?? 'douyin';",
  "    if (!['douyin', 'bilibili', 'xiaohongshu'].includes(platform)) return;",
  "    const identity = canonicalIdentity(target.locator, platform);",
  "    const profileId = platform === 'douyin' ? profile?.sec_uid : profile?.uid ?? profile?.mid ?? profile?.user_id;",
  "    if (!identity || canonicalIdentity(profileId, platform) !== identity",
  "      || (platform === 'douyin' && !/^[1-9]\\d{1,24}$/.test(String(profile.uid ?? '')))) return;",
  "    for (const post of posts) {",
  "      const observedAt = Date.parse(timeFor(post));",
  "      const row = wanted.get(`${targetId}:${post.externalId}:${observedAt}`);",
  "      if (!row || recovered.has(row.id) || !Number.isFinite(observedAt)",
  "        || observedAt !== Date.parse(row.metric_at) || observedAt > Date.parse(asOf)",
  "        || canonicalIdentity(row.author_id, platform) !== identity",
  "        || canonicalIdentity(post.authorId, platform) !== identity",
  "        || (platform === 'douyin' && String(post.raw?.author?.uid ?? '') !== String(profile.uid))",
  "        || metrics.some(field => (row[field] ?? null) !== (post[field] ?? null))",
  "        || (post.publishedAt && Date.parse(post.publishedAt) > observedAt)) continue;",
  "      recovered.set(row.id, { caption: post.caption || null, url: post.url || null,",
  "        published_at: post.publishedAt || null });",
  "    }",
  "  };",
  "  // Project only snapshots capable of binding the requested metric instants.",
  "  // Browser pages can occur after their profile capture, so their stored final",
  "  // page time bounds candidates; browserWorksObservation binds each exact page.",
  "  const hasWorksTime = db.prepare('PRAGMA table_info(snapshots)').all().some(column => column.name === 'works_observed_at');",
  "  const browserTime = hasWorksTime ? `OR (s.works_observed_at IS NOT NULL",
  "      AND julianday(s.captured_at)<=julianday(w.metric_at) AND julianday(s.works_observed_at)>=julianday(w.metric_at))` : '';",
  "  const snapshots = db.prepare(`WITH wanted AS (",
  "    SELECT json_extract(value,'$.targetId') target_id,json_extract(value,'$.metricAt') metric_at FROM json_each(?)",
  "  ) SELECT DISTINCT s.id,s.target_id,s.captured_at,s.source_checksum,s.raw_json FROM wanted w",
  "    JOIN snapshots s ON s.target_id=w.target_id",
  "      AND (julianday(s.captured_at)=julianday(w.metric_at) ${browserTime})",
  "    WHERE s.quality_status IN ('validated','warning') AND julianday(s.captured_at)<=julianday(?)",
  "      ${snapshotMaxId === null ? '' : 'AND s.id<=?'}",
  "    ORDER BY julianday(s.captured_at) DESC,s.id DESC`).all(wantedTimes, asOf, ...(snapshotMaxId === null ? [] : [snapshotMaxId]));",
  "  for (const row of snapshots) {",
  "    try {",
  "      const raw = JSON.parse(row.raw_json), target = targetsById.get(Number(row.target_id));",
  "      if (!target || checksum(raw) !== row.source_checksum || !Number.isFinite(historyObservationTime(raw.capturedAt))",
  "        || historyObservationTime(raw.capturedAt) !== historyObservationTime(row.captured_at)) continue;",
  "      const observation = browserWorksObservation(raw, { reference: Date.parse(asOf) });",
  "      if (raw.works?.pagination?.version === 1 && !observation) continue;",
  "      accept(row.target_id, normalizeCollection(target, raw, { capturedAt: row.captured_at }).posts,",
  "        post => observation?.postTimes.get(post.externalId) ?? row.captured_at, raw.profile?.user);",
  "    } catch { /* Missing or malformed historical evidence stays unknown. */ }",
  "  }",
  "  // Freshness reads deliberately select two accepted windows. Metadata needs",
  "  // the actual historical run for each remaining metric instant instead.",
  "  const unresolved = new Set(changed.filter(row => !recovered.has(row.id) && Number.isFinite(Date.parse(row.metric_at)))",
  "    .map(row => `${row.target_id}:${new Date(row.metric_at).toISOString()}`));",
  "  const unresolvedTimes = JSON.stringify([...times.entries()].filter(([key]) => unresolved.has(key)).map(([, time]) => time));",
  "  if (db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='works_observations'\").get()",
  "    && db.prepare('PRAGMA table_info(works_observations)').all().some(column => column.name === 'run_id')) {",
  "    const runIds = db.prepare(`WITH wanted AS (",
  "      SELECT json_extract(value,'$.targetId') target_id,json_extract(value,'$.metricAt') metric_at FROM json_each(?)",
  "    ) SELECT DISTINCT w.run_id FROM wanted m JOIN works_observations w ON w.target_id=m.target_id",
  "      AND julianday(w.request_started_at)<=julianday(m.metric_at) AND julianday(w.observed_at)>=julianday(m.metric_at)",
  "      WHERE w.status='accepted' AND julianday(w.request_finished_at)<=julianday(?) AND w.run_id IS NOT NULL",
  "        ${snapshotMaxId === null ? '' : 'AND w.anchor_snapshot_id<=?'}`)",
  "      .all(unresolvedTimes, asOf, ...(snapshotMaxId === null ? [] : [snapshotMaxId])).map(row => Number(row.run_id));",
  "    for (const row of loadVerifiedWorksOnlyRows(db, asOf, null, { runIds })) {",
  "      if (row.status !== 'accepted') continue;",
  "      let offset = 0;",
  "      for (const page of row.raw.pagination.pages) {",
  "        accept(row.target_id, row.raw.posts.slice(offset, offset + page.acceptedCount).map(post => normalizePost(post)),",
  "          () => page.observedAt, { sec_uid: row.raw.identity.secUid, uid: row.raw.identity.uid });",
  "        offset += page.acceptedCount;",
  "      }",
  "    }",
  "  }",
  "  // A dated metric alone is not evidence that a work was observed before its",
  "  // later insertion. Only exact source/identity/time/vector recovery admits it;",
  "  // missing metadata on already-known legacy works retains the old semantics.",
  "  return rows.flatMap(row => {",
  "    if (lateKnown(row) && !recovered.has(row.id)) return [];",
  "    return [forceRecovery || lateKnown(row) || Date.parse(row.last_seen_at) > cutoff",
  "      ? { ...row, ...(recovered.get(row.id) ?? { caption: null, url: null, published_at: null }) }",
  "      : row];",
  "  });",
  "}",
].join('\n');

// These two fixed source bodies are the complete pre-reuse works reader and
// the pre-reuse postsAsOf algorithm, captured before implementation. The test
// never reads a deployment backup, a production database, or an external URL.
// Common canonical evidence/normalization helpers are intentionally shared:
// this change concerns reuse of reads, not their canonical source contract.
const moduleSource = source => source.replace(
  /(['"])\.\/([^'"]+)\1/g,
  (_, quote, path) => quote + new URL('../lib/' + path, import.meta.url).href + quote,
);
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const originalWorksUrl = moduleUrl(moduleSource(ORIGINAL_WORKS_SOURCE));
const originalWorks = await import(originalWorksUrl);
const originalPosts = await import(moduleUrl(
  "import { checksum, safeJson, shiftCalendarDate } from " + JSON.stringify(new URL('../lib/utils.mjs', import.meta.url).href) + ";\n" +
  "import { normalizeCollection, normalizePost } from " + JSON.stringify(new URL('../lib/providers/normalize.mjs', import.meta.url).href) + ";\n" +
  "import { browserWorksObservation } from " + JSON.stringify(new URL('../lib/official-profile-evidence.mjs', import.meta.url).href) + ";\n" +
  "import { canonicalAccountLocator } from " + JSON.stringify(new URL('../lib/author-spreadsheet.mjs', import.meta.url).href) + ";\n" +
  "import { loadVerifiedWorksOnlyRows } from " + JSON.stringify(originalWorksUrl) + ";\n" +
  ORIGINAL_POSTS_SOURCE,
));

const SEC = 'MS4wLjABAAAAIndependentReadReuseOracle1234';
const UID = '123456789';
const BASE = Date.parse('2026-09-28T00:00:00.000Z');
const ASOF = '2026-09-28T15:59:59.999Z';
const LATE = '2026-09-29T03:00:00.000Z';
const iso = time => new Date(time).toISOString();
const options = {
  period: 'day', timeZone: 'Asia/Shanghai',
  startDate: '2026-09-28', endDate: '2026-09-28',
  reference: new Date('2026-09-30T12:00:00.000Z'), includeRecordedWindow: false,
};

function fixture(t, { inventory = 3, prefix = 'original', enableClock = true } = {}) {
  if (enableClock) t.mock.timers.enable({ apis: ['Date'], now: BASE });
  else t.mock.timers.setTime(BASE);
  const database = new MonitorDatabase(':memory:');
  t.after(() => database.close());
  const target = database.createTarget({
    type: 'account', provider: 'public-web', locator: SEC,
    label: 'independent isolated oracle', metadata: { platform: 'douyin' },
  });
  const db = database.db, saved = [];
  const post = n => ({
    aweme_id: String(7200000000000000000n + BigInt(n)),
    author: { sec_uid: SEC, uid: UID }, desc: prefix + ' title ' + n,
    create_time: BASE / 1000, statistics: { digg_count: n },
  });
  const anchor = (totalPosts = inventory, at = BASE) => {
    t.mock.timers.setTime(at);
    const capturedAt = iso(at);
    const raw = {
      capturedAt, accountStatus: 'validated', accountError: null,
      profile: { user: { sec_uid: SEC, uid: UID, follower_count: 12, total_favorited: 33, aweme_count: totalPosts } },
      worksCoverage: 'unavailable', worksErrorCode: 'deferred',
      works: { stopReason: 'request-deferred', pagination: { requestCount: 0, pages: [] } },
      provenance: {
        mode: 'guest-ttwid-unsigned-profile', profileMode: 'guest-ttwid-unsigned-profile',
        profileEndpoint: 'https://www.douyin.com/aweme/v1/web/user/profile/other/',
        accountLocator: 'sec_uid', cookiePersisted: false, runtimeAI: false, paidAPI: false,
      },
    };
    database.saveCollection(target, null, normalizeCollection(target, raw, { capturedAt }));
    return readWorksOnlyAnchor(db, target.id, { now: at });
  };
  let currentAnchor = anchor();
  const append = ({ n = saved.length + 1, at = BASE + (saved.length + 1) * 60_000,
    pages = [[0, 0, false, n, 1]], continuation = undefined, totalPosts = undefined,
    failed = false, running = false, maxPages = 3 } = {}) => {
    if (totalPosts !== undefined) currentAnchor = anchor(totalPosts, at - 1000);
    t.mock.timers.setTime(at);
    const runId = database.beginRun('works-only', target.id, 1);
    const pagination = new BrowserWorksPagination({ limit: 30, maxPages, startCursor: continuation?.cursor });
    for (const [index, [cursor, next, more, first, count]] of pages.entries()) {
      const posts = Array.from({ length: count }, (_, offset) => post(first + offset));
      pagination.accept({
        requestCursor: cursor, body: { aweme_list: posts, has_more: more },
        normalized: { posts, maxCursor: next, filteredCount: 0, duplicateCount: 0, locallyTruncated: false },
        observedAt: iso(at + 20 + index * 20),
      });
    }
    const requestFinishedAt = iso(at + 1000);
    t.mock.timers.setTime(at + 1000);
    const input = {
      targetId: target.id, runId, anchorSnapshotId: currentAnchor.snapshotId,
      anchorChecksum: currentAnchor.sourceChecksum, requestStartedAt: iso(at),
      requestFinishedAt, requestedLimit: 30, ...(continuation ? { continuation } : {}),
      result: failed ? { status: 'unavailable', posts: [], errorCode: 'blocked' }
        : { status: 'ok', errorCode: null, ...pagination.result(pages.length) },
    };
    const row = recordWorksOnlyObservation(db, input, { now: Date.now() });
    if (!running) {
      t.mock.timers.setTime(at + 1001);
      database.finishRun(runId, { status: failed ? 'error' : 'success',
        successCount: failed ? 0 : 1, errorCount: failed ? 1 : 0 });
    }
    saved.push({ ...row, runId, input });
    return saved.at(-1);
  };
  const mutateMetadata = () => {
    t.mock.timers.setTime(Date.parse(LATE));
    persistPosts(db, { target, capturedAt: LATE, posts: db.prepare('SELECT external_id FROM posts ORDER BY id').all()
      .map(row => normalizePost({ ...post(Number(BigInt(row.external_id) - 7200000000000000000n)),
        desc: 'later mutable title', statistics: { digg_count: 999 } })) });
  };
  return { database, db, target, saved, post, append, anchor, mutateMetadata };
}

function selectedPosts(f, asOf = ASOF) {
  return f.db.prepare('SELECT p.*,pm.captured_at AS metric_at,pm.likes,pm.comments,pm.shares,pm.collects,pm.plays FROM posts p ' +
    'JOIN post_metrics pm ON pm.id=(SELECT m.id FROM post_metrics m WHERE m.post_id=p.id ' +
    'AND julianday(m.captured_at)<=julianday(?) ORDER BY julianday(m.captured_at) DESC,m.id DESC LIMIT 1) ORDER BY p.id').all(asOf);
}
function targets(f) { return f.db.prepare('SELECT * FROM targets ORDER BY id').all(); }
function scope(f, asOf, callback) {
  assert.equal(typeof works.withWorksObservationRead, 'function', 'scoped reader API is available');
  return works.withWorksObservationRead(f.database, asOf, callback);
}
function compareRead(f, reader, asOf, targetId = null, selection = {}) {
  const actual = reader.loadVerified(targetId, selection);
  const expected = originalWorks.loadVerifiedWorksOnlyRows(f.db, asOf, targetId, selection);
  assert.deepEqual(actual, expected, 'reused verified rows equal fixed original logic');
  return actual;
}
function compareObservations(f, reader, asOf, targetId = null) {
  const actual = reader.loadObservations(targetId);
  assert.deepEqual(actual, originalWorks.loadWorksObservations(f.database, asOf, targetId),
    'coverage and attempt projection equal fixed original logic');
  return actual;
}
function comparePosts(f, asOf = ASOF, recovery = {}) {
  const rows = selectedPosts(f, asOf), accountTargets = targets(f);
  const expected = originalPosts.postsAsOf(f.database, rows, asOf, accountTargets, recovery);
  assert.deepEqual(postsAsOf(f.database, rows, asOf, accountTargets, recovery), expected,
    'public postsAsOf contract equals fixed original logic');
  return expected;
}
function sourceState(f) {
  return Object.fromEntries(['snapshots', 'works_observations', 'runs', 'posts', 'post_metrics', 'audits', 'targets']
    .map(table => [table, f.db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]));
}
function corruptLedger(f, mutation) {
  f.db.exec('DROP TRIGGER works_observations_no_update');
  const row = f.db.prepare('SELECT * FROM works_observations ORDER BY id LIMIT 1').get();
  mutation(row);
}
function chain(f, varyingInventory = false) {
  f.append({ pages: [[0, 100, true, 1, 20], [100, 200, true, 21, 20]], totalPosts: 60 });
  for (let round = 1; round < 3; round++) {
    const at = BASE + (round + 1) * 60_000;
    const identity = { secUid: SEC, uid: UID };
    const resume = originalWorks.readTrustedWorksResume(f.db, f.target.id, identity, iso(at));
    assert.equal(resume.cursor, round * 100, 'continuation comes from the fixed original reader');
    f.append({ at, continuation: resume, totalPosts: varyingInventory && round === 1 ? 61 : 60,
      pages: round === 1 ? [[100, 200, true, 21, 20], [200, 300, true, 41, 20]]
        : [[200, 0, false, 41, 20]] });
  }
  return f.saved.map(row => row.runId);
}

test('independent read reuse: default and selected history intersect without widening the default window', t => {
  const f = fixture(t); f.append(); f.append(); f.append();
  const runIds = f.saved.map(row => row.runId);
  scope(f, ASOF, reader => {
    assert.deepEqual(compareRead(f, reader, ASOF).map(row => row.run_id), runIds.slice(1).reverse());
    assert.deepEqual(compareRead(f, reader, ASOF, null, { runIds }).map(row => row.run_id), runIds.toReversed());
    compareRead(f, reader, ASOF, f.target.id, { runIds: [runIds[0], runIds[2]] });
    compareRead(f, reader, ASOF, f.target.id, { runId: runIds[0] });
    assert.equal(compareRead(f, reader, ASOF, null, { acceptedPerTarget: 1 }).length, 1);
    assert.deepEqual(compareRead(f, reader, ASOF, null, { runIds: [] }), []);
    assert.deepEqual(compareRead(f, reader, ASOF, null, { runIds: [99999] }), []);
    assert.deepEqual(compareRead(f, reader, ASOF).map(row => row.run_id), runIds.slice(1).reverse());
    compareObservations(f, reader, ASOF);
  });
});

test('independent read reuse: oldest historical metadata and later-known work keep exact pre-cutoff source binding', t => {
  const f = fixture(t); f.append(); f.append(); f.append();
  f.mutateMetadata();
  f.db.prepare('UPDATE posts SET first_seen_at=? WHERE external_id=?').run(LATE, f.post(1).aweme_id);
  const before = comparePosts(f);
  assert.equal(before.length, 3);
  assert.deepEqual(before.map(row => row.caption), ['original title 1', 'original title 2', 'original title 3']);
  assert.deepEqual(before.map(row => row.likes), [1, 2, 3]);
  const force = comparePosts(f, ASOF, { forceRecovery: true });
  assert.deepEqual(force, before);
  scope(f, ASOF, reader => {
    assert.ok(!compareRead(f, reader, ASOF).some(row => row.run_id === f.saved[0].runId));
    assert.equal(compareRead(f, reader, ASOF, null, { runIds: [f.saved[0].runId] })[0].run_id, f.saved[0].runId);
    compareObservations(f, reader, ASOF, f.target.id);
  });
  const account = getAccountInsight(f.database, f.target.id, options);
  assert.equal(account.account.publishedSamples.value, 3);
  assert.deepEqual(account.recentWorks.map(row => row.caption).sort(),
    ['original title 1', 'original title 2', 'original title 3']);
  assert.equal(getProductInsights(f.database, options).summary.publishedSamples.value, 3);
});

for (const [name, mutation] of [
  ['canonical checksum', f => corruptLedger(f, row => f.db.prepare('UPDATE works_observations SET source_checksum=? WHERE id=?').run('bad', row.id))],
  ['rehashed author identity', f => corruptLedger(f, row => {
    const raw = JSON.parse(row.raw_json); raw.identity.uid = '999999'; raw.posts[0].author.uid = '999999';
    f.db.prepare('UPDATE works_observations SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(raw), checksum(raw), row.id);
  })],
  ['anchor audit missing', f => f.db.exec('DELETE FROM audits')],
  ['run not processed', f => f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId)],
  ['selected metric vector mismatch', f => f.db.prepare('UPDATE post_metrics SET likes=999 WHERE captured_at=?').run(f.saved[0].observedAt)],
  ['metric time shifted by one millisecond', f => f.db.prepare('UPDATE post_metrics SET captured_at=? WHERE captured_at=?')
    .run(iso(Date.parse(f.saved[0].observedAt) + 1), f.saved[0].observedAt)],
  ['stored author identity mismatch', f => f.db.prepare('UPDATE posts SET author_id=?').run(SEC + 'Foreign')],
]) test('independent read reuse: later-known metadata rejects ' + name, t => {
  const f = fixture(t, { inventory: 1 }); f.append(); f.mutateMetadata();
  f.db.prepare('UPDATE posts SET first_seen_at=?').run(LATE);
  mutation(f);
  scope(f, ASOF, reader => {
    compareRead(f, reader, ASOF);
    compareRead(f, reader, ASOF, null, { runIds: [f.saved[0].runId] });
    compareObservations(f, reader, ASOF);
  });
  assert.deepEqual(comparePosts(f), [], 'dated metric cannot admit a later-known work without matching evidence');
  assert.equal(getProductInsights(f.database, options).summary.publishedSamples.value, 0);
  assert.deepEqual(getAccountInsight(f.database, f.target.id, options).recentWorks, []);
});

test('independent read reuse: later-known metric with no immutable source stays absent', t => {
  const f = fixture(t, { inventory: 1 });
  t.mock.timers.setTime(Date.parse(LATE));
  persistPosts(f.db, { target: f.target, posts: [normalizePost(f.post(1))], capturedAt: LATE });
  const postId = f.db.prepare('SELECT id FROM posts').get().id;
  f.db.prepare('INSERT INTO post_metrics(post_id,captured_at,likes) VALUES(?,?,?)').run(postId, iso(BASE + 60020), 1);
  assert.deepEqual(comparePosts(f), []);
  scope(f, ASOF, reader => {
    assert.deepEqual(compareRead(f, reader, ASOF), []);
    compareObservations(f, reader, ASOF);
  });
  assert.equal(getProductInsights(f.database, options).summary.publishedSamples.value, 0);
});

for (const varyingInventory of [false, true]) test(
  'independent read reuse: intersecting ancestor reads preserve ' + (varyingInventory ? 'limited inventory chain' : 'verified complete chain'),
  t => {
    const f = fixture(t, { inventory: 60 });
    const runIds = chain(f, varyingInventory);
    scope(f, ASOF, reader => {
      compareRead(f, reader, ASOF, f.target.id, { runIds: [runIds[0]] });
      const defaultRows = compareRead(f, reader, ASOF);
      const final = defaultRows.find(row => row.run_id === runIds.at(-1));
      assert.equal(final.coverage, 'limited', 'the immutable source row remains limited');
      assert.equal(final.works_coverage, varyingInventory ? 'limited' : 'complete');
      assert.equal(final.list_count, varyingInventory ? 20 : 60);
      assert.equal(final.coverage_evidence?.kind, varyingInventory ? undefined : 'verified-public-cursor-chain');
      compareRead(f, reader, ASOF, null, { runIds });
      compareRead(f, reader, ASOF);
      assert.equal(compareObservations(f, reader, ASOF).get(f.target.id).coverage,
        varyingInventory ? 'limited' : 'complete');
    });
  },
);

test('independent read reuse: invalid oldest chain node cannot lend cached trust to descendants', t => {
  const f = fixture(t, { inventory: 60 }), runIds = chain(f);
  corruptLedger(f, row => f.db.prepare('UPDATE works_observations SET source_checksum=? WHERE id=?').run('bad', row.id));
  scope(f, ASOF, reader => {
    assert.deepEqual(compareRead(f, reader, ASOF, null, { runIds: [runIds[0]] }), []);
    assert.deepEqual(compareRead(f, reader, ASOF), []);
    assert.deepEqual(compareRead(f, reader, ASOF, null, { runIds }), []);
    compareObservations(f, reader, ASOF);
  });
});

test('independent read reuse: distinct cutoffs and later writes never reuse an earlier request receipt', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  const early = iso(BASE + 61010), later = iso(BASE + 181010);
  const earlyRows = scope(f, early, reader => compareRead(f, reader, early));
  f.append(); f.append();
  scope(f, later, reader => assert.equal(compareRead(f, reader, later).length, 2));
  assert.deepEqual(scope(f, early, reader => compareRead(f, reader, early)), earlyRows);
  scope(f, ASOF, reader => {
    compareRead(f, reader, ASOF);
    compareRead(f, reader, ASOF, null, { runIds: [f.saved[2].runId] });
  });
  f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[2].runId);
  scope(f, ASOF, reader => {
    assert.deepEqual(compareRead(f, reader, ASOF, null, { runIds: [f.saved[2].runId] }), []);
    assert.equal(compareRead(f, reader, ASOF).length, 1, 'later request rechecks an existing run after a write');
  });
  f.append({ at: BASE + 4 * 60_000 });
  scope(f, ASOF, reader => {
    assert.equal(compareRead(f, reader, ASOF)[0].run_id, f.saved[3].runId,
      'a subsequent request sees newly appended evidence');
    compareObservations(f, reader, ASOF);
  });
});

test('independent read reuse: scope cannot escape or accept asynchronous callbacks', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  let escaped;
  scope(f, ASOF, reader => {
    escaped = reader;
    const row = compareRead(f, reader, ASOF)[0];
    assert.throws(() => { row.raw.identity.uid = '999999'; }, TypeError);
    assert.throws(() => { row.raw.posts[0].statistics.digg_count = 999; }, TypeError);
    compareRead(f, reader, ASOF, null, { runIds: [f.saved[0].runId] });
  });
  assert.throws(() => escaped.loadVerified(), 'an expired reader must reject without depending on error wording');
  assert.throws(() => escaped.loadObservations());
  assert.throws(() => scope(f, ASOF, () => Promise.resolve()));
  scope(f, ASOF, reader => compareObservations(f, reader, ASOF));
});

test('independent read reuse: same row and run IDs in different databases cannot share evidence', t => {
  const first = fixture(t, { inventory: 1, prefix: 'first database' }); first.append();
  const second = fixture(t, { inventory: 1, prefix: 'second database', enableClock: false }); second.append();
  assert.equal(first.saved[0].runId, second.saved[0].runId);
  assert.equal(first.saved[0].id, second.saved[0].id);
  scope(first, ASOF, firstReader => {
    const firstRows = compareRead(first, firstReader, ASOF);
    scope(second, ASOF, secondReader => {
      const secondRows = compareRead(second, secondReader, ASOF);
      assert.notEqual(secondRows[0].source_checksum, firstRows[0].source_checksum);
      assert.equal(secondRows[0].raw.posts[0].desc, 'second database title 1');
      compareObservations(second, secondReader, ASOF);
    });
    assert.deepEqual(compareRead(first, firstReader, ASOF), firstRows);
    assert.equal(firstRows[0].raw.posts[0].desc, 'first database title 1');
  });
});

test('independent read reuse: a same-connection write invalidates success receipts inside the scope', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  const before = sourceState(f), expected = originalWorks.loadVerifiedWorksOnlyRows(f.db, ASOF);
  assert.throws(() => scope(f, ASOF, reader => {
    assert.equal(compareRead(f, reader, ASOF)[0].run_id, f.saved[0].runId);
    f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId);
    assert.throws(() => reader.loadVerified(null, { runIds: [f.saved[0].runId] }));
    assert.throws(() => reader.loadVerified());
    assert.throws(() => reader.loadObservations());
  }));
  assert.deepEqual(sourceState(f), before, 'a rejected scope rolls back its attempted run mutation');
  scope(f, ASOF, reader => {
    assert.deepEqual(compareRead(f, reader, ASOF), expected);
    assert.equal(compareRead(f, reader, ASOF)[0].run_id, f.saved[0].runId,
      'the originally valid completed run survives the rejected callback');
  });
});

test('independent read reuse: a standalone accidental callback write is rejected and fully rolled back', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  const before = sourceState(f);
  assert.throws(() => scope(f, ASOF, () => {
    f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId);
    f.db.prepare('UPDATE posts SET caption=? WHERE target_id=?').run('accidental callback title', f.target.id);
    return 'a callback return cannot commit these mutations';
  }));
  assert.deepEqual(sourceState(f), before);
  scope(f, ASOF, reader => assert.equal(compareRead(f, reader, ASOF).length, 1));
});

test('independent read reuse: outer work survives while the rejected inner callback writes roll back', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  f.db.exec('BEGIN');
  let committed = false;
  try {
    f.db.prepare('UPDATE targets SET label=? WHERE id=?').run('previous outer work', f.target.id);
    const outerState = sourceState(f);
    assert.throws(() => scope(f, ASOF, () => {
      f.db.prepare('UPDATE targets SET label=? WHERE id=?').run('accidental inner work', f.target.id);
      f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId);
    }));
    assert.deepEqual(sourceState(f), outerState, 'only mutations after the scoped savepoint are undone');
    scope(f, ASOF, reader => assert.equal(compareRead(f, reader, ASOF).length, 1));
    f.db.exec('COMMIT');
    committed = true;
    assert.deepEqual(sourceState(f), outerState, 'the earlier outer write remains committable');
    assert.equal(f.db.prepare('SELECT label FROM targets WHERE id=?').get(f.target.id).label, 'previous outer work');
  } finally {
    if (!committed) f.db.exec('ROLLBACK');
  }
});

test('independent read reuse: a throwing callback preserves its original error and rolls back its writes', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  const before = sourceState(f), failure = new Error('intentional isolated callback failure');
  let escaped;
  assert.throws(() => scope(f, ASOF, reader => {
    escaped = reader;
    compareRead(f, reader, ASOF);
    f.db.prepare('UPDATE posts SET caption=? WHERE target_id=?').run('throwing callback title', f.target.id);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(sourceState(f), before);
  assert.throws(() => escaped.loadVerified());
  scope(f, ASOF, reader => assert.equal(compareRead(f, reader, ASOF).length, 1));
});

test('independent read reuse: Promise and thenable returns roll back writes without invoking the thenable', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  const before = sourceState(f);
  let invoked = false;
  const thenable = { then() { invoked = true; } };
  for (const result of [Promise.resolve('asynchronous result'), thenable]) {
    assert.throws(() => scope(f, ASOF, () => {
      f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId);
      f.db.prepare('UPDATE posts SET caption=? WHERE target_id=?').run('thenable callback title', f.target.id);
      return result;
    }));
    assert.deepEqual(sourceState(f), before);
    scope(f, ASOF, reader => assert.equal(compareRead(f, reader, ASOF).length, 1));
  }
  assert.equal(invoked, false);
});

test('independent read reuse: rolling back a mutable run write cannot preserve its temporary success receipt', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId);
  assert.throws(() => scope(f, ASOF, reader => {
    assert.deepEqual(compareRead(f, reader, ASOF), []);
    f.db.exec('SAVEPOINT independent_mutable_run');
    try {
      f.db.prepare('UPDATE runs SET processed_count=1 WHERE id=?').run(f.saved[0].runId);
      assert.throws(() => reader.loadVerified());
      f.db.exec('ROLLBACK TO independent_mutable_run');
      assert.throws(() => reader.loadVerified(null, { runIds: [f.saved[0].runId] }));
    } finally {
      f.db.exec('RELEASE independent_mutable_run');
    }
  }));
  scope(f, ASOF, reader => assert.deepEqual(compareRead(f, reader, ASOF), []));
});

test('independent read reuse: an outer rollback after return requires a fresh verification in the next request', t => {
  const f = fixture(t, { inventory: 1 }); f.append();
  f.db.prepare('UPDATE runs SET processed_count=0 WHERE id=?').run(f.saved[0].runId);
  f.db.exec('SAVEPOINT independent_outer_transaction');
  try {
    f.db.prepare('UPDATE runs SET processed_count=1 WHERE id=?').run(f.saved[0].runId);
    scope(f, ASOF, reader => assert.equal(compareRead(f, reader, ASOF).length, 1));
    const changes = f.db.prepare('SELECT total_changes() AS n').get().n;
    f.db.exec('ROLLBACK TO independent_outer_transaction');
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes,
      'the fixture demonstrates that SQLite total_changes does not rewind on rollback');
    scope(f, ASOF, reader => {
      assert.deepEqual(compareRead(f, reader, ASOF), []);
      compareObservations(f, reader, ASOF);
    });
  } finally {
    f.db.exec('RELEASE independent_outer_transaction');
  }
});

test('independent read reuse: query-only projection cannot change source tables or the default reader contract', t => {
  const f = fixture(t); f.append(); f.append(); f.append(); f.mutateMetadata();
  const tableRows = () => Object.fromEntries(['snapshots', 'works_observations', 'runs', 'posts', 'post_metrics', 'audits']
    .map(table => [table, f.db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all()]));
  const before = tableRows(), changes = f.db.prepare('SELECT total_changes() AS n').get().n;
  f.db.exec('PRAGMA query_only=ON');
  scope(f, ASOF, reader => {
    compareRead(f, reader, ASOF);
    compareRead(f, reader, ASOF, null, { runIds: f.saved.map(row => row.runId) });
    compareObservations(f, reader, ASOF);
  });
  comparePosts(f);
  assert.equal(getProductInsights(f.database, options).summary.publishedSamples.value, 3);
  assert.deepEqual(tableRows(), before);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.deepEqual(works.loadVerifiedWorksOnlyRows(f.db, ASOF), originalWorks.loadVerifiedWorksOnlyRows(f.db, ASOF));
});

test('independent read reuse: a cached maximum-height parent cannot admit an overlong selected child', t => {
  const f = fixture(t, { inventory: 60 });
  for (let index = 0; index < 25; index++) {
    const at = BASE + (index + 1) * 60_000;
    const continuation = index === 0 ? undefined : originalWorks.readTrustedWorksResume(
      f.db, f.target.id, { secUid: SEC, uid: UID }, iso(at));
    assert.equal(continuation?.depth, index === 0 ? undefined : index);
    f.append({ at, maxPages: 1, continuation, pages: [[index, index + 1, true, index + 1, 1]] });
  }
  const parent = f.saved.at(-1), stored = f.db.prepare('SELECT * FROM works_observations WHERE id=?').get(parent.id);
  const raw = JSON.parse(stored.raw_json), at = BASE + 26 * 60_000;
  t.mock.timers.setTime(at);
  const runId = f.database.beginRun('works-only', f.target.id, 1);
  raw.runId = runId; raw.requestStartedAt = iso(at); raw.requestFinishedAt = iso(at + 1000);
  raw.observedAt = iso(at + 20); raw.posts = [f.post(26)];
  // A synthetic overlong child is inserted directly because the ordinary
  // writer correctly refuses to grant a 25th continuation edge. Each node's
  // canonical depth remains bounded; the reader must still bind the full
  // predecessor graph instead of borrowing its already-checked parent.
  raw.continuation = { version: 1, observationId: parent.id, runId: parent.runId,
    sourceChecksum: parent.sourceChecksum, cursor: 25, depth: 24 };
  raw.pagination.startCursor = 25;
  raw.pagination.pages = [{ requestCursor: 25, response: { max_cursor: 26, has_more: true },
    rawCount: 1, acceptedCount: 1, duplicateCount: 0, filteredCount: 0, truncated: false, observedAt: raw.observedAt }];
  t.mock.timers.setTime(at + 1000);
  f.db.prepare('INSERT INTO works_observations(target_id,run_id,anchor_snapshot_id,anchor_checksum,' +
    'request_started_at,request_finished_at,observed_at,status,coverage,error_code,source_checksum,raw_json,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.target.id, runId, raw.anchorSnapshotId, raw.anchorChecksum,
    raw.requestStartedAt, raw.requestFinishedAt, raw.observedAt, raw.status, raw.coverage, raw.errorCode,
    checksum(raw), JSON.stringify(raw), raw.requestFinishedAt);
  t.mock.timers.setTime(at + 1001);
  f.database.finishRun(runId, { status: 'success', successCount: 1 });
  scope(f, ASOF, reader => {
    assert.equal(compareRead(f, reader, ASOF, f.target.id, { runIds: [parent.runId] }).length, 1);
    assert.deepEqual(compareRead(f, reader, ASOF, f.target.id, { runIds: [runId] }), [],
      'the overlong child is rejected entirely, rather than projected as a limited accepted node');
    compareRead(f, reader, ASOF);
  });
});
