import { businessDateKey, businessDateStartUtc, shiftCalendarDate, safeJson } from "./utils.mjs";
import { beijingCollectionSlot } from "./collection-cadence.mjs";

const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const usableQuality = (value) => ["validated", "warning"].includes(value);
const round = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

export function latencyDistribution(values) {
  const ordered = values.filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!ordered.length) return { count: 0, minMs: null, p50Ms: null, p90Ms: null, p95Ms: null, maxMs: null, meanMs: null };
  const quantile = (percent) => ordered[Math.max(0, Math.ceil(ordered.length * percent) - 1)];
  return { count: ordered.length, minMs: round(ordered[0]), p50Ms: round(quantile(0.5)), p90Ms: round(quantile(0.9)),
    p95Ms: round(quantile(0.95)), maxMs: round(ordered.at(-1)), meanMs: round(ordered.reduce((sum, value) => sum + value, 0) / ordered.length) };
}

function metricCoverage(rows) {
  const result = { accounts: { total: 0, profileUsable: 0, worksComplete: 0, worksLimited: 0, worksUnavailable: 0, worksUnknown: 0, missingSnapshot: 0 },
    topics: { total: 0, actualCountersUsable: 0, missingSnapshot: 0 } };
  for (const row of rows) {
    const account = row.type === "account";
    const bucket = account ? result.accounts : result.topics;
    bucket.total += 1;
    const quality = usableQuality(row.quality_status);
    if (!account) {
      if (!row.snapshot_id) bucket.missingSnapshot += 1;
      bucket.actualCountersUsable += Number(quality && valid(row.hashtag_participants) && valid(row.hashtag_views));
      continue;
    }
    const profileUsable = quality && ["available", "partial"].includes(row.account_status)
      && [row.followers, row.total_likes, row.total_posts].every(valid);
    bucket.profileUsable += Number(profileUsable);
    // Daily work observation can cross midnight after its profile observation.
    // Run-bound rows have one envelope; daily rows select the two clocks separately.
    const work = Object.hasOwn(row, "works_snapshot_id") ? {
      snapshot_id: row.works_snapshot_id, quality_status: row.works_quality_status, account_status: row.works_account_status,
      followers: row.works_followers, total_likes: row.works_total_likes, total_posts: row.works_total_posts,
      works_coverage: row.observed_works_coverage,
    } : row;
    const workUsable = usableQuality(work.quality_status) && ["available", "partial"].includes(work.account_status)
      && [work.followers, work.total_likes, work.total_posts].every(valid);
    if (!work.snapshot_id) bucket.missingSnapshot += 1;
    else if (workUsable && work.works_coverage === "complete") bucket.worksComplete += 1;
    else if (workUsable && ["limited", "latest-public-window"].includes(work.works_coverage)) bucket.worksLimited += 1;
    else if (["retry", "unavailable"].includes(work.works_coverage)) bucket.worksUnavailable += 1;
    else bucket.worksUnknown += 1;
  }
  return result;
}

/** Read-only diagnostic. Durations inferred from persisted timestamps are not endpoint timers. */
export function auditCollectionRuntime({ database, runId, now = new Date(), anchorTime = "10:00" }) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) throw new Error("A positive runId is required");
  const db = database?.db || database;
  const asOf = now.toISOString();
  db.exec("BEGIN");
  try {
    const run = db.prepare(`SELECT id,trigger_type,started_at,finished_at,status,target_count,processed_count,success_count,error_count,
      skipped_count,heartbeat_at,current_target_id FROM runs WHERE id=?`).get(Number(runId));
    if (!run) throw new Error("Collection run does not exist");
    const cutoff = run.finished_at && Date.parse(run.finished_at) < now.getTime() ? run.finished_at : asOf;
    const rows = db.prepare(`SELECT a.id AS audit_id,a.target_id,a.created_at,a.status,t.type,
      s.id AS snapshot_id,s.captured_at,s.quality_status,s.account_status,s.works_coverage,
      s.followers,s.total_likes,s.total_posts,s.hashtag_participants,s.hashtag_views,
      CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.worksRequestPolicy') END AS policy
      FROM audits a LEFT JOIN targets t ON t.id=a.target_id LEFT JOIN snapshots s ON s.id=(
        SELECT snap.id FROM snapshots snap WHERE snap.target_id=a.target_id AND snap.source_checksum=a.source_checksum
          AND a.source_checksum IS NOT NULL AND a.source_checksum<>'' AND a.status IN ('validated','warning')
          AND julianday(snap.captured_at)>=julianday(?) AND julianday(snap.captured_at)<=julianday(a.created_at)
        ORDER BY snap.captured_at DESC,snap.id DESC LIMIT 1)
      WHERE a.run_id=? AND julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<=julianday(?)
      ORDER BY a.created_at,a.id`).all(run.started_at, run.id, run.started_at, cutoff);
    const latest = new Map(rows.map((row) => [row.target_id, row]));
    const day = businessDateKey(asOf);
    const dayBounds = [businessDateStartUtc(day).toISOString(), businessDateStartUtc(shiftCalendarDate(day, 1)).toISOString(), asOf];
    const dailyRows = db.prepare(`SELECT t.type,s.id AS snapshot_id,s.quality_status,s.account_status,s.works_coverage,
      s.followers,s.total_likes,s.total_posts,s.hashtag_participants,s.hashtag_views,
      w.id AS works_snapshot_id,w.quality_status AS works_quality_status,w.account_status AS works_account_status,
      w.followers AS works_followers,w.total_likes AS works_total_likes,w.total_posts AS works_total_posts,
      w.works_coverage AS observed_works_coverage FROM targets t
      LEFT JOIN snapshots s ON s.id=(SELECT snap.id FROM snapshots snap WHERE snap.target_id=t.id
        AND julianday(snap.captured_at)>=julianday(?) AND julianday(snap.captured_at)<julianday(?) AND julianday(snap.captured_at)<=julianday(?)
        ORDER BY snap.captured_at DESC,snap.id DESC LIMIT 1)
      LEFT JOIN snapshots w ON w.id=(SELECT snap.id FROM snapshots snap WHERE snap.target_id=t.id
        AND julianday(COALESCE(snap.works_observed_at,snap.captured_at))>=julianday(?)
        AND julianday(COALESCE(snap.works_observed_at,snap.captured_at))<julianday(?)
        AND julianday(COALESCE(snap.works_observed_at,snap.captured_at))<=julianday(?)
        ORDER BY julianday(COALESCE(snap.works_observed_at,snap.captured_at)) DESC,snap.id DESC LIMIT 1)
      WHERE t.enabled=1 AND t.provider<>'manual'`).all(...dayBounds, ...dayBounds);
    const freshRows = db.prepare(`SELECT s.captured_at,s.quality_status,s.account_status,s.followers,s.total_likes,s.total_posts
      FROM targets t LEFT JOIN snapshots s ON s.id=(SELECT snap.id FROM snapshots snap WHERE snap.target_id=t.id
        AND julianday(snap.captured_at)<=julianday(?) ORDER BY snap.captured_at DESC,snap.id DESC LIMIT 1)
      WHERE t.enabled=1 AND t.provider<>'manual' AND t.type='account'`).all(asOf);
    const profileAges = freshRows.filter((row) => usableQuality(row.quality_status) && ["available", "partial"].includes(row.account_status)
      && [row.followers, row.total_likes, row.total_posts].every(valid)).map((row) => now.getTime() - Date.parse(row.captured_at));
    const slot = beijingCollectionSlot({ now: new Date(run.started_at), anchorTime });
    const intervals = [], preCaptureIntervals = [], postCaptureIntervals = [];
    const lanes = { anonymous: { attempted: 0, deferred: 0, errors: {} }, browser: { attempted: 0, deferred: 0, errors: {} } };
    const tailGroups = new Map();
    const samples = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index], previous = rows[index - 1];
      const persisted = Date.parse(row.created_at), captured = Date.parse(row.captured_at);
      const intervalMs = previous ? persisted - Date.parse(previous.created_at) : null;
      if (intervalMs !== null) intervals.push(intervalMs);
      const preCaptureMs = previous && Number.isFinite(captured) ? captured - Date.parse(previous.created_at) : null;
      const postCaptureMs = Number.isFinite(captured) ? persisted - captured : null;
      if (preCaptureMs !== null) preCaptureIntervals.push(preCaptureMs);
      if (postCaptureMs !== null) postCaptureIntervals.push(postCaptureMs);
      const policy = safeJson(row.policy, {});
      for (const laneName of ["anonymous", "browser"]) {
        const lane = policy[laneName];
        if (!lane) continue;
        lanes[laneName].attempted += Number(lane.attempted === true);
        lanes[laneName].deferred += Number(lane.deferred === true);
        const code = typeof lane.errorCode === "string" ? lane.errorCode : "success";
        if (lane.attempted === true) lanes[laneName].errors[code] = (lanes[laneName].errors[code] || 0) + 1;
      }
      const tailGroup = policy.browser?.attempted === true ? `browser-${policy.browser.errorCode || "success"}`
        : policy.browser?.deferred ? "browser-deferred" : "no-browser-evidence";
      if (postCaptureMs !== null) tailGroups.set(tailGroup, [...(tailGroups.get(tailGroup) || []), postCaptureMs]);
      samples.push({ targetId: row.target_id, auditId: row.audit_id, type: row.type, status: row.status,
        capturedAt: row.captured_at, persistedAt: row.created_at, intervalMs: round(intervalMs),
        preCaptureMs: round(preCaptureMs), postCaptureMs: round(postCaptureMs), worksCoverage: row.works_coverage,
        anonymous: policy.anonymous ? { attempted: policy.anonymous.attempted, deferred: policy.anonymous.deferred, errorCode: policy.anonymous.errorCode, nextEligibleAt: policy.anonymous.nextEligibleAt } : null,
        browser: policy.browser ? { attempted: policy.browser.attempted, deferred: policy.browser.deferred, errorCode: policy.browser.errorCode, nextEligibleAt: policy.browser.nextEligibleAt } : null });
    }
    const elapsedMs = Date.parse(cutoff) - Date.parse(run.started_at);
    const completed = Math.max(Number(run.processed_count) || 0, latest.size);
    const remaining = Math.max(0, run.target_count - completed);
    const intervalStats = latencyDistribution(intervals);
    const observedPerTargetMs = completed > 0 ? elapsedMs / completed : null;
    const estimate = (rate) => rate !== null && Number.isFinite(rate) ? new Date(Date.parse(cutoff) + remaining * rate).toISOString() : null;
    const report = { version: 3, checkedAt: asOf, run: { ...run }, dailySavedSnapshotCoverage: { businessDate: day, ...metricCoverage(dailyRows) },
      coverageDefinitions: {
        worksPartition: "worksComplete + worksLimited + worksUnavailable + worksUnknown + missingSnapshot = total; these five buckets do not overlap",
        worksUnknown: "a snapshot exists, but it does not establish complete, limited or explicitly unavailable works coverage",
        missingSnapshot: "no work observation bound to the selected day or run (topics use their own snapshot); not an upstream failure and never zero metrics",
        profileOverlap: "profileUsable is independent and may overlap any works bucket including missingSnapshot; profile and work clocks are distinct",
        legacyReportWarning: "version 1 diagnostics may overlap work buckets; version 2 used profile time for daily work coverage; version 3 uses the independently persisted work time without rewriting history",
      },
      accountFreshness: { total: freshRows.length, validProfile: profileAges.length,
        withinEightHours: profileAges.filter((age) => age <= 8 * 3_600_000).length,
        olderThanEightHours: profileAges.filter((age) => age > 8 * 3_600_000).length,
        noValidProfile: freshRows.length - profileAges.length, age: latencyDistribution(profileAges) },
      runCoverage: metricCoverage([...latest.values()]), persistedAuditCount: rows.length, persistedTargetCount: latest.size,
      timings: { elapsedMs: round(elapsedMs), startupToFirstAuditMs: rows.length ? Date.parse(rows[0].created_at) - Date.parse(run.started_at) : null,
        interAudit: intervalStats, previousAuditToCapture: latencyDistribution(preCaptureIntervals), captureToAudit: latencyDistribution(postCaptureIntervals),
        captureToAuditByBrowserOutcome: Object.fromEntries([...tailGroups].map(([key, values]) => [key, latencyDistribution(values)])) },
      transports: lanes, capacity: { remainingTargets: remaining, currentTargetId: run.current_target_id,
        nextSlotStartsAt: slot.endsAt, remainingSlotBudgetMs: Date.parse(slot.endsAt) - Date.parse(cutoff),
        requiredAverageMsPerRemainingTarget: remaining > 0 ? round((Date.parse(slot.endsAt) - Date.parse(cutoff)) / remaining) : null,
        observedAverageMsPerTarget: round(observedPerTargetMs), estimatedFinishWithObservedRate: estimate(observedPerTargetMs),
        estimatedFinishWithSteadyRate: estimate(intervalStats.meanMs), estimateIsGuarantee: false }, samples,
      limitations: ["interAudit includes cooldown, identity verification and writes; it is not a pure network timer",
        "captureToAudit includes browser fallback and any later identity/write work; seconds-only captures add up to 999 ms quantization",
        "startup may include source probing and topic prefetch; no per-stage timer exists to apportion it",
        "dailySavedSnapshotCoverage counts persisted daily observations, not latest-attempt success or complete work history",
        "completion estimates extrapolate a changing sample and are not an 8-hour SLA guarantee"] };
    db.exec("COMMIT");
    return report;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
