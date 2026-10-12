import { localDateKey, parseTimeOfDay } from "./utils.mjs";

const activeTicks = new WeakSet();

/** Read-only: import/identity audits without a run are not collection attempts. */
export function getNextFirstCollectionTarget(database) {
  const row = database.db.prepare(`
    SELECT t.id,t.label,t.created_at FROM targets t
    WHERE t.type='account' AND t.provider='public-web' AND t.enabled=1
      AND COALESCE(t.last_checked_at,'')='' AND t.last_status='pending'
      AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.target_id=t.id)
      AND NOT EXISTS (SELECT 1 FROM audits a WHERE a.target_id=t.id AND a.run_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.target_id=t.id)
      AND NOT EXISTS (
        SELECT 1 FROM author_resolution_queue q WHERE q.resolved_target_id=t.id
          AND q.suspended_target_enabled IS NOT NULL AND q.status IN ('pending','retry','rejected')
      )
    ORDER BY t.created_at,t.id LIMIT 1
  `).get();
  return row ? { id: Number(row.id), label: row.label, createdAt: row.created_at } : null;
}

function dailyPriority(database, scheduler, now, guardWindowMs) {
  // The production scheduler owns every Beijing eight-hour slot, including
  // 02:00 and 18:00. A local-calendar 10:00 gate can otherwise let first
  // collection take its place, or indefinitely wait for yesterday's plan.
  if (scheduler.scheduleIntervalHours === 8) {
    if (typeof scheduler.collectionSlot !== "function"
      || typeof scheduler.scheduledDateKey !== "function"
      || typeof scheduler.scheduledDueTargetIds !== "function") return "slot-state-unknown";
    const slot = scheduler.collectionSlot(now);
    const startsAt = Date.parse(slot?.startsAt);
    const endsAt = Date.parse(slot?.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)
      || startsAt > now.getTime() || endsAt <= now.getTime()) return "slot-state-unknown";
    if (endsAt - now.getTime() <= guardWindowMs) return "slot-window";
    const latest = database.lastScheduledRun();
    const latestAt = Date.parse(latest?.started_at);
    if (latestAt >= startsAt && latestAt < endsAt && !latest.finished_at) return "slot-incomplete";
    return scheduler.scheduledDueTargetIds(scheduler.scheduledDateKey(now), now, slot).length
      ? "slot-due" : null;
  }
  const [hour, minute] = parseTimeOfDay(database.getSettings().scheduleTime).split(":").map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);
  const untilSchedule = scheduled.getTime() - now.getTime();
  if (untilSchedule > 0 && untilSchedule <= guardWindowMs) return "daily-window";
  if (untilSchedule > 0) return null;
  const latest = database.lastScheduledRun();
  const latestAt = latest?.started_at ? new Date(latest.started_at) : null;
  if (!latestAt || !Number.isFinite(latestAt.getTime()) || localDateKey(latestAt) !== localDateKey(now)) return "daily-due";
  // A stopped/incomplete daily plan owns its pending targets. A later normal
  // scheduler tick will reconcile it; first-collection does not usurp it.
  if (!latest.finished_at) return "daily-incomplete";
  if (typeof scheduler.scheduledDueTargetIds !== "function") return "daily-state-unknown";
  return scheduler.scheduledDueTargetIds(localDateKey(now), now).length ? "daily-due" : null;
}

/**
 * Call from the existing server tick/job completion hook. One candidate only;
 * no private timer or retry queue is created. MonitorScheduler synchronously
 * writes its run before awaiting collection, and updates last_checked_at on
 * normal success/failure. The run also makes a crash before a snapshot durable:
 * such a target is left to the daily retry plan, never repeatedly first-tried.
 * Uses the server's singleton scheduler; it is not a cross-process lease.
 */
export async function runFirstCollectionTick(database, scheduler, {
  now = new Date(), signal, canRun = () => true, guardWindowMs = 60_000,
} = {}) {
  const skipped = (reason) => ({ status: "skipped", reason, targetId: null });
  if (signal?.aborted) return skipped("aborted");
  if (!scheduler || typeof scheduler.runAll !== "function") throw new Error("首次采集需要共用监控调度器");
  if (activeTicks.has(scheduler) || scheduler.running) return skipped("scheduler-busy");
  if (!canRun()) return skipped("caller-busy");
  const reference = new Date(now);
  if (!Number.isFinite(reference.getTime())) throw new Error("首次采集调度时间无效");
  const guard = Math.max(0, Number(guardWindowMs) || 0);
  activeTicks.add(scheduler);
  try {
    const priority = dailyPriority(database, scheduler, reference, guard);
    if (priority) return skipped(priority);
    const candidate = getNextFirstCollectionTarget(database);
    if (!candidate) return skipped("no-candidate");
    if (signal?.aborted || !canRun() || scheduler.running) return skipped("state-changed");
    // No async gap occurs between eligibility and runAll's own target-enabled
    // check. That scheduler checks pause/deletion again before and after I/O.
    const result = await scheduler.runAll({ triggerType: "first-collection", targetId: candidate.id });
    return { status: "attempted", targetId: candidate.id, runId: result?.runId ?? null,
      runStatus: result?.status ?? "unknown", result };
  } finally {
    activeTicks.delete(scheduler);
  }
}
