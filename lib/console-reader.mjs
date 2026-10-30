import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("./console-reader-worker.mjs", import.meta.url);
const uncachedKinds = new Set(['planning','bootstrap-overview','creator-operating']);
const readError = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const canonical = (value) => value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export class ConsoleReader {
  constructor({ databasePath, timeoutMs = 45_000, maxQueue = 12, cacheTtlMs = 30_000, cacheMaxEntries = 12,
    workerFactory = () => new Worker(fileURLToPath(workerUrl), { workerData: { databasePath }, execArgv: [] }) } = {}) {
    if (!databasePath) throw new Error("ConsoleReader 缺少数据库路径");
    this.databasePath = databasePath;
    this.timeoutMs = timeoutMs;
    this.maxQueue = maxQueue;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheMaxEntries = cacheMaxEntries;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.activeId = null;
    this.jobs = new Map();
    this.pending = new Map();
    this.queue = [];
    this.cache = new Map();
    this.generation = 0;
    this.closed = false;
    this.terminations = new Set();
    this.#ensureWorker();
  }

  #ensureWorker() {
    if (this.worker || this.closed) return;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.on("message", (message) => { if (this.worker === worker) this.#resolve(message); });
    worker.on("error", () => {
      if (this.worker === worker) this.#failWorker(readError("CONSOLE_READER_FAILED", "数据读取进程暂时不可用，请刷新重试"));
    });
    worker.on("exit", () => {
      if (this.worker === worker && !this.closed) this.#failWorker(readError("CONSOLE_READER_FAILED", "数据读取进程已退出，请刷新重试"));
    });
    worker.unref();
  }

  #cacheKey(kind, options, targetId) {
    // A short cache must still not carry yesterday's "today" over midnight.
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone || "UTC" }).format(new Date());
    return JSON.stringify([this.generation, date, kind, canonical(options), targetId]);
  }

  #settle(job, error, value) {
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
    if (this.pending.get(job.cacheKey) === job) this.pending.delete(job.cacheKey);
    this.queue = this.queue.filter((id) => id !== job.id);
    if (this.activeId === job.id) this.activeId = null;
    if (!this.jobs.size) this.worker?.unref();
    for (const subscriber of [...job.subscribers]) this.#settleSubscriber(job, subscriber, error, value);
  }

  #settleSubscriber(job, subscriber, error, value) {
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort);
    job.subscribers.delete(subscriber);
    if (error) subscriber.reject(error);
    else subscriber.resolve(value);
  }

  #subscribe(job, signal) {
    // Preserve the existing same-promise contract for callers without a signal.
    if (!signal && job.promise) return job.promise;
    if (job.subscribers.size >= 128) return Promise.reject(readError("CONSOLE_READER_BUSY", "读取任务较多，请稍后重试"));
    const subscriber = { signal };
    const promise = new Promise((resolve, reject) => Object.assign(subscriber, { resolve, reject }));
    job.subscribers.add(subscriber);
    if (!signal) job.promise = promise;
    subscriber.onAbort = () => {
      if (!job.subscribers.has(subscriber)) return;
      const error = readError('CONSOLE_READER_ABORTED', '读取已取消');
      this.#settleSubscriber(job, subscriber, error);
      if (job.subscribers.size) return;
      if (this.activeId === job.id) {
        const worker = this.worker;
        this.worker = null;
        this.#retireWorker(worker);
      }
      this.#settle(job, error);
      this.#pump();
    };
    signal?.addEventListener('abort', subscriber.onAbort, { once: true });
    if (signal?.aborted) subscriber.onAbort();
    return promise;
  }

  #retireWorker(worker) {
    if (!worker) return;
    const finished = () => {
      this.terminations.delete(ended);
      this.#pump();
    };
    const ended = Promise.resolve(worker.terminate()).then(finished, finished);
    this.terminations.add(ended);
  }

  #resolve(message) {
    const job = this.jobs.get(message.id);
    if (!job || message.id !== this.activeId) return;
    if (message.ok) {
      // A write during a read invalidates the cache, including this result.
      if (!uncachedKinds.has(job.kind) && job.generation === this.generation) {
        this.cache.set(job.cacheKey, { at: Date.now(), value: message.result });
        while (this.cache.size > this.cacheMaxEntries) this.cache.delete(this.cache.keys().next().value);
      }
      this.#settle(job, null, message.result);
    } else {
      this.#settle(job, readError(message.code || "CONSOLE_READER_ERROR", message.error || "读取数据失败", 400));
    }
    this.#pump();
  }

  #failWorker(error) {
    const worker = this.worker;
    this.worker = null;
    this.activeId = null;
    this.cache.clear();
    for (const job of [...this.jobs.values()]) this.#settle(job, error);
    // Recovery is demand-driven, not an unbounded restart loop.
    this.#retireWorker(worker);
  }

  #pump() {
    if (this.closed || this.activeId || this.terminations.size || !this.queue.length) return;
    try {
      this.#ensureWorker();
      const job = this.jobs.get(this.queue.shift());
      this.activeId = job.id;
      this.worker.ref?.();
      this.worker.postMessage({ id: job.id, kind: job.kind, targetId: job.targetId, options: job.options });
    } catch {
      this.#failWorker(readError("CONSOLE_READER_FAILED", "数据读取进程暂时不可用，请刷新重试"));
    }
  }

  #read(kind, options, targetId = null, signal) {
    if (this.closed) return Promise.reject(readError("CONSOLE_READER_CLOSED", "数据读取器已关闭"));
    if (signal?.aborted) return Promise.reject(readError('CONSOLE_READER_ABORTED', '读取已取消'));
    // Planning/source identity must revalidate current DB on every call, even
    // at an identical asOf. Do not cache or coalesce these fresh read snapshots.
    const cacheKey = uncachedKinds.has(kind) ? randomUUID() : this.#cacheKey(kind, options, targetId);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) return Promise.resolve(cached.value);
    if (this.pending.has(cacheKey)) return this.#subscribe(this.pending.get(cacheKey), signal);
    if (this.jobs.size >= this.maxQueue) return Promise.reject(readError("CONSOLE_READER_BUSY", "读取任务较多，请稍后重试"));
    const job = { id: randomUUID(), kind, targetId, options: structuredClone(options), cacheKey, generation: this.generation, subscribers: new Set() };
    // Deadline includes queue time, not just worker execution time.
    job.timer = setTimeout(() => {
      if (!this.jobs.has(job.id)) return;
      const error = readError("CONSOLE_READER_TIMEOUT", "读取数据超时，请刷新重试", 504);
      if (this.activeId === job.id) this.#failWorker(error);
      else this.#settle(job, error);
    }, this.timeoutMs);
    this.jobs.set(job.id, job);
    this.pending.set(cacheKey, job);
    this.queue.push(job.id);
    const promise = this.#subscribe(job, signal);
    this.#pump();
    return promise;
  }

  invalidate() { this.generation += 1; this.cache.clear(); }
  overview(options = {}, { signal } = {}) { return this.#read("overview", options, null, signal); }
  account(targetId, options = {}, { signal } = {}) { return this.#read("account", options, Number(targetId), signal); }
  history(targetId, options = {}, { signal } = {}) { return this.#read("history", options, Number(targetId), signal); }
  planning(options, { signal } = {}) { return this.#read('planning', options, null, signal); }
  bootstrapOverview(options, { signal } = {}) { return this.#read('bootstrap-overview', options, null, signal); }
  creatorOperatingView(options = {}, { signal } = {}) { return this.#read('creator-operating', options, null, signal); }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.cache.clear();
    for (const job of [...this.jobs.values()]) this.#settle(job, readError("CONSOLE_READER_CLOSED", "数据读取器已关闭"));
    this.closePromise = Promise.all([...this.terminations, ...(worker ? [worker.terminate()] : [])]).then(() => {});
    return this.closePromise;
  }
}
