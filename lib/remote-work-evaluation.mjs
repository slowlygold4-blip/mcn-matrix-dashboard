// Bounded evaluation admission only: no network, timer, browser or model calls.
// The owner reserves before HTTP, then commits successful admission and finish
// in the same transaction. Existing account/source/history rows are untouched.
import { randomUUID } from 'node:crypto';
import { readWorksOnlyAnchor } from './works-only-observation.mjs';

export const REMOTE_WORK_EVALUATION_ORIGIN = 'https://demo.douyin.wtf';
const DAY_MS = 86_400_000;
const RUNNING_GRACE_MS = 120_000; // Exceeds the owner's 50-second HTTP deadline.
const TERMINAL = new Set(['success', 'failed', 'stopped']);
const STOP_CODES = new Set(['http_401', 'http401', 'http_403', 'http403', 'http_429', 'http429',
  '401', '403', '429', 'login_required', 'identity_login_required', 'blocked', 'block',
  'rate_limited', 'endpoint_circuit_open', 'circuit_open']);
function fail() {
  throw Object.assign(new Error('远程作品评估参数或状态无效'), { code: 'REMOTE_WORK_EVALUATION_INVALID' });
}
function instant(value) {
  const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(at) || at < 0 || at > 253402271999999) fail();
  const iso = new Date(at).toISOString();
  if (typeof value === 'string' && value !== iso) fail();
  return { at, iso };
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const at = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) fail();
  return at;
}
const attemptRow = (db, id) => db.prepare('SELECT * FROM remote_work_attempts WHERE id=?').get(id);

export function ensureRemoteWorkAttempts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_work_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    target_id INTEGER NOT NULL REFERENCES targets(id),
    source TEXT NOT NULL,
    day TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('running','success','failed','stopped')),
    error_code TEXT,
    post_count INTEGER NOT NULL DEFAULT 0 CHECK(post_count BETWEEN 0 AND 100),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count BETWEEN 0 AND 4),
    event_key TEXT,
    UNIQUE(source,target_id,day),
    CHECK((status='running' AND finished_at IS NULL AND error_code IS NULL AND post_count=0 AND request_count=0 AND event_key IS NULL)
       OR (status='success' AND finished_at IS NOT NULL AND error_code IS NULL AND post_count>=1 AND request_count>=1 AND event_key IS NOT NULL)
       OR (status IN ('failed','stopped') AND finished_at IS NOT NULL AND error_code IS NOT NULL AND post_count=0 AND event_key IS NULL))
  );`);
}

/** One reservation per approved source/target/Beijing day, within <=7 days.
 * An unfinished previous day stays immutable; it does not become a fake failure
 * or a second same-day request. Any stopped result closes this source/target.
 */
export function reserveRemoteWorkAttempt(db, { targetId, sourceOrigin, startsOn, endsOn, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(targetId) || targetId < 1 || sourceOrigin !== REMOTE_WORK_EVALUATION_ORIGIN) fail();
  const start = date(startsOn), end = date(endsOn), clock = instant(now);
  if (end < start || end - start > 6 * DAY_MS) fail();
  const day = new Date(clock.at + 8 * 3_600_000).toISOString().slice(0, 10);
  if (day < startsOn || day > endsOn) return null;
  // A caller-owned transaction must never be committed or rolled back here.
  if (db.isTransaction) fail();
  let opened = false;
  try {
    db.exec('BEGIN IMMEDIATE'); opened = true;
    if (db.prepare(`SELECT 1 FROM remote_work_attempts WHERE source=? AND target_id=?
      AND (day=? OR status='stopped' OR (status='running' AND julianday(started_at)>julianday(?))) LIMIT 1`)
      .get(sourceOrigin, targetId, day, new Date(clock.at - RUNNING_GRACE_MS).toISOString())) {
      db.exec('COMMIT'); opened = false; return null;
    }
    let anchor;
    try { anchor = readWorksOnlyAnchor(db, targetId, { now: clock.at }); }
    catch (error) {
      if (error?.code !== 'WORKS_OBSERVATION_INVALID') throw error;
      db.exec('COMMIT'); opened = false; return null;
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO remote_work_attempts
      (id,target_id,source,day,started_at,finished_at,status,error_code,post_count,request_count,event_key)
      VALUES(?,?,?,?,?,NULL,'running',NULL,0,0,NULL)`).run(id, targetId, sourceOrigin, day, clock.iso);
    const row = attemptRow(db, id);
    db.exec('COMMIT'); opened = false;
    return { ...row, anchor };
  } catch (error) {
    if (opened) db.exec('ROLLBACK');
    throw error;
  }
}

/** No transaction boundary here: the receipt writer can atomically commit the
 * post vectors, immutable source event and this outcome together. Counts include
 * authentication/logout HTTP requests, not just the single author-list request.
 */
export function finishRemoteWorkAttempt(db, id, { status, errorCode = null, postCount = 0, requestCount = 0, eventKey = null, now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(id)
    || !TERMINAL.has(status) || !Number.isSafeInteger(postCount) || postCount < 0 || postCount > 100
    || !Number.isSafeInteger(requestCount) || requestCount < 0 || requestCount > 4) fail();
  const clock = instant(now);
  if (status === 'success') {
    if (errorCode !== null || postCount < 1 || requestCount < 1 || typeof eventKey !== 'string' || !/^[a-f\d]{64}$/.test(eventKey)) fail();
  } else {
    if (postCount !== 0 || eventKey !== null || typeof errorCode !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(errorCode)) fail();
    if (STOP_CODES.has(errorCode.toLowerCase())) status = 'stopped';
  }
  const row = attemptRow(db, id);
  if (!row || row.source !== REMOTE_WORK_EVALUATION_ORIGIN || clock.at < instant(row.started_at).at) fail();
  // A retry of the finish operation reuses the actual saved finish clock, even
  // if the caller's wall clock has advanced. Different outcomes never overwrite.
  const same = saved => saved?.status === status && saved.error_code === errorCode
    && saved.post_count === postCount && saved.request_count === requestCount && saved.event_key === eventKey;
  if (row.status !== 'running') {
    if (!same(row)) fail();
    return { ...row };
  }
  const updated = db.prepare(`UPDATE remote_work_attempts SET finished_at=?,status=?,error_code=?,post_count=?,request_count=?,event_key=?
    WHERE id=? AND status='running'`).run(clock.iso, status, errorCode, postCount, requestCount, eventKey, id);
  const saved = attemptRow(db, id);
  if (updated.changes !== 1 && !same(saved)) fail();
  return { ...saved };
}
