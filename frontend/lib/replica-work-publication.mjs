import { validDate } from './replica-model.mjs';
import {publicationDateBasisLabel} from './publication-date-basis.mjs';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const SOURCE_DATE_BASIS = 'creator-source-date-only';

function savedTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString() === value ? Date.parse(value) : null;
}

function sourceDay(work) {
  return [SOURCE_DATE_BASIS,'source-explicit-date','source-inferred-date','source-date-conflict','unverified-date'].includes(work?.publicationDateBasis) && validDate(work?.publishedOn)
    ? work.publishedOn : null;
}

function platformTimestamp(work) {
  return work?.publicationDateBasis === undefined || work?.publicationDateBasis === null
    || work.publicationDateBasis === 'platform-timestamp'
    ? savedTimestamp(work?.publishedAt) : null;
}

/** A source-table day has day precision only; it must not become midnight playback data. */
export function workPublicationDay(work) {
  const timestamp = platformTimestamp(work);
  if (timestamp !== null) return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
  return sourceDay(work);
}
export function workPublicationDateConfirmed(work){
 return platformTimestamp(work)!==null||work?.publicationDateBasis==='source-explicit-date'&&sourceDay(work)!==null;
}

export function workPublicationDisplay(work) {
  const timestamp = platformTimestamp(work);
  if (timestamp !== null) return {
    value: new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    note: '已保存发布时间',
  };
  const day = sourceDay(work);
  if (day) return { value: day, note:publicationDateBasisLabel(work.publicationDateBasis===SOURCE_DATE_BASIS?'unverified-date':work.publicationDateBasis) };
  return { value: '—', note: '未记录可靠作品日期' };
}

function stableId(left, right) {
  return String(left.id).localeCompare(String(right.id), 'zh-CN', { numeric: true });
}

/** Missing dates remain last in both directions; same-day table dates have no fabricated hour. */
export function compareWorkPublication(left, right, direction = 'desc') {
  const a = workPublicationDay(left), b = workPublicationDay(right);
  if (a === null || b === null) return a === null && b === null ? stableId(left, right) : a === null ? 1 : -1;
  const order = direction === 'asc' ? 1 : -1;
  if (a !== b) return a.localeCompare(b) * order;
  const aTime = platformTimestamp(left), bTime = platformTimestamp(right);
  if (aTime !== null && bTime !== null && aTime !== bTime) return (aTime - bTime) * order;
  return stableId(left, right);
}
