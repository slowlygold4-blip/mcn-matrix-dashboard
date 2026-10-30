import { isCalendarDate } from './utils.mjs';

/** Real metric instants only. SQLite's legacy unzoned clocks are UTC, never
 * the host timezone; callers must explicitly opt into that storage format. */
export function metricInstant(value, { legacyUtc = false } = {}) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})([T ])(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match || !isCalendarDate(match[1]) || Number(match[3]) > 23
    || Number(match[4]) > 59 || Number(match[5]) > 59
    || !legacyUtc && (match[2] !== 'T' || !match[7])) return null;
  const normalized = `${match[1]}T${match[3]}:${match[4]}:${match[5]}${match[6] || ''}${match[7] || 'Z'}`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
