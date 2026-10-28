import { createProvider } from "./providers/index.mjs";
import { reviewState } from "./analytics.mjs";
import { businessDateKey, localDateKey, nextDailyRun, parseTimeOfDay, safeJson } from "./utils.mjs";
import { projectWorksRequestPolicy, worksErrorCode } from "./works-request-policy.mjs";
import { beijingCollectionSlot } from "./collection-cadence.mjs";
import { readVerifiedTopicIdentity } from "./topic-identity-reuse.mjs";
import { planWorksOnly, runNextWorksOnly, worksOnlyRetryGate } from "./works-only-scheduler.mjs";
import { loadVerifiedWorksOnlyRows } from "./works-observation.mjs";
import { ConsoleReader } from './console-reader.mjs';
import { targetPlatform } from './target-platform.mjs';

const DEFAULT_SCHEDULED_RETRY_DELAYS_MS = Object.freeze([
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
]);

function collectionRequestError(message, status = 400, code = "INVALID_COLLECTION_SCOPE") {
  return Object.assign(new Error(message), { status, code });
}

function collectionTargetId(value) {
  const number = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) throw collectionRequestError("采集目标必须是有效的正整数 ID");
  return number;
}

function normalizeCollectionRequest(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw collectionRequestError("采集范围格式无效");
  const supported = new Set(["triggerType", "targetId", "excludeTargetIds", "onlyType"]);
  if (Object.keys(options).some((key) => !supported.has(key))) throw collectionRequestError("不支持此采集范围参数；请求未执行");
  const { triggerType = "manual", targetId = null, excludeTargetIds = [], onlyType = null } = options;
  if (typeof triggerType !== "string" || !triggerType.trim() || triggerType.length > 80) throw collectionRequestError("采集触发类型无效");
  if (onlyType !== null && !["account", "hashtag"].includes(onlyType)) throw collectionRequestError("采集类型只支持账号或话题");
  if (!Array.isArray(excludeTargetIds)) throw collectionRequestError("排除目标必须是 ID 数组");
  return { triggerType, targetId: targetId === null ? null : collectionTargetId(targetId), onlyType,
    excludeTargetIds: [...new Set(excludeTargetIds.map(collectionTargetId))].sort((a, b) => a - b) };
}

function normalizedAuthorName(value) {
  return String(value ?? "").normalize("NFKC").replace(/^@/, "").replace(/\s+/g, "").trim().toLowerCase();
}

function scheduledAuditReviewState(row, strictMetrics = false) {
  if (row?.lifecycle_deleted === 1) return "inactive";
  const warnings = safeJson(row?.warnings_json, []);
  const message = String(row?.message ?? "");
  // `recordFailure` keeps the historical audit status `rejected` for both
  // deterministic identity failures and transient transport failures. Only
  // the former should be held for evidence; generic rejected/error messages
  // must remain retryable or a temporary outage would silently consume the
  // whole day's plan.
  if (row?.status === "rejected" && /身份|账号.{0,12}(?:不一致|未回显|缺失)|公开主页.{0,18}(?:不一致|未回显)|搜索结果页|合法(?: URL|链接|BV|账号)|无效重定向|非.{0,12}域名|提交目标不一致|证据|短链.{0,12}大小写|无法唯一/.test(message)) return "manual";
  if (row?.status === "rejected") return "retry";
  // Topics have no profile or works-list contract. Their two actual counters
  // alone decide metric completion; generic account defaults must not reopen
  // a successful topic as a missing-works retry.
  if (row?.target_type === "hashtag" && (row.snapshot_id || strictMetrics)) {
    const complete = ["validated", "warning"].includes(row.snapshot_quality)
      && [row.hashtag_participants, row.hashtag_views].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    return complete ? (row.status === "validated" ? "complete" : "limited") : "retry";
  }
  if (strictMetrics && row?.target_type === "account" && (!row.snapshot_id || !completeProfileMetrics({
    quality_status: row.snapshot_quality, account_status: row.account_status,
    followers: row.followers, total_likes: row.total_likes, total_posts: row.total_posts,
  }))) return "retry";
  return reviewState(row?.status, warnings, row?.snapshot_id && row.target_type === "account" ? {
    accountStatus: row.account_status, worksCoverage: row.works_coverage,
  } : {});
}

function effectiveScheduledReviewState(target, attempt) {
  const review = attempt?.latestReviewState;
  if (review === "inactive") return review;
  // Older snapshots could be written with a retry warning even though the
  // same response carried explicit public-window or zero-work evidence. The
  // database repair normalizes new reads, while this guard keeps a warning
  // audit from reopening a target whose saved snapshot is already usable.
  // Never promote a warning by reading mutable target metadata: it can still
  // describe yesterday's successful snapshot after today's attempt failed.
  // Only the snapshot joined to today's latest audit is authoritative.
  if (attempt?.latestStatus === "warning" && completeProfileMetrics(attempt.latestSnapshot)) {
    const coverage = String(attempt.latestSnapshot?.works_coverage ?? "");
    if (["limited", "latest-public-window"].includes(coverage)) return "limited";
    if (coverage === "complete") return "complete";
  }
  return review;
}

function completeProfileMetrics(snapshot) {
  return snapshot && ["validated", "warning"].includes(snapshot.quality_status)
    && ["available", "partial"].includes(snapshot.account_status)
    && [snapshot.followers, snapshot.total_likes, snapshot.total_posts]
      .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function worksPolicyLanes(snapshot) {
  const policy = projectWorksRequestPolicy(safeJson(snapshot?.works_policy_json, null));
  return policy ? [policy.anonymous, policy.browser].filter(Boolean) : [];
}

function worksAccessBlocked(snapshot, now = new Date()) {
  if (!snapshot || !["retry", "unavailable"].includes(snapshot.works_coverage)) return false;
  const code = worksErrorCode(snapshot.works_error_code);
  const lanes = worksPolicyLanes(snapshot);
  // A cooldown belongs to one transport, not the entire account. Keep a
  // bounded retry available when another evidenced lane is ready, or when
  // an explicit deadline has expired. Legacy denial codes below apply only
  // to snapshots without the structured policy contract.
  if (lanes.length) return lanes.every((lane) => lane.retryAfterStatus === "too-long" || Date.parse(lane.nextEligibleAt) > now.getTime());
  if (["blocked", "login_required"].includes(code)) return true;
  // Stable codes win over mutable/localised wording. Only legacy snapshots
  // without a recognised code fall back to the old HTTP text evidence.
  if (code !== "unknown") return false;
  // A profile HTTP error is not works evidence. Only the dedicated works
  // error or a warning that explicitly names the works endpoint can defer it.
  if (/HTTP\s*403\b/i.test(String(snapshot.works_error ?? ""))) return true;
  const warnings = safeJson(snapshot.warnings_json, []);
  return Array.isArray(warnings) && warnings.some((warning) => {
    const text = typeof warning === "string" ? warning : String(warning?.message ?? warning?.reason ?? warning?.error ?? "");
    return /作品/.test(text) && /HTTP\s*403\b/i.test(text);
  });
}

function dailyProfileCompleted(target, attempt) {
  return target.type === "account" && attempt?.profileCompleted === true
    && !["inactive", "manual"].includes(attempt.latestReviewState);
}

function completeHashtagMetrics(target, attempt) {
  if (target.type !== "hashtag" || ["inactive", "manual"].includes(attempt?.latestReviewState)) return false;
  const snapshot = attempt?.latestSnapshot;
  return Boolean(snapshot && ["validated", "warning"].includes(snapshot.quality_status)
    && [snapshot.hashtag_participants, snapshot.hashtag_views]
      .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0));
}

function worksRetryDeferred(target, attempt, now = new Date()) {
  return dailyProfileCompleted(target, attempt) && worksAccessBlocked(attempt.latestSnapshot, now);
}

function stateFromScheduledPlan(plan, latestRun) {
  // Keep the run-level fallback for historical runs whose target rows were
  // deleted before the per-target audit could be replayed.
  if (!plan.trackedCount) {
    if (latestRun?.status === "partial") return "partial";
    if (latestRun?.status === "error") return "failed";
    return "completed";
  }
  if (plan.unresolvedCount === 0) return "completed";
  if (plan.exhaustedCount === plan.trackedCount) return "failed";
  return "partial";
}

export class MonitorScheduler {
  constructor(database, options = {}) {
    this.database = database;
    // The production service runs with TZ=Asia/Shanghai. Keep the explicit
    // option so read-only audits/tests can select the same business day even
    // when the shell itself is in another timezone; legacy tests that set TZ
    // continue to observe their local-day contract.
    this.scheduleTimeZone = String(options.scheduleTimeZone || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    // Opt in explicitly at the production boundary; retain historical daily
    // readers/tests without reinterpreting saved runs or daily snapshots.
    this.scheduleIntervalHours = options.scheduleIntervalHours === 8 ? 8 : 24;
    if (this.scheduleIntervalHours === 8) this.scheduleTimeZone = "Asia/Shanghai";
    this.continuousRoundStore = options.continuousRoundStore ?? null;
    this.continuousWindow = options.continuousWindow ?? null;
    this.continuous = Boolean(this.continuousRoundStore || this.continuousWindow);
    if (this.continuous) { this.scheduleIntervalHours = 8; this.scheduleTimeZone = "Asia/Shanghai"; }
    this.providerOptions = options.providerOptions ?? {};
    this.worksOnlySignal = options.worksOnlySignal ?? this.providerOptions.signal;
    this.worksOnlyEnabled = options.worksOnlyEnabled === true;
    this.asyncPlanning = options.asyncPlanning === true;
    this.planningReaderFactory = options.planningReaderFactory ?? (options => new ConsoleReader(options));
    this.planningReaders = new Map();
    this.planningTick = false;
    this.planningEpoch = 0;
    this.stopped = false;
    this.stopping = false;
    this.draining = false;
    this.stopPromise = null;
    this.drainPromise = null;
    this.activeTicks = new Set();
    // A scheduled run can perform one cheap, anonymous source probe before
    // touching the roster. Tests and one-off/manual runs stay isolated unless
    // the server explicitly enables this production guard.
    this.scheduledSourceProbe = options.scheduledSourceProbe === true;
    this.shouldYieldScheduledCollection = options.shouldYieldScheduledCollection ?? (() => false);
    this.onRunComplete = typeof options.onRunComplete === "function" ? options.onRunComplete : null;
    this.scheduledRetryDelaysMs = Array.isArray(options.scheduledRetryDelaysMs)
      ? options.scheduledRetryDelaysMs
        .map((delay) => Math.max(0, Number(delay) || 0))
        .slice(0, 6)
      : [...DEFAULT_SCHEDULED_RETRY_DELAYS_MS];
    this.running = false;
    this.currentPromise = null;
    this.currentScope = null;
    this.currentProgress = null;
    this.timer = null;
    this.lastTickAt = null;
    // Keep scheduler-loop failures visible. Previously start() swallowed the
    // rejected tick promise, so a provider or database error could leave the
    // process alive while the UI continued to report a healthy heartbeat.
    this.lastSuccessfulTickAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.tickCount = 0;
    this.tickDurationMs = null;
  }

  recordTickError(error) {
    this.lastErrorAt = new Date().toISOString();
    this.lastError = String(error?.message ?? error ?? "定时调度异常").slice(0, 500);
    console.error(`[${this.lastErrorAt}] 定时调度异常：${this.lastError}`);
  }

  scheduledDateKey(value = new Date()) {
    return this.scheduleTimeZone === "Asia/Shanghai" ? businessDateKey(value, "Asia/Shanghai") : localDateKey(value);
  }

  scheduledDateSql(column) {
    return this.scheduleTimeZone === "Asia/Shanghai"
      ? `date(${column},'+8 hours')`
      : `date(${column},'localtime')`;
  }

  collectionSlot(now = new Date()) {
    if (this.continuous) return this.continuousRoundStore?.window(now) ?? { ...this.continuousWindow, asOf: now.toISOString() };
    return this.scheduleIntervalHours === 8
      ? beijingCollectionSlot({ now, anchorTime: this.database.getSettings().scheduleTime })
      : null;
  }

  async readPlanning(mode, now, { signal, targetId } = {}) {
    if (this.stopped) throw Object.assign(new Error('Scheduler stopped'), { code: 'SCHEDULER_STOPPED' });
    const lane = mode === 'status' ? 'status' : 'tick';
    let reader = this.planningReaders.get(lane);
    if (!reader) {
      // HTTP demand cannot occupy the ordinary planner's reserved worker.
      reader = this.planningReaderFactory({ databasePath: this.database.filePath, cacheTtlMs: 0,
        maxQueue: lane === 'tick' ? 1 : 12, timeoutMs: 10_000 });
      this.planningReaders.set(lane, reader);
    }
    return reader.planning({ mode, targetId, asOf: now.toISOString(), scheduler: {
      continuousWindow: this.continuous ? this.collectionSlot(now) : null,
      scheduleIntervalHours: this.scheduleIntervalHours, scheduleTimeZone: this.scheduleTimeZone,
      worksOnlyEnabled: this.worksOnlyEnabled, scheduledRetryDelaysMs: this.scheduledRetryDelaysMs,
    } }, { signal });
  }

  async getStatusAsync(now = new Date(), { signal } = {}) {
    const state = await this.readPlanning('status', now, { signal });
    return { ...state, planningAsOf: now.toISOString(), running: this.running,
      ...(this.running ? { scheduleState: 'running' } : {}),
      lastTickAt: this.lastTickAt, lastSuccessfulTickAt: this.lastSuccessfulTickAt,
      lastErrorAt: this.lastErrorAt, lastError: this.lastError, tickCount: this.tickCount, tickDurationMs: this.tickDurationMs,
      currentRun: this.currentProgress ? { ...this.currentProgress, currentTarget: this.currentProgress.currentTarget ? { ...this.currentProgress.currentTarget } : null } : null };
  }

  planningRevision() {
    return `${this.database.db.prepare('SELECT total_changes() n').get().n - (this.database.sessionHeartbeatChanges ?? 0)}:${this.database.db.prepare('PRAGMA data_version').get().data_version}`;
  }

  getStatus(now = new Date()) {
    const settings = this.database.getSettings();
    const scheduleTime = parseTimeOfDay(settings.scheduleTime);
    const slot = this.collectionSlot(now);
    const [hour, minute] = scheduleTime.split(":").map(Number);
    const todaySchedule = new Date(now);
    todaySchedule.setHours(hour, minute, 0, 0);
    const latestScheduledRun = this.database.lastScheduledRun?.() ?? null;
    const lastScheduledRunAt = latestScheduledRun?.started_at ?? null;
    const lastScheduledRunDate = lastScheduledRunAt ? new Date(lastScheduledRunAt) : null;
    const slotPlan = slot ? this.scheduledPlanSummary(this.scheduledDateKey(now), slot) : null;
    const hasTodayRun = slot
      ? Boolean(slotPlan.attempts.size || (lastScheduledRunAt && lastScheduledRunAt >= slot.startsAt && lastScheduledRunAt < slot.endsAt))
      : Boolean(lastScheduledRunDate && Number.isFinite(lastScheduledRunDate.getTime()) && this.scheduledDateKey(lastScheduledRunDate) === this.scheduledDateKey(now));
    const plan = slotPlan ?? (hasTodayRun ? this.scheduledPlanSummary(this.scheduledDateKey(now)) : null);
    let scheduleState = slot || now >= todaySchedule ? "due" : "waiting";
    if (this.running) scheduleState = "running";
    else if (hasTodayRun) {
      const interrupted = slot
        ? Boolean(lastScheduledRunAt >= slot.startsAt && lastScheduledRunAt < slot.endsAt && !latestScheduledRun?.finished_at)
        : !latestScheduledRun?.finished_at;
      scheduleState = interrupted ? "interrupted" : stateFromScheduledPlan(plan, latestScheduledRun);
    }
    return {
      running: this.running,
      scheduleTime,
      scheduleMode: this.continuous ? "continuous" : "scheduled",
      scheduleIntervalHours: this.continuous ? null : this.scheduleIntervalHours,
      timeZone: this.scheduleTimeZone,
      currentSlotKey: slot?.key ?? null,
      currentSlotStartedAt: slot?.startsAt ?? null,
      currentSlotEndsAt: this.continuous ? null : slot?.endsAt ?? null,
      slotTimes: this.continuous ? [] : slot?.slotTimes ?? [scheduleTime],
      scheduleState,
      scheduleDueAt: slot?.startsAt ?? todaySchedule.toISOString(),
      nextRunAt: this.continuous ? null : slot?.endsAt ?? nextDailyRun(settings.scheduleTime, now).toISOString(),
      lastTickAt: this.lastTickAt,
      lastSuccessfulTickAt: this.lastSuccessfulTickAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      tickCount: this.tickCount,
      tickDurationMs: this.tickDurationMs,
      lastScheduledRunAt,
      lastScheduledRunStatus: latestScheduledRun?.status ?? null,
      lastScheduledRunFinishedAt: latestScheduledRun?.finished_at ?? null,
      scheduledTargetCount: plan?.trackedCount ?? null,
      scheduledAccountTargetCount: plan?.scheduledAccountTargetCount ?? null,
      scheduledCompletedTargetCount: plan?.completedCount ?? null,
      scheduledPendingTargetCount: plan?.pendingCount ?? null,
      scheduledProfilePendingTargetCount: plan?.scheduledProfilePendingTargetCount ?? null,
      scheduledMetricCompletedTargetCount: plan?.scheduledMetricCompletedTargetCount ?? null,
      scheduledTopicTargetCount: plan?.scheduledTopicTargetCount ?? null,
      scheduledTopicMetricCompletedTargetCount: plan?.scheduledTopicMetricCompletedTargetCount ?? null,
      scheduledExhaustedTargetCount: plan?.exhaustedCount ?? null,
      scheduledManualTargetCount: plan?.manualCount ?? null,
      scheduledInactiveTargetCount: plan?.inactiveCount ?? null,
      scheduledSettledTargetCount: plan ? plan.completedCount + plan.inactiveCount : null,
      scheduledProfileCompletedTargetCount: plan?.profileCompletedCount ?? null,
      scheduledWorksCompleteTargetCount: plan?.worksCompleteCount ?? null,
      scheduledWorksLimitedTargetCount: plan?.worksLimitedCount ?? null,
      scheduledWorksRetryTargetCount: plan?.worksRetryCount ?? null,
      scheduledWorksDeferredTargetCount: plan?.worksDeferredCount ?? null,
      scheduledWorksAwaitingNextSlotTargetCount: plan?.worksAwaitingNextSlotCount ?? null,
      scheduledWorksUnknownTargetCount: plan?.worksUnknownCount ?? null,
      scheduledWorksOnlyEnabled: this.worksOnlyEnabled,
      worksOnlyRetry: this.worksOnlyEnabled && slot ? worksOnlyRetryGate(this.database, { now, slot }) : null,
      currentRun: this.currentProgress ? { ...this.currentProgress, currentTarget: this.currentProgress.currentTarget ? { ...this.currentProgress.currentTarget } : null } : null,
    };
  }

  start() {
    if (this.timer || this.stopping || this.draining) return;
    this.stopPromise = null;
    this.drainPromise = null;
    this.stopped = false;
    this.runManagedTick();
    this.timer = setInterval(() => this.runManagedTick(), 30_000);
    this.timer.unref?.();
  }

  // Continue the existing serial queue after successful evidence, instead of
  // spending the remainder of every 30-second heartbeat idle. Replanning still
  // enforces slot, identity, browser ownership and transport cooldown gates.
  queueWorksFollowup(result) {
    if (!this.timer || this.stopped || this.stopping || this.draining || this.worksFollowupTimer
      || result?.triggerType !== 'works-only' || result.successCount !== 1
      || result.details?.[0]?.attempted !== true || result.details[0].errorCode != null) return;
    this.worksNextAllowedAt = Date.now() + 5000;
    this.worksFollowupTimer = setTimeout(() => {
      this.worksFollowupTimer = null;
      if (!this.stopped && !this.stopping && !this.draining) void this.runManagedTick();
    }, 5000);
    this.worksFollowupTimer.unref?.();
  }

  runManagedTick() {
    let pending;
    pending = this.tick()
      .catch((error) => this.recordTickError(error))
      .finally(() => this.activeTicks.delete(pending));
    this.activeTicks.add(pending);
    return pending;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.worksFollowupTimer) clearTimeout(this.worksFollowupTimer);
    this.worksFollowupTimer = null;
    this.worksNextAllowedAt = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.stopping = true;
    this.planningEpoch++;
    const readers = [...this.planningReaders.values()];
    this.planningReaders.clear();
    this.planningClose = Promise.all([this.planningClose, ...readers.map(reader => reader.close())]);
    this.stopPromise = this.planningClose.finally(() => { this.stopping = false; });
    return this.stopPromise;
  }

  drain() {
    if (this.drainPromise) return this.drainPromise;
    // Close the scheduling gate synchronously so a queued interval callback
    // cannot enter while the stop promise is settling.
    this.draining = true;
    const stopped = this.stop();
    this.drainPromise = (async () => {
      try { await stopped; }
      catch (error) { this.recordTickError(error); }
      await Promise.allSettled([...this.activeTicks]);
      // A direct/manual collection may be active without an automatic tick.
      // Wait until its immutable run finalization and completion receipt finish too.
      while (this.currentPromise) {
        const current = this.currentPromise;
        await current.catch(() => {});
        if (this.currentPromise === current) await Promise.resolve();
      }
    })().finally(() => { this.draining = false; });
    return this.drainPromise;
  }

  async notifyRunComplete(result) {
    if (!this.onRunComplete) return;
    try { await this.onRunComplete(result); }
    catch (error) { console.error(`[${new Date().toISOString()}] 定时任务完成回调失败：`, error); }
  }

  async runScheduledSourceProbe(runnable, frozenSettings) {
    if (!this.scheduledSourceProbe) return [];
    const samples = new Map();
    for (const target of runnable) {
      if (target.provider !== "public-web" || target.type !== "account") continue;
      const platform = targetPlatform(target);
      if (!samples.has(platform)) samples.set(platform, target);
    }
    if (!samples.size) return [];
    const today = this.scheduledDateKey(new Date());
    const probes = [];
    // A failed manual check must not suppress the automatic daily probe. A
    // successful same-day probe is sufficient evidence and avoids a duplicate
    // anonymous request when an admin already checked that platform.
    for (const [platform, sample] of samples) {
      this.providerOptions.signal?.throwIfAborted();
      const providerKey = `${platform}-public`;
      const latest = this.database.getLatestSourceProbe?.(providerKey);
      const latestDate = latest?.checkedAt ? new Date(latest.checkedAt) : null;
      if (latest?.ok === true && latestDate && Number.isFinite(latestDate.getTime()) && this.scheduledDateKey(latestDate) === today) {
        probes.push(latest);
        continue;
      }
      const probeStartedAt = Date.now();
      try {
        const provider = createProvider(sample.provider, frozenSettings, { ...this.providerOptions, database: this.database });
        const test = provider.testConnectionForPlatform ?? (platform === "douyin" ? provider.testConnection : null);
        if (typeof test !== "function") continue;
        const result = await test.call(provider, platform, sample);
        this.providerOptions.signal?.throwIfAborted();
        probes.push(this.database.recordSourceProbe?.(providerKey, {
          ok: true,
          result,
          trigger: "scheduled",
          durationMs: Date.now() - probeStartedAt,
        }) ?? null);
      } catch (error) {
        this.providerOptions.signal?.throwIfAborted();
        probes.push(this.database.recordSourceProbe?.(providerKey, {
          ok: false,
          error: error?.message ?? error,
          trigger: "scheduled",
          durationMs: Date.now() - probeStartedAt,
        }) ?? null);
      }
    }
    return probes.filter(Boolean);
  }

  async prepareTopicBrowserBatch(runnable, frozenSettings) {
    const requestedMode = this.providerOptions.topicResolverMode ?? process.env.DOUYIN_TOPIC_RESOLVER_MODE ?? "public";
    if (!["browser", "browser-first"].includes(requestedMode)) return null;
    // A verified historical ID is an identity hint, not a fresh metric. Its
    // provider fetches new official detail; don't first re-search that topic.
    const topics = runnable.filter((target) => target.provider === "public-web" && target.type === "hashtag"
      && readVerifiedTopicIdentity(this.database, target).status === "missing");
    if (!topics.length) return null;
    const labels = topics.map((target) => String(target.locator ?? "").replace(/^#/, "").trim()).filter(Boolean);
    if (!labels.length) return null;
    const resultMap = new Map();
    try {
      const provider = createProvider("public-web", frozenSettings, { ...this.providerOptions, database: this.database, topicResolverMode: requestedMode });
      const result = await provider.runTopicBrowser(labels);
      for (const item of result?.items ?? []) resultMap.set(String(item?.label ?? "").toLocaleLowerCase(), item);
      for (const label of labels) {
        const key = label.toLocaleLowerCase();
        if (!resultMap.has(key)) resultMap.set(key, { label, status: "missing", error: "批量话题 broker 未返回该标签" });
      }
    } catch (error) {
      this.providerOptions.signal?.throwIfAborted();
      for (const label of labels) resultMap.set(label.toLocaleLowerCase(), {
        label,
        status: "broker_unavailable",
        error: String(error?.message ?? error).slice(0, 240),
      });
    }
    return resultMap;
  }

  scheduledTargetAttemptStates(dateKey, window = null) {
    const snapshotDay = this.scheduledDateSql("observed.captured_at");
    const runDay = this.scheduledDateSql("r.started_at");
    // Slot freshness belongs to the actual observation/audit, not the batch
    // start: a slow batch spanning 18:00 must not recollect accounts it just
    // sampled after 18:00. Daily callers retain their historical contract.
    const snapshotScope = window
      ? "julianday(observed.captured_at)>=julianday(?) AND julianday(observed.captured_at)<julianday(?)"
      : `${snapshotDay}=?`;
    const auditScope = window
      ? "julianday(a.created_at)>=julianday(?) AND julianday(a.created_at)<julianday(?) AND julianday(a.created_at)<=julianday(?)"
      : `${runDay}=?`;
    // A continuous pass may take days while new authors arrive. Age out
    // completed profile observations and exhausted retries independently of
    // pass rollover, otherwise old accounts are sampled only once forever.
    const observedAsOf = window?.asOf ?? new Date().toISOString();
    const attemptStart = this.continuous && window
      ? new Date(Math.max(Date.parse(window.startsAt), Date.parse(observedAsOf) - 8 * 60 * 60_000)).toISOString()
      : window?.startsAt;
    const scopeParameters = window
      ? [attemptStart, window.endsAt, attemptStart, window.endsAt, observedAsOf]
      : [String(dateKey), String(dateKey)];
    const runScope = window
      ? `(r.trigger_type='scheduled' OR (
          r.trigger_type IN ('manual','manual-topics','manual-refresh','first-collection')
          AND a.provider='public-web' AND s.quality_status IN ('validated','warning')
          AND ((t.type='account' AND s.account_status IN ('available','partial')
            AND s.followers>=0 AND s.total_likes>=0 AND s.total_posts>=0)
            OR (t.type='hashtag' AND s.hashtag_participants>=0 AND s.hashtag_views>=0))
        ))`
      : "r.trigger_type='scheduled'";
    const rows = this.database.db.prepare(`
      SELECT a.target_id,a.created_at,a.status,a.warnings_json,a.message,t.type AS target_type,
        s.id AS snapshot_id,s.captured_at AS snapshot_at,s.followers,s.total_likes,s.total_posts,
        s.hashtag_participants,s.hashtag_views,
        s.quality_status AS snapshot_quality,s.account_status,s.works_coverage,s.works_error,
        s.warnings_json AS snapshot_warnings_json,
        CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.worksErrorCode') END AS works_error_code,
        CASE WHEN json_valid(s.raw_json) THEN json_extract(s.raw_json,'$.worksRequestPolicy') END AS works_policy_json,
        EXISTS (SELECT 1 FROM account_events e WHERE e.run_id=r.id AND e.target_id=a.target_id
          AND e.event_type='lifecycle' AND json_extract(e.event_json,'$.state')='deleted') AS lifecycle_deleted
      FROM audits a JOIN runs r ON r.id=a.run_id
      LEFT JOIN targets t ON t.id=a.target_id
      LEFT JOIN snapshots s ON s.id=(
        SELECT observed.id FROM snapshots observed
        WHERE observed.target_id=a.target_id
          AND a.status IN ('validated','warning')
          AND a.source_checksum IS NOT NULL AND a.source_checksum<>''
          AND observed.source_checksum=a.source_checksum
          AND ${snapshotScope}
          AND julianday(observed.captured_at)>=julianday(r.started_at)
          AND julianday(observed.captured_at)<=julianday(a.created_at)
        ORDER BY julianday(observed.captured_at) DESC,observed.id DESC LIMIT 1
      )
      WHERE ${runScope}
        AND ${auditScope}
        AND julianday(a.created_at)>=julianday(r.started_at)
        AND (r.finished_at IS NULL OR julianday(a.created_at)<=julianday(r.finished_at))
        AND a.target_id IS NOT NULL
      ORDER BY a.target_id ASC,a.created_at DESC,a.id DESC
    `).all(...scopeParameters);
    const attempts = new Map();
    for (const row of rows) {
      const targetId = Number(row.target_id);
      let attempt = attempts.get(targetId);
      const isLatest = !attempt;
      if (!attempt) {
        attempt = {
          latestAt: row.created_at,
          latestStatus: row.status,
          latestReviewState: scheduledAuditReviewState(row, Boolean(window)),
          failedAttempts: 0,
          reachedEarlierCompletion: false,
          profileCompleted: false,
          profileCapturedAt: null,
          latestSnapshot: null,
        };
        attempts.set(targetId, attempt);
      }
      // Rows are ordered latest-first. Profile/works completion must describe
      // today's latest audit only; older snapshots are historical evidence,
      // not a reason to defer a new failure.
      if (isLatest && row.snapshot_id) {
        const snapshot = {
          id: Number(row.snapshot_id), captured_at: row.snapshot_at,
          followers: row.followers, total_likes: row.total_likes, total_posts: row.total_posts,
          hashtag_participants: row.hashtag_participants, hashtag_views: row.hashtag_views,
          quality_status: row.snapshot_quality, account_status: row.account_status,
          works_coverage: row.works_coverage, works_error: row.works_error,
          warnings_json: row.snapshot_warnings_json,
          works_error_code: row.works_error_code, works_policy_json: row.works_policy_json,
        };
        attempt.latestSnapshot = snapshot;
        attempt.profileCompleted = completeProfileMetrics(snapshot);
        attempt.profileCapturedAt = snapshot.captured_at;
      }
      if (attempt.reachedEarlierCompletion) continue;
      const state = scheduledAuditReviewState(row, Boolean(window));
      if (["complete", "limited", "inactive"].includes(state)) attempt.reachedEarlierCompletion = true;
      else {
        const lanes = worksPolicyLanes(row);
        const skippedWorks = row.snapshot_id && ["validated", "warning"].includes(row.snapshot_quality)
          && ["available", "partial"].includes(row.account_status) && [row.followers, row.total_likes, row.total_posts]
          .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
          && lanes.length > 0 && lanes.every((lane) => !lane.attempted) && lanes.some((lane) => lane.deferred);
        // A recorded profile with explicitly skipped works is not another
        // network failure and must not consume the bounded retry allowance.
        if (!skippedWorks) attempt.failedAttempts += 1;
      }
    }
    return attempts;
  }

  scheduledPlanSummary(dateKey, window = null) {
    const attempts = this.scheduledTargetAttemptStates(dateKey, window);
    const worksOnlyCoverage = new Map();
    const verifiedWorksOnlyRows = this.worksOnlyEnabled && window ? loadVerifiedWorksOnlyRows(this.database.db, window.asOf || new Date().toISOString())
      .filter(row => row.status === 'accepted' && row.request_finished_at >= window.startsAt && row.request_finished_at < window.endsAt)
      : [];
    for (const row of verifiedWorksOnlyRows) {
      const current = worksOnlyCoverage.get(row.target_id);
      const coverage = ['complete', 'limited', 'latest-public-window'].includes(row.works_coverage) ? row.works_coverage : 'limited';
      if (!current || coverage === 'complete') worksOnlyCoverage.set(row.target_id, coverage);
    }
    const targets = this.database.listTargets().filter((target) => target.enabled && target.provider !== "manual");
    const maximumAttempts = 1 + this.scheduledRetryDelaysMs.length;
    let completedCount = 0;
    let pendingCount = 0;
    let exhaustedCount = 0;
    let manualCount = 0;
    let inactiveCount = 0;
    let accountTargetCount = 0;
    let topicTargetCount = 0;
    let profilePendingCount = 0;
    let metricCompletedCount = 0;
    let topicMetricCompletedCount = 0;
    let profileCompletedCount = 0;
    let worksCompleteCount = 0;
    let worksLimitedCount = 0;
    let worksRetryCount = 0;
    let worksDeferredCount = 0;
    let worksAwaitingNextSlotCount = 0;
    let worksUnknownCount = 0;
    for (const target of targets) {
      if (target.type === "account") accountTargetCount += 1;
      else if (target.type === "hashtag") topicTargetCount += 1;
      const attempt = attempts.get(Number(target.id));
      const acceptedWorks = worksOnlyCoverage.has(target.id) && dailyProfileCompleted(target, attempt);
      const effectiveReviewState = acceptedWorks ? 'limited' : effectiveScheduledReviewState(target, attempt);
      if (effectiveReviewState === "inactive") {
        inactiveCount += 1;
        continue;
      }
      const deferredWorks = !acceptedWorks && target.type === "account" && worksRetryDeferred(target, attempt, window?.asOf ? new Date(window.asOf) : new Date());
      const awaitingWorksSlot = Boolean(window && this.scheduleIntervalHours === 8
        && dailyProfileCompleted(target, attempt)
        && !["complete", "limited"].includes(effectiveReviewState));
      if (target.type === "account") {
        if (dailyProfileCompleted(target, attempt)) profileCompletedCount += 1;
        else if (effectiveReviewState !== "inactive") profilePendingCount += 1;
        if (dailyProfileCompleted(target, attempt)) metricCompletedCount += 1;
        const coverage = acceptedWorks ? worksOnlyCoverage.get(target.id) : attempt?.latestSnapshot?.works_coverage;
        if (coverage === "complete") worksCompleteCount += 1;
        else if (["limited", "latest-public-window"].includes(coverage)) worksLimitedCount += 1;
        else if (["retry", "unavailable"].includes(coverage)) worksRetryCount += 1;
        else worksUnknownCount += 1;
        if (deferredWorks) worksDeferredCount += 1;
        if (awaitingWorksSlot) worksAwaitingNextSlotCount += 1;
      } else if (completeHashtagMetrics(target, attempt)) {
        metricCompletedCount += 1;
        topicMetricCompletedCount += 1;
      }
      // Keep transport cooldowns (and legacy works-denial daily deferrals)
      // out of the generic pending/exhausted
      // buckets so the UI cannot present an intentional deferral as a retry
      // failure or as a missing first collection.
      if (deferredWorks) continue;
      // Missing works must not re-enter the profile retry lane. The independent
      // works-only lane owns those attempts when enabled; otherwise next slot.
      if (awaitingWorksSlot) continue;
      // Keep completedCount's existing meaning: a complete/limited works
      // review. Profile completion is exposed separately above so the UI can
      // show homepage freshness without silently changing the historical run
      // completion denominator.
      if (attempt && ["complete", "limited"].includes(effectiveReviewState)) {
        completedCount += 1;
        continue;
      }
      // A deterministic identity/evidence conflict is a human-resolution
      // state, not a transient source failure. Do not spend the automatic
      // retry budget repeating the same unverifiable write.
      if (effectiveReviewState === "manual") {
        manualCount += 1;
        continue;
      }
      if (attempt?.failedAttempts >= maximumAttempts) exhaustedCount += 1;
      else pendingCount += 1;
    }
    return {
      trackedCount: targets.length,
      scheduledAccountTargetCount: accountTargetCount,
      scheduledTopicTargetCount: topicTargetCount,
      scheduledTopicMetricCompletedTargetCount: topicMetricCompletedCount,
      scheduledProfilePendingTargetCount: profilePendingCount,
      scheduledMetricCompletedTargetCount: metricCompletedCount,
      completedCount,
      pendingCount,
      exhaustedCount,
      manualCount,
      inactiveCount,
      profileCompletedCount,
      worksCompleteCount,
      worksLimitedCount,
      worksRetryCount,
      worksDeferredCount,
      worksAwaitingNextSlotCount,
      worksUnknownCount,
      unresolvedCount: Math.max(0, targets.length - completedCount - inactiveCount),
      attempts,
    };
  }

  scheduledPlanState(dateKey, latestRun, window = null) {
    const plan = this.scheduledPlanSummary(dateKey, window);
    return stateFromScheduledPlan(plan, latestRun);
  }

  scheduledDueTargetIds(dateKey, now = new Date(), window = null) {
    const attempts = this.scheduledTargetAttemptStates(dateKey, window);
    const maximumAttempts = 1 + this.scheduledRetryDelaysMs.length;
    return this.database.listTargets().flatMap((target) => {
      if (!target.enabled || target.provider === "manual") return [];
      const attempt = attempts.get(Number(target.id));
      if (!attempt) return [Number(target.id)];
      const effectiveReviewState = effectiveScheduledReviewState(target, attempt);
      if (["complete", "limited", "inactive"].includes(effectiveReviewState)) return [];
      if (effectiveReviewState === "manual") return [];
      if (window && this.scheduleIntervalHours === 8 && dailyProfileCompleted(target, attempt)) return [];
      // Saved profile counters do not need repeated full-roster refreshes.
      // Respect active transport waits; explicit expired waits or a ready
      // alternate lane keep the ordinary bounded retry allowance.
      if (worksRetryDeferred(target, attempt, now)) return [];
      if (attempt.failedAttempts >= maximumAttempts) return [];
      const delay = this.scheduledRetryDelaysMs[Math.max(0, attempt.failedAttempts - 1)] ?? 0;
      const anchor = new Date(attempt.latestAt).getTime();
      return !Number.isFinite(anchor) || now.getTime() >= anchor + delay ? [Number(target.id)] : [];
    });
  }

  async tick(now = new Date()) {
    const tickStartedAt = Date.now();
    this.lastTickAt = now.toISOString();
    this.tickCount += 1;
    if (this.running || this.planningTick || this.worksPlanning || this.stopped || this.shouldYieldScheduledCollection()) return;
    const slot = this.collectionSlot(now);
    if (slot) {
      let planned;
      if (this.asyncPlanning) {
        const epoch = this.planningEpoch, revision = this.planningRevision();
        this.planningTick = true;
        try {
          planned = await this.readPlanning('tick', now, { signal: this.providerOptions.signal });
          if (this.stopped || this.shouldYieldScheduledCollection() || epoch !== this.planningEpoch || this.running || this.providerOptions.signal?.aborted
            || revision !== this.planningRevision() || this.collectionSlot(new Date())?.key !== slot.key
            || planned.asOf !== now.toISOString() || planned.slotKey !== slot.key) return;
        } finally { this.planningTick = false; }
      }
      const due = new Set(planned ? planned.dueIds : this.scheduledDueTargetIds(this.scheduledDateKey(now), now, slot));
      if (due.size) {
        const excludedTargetIds = this.database.listTargets().filter((target) => !due.has(Number(target.id))).map((target) => Number(target.id));
        await this.runAll({ triggerType: "scheduled", excludeTargetIds: excludedTargetIds });
      } else if (this.worksOnlyEnabled) {
        if (Date.now() < (this.worksNextAllowedAt ?? 0)) return;
        let worksResult;
        if (planned) {
          const target = planned.worksTargetId === null ? null : this.database.getTarget(planned.worksTargetId);
          worksResult = await runNextWorksOnly(this, target ? { target } : null);
        } else {
          const attempts = this.scheduledTargetAttemptStates(this.scheduledDateKey(now), slot);
          const worksPlan = planWorksOnly(this.database, attempts, { now, slot });
          worksResult = await runNextWorksOnly(this, worksPlan.due[0]);
        }
        this.queueWorksFollowup(worksResult);
        if (this.continuousRoundStore && planned?.profilePassSettled === true
          && !this.stopped && !this.running && !this.shouldYieldScheduledCollection()) {
          this.continuousRoundStore.advance(slot.key, new Date());
        }
      }
      this.lastSuccessfulTickAt = this.lastTickAt;
      this.lastErrorAt = null;
      this.lastError = null;
      this.tickDurationMs = Math.max(0, Date.now() - tickStartedAt);
      return;
    }
    const { scheduleTime } = this.database.getSettings();
    const [hour, minute] = parseTimeOfDay(scheduleTime).split(":").map(Number);
    const scheduled = new Date(now);
    scheduled.setHours(hour, minute, 0, 0);
    if (now < scheduled) {
      this.lastSuccessfulTickAt = this.lastTickAt;
      this.lastErrorAt = null;
      this.lastError = null;
      this.tickDurationMs = Math.max(0, Date.now() - tickStartedAt);
      return;
    }
    const lastRun = this.database.lastScheduledRun();
    const dateKey = this.scheduledDateKey(now);
    if (lastRun && this.scheduledDateKey(new Date(lastRun.started_at)) === dateKey) {
      const dueTargetIds = this.scheduledDueTargetIds(dateKey, now);
      if (!dueTargetIds.length) {
        this.lastSuccessfulTickAt = this.lastTickAt;
        this.lastErrorAt = null;
        this.lastError = null;
        this.tickDurationMs = Math.max(0, Date.now() - tickStartedAt);
        return;
      }
      const due = new Set(dueTargetIds);
      const excludedTargetIds = this.database.listTargets()
        .filter((target) => !due.has(Number(target.id)))
        .map((target) => Number(target.id));
      await this.runAll({ triggerType: "scheduled", excludeTargetIds: excludedTargetIds });
      this.lastSuccessfulTickAt = new Date().toISOString();
      this.lastErrorAt = null;
      this.lastError = null;
      this.tickDurationMs = Math.max(0, Date.now() - tickStartedAt);
      return;
    }
    await this.runAll({ triggerType: "scheduled" });
    this.lastSuccessfulTickAt = new Date().toISOString();
    this.lastErrorAt = null;
    this.lastError = null;
    this.tickDurationMs = Math.max(0, Date.now() - tickStartedAt);
  }

  async runAll(options = {}) {
    // stop()/drain() close admission, not just the recurring timer. Manual
    // HTTP requests may already be awaiting their request body when SIGTERM
    // arrives, so they must be rejected before a durable run is reserved.
    if (this.stopped || this.stopping || this.draining) {
      throw collectionRequestError("服务正在停止采集；请在服务重新就绪后重试", 503, "SCHEDULER_STOPPED");
    }
    const { triggerType, targetId, excludeTargetIds, onlyType } = normalizeCollectionRequest(options);
    const excluded = new Set(excludeTargetIds);
    const requestedTarget = targetId === null ? null : this.database.getTarget(targetId);
    if (targetId !== null) {
      if (!requestedTarget) throw collectionRequestError("监控目标不存在", 404, "COLLECTION_TARGET_NOT_FOUND");
      if (!requestedTarget.enabled) throw collectionRequestError("该作者已暂停监控；请明确恢复监控后再采集", 409, "COLLECTION_TARGET_PAUSED");
      if (excluded.has(targetId) || (onlyType && requestedTarget.type !== onlyType)) throw collectionRequestError("指定目标与采集筛选条件冲突");
    }
    const allTargets = targetId
      ? [requestedTarget]
      : this.database.listTargets().filter((target) => target.enabled && !excluded.has(Number(target.id)) && (!onlyType || target.type === onlyType));
    if (!allTargets.length) throw collectionRequestError("当前范围没有可采集的监控目标", 400, "COLLECTION_SCOPE_EMPTY");
    // A request can share a live receipt only when its full scope is identical.
    // Include the resolved roster so imports during a run cannot silently join
    // an older, narrower batch and claim the new accounts were sampled.
    const scope = JSON.stringify({ triggerType, targetId, excludeTargetIds, onlyType,
      targetIds: allTargets.map((target) => Number(target.id)).sort((a, b) => a - b) });
    if (this.running) {
      if (this.currentScope === scope && this.currentPromise) return this.currentPromise;
      throw collectionRequestError("另一批采集正在进行，本次请求尚未执行；请等待当前采集结束后重试", 409, "COLLECTION_SCOPE_CONFLICT");
    }
    // Topic observations are prefetched once below. Persist them before the
    // potentially hours-long account pass, so a slow works endpoint cannot
    // hide already-observed topic data or lose it on a later interruption.
    const runnable = allTargets.filter((target) => target.provider !== "manual").sort((a, b) => Number(b.type === "hashtag") - Number(a.type === "hashtag"));
    const skipped = allTargets.filter((target) => target.provider === "manual");
    const frozenSettings = this.database.getSettings();
    const runId = this.database.beginRun(triggerType, targetId, allTargets.length);
    const startedAt = new Date().toISOString();
    this.running = true;
    this.currentScope = scope;
    this.currentProgress = {
      runId,
      triggerType,
      targetCount: allTargets.length,
      runnableCount: runnable.length,
      completedCount: skipped.length,
      successCount: 0,
      warningCount: 0,
      errorCount: 0,
      skippedCount: skipped.length,
      currentTarget: null,
      startedAt,
      heartbeatAt: startedAt,
    };
    this.currentPromise = (async () => {
      let successCount = 0;
      let errorCount = 0;
      let warningCount = 0;
      let interrupted = false;
      const signal = this.providerOptions.signal;
      const details = skipped.map((target) => ({ targetId: target.id, label: target.label, status: "skipped", message: "手动导入目标不参与定时采集" }));
      try {
        this.database.updateRunProgress(runId, { processedCount: skipped.length, skippedCount: skipped.length });
        signal?.throwIfAborted();
        if (triggerType === "scheduled") await this.runScheduledSourceProbe(runnable, frozenSettings);
        signal?.throwIfAborted();
        const topicBrowserBatch = await this.prepareTopicBrowserBatch(runnable, frozenSettings);
        signal?.throwIfAborted();
        // Reuse one provider instance for the whole run. Besides avoiding
        // repeated setup, this lets public-web's authenticated browser gate
        // classify a global 403 once and short-circuit the remaining targets
        // instead of launching one browser per account.
        const providers = new Map();
        const providerFor = (target) => {
          const key = String(target.provider ?? "");
          if (!providers.has(key)) providers.set(key, createProvider(target.provider, frozenSettings, {
            ...this.providerOptions,
            database: this.database,
            ...(topicBrowserBatch ? { topicBrowserBatch } : {}),
          }));
          return providers.get(key);
        };
        for (const target of runnable) {
          if (signal?.aborted) { interrupted = true; break; }
          let targetCompleted = true;
          this.currentProgress.currentTarget = { id: target.id, label: target.label };
          this.currentProgress.heartbeatAt = new Date().toISOString();
          this.database.updateRunProgress(runId, {
            processedCount: this.currentProgress.completedCount,
            successCount,
            errorCount,
            skippedCount: this.currentProgress.skippedCount,
            warningCount,
            currentTargetId: target.id,
          });
          try {
            const beforeCollection = this.database.getTarget(target.id);
            if (!beforeCollection || !beforeCollection.enabled) {
              this.currentProgress.skippedCount += 1;
              details.push({ targetId: target.id, label: target.label, status: "skipped", message: "目标已删除或暂停，已安全跳过" });
              continue;
            }
            const provider = providerFor(target);
            const collection = await provider.collect(beforeCollection, {
              // Finish the ordinary profile roster before spending the bounded
              // browser budget. The existing works-only lane owns that later
              // observation. Global refresh shares this profile-first policy;
              // single-target retries and deployments without it stay exact.
              deferBrowserWorks: ['scheduled', 'manual-refresh'].includes(triggerType) && this.scheduleIntervalHours === 8 && this.worksOnlyEnabled,
            });
            signal?.throwIfAborted();
            let currentTarget = this.database.getTarget(target.id);
            if (!currentTarget || !currentTarget.enabled) {
              this.currentProgress.skippedCount += 1;
              details.push({ targetId: target.id, label: target.label, status: "skipped", message: "采集期间目标已删除或暂停，未保存本次结果" });
              continue;
            }
            if (currentTarget.locator !== beforeCollection.locator || currentTarget.provider !== beforeCollection.provider) {
              this.currentProgress.skippedCount += 1;
              details.push({ targetId: target.id, label: target.label, status: "skipped", message: "采集期间目标身份已变更，未保存旧目标结果" });
              continue;
            }
            if (collection.lifecycle) {
              this.database.recordAccountLifecycle(currentTarget, runId, collection.lifecycle, collection.raw);
              this.currentProgress.skippedCount += 1;
              warningCount += 1;
              details.push({ targetId: target.id, label: currentTarget.label, status: "inactive", reviewState: "inactive",
                lifecycleState: "deleted", accountStatus: "deleted", profileUsable: false, postCount: 0,
                message: this.scheduleIntervalHours === 8
                  ? "官方主页显示已注销；保留历史，下个8小时时隙复查主页状态，不再反复获取不可用作品"
                  : "官方主页显示已注销；保留历史，每天检查主页状态，不再反复获取不可用作品" });
              continue;
            }
            if (collection.verifiedIdentity) {
              const { aliasEvent: _aliasEvent, sourceEvidenceEvent: _sourceEvidenceEvent, ...identityVerification } = collection.verifiedIdentity;
              const metadata = { ...currentTarget.metadata, identityVerification };
              const observedName = String(collection.verifiedIdentity.nickname ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
              const submittedName = String(metadata.submittedName ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
              const nameMismatch = Boolean(observedName && submittedName
                && normalizedAuthorName(observedName) !== normalizedAuthorName(submittedName));
              const previousNameVerification = metadata.nameVerification && typeof metadata.nameVerification === "object"
                ? metadata.nameVerification
                : null;
              const previousMismatchAt = previousNameVerification?.firstMismatchAt
                || (previousNameVerification?.status === "corrected" ? previousNameVerification?.verifiedAt : null);
              const mismatchWasAlreadyRecorded = Boolean(previousMismatchAt);
              const firstMismatchAt = previousMismatchAt || (nameMismatch ? collection.verifiedIdentity.verifiedAt : null);
              if (submittedName && observedName) {
                metadata.nameVerification = {
                  status: nameMismatch ? "corrected" : "matched",
                  submittedName,
                  observedName,
                  verifiedAt: collection.verifiedIdentity.verifiedAt,
                  ...(firstMismatchAt ? { firstMismatchAt } : {}),
                };
              }
              if (nameMismatch && !mismatchWasAlreadyRecorded) {
                collection.warnings = [...new Set([
                  ...(collection.warnings ?? []),
                  `表格作者名称“${submittedName}”与公开主页昵称“${observedName}”不一致；已按已核验主页更正显示名称`,
                ])];
                collection.qualityStatus = "warning";
              }
              const shouldRelabel = Boolean(observedName && currentTarget.label !== observedName);
              delete metadata.autoLabelPending;
              collection.targetUpdate = {
                ...(shouldRelabel ? { label: observedName } : {}),
                metadata,
              };
              currentTarget = { ...currentTarget, ...collection.targetUpdate };
            }
            this.database.saveCollection(currentTarget, runId, collection);
            const isTopic = target.type === "hashtag";
            const topicMetricsUsable = isTopic && ["validated", "warning"].includes(collection.qualityStatus)
              && [collection.snapshot?.hashtagParticipants, collection.snapshot?.hashtagViews]
                .every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
            const collectionReviewState = isTopic && !topicMetricsUsable ? "retry" : reviewState(collection.qualityStatus, collection.warnings ?? [], {
              accountStatus: collection.accountStatus,
              worksCoverage: collection.worksCoverage,
            });
            const profileUsable = String(collection.accountStatus ?? "") === "available";
            // A valid profile is a successful account snapshot even when the
            // public works window needs a retry.  This is the same separation
            // used by the local Jixuan workbench and keeps daily follower and
            // cumulative-like deltas available.
            // A saved warning/partial topic is evidence, not successful
            // monitoring: both actual counters must be present, including 0.
            if (isTopic ? topicMetricsUsable : profileUsable || ["complete", "limited"].includes(collectionReviewState)) successCount += 1;
            else errorCount += 1;
            // Hashtag snapshots intentionally have no account works-coverage
            // field. Count that field only for account targets; otherwise a
            // fully verified topic would make the whole batch look warning.
            if (collection.qualityStatus === "warning" || collection.warnings?.length
              || (target.type === "account" && collection.worksCoverage !== "complete")) warningCount += 1;
            details.push({
              targetId: target.id,
              label: currentTarget.label,
              status: collection.qualityStatus,
              reviewState: collectionReviewState,
              accountStatus: collection.accountStatus ?? "unknown",
              worksCoverage: collection.worksCoverage ?? "unknown",
              profileUsable,
              ...(isTopic ? { topicMetricsUsable } : {}),
              postCount: collection.posts.length,
              warnings: collection.warnings,
              ...(projectWorksRequestPolicy(collection.raw?.worksRequestPolicy) ? {
                worksRequestPolicy: projectWorksRequestPolicy(collection.raw.worksRequestPolicy),
                worksErrorCode: collection.raw.worksErrorCode === null ? null : worksErrorCode(collection.raw.worksErrorCode),
              } : {}),
            });
            const cooldownMs = this.providerOptions.cooldownMs ?? (target.provider === "public-web" && target.type === "account" ? 1_500 : 0);
            if (cooldownMs > 0) await new Promise((resolve) => setTimeout(resolve, cooldownMs));
          } catch (error) {
            if (signal?.aborted) {
              // A shutdown is not an upstream failure. Leave this target
              // unaudited so the next process resumes it without spending
              // retry budget or overwriting the last real account status.
              interrupted = true;
              targetCompleted = false;
              break;
            }
            const remainingTarget = this.database.getTarget(target.id);
            if (!remainingTarget || !remainingTarget.enabled) {
              this.currentProgress.skippedCount += 1;
              details.push({ targetId: target.id, label: target.label, status: "skipped", message: "采集期间目标已删除或暂停，未改写原状态" });
              continue;
            }
            errorCount += 1;
            try { this.database.recordFailure(target, runId, error); } catch {}
            details.push({ targetId: target.id, label: target.label, status: "error", message: String(error?.message ?? error) });
          } finally {
            if (targetCompleted) this.currentProgress.completedCount += 1;
            this.currentProgress.successCount = successCount;
            this.currentProgress.warningCount = warningCount;
            this.currentProgress.errorCount = errorCount;
            this.currentProgress.currentTarget = null;
            this.currentProgress.heartbeatAt = new Date().toISOString();
            this.database.updateRunProgress(runId, {
              processedCount: this.currentProgress.completedCount,
              successCount,
              errorCount,
              skippedCount: this.currentProgress.skippedCount,
              warningCount,
              currentTargetId: null,
            });
          }
        }
        const status = interrupted || signal?.aborted ? "interrupted" : errorCount === 0 ? "success" : successCount > 0 ? "partial" : "error";
        this.database.finishRun(runId, { status, successCount, errorCount, skippedCount: this.currentProgress.skippedCount, warningCount, processedCount: this.currentProgress.completedCount, details });
        const result = { runId, triggerType, status, targetCount: allTargets.length, successCount, warningCount, errorCount, skippedCount: this.currentProgress.skippedCount, details };
        await this.notifyRunComplete(result);
        return result;
      } catch (fatalError) {
        if (signal?.aborted) {
          const result = { runId, triggerType, status: "interrupted", targetCount: allTargets.length,
            successCount, errorCount, warningCount, skippedCount: this.currentProgress.skippedCount, details };
          this.database.finishRun(runId, { ...result, processedCount: this.currentProgress.completedCount });
          await this.notifyRunComplete(result);
          return result;
        }
        errorCount += 1;
        details.push({ status: "error", message: `任务异常中断：${String(fatalError?.message ?? fatalError)}` });
        let finalized = false;
        try {
          this.database.finishRun(runId, {
            status: "error",
            successCount,
            errorCount,
            skippedCount: this.currentProgress.skippedCount,
            warningCount,
            processedCount: this.currentProgress.completedCount,
            details,
          });
          finalized = true;
        } catch {}
        if (finalized) await this.notifyRunComplete({
          runId,
          triggerType,
          status: "error",
          targetCount: allTargets.length,
          successCount,
          warningCount,
          errorCount,
          skippedCount: this.currentProgress.skippedCount,
          details,
        });
        throw fatalError;
      }
    })();
    try {
      return await this.currentPromise;
    } finally {
      this.running = false;
      this.currentPromise = null;
      this.currentScope = null;
      this.currentProgress = null;
    }
  }
}
