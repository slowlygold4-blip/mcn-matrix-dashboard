import {sourceRosterMetric} from './tuantuan-roster.mjs';
import {rosterSortFields,rosterProfileMetric} from './tuantuan-roster-metrics.mjs';

const collator = new Intl.Collator('zh-CN', {numeric: true});

/** Order the same values that the table displays; unavailable metrics stay last. */
export function sortTuantuanRoster(rows, field = 'plays', direction = 'desc', context = {}) {
 if (!rosterSortFields.some(option=>option.key===field) || !['asc', 'desc'].includes(direction)) {
  throw Error('无效的团团名册排序');
 }
 const value = row => field === 'name'
  ? String(row.source?.name || row.accounts?.[0]?.label || '').trim() || null
  : field.includes('.') ? rosterProfileMetric(row,field,context) : sourceRosterMetric(row.source, field);
 // Read each displayed value once per row, not twice per comparison.
 return rows.map(row=>({row,value:value(row)})).sort((left, right) => {
  const a = left.value, b = right.value;
  const tie = () => String(left.row.key).localeCompare(String(right.row.key));
  if (a == null && b == null) return tie();
  if (a == null) return 1;
  if (b == null) return -1;
  const compared = field === 'name' ? collator.compare(a, b) : a - b;
  return compared * (direction === 'asc' ? 1 : -1) || tie();
 }).map(item=>item.row);
}

/** Reset on a changed view, and store the clamped page so old pages cannot return. */
export function resolveRosterPage(previous, scope, total, size = 30) {
 if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(size) || size <= 0) {
  throw Error('无效的团团名册分页');
 }
 const pages = Math.max(1, Math.ceil(total / size));
 const requested = previous?.scope === scope && Number.isSafeInteger(previous.page) ? previous.page : 1;
 const page = Math.min(pages, Math.max(1, requested));
 return {scope, page, pages, start: total ? (page - 1) * size + 1 : 0, end: Math.min(total, page * size)};
}
