import { isCalendarDate } from './utils.mjs';

const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
export const PUBLIC_SOURCE_WORK_FIELDS = Object.freeze(['source','sourceCumulativePlays','sourceCumulativeLikes',
  'sourceRefreshedAt','sourcePublishedOn','sourceImportId','sourceRevision','sourceRow']);
const time = (value, asOf) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && isCalendarDate(value.slice(0,10)) && Number.isFinite(Date.parse(value))
  && Date.parse(value) <= Date.parse(asOf) ? new Date(value).toISOString() : null;

/** Public, scalar-only projection of a work already strictly merged by
 * account-history. Never forward private source URLs, references or raw proof.
 * A source refresh time is not a platform observation time.
 */
export function publicSourceWorkFields(work, asOf) {
  if (!['creator-source', 'platform-and-creator-source'].includes(work?.source)) return {};
  const provenance = work.provenance ?? {};
  const revision = String(provenance.revision ?? '');
  return {
    source: work.source,
    sourceCumulativePlays: counter(work.sourceCumulativePlays),
    sourceCumulativeLikes: counter(work.sourceCumulativeLikes),
    sourceRefreshedAt: time(work.sourceRefreshedAt, asOf),
    sourcePublishedOn: isCalendarDate(work.sourcePublishedOn) ? work.sourcePublishedOn : null,
    sourceImportId: positive(provenance.importId),
    sourceRevision: /^[\w.-]{1,100}$/.test(revision) ? revision : null,
    sourceRow: positive(provenance.row),
  };
}

/** Validate optional enriched fields before sealing a public generation. */
export function publicSourceWorkFieldsValid(work, asOf) {
  if (!PUBLIC_SOURCE_WORK_FIELDS.some(key => work[key] != null)) return true;
  if (!['creator-source','platform-and-creator-source'].includes(work.source)) return false;
  if (!/^\d{15,25}$/.test(work.externalId ?? '')) return false;
  for (const key of ['sourceCumulativePlays','sourceCumulativeLikes'])
    if (work[key] != null && counter(work[key]) === null) return false;
  if (work.sourceRefreshedAt != null && time(work.sourceRefreshedAt,asOf) !== work.sourceRefreshedAt) return false;
  if (work.sourcePublishedOn != null && !isCalendarDate(work.sourcePublishedOn)) return false;
  for (const key of ['sourceImportId','sourceRow']) if (work[key] != null && positive(work[key]) === null) return false;
  if (work.sourceRevision != null && (typeof work.sourceRevision !== 'string' || !/^[\w.-]{1,100}$/.test(work.sourceRevision))) return false;
  const synthetic = typeof work.id === 'string' && /^creator-source:[1-9]\d*:[1-9]\d*$/.test(work.id);
  return work.source === 'creator-source' ? synthetic : Number.isSafeInteger(work.id) && work.id > 0;
}
