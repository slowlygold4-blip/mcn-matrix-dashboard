// UTC timestamps stay unchanged; display and calendar grouping use the server's business zone.
export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Shanghai';

export function resolveBusinessTimeZone(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: candidate.trim() });
      return candidate.trim();
    } catch { /* Try the next declared zone, never the browser's implicit default. */ }
  }
  return DEFAULT_BUSINESS_TIME_ZONE;
}

export function businessTimeZoneLabel(timeZone) {
  const zone = resolveBusinessTimeZone(timeZone);
  return zone === 'Asia/Shanghai' ? '北京时间（Asia/Shanghai）' : zone;
}

export function formatBusinessTimestamp(value, {
  timeZone, empty = '尚未更新', invalid = '时间无效', ...options
} = {}) {
  if (value === null || value === undefined || value === '') return empty;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return invalid;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...options, timeZone: resolveBusinessTimeZone(timeZone),
  }).format(date);
}

export function businessDateKey(value = new Date(), timeZone) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveBusinessTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
