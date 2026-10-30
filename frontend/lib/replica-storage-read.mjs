// Storage transport recovery only. Never retry or suppress a content proof failure.
const kinds = new Set(['aborted', 'resource-limit', 'access-denied', 'read-failed']);
export function replicaStorageFailure(error) {
  if (kinds.has(error?.storageFailure)) return error.storageFailure;
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`;
  if (/abort/i.test(text)) return 'aborted';
  if (/subrequest|quota|resource.{0,30}limit|too many.{0,30}requests/i.test(text)) return 'resource-limit';
  if (/unauthori[sz]ed|forbidden|permission|access.?denied/i.test(text)) return 'access-denied';
  return 'read-failed';
}
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
});

/** At most three GET/body attempts, all within the original caller's request.
 * Fixed classifications are safe for logs; original exception text is discarded. */
export async function readStoredReplicaText(bucket, key, expectedBytes, { signal, wait = pause } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const object = await bucket.get(key);
      if (signal?.aborted) { await object?.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
      signal?.throwIfAborted();
      if (!object) return undefined;
      if (typeof object.size === 'number' && object.size !== expectedBytes) {
        await object.body?.cancel().catch(() => {});
        throw Object.assign(Error('replica-reference-invalid'), { code: 'replica-storage-repair' });
      }
      const text = await object.text(); signal?.throwIfAborted(); return text;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code === 'replica-storage-repair') throw error;
      const kind = replicaStorageFailure(error);
      if (kind !== 'read-failed' || attempt === 3) throw Object.assign(Error('replica-storage-read-failed'),
        { code: 'replica-storage-read', storageFailure: kind, attempts: attempt });
      await wait(attempt === 1 ? 50 : 150, signal);
    }
  }
}
