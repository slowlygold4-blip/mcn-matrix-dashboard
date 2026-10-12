import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

function auditError(code) {
  const messages = {
    SYSTEM_AUDIT_TIMEOUT: '系统完整性检查超时，请稍后重试',
    SYSTEM_AUDIT_UNAVAILABLE: '系统完整性检查暂不可用，请稍后重试',
    SYSTEM_AUDIT_CLOSED: '系统完整性检查已关闭',
  };
  return Object.assign(new Error(messages[code]), { code, status: code === 'SYSTEM_AUDIT_TIMEOUT' ? 504 : 503 });
}

function validResult(result) {
  return result && ['ok', 'error'].includes(result.database?.status)
    && ['ok', 'error', 'missing'].includes(result.backup?.status)
    && typeof result.checkStartedAt === 'string' && typeof result.checkFinishedAt === 'string'
    && Number.isFinite(Date.parse(result.checkStartedAt))
    && Date.parse(result.checkFinishedAt) >= Date.parse(result.checkStartedAt);
}

// At most one active job and one other-mode job. Pending requests share work;
// completed audits are deliberately never cached across database/backup writes.
export class SystemAuditReader {
  constructor({ databasePath, backupDir, timeoutMs = 45_000, workerFactory } = {}) {
    if (!databasePath || !backupDir) throw new Error('系统审查缺少数据库或备份目录');
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45_000;
    this.workerFactory = workerFactory ?? (() => new Worker(new URL('./system-audit-reader-worker.mjs', import.meta.url), {
      workerData: { databasePath, backupDir }, execArgv: [],
    }));
    this.jobs = new Map();
    this.worker = null;
    this.active = null;
    this.closed = false;
    this.terminations = new Set();
  }

  #terminate(worker) {
    if (!worker) return;
    const stopped = Promise.resolve().then(() => worker.terminate()).catch(() => {});
    this.terminations.add(stopped);
    void stopped.finally(() => this.terminations.delete(stopped));
  }

  #fail(code) {
    const worker = this.worker;
    this.worker = null;
    this.active = null;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(auditError(code));
    }
    this.jobs.clear();
    this.#terminate(worker);
  }

  #ensureWorker() {
    if (this.worker) return;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.on('message', (message) => {
      if (this.worker !== worker || this.closed) return;
      const job = this.active;
      if (!job || message?.id !== job.id) return;
      if (message.ok !== true || !validResult(message.result)) {
        this.#fail('SYSTEM_AUDIT_UNAVAILABLE');
        return;
      }
      clearTimeout(job.timer);
      this.jobs.delete(job.deep);
      this.active = null;
      job.resolve(message.result);
      this.#pump();
    });
    worker.on('error', () => { if (this.worker === worker) this.#fail('SYSTEM_AUDIT_UNAVAILABLE'); });
    worker.on('exit', () => { if (this.worker === worker) this.#fail('SYSTEM_AUDIT_UNAVAILABLE'); });
    worker.unref?.();
  }

  #pump() {
    if (this.closed || this.active || !this.jobs.size) return;
    try {
      this.#ensureWorker();
      this.active = this.jobs.values().next().value;
      this.worker.postMessage({ id: this.active.id, deep: this.active.deep });
    } catch {
      this.#fail('SYSTEM_AUDIT_UNAVAILABLE');
    }
  }

  read({ deep = false } = {}) {
    if (this.closed) return Promise.reject(auditError('SYSTEM_AUDIT_CLOSED'));
    const mode = deep === true;
    if (this.jobs.has(mode)) return this.jobs.get(mode).promise;
    const job = { id: randomUUID(), deep: mode };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    // The deadline includes queue time, so neither mode can hold HTTP open indefinitely.
    job.timer = setTimeout(() => this.#fail('SYSTEM_AUDIT_TIMEOUT'), this.timeoutMs);
    this.jobs.set(mode, job);
    this.#pump();
    return job.promise;
  }

  async close() {
    this.closed = true;
    this.#fail('SYSTEM_AUDIT_CLOSED');
    await Promise.all([...this.terminations]);
  }
}
