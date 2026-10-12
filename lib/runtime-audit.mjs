const REQUIRED_TABLES = Object.freeze([
  "targets",
  "target_boards",
  "posts",
  "post_metrics",
  "snapshots",
  "runs",
  "audits",
  "source_probes",
  "author_resolution_queue",
  "author_resolution_jobs",
  "author_resolution_idempotency",
]);

function checkRows(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => String(Object.values(row)[0] ?? "").toLowerCase() === "ok");
}

const SNAPSHOT_ACCOUNT_STATUSES = ["unknown", "available", "partial", "unavailable", "not-applicable"];
const SNAPSHOT_WORKS_COVERAGE = ["unknown", "complete", "limited", "retry", "unavailable", "latest-public-window", "not-applicable"];

function inspectDataQuality(database, tables) {
  const checks = {};
  const addCheck = (key, rows, description) => {
    const normalizedRows = Array.isArray(rows) ? rows : [];
    const count = Number(normalizedRows[0]?.count ?? 0);
    checks[key] = {
      status: count === 0 ? "ok" : "error",
      count,
      description,
      samples: normalizedRows.slice(0, 5).map((row) => ({ ...row })),
    };
  };

  if (tables.has("snapshots")) {
    addCheck(
      "snapshotMetricContract",
      database.db.prepare(`
        SELECT COUNT(*) AS count FROM snapshots
        WHERE account_status IN ('available','partial')
          AND followers IS NULL AND total_likes IS NULL
      `).all(),
      "可用主页快照至少保留一项累计指标",
    );
    addCheck(
      "snapshotEnumContract",
      database.db.prepare(`
        SELECT COUNT(*) AS count FROM snapshots
        WHERE account_status NOT IN (${SNAPSHOT_ACCOUNT_STATUSES.map(() => "?").join(",")})
           OR works_coverage NOT IN (${SNAPSHOT_WORKS_COVERAGE.map(() => "?").join(",")})
      `).all(...SNAPSHOT_ACCOUNT_STATUSES, ...SNAPSHOT_WORKS_COVERAGE),
      "主页状态和作品覆盖必须来自受控枚举",
    );
  }
  if (tables.has("runs")) {
    addCheck(
      "runLifecycleContract",
      database.db.prepare(`
        SELECT COUNT(*) AS count FROM runs
        WHERE (status IN ('success','partial','error') AND finished_at IS NULL)
           OR (status='running' AND finished_at IS NOT NULL)
      `).all(),
      "终态任务必须有完成时间，运行中任务不能提前结束",
    );
  }
  if (tables.has("audits") && tables.has("runs")) {
    addCheck(
      "auditRunReference",
      database.db.prepare(`
        SELECT COUNT(*) AS count FROM audits a
        LEFT JOIN runs r ON r.id=a.run_id
        WHERE a.run_id IS NOT NULL AND r.id IS NULL
      `).all(),
      "审查记录必须引用仍存在的任务",
    );
  }
  if (tables.has("source_probes")) {
    const latestByProvider = new Map();
    for (const row of database.db.prepare("SELECT provider,checked_at,result_json FROM source_probes ORDER BY checked_at DESC,id DESC").all()) {
      if (latestByProvider.has(row.provider)) continue;
      let payload = {};
      try { payload = JSON.parse(String(row.result_json ?? "{}")); } catch { payload = { parseError: true }; }
      latestByProvider.set(row.provider, { ...row, payload });
    }
    const invalid = [...latestByProvider.values()]
      .filter(({ payload }) => payload?.ok === true && (
        payload?.result?.runtimeAI !== false
        || payload?.result?.paidAPI !== false
        || !String(payload?.result?.mode ?? "").trim()
      ))
      .map(({ provider, checked_at: checkedAt, payload }) => ({ provider, checkedAt, mode: payload?.result?.mode ?? null }));
    addCheck(
      "sourceProbeContract",
      [{ count: invalid.length, samples: invalid }],
      "通过的来源探针必须明确模式且声明不使用运行时 AI / 付费 API",
    );
    checks.sourceProbeContract.samples = invalid.slice(0, 5);
  }

  const failedChecks = Object.entries(checks).filter(([, check]) => check.status !== "ok");
  return {
    status: failedChecks.length ? "error" : "ok",
    checkCount: Object.keys(checks).length,
    violationCount: failedChecks.reduce((total, [, check]) => total + check.count, 0),
    checks,
  };
}

export function inspectDatabase(database) {
  if (!database?.db) throw new Error("数据库连接不可用");
  const tables = new Set(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
  const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
  const quickRows = database.db.prepare("PRAGMA quick_check").all();
  const integrityRows = database.db.prepare("PRAGMA integrity_check").all();
  const foreignKeyViolations = database.db.prepare("PRAGMA foreign_key_check").all();
  const counts = {};
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) continue;
    counts[table] = Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }
  const quickCheck = checkRows(quickRows) ? "ok" : "error";
  const integrityCheck = checkRows(integrityRows) ? "ok" : "error";
  const dataQuality = inspectDataQuality(database, tables);
  const status = !missingTables.length && quickCheck === "ok" && integrityCheck === "ok" && foreignKeyViolations.length === 0 && dataQuality.status === "ok" ? "ok" : "error";
  return {
    status,
    quickCheck,
    integrityCheck,
    foreignKeyViolations: foreignKeyViolations.length,
    missingTables,
    counts,
    dataQuality,
  };
}

export function schedulerReadiness(state, { now = new Date(), maxTickAgeMs = 90_000 } = {}) {
  // `running` describes the current job, not whether the scheduler loop is
  // alive. An idle scheduler is healthy when it has emitted a tick and knows
  // its next planned run.
  if (!state?.lastTickAt || !state?.nextRunAt) return false;
  const reference = new Date(now).getTime();
  const tick = new Date(state.lastTickAt).getTime();
  const nextRun = new Date(state.nextRunAt).getTime();
  const maximumAge = Number(maxTickAgeMs);
  if (![reference, tick, nextRun, maximumAge].every(Number.isFinite) || maximumAge <= 0) return false;
  // A live interval alone is not enough: the scheduler must surface a recent
  // tick failure instead of appearing healthy while every automatic run is
  // rejected. The next successful tick clears this field.
  if (state.lastErrorAt) {
    const errorAt = new Date(state.lastErrorAt).getTime();
    const successAt = state.lastSuccessfulTickAt ? new Date(state.lastSuccessfulTickAt).getTime() : null;
    if (!Number.isFinite(errorAt)) return false;
    if (Number.isFinite(successAt) && errorAt > successAt) return false;
    if (!Number.isFinite(successAt) && reference - errorAt <= maximumAge) return false;
  }
  // Three missed 30-second ticks indicate an unhealthy loop. A far-future
  // timestamp is not proof of liveness either; tolerate only small clock skew.
  return tick <= reference + 5_000 && reference - tick <= maximumAge;
}

/**
 * Readiness answers “is the scheduler loop alive?” while this check answers
 * “does today's automatic collection have a healthy outcome?”. Keep the two
 * separate so an idle process is not mistaken for a failed collection, but do
 * not let a failed/partial/missed batch make the system audit look green.
 */
export function schedulerScheduleHealthy(state) {
  return ["waiting", "running", "completed"].includes(String(state?.scheduleState ?? ""));
}
