import { sanitizeBrowserWorksDiagnostics } from './douyin-browser-diagnostics.mjs';

const MAX_SECOND = 253402300799;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const invalid = () => ({ retryAfterStatus: 'invalid', retryAfterSeconds: null });
const pad = number => String(number).padStart(2, '0');

// Match and round-trip every HTTP-date component. Date.parse is deliberately
// not used for upstream text: it accepts invalid calendars and wrong weekdays.
export function parseBrowserRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value || value.length > 512 || !Number.isFinite(now)
    || now < 0 || now > MAX_SECOND * 1000) return invalid();
  let delay;
  if (/^[0-9]+$/.test(value)) {
    const seconds = BigInt(value);
    if (seconds > BigInt(MAX_SECOND)) return { retryAfterStatus: 'too-long', retryAfterSeconds: null };
    delay = Number(seconds);
  } else {
    const imf = /^([A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
    const old = /^([A-Z][a-z]+), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
    const asc = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
    const parts = imf || old || asc;
    if (!parts) return invalid();
    const monthName = asc ? parts[2] : parts[3], month = MONTHS.indexOf(monthName);
    const day = Number(asc ? parts[3] : parts[2]);
    let year = Number(asc ? parts[7] : parts[4]);
    if (old) {
      const currentYear = new Date(now).getUTCFullYear();
      year += Math.floor(currentYear / 100) * 100;
      if (year > currentYear + 50) year -= 100;
    }
    const hour = Number(asc ? parts[4] : parts[5]), minute = Number(asc ? parts[5] : parts[6]);
    const second = Number(asc ? parts[6] : parts[7]);
    if (month < 0 || year < 1 || year > 9999 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return invalid();
    const date = new Date(0);
    date.setUTCFullYear(year, month, day); date.setUTCHours(hour, minute, second, 0);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return invalid();
    const time = `${pad(hour)}:${pad(minute)}:${pad(second)}`;
    const canonical = asc ? `${DAYS[date.getUTCDay()]} ${monthName} ${String(day).padStart(2, ' ')} ${time} ${String(year).padStart(4, '0')}`
      : old ? `${FULL_DAYS[date.getUTCDay()]}, ${pad(day)}-${monthName}-${pad(year % 100)} ${time} GMT`
        : `${DAYS[date.getUTCDay()]}, ${pad(day)} ${monthName} ${String(year).padStart(4, '0')} ${time} GMT`;
    if (canonical !== value) return invalid();
    delay = Math.max(0, Math.ceil((date.getTime() - now) / 1000));
  }
  return delay > MAX_SECOND - now / 1000 ? { retryAfterStatus: 'too-long', retryAfterSeconds: null }
    : { retryAfterStatus: 'valid', retryAfterSeconds: delay };
}

// headerValues reads this single field only. Repeated values never become a
// comma-joined date, and neither values nor arbitrary headers leave this module.
export function parseBrowserRetryAfterValues(values, now = Date.now()) {
  if (!Array.isArray(values) || values.length > 1) return invalid();
  return values.length ? parseBrowserRetryAfter(values[0], now)
    : { retryAfterStatus: 'absent', retryAfterSeconds: null };
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 && time <= MAX_SECOND * 1000 && new Date(time).toISOString() === value ? time : null;
}

// This grants only an operational wait. Business data keeps its original
// validator, error and coverage. Old envelopes with no hint remain identical.
export function browserRetryAfterPolicyInput(item, { key, startedAt, finishedAt, errorCode } = {}) {
  const hint = item?.retryAfter, start = instant(startedAt), finish = instant(finishedAt), observed = instant(hint?.observedAt);
  const status = hint?.httpStatus;
  const expected = status === 401 ? 'login_required' : status === 403 ? 'blocked' : status === 429 ? 'rate_limited' : 'network_error';
  const diagnostics = sanitizeBrowserWorksDiagnostics(item?.failureDiagnostics);
  if (!item || typeof key !== 'string' || !key || item.key !== key || !['ok', 'unavailable'].includes(item.status)
    || !Number.isInteger(status) || status < 400 || status > 599 || item.errorCode !== expected || errorCode !== expected
    || start === null || finish === null || start > finish || observed === null || observed < start || observed > finish
    || !diagnostics || diagnostics.navigation.observed !== true || diagnostics.navigation.committed !== true
    || diagnostics.stopReason !== 'http-rejection' || !(diagnostics.requests.matched > 0) || !(diagnostics.responses.matched > 0)
    || !diagnostics.httpStatuses.includes(status)) return {};
  if (hint.retryAfterStatus === 'too-long' && hint.retryAfterSeconds === null)
    return { retryAfterStatus: 'too-long', retryAfterSeconds: null };
  if (hint.retryAfterStatus !== 'valid' || !Number.isSafeInteger(hint.retryAfterSeconds) || hint.retryAfterSeconds < 0) return {};
  if (hint.retryAfterSeconds > MAX_SECOND - finish / 1000)
    return { retryAfterStatus: 'too-long', retryAfterSeconds: null };
  return { retryAfterStatus: 'valid', retryAfterSeconds: hint.retryAfterSeconds };
}
