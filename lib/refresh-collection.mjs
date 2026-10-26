import { randomUUID } from 'node:crypto';

const ACTIVE = new Set(['queued', 'running']);
const TRIGGER = 'manual-refresh';
const now = () => new Date().toISOString();
const count = value => Math.max(0, Number(value) || 0);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const requestError = (message, status, code) => Object.assign(new Error(message), { status, code });

function runResult(run) {
  if (!run) return null;
  // The persisted scheduler details contain normalized counters and bounded
  // warnings, never the provider's raw response or authentication material.
  const details = parse(run.details_json, []).map(item => ({
    ...(Number.isSafeInteger(item.targetId) ? { targetId: item.targetId } : {}),
    ...(item.label ? { label: String(item.label).slice(0, 160) } : {}),
    status: String(item.status || 'unknown').slice(0, 40),
    ...Object.fromEntries(['reviewState', 'accountStatus', 'worksCoverage'].filter(key => item[key] !== undefined)
      .map(key => [key, String(item[key]).slice(0, 60)])),
    ...(typeof item.profileUsable === 'boolean' ? { profileUsable: item.profileUsable } : {}),
    ...(typeof item.topicMetricsUsable === 'boolean' ? { topicMetricsUsable: item.topicMetricsUsable } : {}),
    ...(item.postCount !== undefined ? { postCount: count(item.postCount) } : {}),
  }));
  return { runId: run.id, triggerType: run.trigger_type, status: run.status,
    targetCount: count(run.target_count), processedCount: count(run.processed_count),
    successCount: count(run.success_count), errorCount: count(run.error_count),
    warningCount: count(run.warning_count), skippedCount: count(run.skipped_count),
    profileUsableCount: details.filter(item => item.profileUsable === true).length,
    topicMetricsUsableCount: details.filter(item => item.topicMetricsUsable === true).length,
    worksCompleteCount: details.filter(item => item.worksCoverage === 'complete').length,
    worksLimitedCount: details.filter(item => ['limited', 'latest-public-window'].includes(item.worksCoverage)).length,
    worksUnavailableCount: details.filter(item => item.topicMetricsUsable === undefined && item.profileUsable !== undefined && !['complete', 'limited', 'latest-public-window'].includes(item.worksCoverage)).length,
    details };
}

function terminalStatus(runStatus) {
  return runStatus === 'interrupted' || runStatus === 'running' ? 'interrupted'
    : ['success', 'partial'].includes(runStatus) ? 'completed' : 'failed';
}

export class RefreshCollection {
  constructor({ database, scheduler }) {
    this.database = database;
    this.scheduler = scheduler;
    this.stopped = false;
    this.currentJobId = null;
    this.currentPromise = null;
    database.db.exec(`CREATE TABLE IF NOT EXISTS refresh_collection_jobs (
      id TEXT PRIMARY KEY, requested_at TEXT NOT NULL, payload_json TEXT NOT NULL
    )`);
    database.db.exec(`CREATE TABLE IF NOT EXISTS refresh_collection_requests (request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL)`);
    // A queued click is never replayed after a process restart. A completed
    // run still provides its durable receipt if the process died before the
    // final job write. afterRunId also closes the beginRun / job-write gap.
    for (const row of database.db.prepare('SELECT payload_json FROM refresh_collection_jobs').all()) {
      const job = parse(row.payload_json, null);
      if (!job || !ACTIVE.has(job.status)) continue;
      const run = this.findRun(job);
      if (run) { job.runId = run.id; job.startedAt = run.started_at; }
      job.status = run ? terminalStatus(run.status) : 'interrupted';
      job.finishedAt = run?.finished_at || now();
      job.error = job.status === 'interrupted' ? '服务已重启，上次刷新未完成；没有自动重放采集。' : null;
      this.save(job);
    }
  }

  save(job) {
    this.database.db.prepare(`INSERT INTO refresh_collection_jobs(id,requested_at,payload_json) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json`)
      .run(job.id, job.requestedAt, JSON.stringify(job));
  }

  findRun(job) {
    return job.runId
      ? this.database.db.prepare('SELECT * FROM runs WHERE id=?').get(job.runId)
      : this.database.db.prepare('SELECT * FROM runs WHERE trigger_type=? AND id>? ORDER BY id LIMIT 1').get(TRIGGER, job.afterRunId);
  }

  readJob(id) {
    const row = id
      ? this.database.db.prepare('SELECT payload_json FROM refresh_collection_jobs WHERE id=?').get(id)
      : this.database.db.prepare('SELECT payload_json FROM refresh_collection_jobs ORDER BY rowid DESC LIMIT 1').get();
    return row ? parse(row.payload_json, null) : null;
  }

  get(id = null) {
    const job = this.readJob(id);
    if (!job) return null;
    const run = job.runId ? this.findRun(job) : null;
    const live = run && this.scheduler.currentProgress?.runId === run.id ? this.scheduler.currentProgress : null;
    const result = !ACTIVE.has(job.status) && run ? runResult(run) : null;
    if (result && job.status === 'interrupted' && result.status === 'running') result.status = 'interrupted';
    return { id: job.id, status: job.status, scope: 'all-enabled', collectionMode: 'profile-first',
      runId: job.runId || null, requestedAt: job.requestedAt, startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null, error: job.error || null,
      progress: { targetCount: count(run?.target_count ?? job.targetCount),
        processedCount: count(live?.completedCount ?? run?.processed_count),
        successCount: count(live?.successCount ?? run?.success_count),
        errorCount: count(live?.errorCount ?? run?.error_count),
        warningCount: count(live?.warningCount ?? run?.warning_count),
        skippedCount: count(live?.skippedCount ?? run?.skipped_count),
        currentTarget: live?.currentTarget ? { id: live.currentTarget.id, label: live.currentTarget.label } : null },
      result };
  }

  request({ requestId = null } = {}) {
    if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw requestError("无效请求编号",400,"INVALID_REQUEST_ID");
    if (requestId) {
      const previous=this.database.db.prepare("SELECT job_id FROM refresh_collection_requests WHERE request_id=?").get(requestId);
      if(previous) return {job:this.get(previous.job_id),reused:true};
      if(this.readJob(requestId)) return {job:this.get(requestId),reused:true};
    }
    if (this.stopped || this.scheduler.stopped || this.scheduler.stopping || this.scheduler.draining) {
      throw requestError('服务正在停止采集，请稍后重试', 503, 'SCHEDULER_STOPPED');
    }
    if (this.currentJobId) {
      if(requestId)this.database.db.prepare("INSERT INTO refresh_collection_requests(request_id,job_id) VALUES(?,?)").run(requestId,this.currentJobId);
      return { job: this.get(this.currentJobId), reused: true };
    }
    const targets = this.database.listTargets().filter(target => target.enabled);
    if (!targets.length) throw requestError('没有已启用的监控账号或话题', 400, 'COLLECTION_SCOPE_EMPTY');
    const job = { id: requestId || randomUUID(), status: 'queued', requestedAt: now(), runId: null,
      targetCount: targets.length, afterRunId: this.database.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM runs').get().id };
    this.save(job);
    if(requestId)this.database.db.prepare("INSERT INTO refresh_collection_requests(request_id,job_id) VALUES(?,?)").run(requestId,job.id);
    this.currentJobId = job.id;
    // Yield before starting so even a long roster never holds the POST open.
    this.currentPromise = Promise.resolve().then(() => this.execute(job)).catch(error => {
      console.error('刷新采集任务收尾失败：', error?.message || error);
    }).finally(() => { this.currentJobId = null; this.currentPromise = null; });
    return { job: this.get(job.id), reused: false };
  }

  async execute(job) {
    try {
      while (this.scheduler.running) {
        // A works-only or single-target run is only a blocker. It can never
        // serve as this request's all-enabled collection receipt.
        const current = this.scheduler.currentPromise;
        if (!current) throw requestError('当前采集状态不完整，请稍后重试', 503, 'COLLECTION_BUSY');
        await current.catch(() => {});
        await Promise.resolve();
        if (this.stopped) return;
      }
      if (this.stopped) return;
      const pending = this.scheduler.runAll({ triggerType: TRIGGER });
      const progress = this.scheduler.currentProgress;
      if (progress?.triggerType === TRIGGER) {
        job.runId = progress.runId;
        job.startedAt = progress.startedAt;
        job.targetCount = progress.targetCount;
        job.status = 'running';
        this.save(job);
      }
      const result = await pending;
      job.status = terminalStatus(result.status);
      job.finishedAt = now();
      job.error = job.status === 'failed' ? '本次采集未取得可用结果，请查看失败数量与采集状态。'
        : job.status === 'interrupted' ? '本次采集已中断，页面保留已保存的数据。' : null;
      this.save(job);
    } catch (error) {
      const run = this.findRun(job);
      if (run) { job.runId = run.id; job.startedAt = run.started_at; }
      job.status = this.stopped || error?.code === 'SCHEDULER_STOPPED' ? 'interrupted' : 'failed';
      job.finishedAt = now();
      // Provider exception strings may include request details. Expose a
      // stable product message and retain normalized run counters only.
      job.error = job.status === 'interrupted' ? '服务已停止，本次刷新未完成。'
        : error?.code === 'COLLECTION_SCOPE_EMPTY' ? '没有已启用的监控账号或话题。' : '本次刷新采集未完成，请查看采集状态后重试。';
      this.save(job);
    }
  }

  stop() {
    this.stopped = true;
    const job = this.currentJobId ? this.readJob(this.currentJobId) : null;
    if (job?.status === 'queued') {
      job.status = 'interrupted'; job.finishedAt = now(); job.error = '服务已停止，排队中的刷新没有执行。';
      this.save(job);
    }
  }
}
