// Manual collection is separate from automatic, read-only snapshot polling.
const pending = job => ['queued', 'running'].includes(job?.status);
const statuses = new Set(['queued', 'running', 'completed', 'failed', 'interrupted']);
function checkedJob(value) {
  if (value === null) return null;
  if (!value || typeof value.id !== 'string' || !value.id || !statuses.has(value.status)) {
    throw new Error('采集任务回执无效，请重新读取状态');
  }
  return value;
}

export function createCollectionRefresh({ api, onChange = () => {}, onComplete = async () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 5000 }) {
  let job = null, submitting = false, checking = false, error = '', disposed = false;
  let timer = null, requestPromise = null, readPromise = null;
  const notified = new Set();
  const getState = () => ({ job, submitting, checking, error });
  const emit = () => { if (!disposed) onChange(getState()); };
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = () => {
    clear();
    if (!disposed && pending(job)) timer = setTimer(() => { timer = null; void read(false); }, pollMs);
  };
  async function accept(value, restoring = false) {
    const next = checkedJob(value);
    if (disposed) return;
    if (!restoring && job && (!next || next.id !== job.id)) throw new Error('采集任务身份不一致，保留原任务并重查');
    job = next; error = ''; emit();
    if (job && !pending(job) && !notified.has(job.id)) {
      notified.add(job.id);
      if (!restoring) await onComplete(job);
    }
  }
  function read(restoring) {
    if (disposed) return Promise.resolve();
    if (requestPromise) return requestPromise;
    if (readPromise) return readPromise;
    checking = true; emit();
    readPromise = (async () => {
      try {
        const path = '/api/refresh-collection' + (!restoring && job ? `?jobId=${encodeURIComponent(job.id)}` : '');
        const response = await api(path);
        await accept(response.job, restoring);
      } catch (failure) {
        if (!disposed) { error = `采集状态读取失败：${failure.message}。不会重复提交采集。`; emit(); }
      } finally {
        checking = false; readPromise = null;
        if (!disposed) { emit(); schedule(); }
      }
    })();
    return readPromise;
  }
  function request() {
    if (disposed) return Promise.resolve();
    if (requestPromise) return requestPromise;
    if (pending(job)) return read(false);
    if (readPromise) return readPromise;
    clear(); submitting = true; error = ''; emit();
    requestPromise = (async () => {
      try {
        const response = await api('/api/refresh-collection', { method: 'POST', body: '{}' });
        const next = checkedJob(response.job);
        if (!next) throw new Error('服务器没有返回采集任务');
        if (!disposed) { job = next; await accept(next); }
      } catch (failure) {
        if (!disposed) { error = `采集请求未确认：${failure.message}。请先核对任务状态，勿连续重试。`; emit(); }
      } finally {
        submitting = false; requestPromise = null;
        if (!disposed) { emit(); schedule(); }
      }
    })();
    return requestPromise;
  }
  return { request, restore: () => read(job === null), getState,
    dispose() { disposed = true; clear(); } };
}
