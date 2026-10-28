import { createProvider } from './providers/index.mjs';
import { readWorksOnlyAnchor, recordWorksOnlyObservation } from './works-only-observation.mjs';
import { safeJson } from './utils.mjs';
import { projectWorksRequestPolicy, isOccludedNoBoundWorksFailure } from './works-request-policy.mjs';
import { loadVerifiedWorksOnlyRows, loadWorksSamplingStates } from './works-observation.mjs';
import { projectWorksOnlyFailure } from './works-only-failure.mjs';
import { ownedCollectorExecutor } from './collector-ownership.mjs';

const RETRY_DELAY = 15 * 60_000;
const DENIALS = new Set(['blocked', 'login_required', 'rate_limited', 'upstream_changed']);

// A visible obstruction with no bound works request is not evidence of a
// transient endpoint/transport failure. Keep the source result unavailable,
// but do not spend a second request or trip the cross-account circuit in this
// slot. Unknown or incomplete diagnostics retain the ordinary retry policy.
function occludedNoBoundWorksAttempt(run, detail) {
  return run?.status === 'error' && detail?.mode === 'works-only' && detail.targetId === run.target_id
    && detail.attempted === true && isOccludedNoBoundWorksFailure(detail);
}

// Durable cross-account load shedding. A failed transport invocation is not
// proof a platform request reached Douyin; neither is a fabricated success
// detail enough to reset this gate. Normal profile/topic schedules are separate.
export function worksOnlyRetryGate(database, { now = new Date(), slot } = {}) {
  const open = { deferred: false, nextEligibleAt: null, reason: null, failureCount: 0 };
  if (!slot || !Number.isFinite(now.getTime())) return open;
  const rows = database.db.prepare(`SELECT id,target_id,status,started_at,finished_at,details_json FROM runs
    WHERE trigger_type='works-only' AND julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?)
      AND finished_at IS NOT NULL AND julianday(finished_at)>=julianday(started_at) AND julianday(finished_at)<=julianday(?)
    ORDER BY julianday(finished_at) DESC,id DESC LIMIT 1000`).all(slot.startsAt, slot.endsAt, now.toISOString());
  const failedTargets = new Set(); let latestFailureAt = null;
  for (const run of rows) {
    if (['partial','success'].includes(run.status)
      && loadVerifiedWorksOnlyRows(database.db, now.toISOString(), null, { runId: run.id }).some(row => row.status === 'accepted')) break;
    const details = safeJson(run.details_json, []);
    const detail = Array.isArray(details) && details.length === 1 ? details[0] : null;
    if (detail?.mode !== 'works-only' || detail?.targetId !== run.target_id || detail?.attempted !== true) continue;
    if (occludedNoBoundWorksAttempt(run, detail)) continue;
    // A denial, skipped/unknown result or unproven success is not a recovered
    // public sample. It neither adds a transient failure nor clears the streak.
    if (run.status !== 'error' || !['collector_error','network_error'].includes(detail.errorCode)) continue;
    latestFailureAt ??= Date.parse(run.finished_at);
    failedTargets.add(run.target_id);
    if (failedTargets.size >= 5) break;
  }
  if (failedTargets.size < 5) return { ...open, failureCount: failedTargets.size };
  const until = latestFailureAt + RETRY_DELAY;
  return { deferred: now.getTime() < until, nextEligibleAt: new Date(until).toISOString(),
    reason: 'consecutive-works-transient-failures', failureCount: failedTargets.size };
}

// Uses the existing eight-hour slot and singleton scheduler; no extra timer.
// A run reservation survives restart even if a process dies before its result.
export function planWorksOnly(database, attempts, { now, slot, targetId = null } = {}) {
  if (!slot || !database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='works_observations'").get()) return { due: [], deferred: 0, exhausted: 0 };
  const runs = database.db.prepare(`SELECT id,target_id,started_at,finished_at,status,details_json FROM runs
    WHERE trigger_type='works-only' AND julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?)
    AND julianday(started_at)<=julianday(?) ORDER BY id DESC`).all(slot.startsAt, slot.endsAt, now.toISOString());
  const byTarget = new Map();
  for (const run of runs) {
    if (!byTarget.has(run.target_id)) byTarget.set(run.target_id, []);
    byTarget.get(run.target_id).push(run);
  }
  const plan = { due: [], deferred: 0, exhausted: 0 };
  const samplingStates = loadWorksSamplingStates(database.db, now.toISOString(), targetId);
  for (const target of database.listTargets()) {
    if (targetId !== null && target.id !== targetId) continue;
    const attempt = attempts.get(Number(target.id));
    if (!target.enabled || target.type !== 'account' || target.provider !== 'public-web'
      || attempt?.profileCompleted !== true || ['inactive', 'manual'].includes(attempt.latestReviewState)
      || !['retry', 'unavailable', 'unknown'].includes(attempt.latestSnapshot?.works_coverage)) continue;
    const history = byTarget.get(target.id) ?? [];
    const newest = history[0];
    const detail = safeJson(newest?.details_json, [])?.[0];
    // Explicitly skipped (no network) runs do not consume a retry allowance.
    const consumed = history.filter(run => safeJson(run.details_json, [])?.[0]?.attempted !== false);
    if (newest && (!newest.finished_at || newest.status === 'running')) { plan.deferred++; continue; }
    if (consumed.length >= 2 || (detail?.attempted && DENIALS.has(detail.errorCode))
      || occludedNoBoundWorksAttempt(newest, detail)) { plan.exhausted++; continue; }
    const policy = projectWorksRequestPolicy(detail?.requestPolicy)?.browser;
    const wait = Math.max(Date.parse(policy?.nextEligibleAt) || 0,
      newest && (!['success', 'partial'].includes(newest.status) || detail?.errorCode != null)
        ? Date.parse(newest.finished_at || newest.started_at) + RETRY_DELAY : 0);
    // An indefinite refusal settles this account for the round; it must not
    // prevent every other account from starting their next continuous round.
    // The provider retains the transport policy independently across rounds.
    if (policy?.retryAfterStatus === 'too-long') { plan.exhausted++; continue; }
    if (now.getTime() < wait) { plan.deferred++; continue; }
    let anchor;
    try { anchor = readWorksOnlyAnchor(database.db, target.id, { now: now.getTime() }); } catch { continue; }
    if (!anchor) continue;
    const savedSampling = samplingStates.get(target.id);
    const sampling = savedSampling?.secUid === anchor.secUid && savedSampling?.uid === anchor.uid
      ? savedSampling : { samplingMode: 'head' };
    if (!sampling.samplingMode) continue;
    plan.due.push({ target, anchor, attempts: consumed.length, samplingMode: sampling.samplingMode });
  }
  // Fresh heads first; within each lane, untouched in this slot first, then
  // the oldest trustworthy attempt across slots.
  // If a full roster exceeds one slot, repeatedly restarting at the smallest
  // ID must not starve authors whose old anchors correctly expired. No cached
  // timestamp is trusted: the same source-verified read above owns this order.
  plan.due.sort((a, b) => Number(a.samplingMode === 'backfill') - Number(b.samplingMode === 'backfill')
    || a.attempts - b.attempts
    || (Date.parse(samplingStates.get(a.target.id)?.lastAttemptAt) || 0)
      - (Date.parse(samplingStates.get(b.target.id)?.lastAttemptAt) || 0) || a.target.id - b.target.id);
  return plan;
}

export async function runNextWorksOnly(scheduler, candidate) {
  if (scheduler.running || scheduler.worksPlanning || scheduler.stopped || !candidate) return null;
  const signal = scheduler.worksOnlySignal ?? scheduler.providerOptions.signal;
  if (signal?.aborted) return null;
  const { database } = scheduler;
  const now = new Date(), slot = scheduler.collectionSlot(now);
  if (!slot) return null;
  if (scheduler.asyncPlanning) {
    const epoch = scheduler.planningEpoch, revision = scheduler.planningRevision();
    scheduler.worksPlanning = true;
    try {
      const guard = await scheduler.readPlanning('guard', now, { signal, targetId: candidate.target.id });
      if (scheduler.running || scheduler.stopped || signal?.aborted || epoch !== scheduler.planningEpoch
        || revision !== scheduler.planningRevision() || scheduler.collectionSlot(new Date())?.key !== slot.key
        || guard.asOf !== now.toISOString() || guard.slotKey !== slot.key || guard.targetId !== candidate.target.id || !guard.allowed) return null;
    } finally { scheduler.worksPlanning = false; }
  } else if (worksOnlyRetryGate(database, { now, slot }).deferred) return null;
  const target = database.getTarget(candidate.target.id);
  if (!target?.enabled) return null;
  // A preselected candidate may outlive planning (or be passed directly by a
  // caller); enforce the same current-slot obstruction rule before reserving.
  const latestRun = database.db.prepare(`SELECT target_id,status,details_json FROM runs
    WHERE trigger_type='works-only' AND target_id=?
      AND julianday(started_at)>=julianday(?) AND julianday(started_at)<julianday(?)
      AND julianday(started_at)<=julianday(?) AND finished_at IS NOT NULL
      AND julianday(finished_at)>=julianday(started_at) AND julianday(finished_at)<=julianday(?)
    ORDER BY id DESC LIMIT 1`).get(target.id, slot.startsAt, slot.endsAt, now.toISOString(), now.toISOString());
  if (occludedNoBoundWorksAttempt(latestRun, safeJson(latestRun?.details_json, [])?.[0])) return null;
  const anchor = readWorksOnlyAnchor(database.db, target.id, { now: Date.now() });
  if (!anchor) return null;
  const settings = database.getSettings();
  const settingsKey = JSON.stringify(settings);
  if (!scheduler.worksOnlyProvider || scheduler.worksOnlyProviderSettings !== settingsKey) {
    scheduler.worksOnlyProvider = createProvider(target.provider, settings, { ...scheduler.providerOptions, signal, database });
    scheduler.worksOnlyProviderSettings = settingsKey;
  }
  const provider = scheduler.worksOnlyProvider;
  // Merge waits written by a intervening normal profile run, retaining this
  // instance's distinct-target backpressure counters.
  provider.restoreWorksRequestPolicy?.();
  // Respect the already-authorized browser option. No run or request on opt-out.
  if (!provider.accountBrowserFallback) return null;
  const decision = provider.worksRequestPolicy.decision('authorised-browser');
  if (decision.deferred) return null;
  // Another authorised task may own this process-wide lane. Wait for the
  // next scheduler tick instead of reserving a works run we cannot launch.
  if (ownedCollectorExecutor.state().busy) return null;
  const runId = database.beginRun('works-only', target.id, 1);
  const startedAt = new Date().toISOString();
  scheduler.running = true;
  scheduler.currentScope = `works-only:${target.id}`;
  scheduler.currentProgress = { runId, triggerType: 'works-only', targetCount: 1, runnableCount: 1,
    completedCount: 0, successCount: 0, warningCount: 0, errorCount: 0, skippedCount: 0,
    currentTarget: { id: target.id, label: target.label }, startedAt, heartbeatAt: startedAt };
  scheduler.currentPromise = (async () => {
    let status = 'error', successCount = 0, errorCount = 0, skippedCount = 0, warningCount = 0;
    let detail = { targetId: target.id, attempted: null, mode: 'works-only', errorCode: 'collector_error' };
    try {
      database.updateRunProgress(runId, { currentTargetId: target.id });
      signal?.throwIfAborted();
      const output = await provider.collectWorksOnly(target, anchor);
      signal?.throwIfAborted();
      detail = { ...detail, attempted: output.attempted === true, errorCode: output.result?.errorCode ?? null,
        requestPolicy: projectWorksRequestPolicy(output.requestPolicy),
        ...(output.deferredReason === 'browser-lane-busy' ? { deferredReason: 'browser-lane-busy' } : {}),
        ...projectWorksOnlyFailure(output.result) };
      if (output.deferred || !output.attempted) { status = 'success'; skippedCount = 1; }
      else {
        const saved = recordWorksOnlyObservation(database.db, {
          targetId: target.id, runId, anchorSnapshotId: anchor.snapshotId, anchorChecksum: anchor.sourceChecksum,
          requestStartedAt: output.requestStartedAt, requestFinishedAt: output.requestFinishedAt,
          requestedLimit: output.requestedLimit, result: output.result, continuation: output.continuation,
          worksRequestPolicy: projectWorksRequestPolicy(output.requestPolicy),
        });
        detail.observationId = saved.id;
        detail.coverage = saved.coverage;
        if (saved.status === 'accepted') { status = 'partial'; successCount = 1; warningCount = 1; }
        else errorCount = 1;
      }
    } catch (error) {
      status = signal?.aborted ? 'interrupted' : 'error';
      // Invalid anchors/time/identity never update target.last_checked_at or
      // create a rejected homepage audit. Only the works run records failure.
      detail.errorCode = ['WORKS_OBSERVATION_INVALID', 'WORKS_ONLY_ANCHOR_INVALID', 'WORKS_ONLY_TIME_INVALID'].includes(error?.code)
        ? 'upstream_changed' : 'collector_error';
      if (typeof error?.attempted === 'boolean') detail.attempted = error.attempted;
      Object.assign(detail, projectWorksOnlyFailure(error));
      detail.requestPolicy ??= projectWorksRequestPolicy({ version: 1, endpoint: 'douyin.author_posts', scope: 'endpoint-transport',
        browser: provider.worksRequestPolicy.decision('authorised-browser') });
      errorCount = 1;
    }
    const result = { runId, triggerType: 'works-only', status, targetCount: 1, successCount, errorCount, skippedCount, warningCount, details: [detail] };
    database.finishRun(runId, { ...result, processedCount: 1 });
    await scheduler.notifyRunComplete(result);
    return result;
  })();
  try { return await scheduler.currentPromise; }
  finally {
    scheduler.running = false; scheduler.currentPromise = null; scheduler.currentScope = null; scheduler.currentProgress = null;
  }
}
