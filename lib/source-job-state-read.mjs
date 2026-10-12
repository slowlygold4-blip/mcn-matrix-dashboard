export const MAX_SOURCE_STATE_JOB_READS = 50;
export const MAX_SOURCE_STATE_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_SOURCE_STATE_TOTAL_BYTES = 16 * 1024 * 1024;

/** One synchronous inspection only. Never returns request/result documents,
 * mutates jobs, or opens/migrates the database. Null means unverified, not idle.
 */
export function createSourceJobStateReader(db) {
  const cache = new Map();
  let bytes = 0, metadata, binding;
  try {
    metadata = db.prepare(`SELECT id,status,created_at AS createdAt,updated_at AS updatedAt,
      started_at AS startedAt,finished_at AS finishedAt,
      CASE WHEN typeof(request_json)='text' THEN length(CAST(request_json AS BLOB)) END AS requestBytes
      FROM author_resolution_jobs WHERE id=?`);
    const field = (name, limit) => `CASE WHEN json_type(request_json,'$.${name}')='text'
      AND length(json_extract(request_json,'$.${name}'))<=${limit} THEN json_extract(request_json,'$.${name}') END`;
    const allowed = (name, limit) => `(json_type(request_json,'$.${name}') IS NULL OR json_type(request_json,'$.${name}')='null'
      OR (json_type(request_json,'$.${name}')='text' AND length(json_extract(request_json,'$.${name}'))<=${limit}))`;
    binding = db.prepare(`SELECT CASE WHEN json_valid(request_json) THEN CASE WHEN json_type(request_json)='object'
      AND ${allowed('sourceUrl', 2000)} AND ${allowed('sourceSheetId', 120)} AND ${allowed('sheetName', 120)} AND ${allowed('defaultBoard', 120)}
      THEN json_array(${field('sourceUrl', 2000)},${field('sourceSheetId', 120)},${field('sheetName', 120)},${field('defaultBoard', 120)}) END END AS binding_json
      FROM author_resolution_jobs WHERE id=?`);
  } catch { return () => null; }
  return (id) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) return null;
    if (cache.has(id)) return cache.get(id);
    if (cache.size >= MAX_SOURCE_STATE_JOB_READS) return null;
    cache.set(id, null);
    try {
      // An external connection may update a durable job between these two
      // synchronous reads. Keep metadata and binding in one short snapshot.
      db.exec('SAVEPOINT source_job_state_read');
      try {
        const row = metadata.get(id);
        if (!row || row.id !== id || !Number.isSafeInteger(row.requestBytes) || row.requestBytes < 0
          || row.requestBytes > MAX_SOURCE_STATE_REQUEST_BYTES || bytes + row.requestBytes > MAX_SOURCE_STATE_TOTAL_BYTES) return null;
        bytes += row.requestBytes;
        const projected = binding.get(id)?.binding_json;
        if (typeof projected !== 'string' || Buffer.byteLength(projected) > 12000) return null;
        const [sourceUrl, sourceSheetId, sheetName, defaultBoard] = JSON.parse(projected);
        const result = { id: row.id, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
          startedAt: row.startedAt, finishedAt: row.finishedAt, request: { sourceUrl, sourceSheetId, sheetName, defaultBoard } };
        cache.set(id, result);
        return result;
      } finally { db.exec('RELEASE source_job_state_read'); }
    } catch { cache.set(id, null); return null; }
  };
}
