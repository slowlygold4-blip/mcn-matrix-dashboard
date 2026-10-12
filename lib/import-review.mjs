// A read-only projection of the immutable job result, never a live queue balance.
const searchable = ['sourceRow', 'sourceRecordId', 'name', 'platform', 'board', 'douyinId', 'bilibiliId', 'xiaohongshuId', 'reason', 'identityConflict'];
const normalized = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const boundedInteger = (value, fallback, minimum, maximum) => {
  const number = Number(value);
  return value === null || value === '' || !Number.isFinite(number) ? fallback : Math.max(minimum, Math.min(maximum, Math.trunc(number)));
};
export function projectImportReview(job, options = {}) {
  const original = Array.isArray(job?.result?.skipped) ? job.result.skipped : [];
  const entries = original.filter(row => row && typeof row === 'object' && !Array.isArray(row));
  const query = normalized(options.query).slice(0, 200);
  const status = String(options.status ?? '').trim().slice(0, 60);
  const statuses = new Map();
  for (const row of entries) { const value = String(row.status || 'unknown'); statuses.set(value, (statuses.get(value) || 0) + 1); }
  const filtered = entries.filter(row => (!status || status === 'all' || String(row.status || 'unknown') === status)
    && (!query || searchable.some(key => normalized(row[key]).includes(query))));
  const limit = boundedInteger(options.limit, 20, 1, 500);
  const requestedOffset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const offset = Math.min(requestedOffset, filtered.length ? Math.floor((filtered.length - 1) / limit) * limit : 0);
  return { version: 1, jobId: job.id, scope: 'historical-job-review-not-live-queue', finishedAt: job.finishedAt ?? null,
    originalTotal: original.length, validTotal: entries.length, total: filtered.length, offset, limit, query, status,
    statuses: [...statuses].map(([status, count]) => ({ status, count })),
    items: filtered.slice(offset, offset + limit) };
}
