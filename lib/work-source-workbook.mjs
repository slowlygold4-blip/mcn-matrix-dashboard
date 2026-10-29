/** Read source work facts without inventing author identity or sample dates. */
import * as XLSX from '@e965/xlsx';
import { createHash } from 'node:crypto';
import { sheetJsVisibleText, officialDouyinVideoIds, officialDouyinWorkUrls } from './author-spreadsheet.mjs';

const key = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_（）()]/g, '');
const aliases = {
  contentId: ['视频id', '作品id', '内容id', 'awemeid'],
  authorName: ['作者昵称', '作者名', '抖音名', '抖音名称'],
  accountId: ['作者抖音号', '抖音号', '抖音id'],
  uid: ['作者id', '作者uid'],
  title: ['视频标题', '作品标题', '标题'],
  url: ['视频链接', '作品链接'],
  plays: ['视频累计播放次数', '播放', '播放量'],
  likes: ['视频累计获赞次数', '当天累积点赞数端显值', '点赞', '点赞数'],
  publishedOn: ['发布时间', '发布日期', '作品日期'],
  metricDate: ['采样日期', '统计日期', '数据日期'],
};
const names = new Map(Object.entries(aliases).flatMap(([field, values]) => values.map(value => [key(value), field])));
const missing = value => value == null || ['', '-', '—', '–'].includes(String(value).trim());
const idPattern = /^[1-9]\d{14,24}$/;
const evidenceLinkKey = value => {
  try {
    const url = new URL(String(value ?? '').trim());
    if (url.protocol !== 'https:' || url.username || url.password
      || !['www.douyin.com', 'douyin.com', 'v.douyin.com', 'www.iesdouyin.com'].includes(url.hostname)) return null;
    if (!officialDouyinWorkUrls(String(value)).includes(url.toString())) return null;
    if (url.hostname === 'v.douyin.com') url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch { return null; }
};

export function sourceCounter(value) {
  if (missing(value)) return { value: null, representation: 'missing' };
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid-counter');
    return { value, representation: 'integer' };
  }
  if (typeof value !== 'string') throw new Error('invalid-counter');
  const raw = value.normalize('NFKC').trim();
  const match = raw.match(/^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?\s*(万|亿|[wW])?$/);
  if (!match) throw new Error('invalid-counter');
  const decimals = match[2] || '';
  if (decimals.length > 12) throw new Error('invalid-counter');
  const numerator = BigInt(match[1].replaceAll(',', '') + decimals);
  const denominator = 10n ** BigInt(decimals.length);
  const factor = match[3] === '亿' ? 100000000n : match[3] ? 10000n : 1n;
  if (numerator * factor % denominator !== 0n) throw new Error('fractional-counter');
  const count = numerator * factor / denominator;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('unsafe-counter');
  return { value: Number(count), representation: match[3] ? 'unit-display' : 'integer' };
}

function identity(cell, kind) {
  if (!cell || missing(cell.v)) return null;
  if (cell.t === 'n' && !Number.isSafeInteger(cell.v)) throw new Error('unsafe-numeric-identity');
  const value = String(sheetJsVisibleText(cell)).normalize('NFKC').trim();
  if (kind === 'contentId' && !idPattern.test(value)) throw new Error('invalid-content-id');
  return value;
}

function sourceUrl(cell) {
  const values = [...new Set([sheetJsVisibleText(cell), cell?.l?.Target].map(value => String(value ?? '').trim()).filter(Boolean))];
  if (!values.length) return null;
  const urls = [], ids = new Set();
  for (const value of values) {
    if (value.length > 1000) throw new Error('oversized-work-link-evidence');
    const candidates = officialDouyinWorkUrls(value);
    if (!candidates.length) throw new Error('invalid-work-url');
    for (const candidate of candidates) {
      const url = new URL(candidate), directIds = officialDouyinVideoIds(candidate);
      if (!directIds.length && !(url.hostname === 'v.douyin.com' && /^\/[\w-]+\/?$/.test(url.pathname))) throw new Error('invalid-work-url');
      for (const id of directIds) ids.add(id);
      urls.push(candidate);
    }
  }
  if (ids.size > 1) throw new Error('conflicting-work-identities');
  if (!ids.size && new Set(urls.map(evidenceLinkKey)).size > 1) throw new Error('ambiguous-work-links');
  return { url: urls[0], urls: [...new Set(urls)], contentId: [...ids][0] || null };
}

function calendar(value) {
  if (missing(value)) return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('invalid-source-date');
  const time = Date.parse(raw + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== raw) throw new Error('invalid-source-date');
  return raw;
}

function header(sheet) {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  for (let r = range.s.r; r <= Math.min(range.e.r, 24); r++) {
    const fields = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const field = names.get(key(sheetJsVisibleText(sheet[XLSX.utils.encode_cell({ r, c })])));
      if (!field) continue;
      if (Object.hasOwn(fields, field)) throw new Error('ambiguous-source-header');
      fields[field] = c;
    }
    if ((fields.contentId !== undefined || fields.url !== undefined)
      && (fields.plays !== undefined || fields.likes !== undefined)) return { row: r, fields, range };
  }
  return null;
}

/** Source workbook edition is not the measurement time of all its counters.
 * An explicit measurement-date column is the only daily observation here.
 * Rejected rows retain physical locations and machine-readable reasons.
 */
export function readWorkSourceWorkbook(buffer, { maxRows = 100000, maxColumns = 64 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('empty-workbook');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: false, cellHTML: false,
    cellDates: false, cellText: true, dense: false, nodim: true });
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 100) throw new Error('invalid-workbook-sheet-count');
  const facts = [], rejected = [], sheets = [];
  let populatedRows = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name], range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.r + 1 > maxRows || range.e.c + 1 > maxColumns) throw new Error('workbook-range-exceeds-policy');
    const columns = header(sheet);
    const result = { name, status: columns ? 'work-facts' : 'unsupported-layout',
      headerRow: columns ? columns.row + 1 : null, facts: 0, rejected: 0, populatedRows: 0 };
    for (let r = columns ? columns.row + 1 : range.s.r; r <= range.e.r; r++) {
      const cells = Array.from({ length: range.e.c + 1 }, (_, c) => sheet[XLSX.utils.encode_cell({ r, c })]);
      if (!cells.some(cell => !missing(sheetJsVisibleText(cell)))) continue;
      populatedRows++; result.populatedRows++;
      if (populatedRows > maxRows) throw new Error('workbook-rows-exceed-policy');
      if (!columns) continue;
      const cell = field => columns.fields[field] === undefined ? undefined : cells[columns.fields[field]];
      const origin = { sheet: name, row: r + 1 };
      try {
        const explicitId = identity(cell('contentId'), 'contentId');
        const linked = cell('url') ? sourceUrl(cell('url')) : null;
        if (explicitId && linked?.contentId && explicitId !== linked.contentId) throw new Error('conflicting-work-identities');
        const contentId = explicitId || linked?.contentId || null;
        if (!contentId && !linked) throw new Error('missing-work-identity');
        const metric = field => cell(field)?.t === 'n' ? cell(field).v : sheetJsVisibleText(cell(field));
        const metricIssues = [], rawMetricValues = {};
        const counter = field => {
          const raw = metric(field);
          try { return sourceCounter(raw); }
          catch (error) {
            metricIssues.push({ field, reason: ['invalid-counter','fractional-counter','unsafe-counter'].includes(error.message)
              ? error.message : 'source-cell-unreadable' });
            rawMetricValues[field] = raw;
            return { value: null, representation: 'invalid' };
          }
        };
        const counts = { plays: counter('plays'), likes: counter('likes') };
        // A precise video ID can still retain its counters when a separate
        // submitted author ID was saved as an unsafe Excel number. Do not
        // round that author ID, or discard the otherwise usable work record.
        const identityIssues = [];
        const authorIdentity = field => {
          try { return identity(cell(field), field); }
          catch (error) {
            if (error.message !== 'unsafe-numeric-identity') throw error;
            identityIssues.push({ field, reason: error.message }); return null;
          }
        };
        facts.push({ ...origin, contentId, url: linked?.url || null, evidenceUrls: linked?.urls || [],
          authorName: String(sheetJsVisibleText(cell('authorName'))).trim(),
          accountId: authorIdentity('accountId'), uid: authorIdentity('uid'), identityIssues,
          title: String(sheetJsVisibleText(cell('title'))).trim(),
          plays: counts.plays.value, likes: counts.likes.value,
          metricIssues, rawMetricValues,
          representation: { plays: counts.plays.representation, likes: counts.likes.representation },
          publishedOn: calendar(sheetJsVisibleText(cell('publishedOn'))),
          metricDate: calendar(sheetJsVisibleText(cell('metricDate'))),
          rowSha256: createHash('sha256').update(JSON.stringify(cells.map(c => [c?.t ?? null, c?.v ?? null, c?.r ?? null, c?.l?.Target ?? null]))).digest('hex') });
        result.facts++;
      } catch (error) {
        const reason = ['invalid-counter','fractional-counter','unsafe-counter','unsafe-numeric-identity',
          'invalid-content-id','invalid-work-url','invalid-source-date','conflicting-work-identities','missing-work-identity',
          'oversized-work-link-evidence','ambiguous-work-links'].includes(error.message)
          ? error.message : 'source-cell-unreadable';
        rejected.push({ ...origin, reason }); result.rejected++;
      }
    }
    sheets.push(result);
  }
  return { sourceSha256: createHash('sha256').update(buffer).digest('hex'), facts, rejected, sheets,
    summary: { parsedFacts: facts.length, rejectedRows: rejected.length, populatedRows,
      uniqueContentIds: new Set(facts.map(f => f.contentId).filter(Boolean)).size,
      unresolvedLinks: facts.filter(f => !f.contentId).length,
      rowsWithIdentityIssues: facts.filter(f => f.identityIssues.length).length,
      rowsWithMetricIssues: facts.filter(f => f.metricIssues.length).length,
      datedMeasurements: facts.filter(f => f.metricDate).length } };
}

/** Reuse explicit URL + video-ID pairs from preserved source rows. This
 * resolves a work reference only, never an author's sec_uid or ownership.
 * Every returned binding carries the exact immutable source-row checksum.
 */
export function bindWorkFactsToStoredSourceIds(facts, storedLinks, canonicalIds) {
  const index = new Map();
  for (const link of storedLinks) {
    const key = evidenceLinkKey(link.url), proof = link.provenance;
    if (!key || typeof link.contentId !== 'string' || !idPattern.test(link.contentId)
      || !canonicalIds.has(link.contentId) || !Number.isSafeInteger(proof?.importId) || proof.importId < 1
      || !['10', '13'].includes(proof.sheetId) || !Number.isSafeInteger(proof.row) || proof.row < 2
      || !/^[a-f0-9]{64}$/.test(proof.rowSha256 ?? '')) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(link);
  }
  let bound = 0, conflicts = 0;
  const rows = facts.map(fact => {
    const links = fact.evidenceUrls || (fact.url ? [fact.url] : []);
    const candidates = links.flatMap(url => index.get(evidenceLinkKey(url)) || []);
    const ids = new Set(candidates.map(row => row.contentId));
    if (ids.size > 1 || fact.contentId && ids.size === 1 && !ids.has(fact.contentId)) {
      conflicts++;
      return { ...fact, bindingIssues: ['stored-source-link-id-conflict'],
        bindingCandidates: candidates.map(row => ({ contentId: row.contentId, provenance: row.provenance })) };
    }
    if (fact.contentId || ids.size !== 1) return fact;
    bound++;
    return { ...fact, contentId: candidates[0].contentId,
      contentIdEvidence: { kind: 'stored-source-explicit-link-id', provenance: candidates[0].provenance },
      authorIdentityVerified: false };
  });
  return { facts: rows, summary: { newlyBoundWorkReferences: bound, conflicts,
    unresolvedLinks: rows.filter(row => !row.contentId).length, networkRequests: 0 } };
}

/** A1 + A1 remains A1. Source candidates are evidence, never additive metrics. */
export function reconcileWorkSourceFacts(facts, canonicalWorks) {
  for (const row of canonicalWorks) {
    if (typeof row.contentId !== 'string' || !idPattern.test(row.contentId) || ['plays', 'likes'].some(field =>
      row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 0))) throw new Error('invalid-canonical-work');
  }
  const current = new Map(canonicalWorks.map(row => [String(row.contentId), row]));
  if (current.size !== canonicalWorks.length) throw new Error('canonical-work-ids-not-unique');
  const byId = new Map();
  for (const fact of facts) {
    if (!fact.contentId || fact.bindingIssues?.length) continue;
    if (typeof fact.contentId !== 'string' || !idPattern.test(fact.contentId) || ['plays', 'likes'].some(field =>
      fact[field] != null && (!Number.isSafeInteger(fact[field]) || fact[field] < 0))) throw new Error('invalid-source-fact');
    if (!byId.has(fact.contentId)) byId.set(fact.contentId, []);
    byId.get(fact.contentId).push(fact);
  }
  const works = [];
  for (const [contentId, origins] of byId) {
    const existing = current.get(contentId);
    const metrics = {};
    for (const field of ['plays', 'likes']) {
      const values = [...new Set(origins.map(row => row[field]).filter(v => v != null))].sort((a, b) => a - b);
      const previous = existing?.[field] ?? null;
      metrics[field] = { previous, sourceValues: values,
        status: !values.length ? 'missing' : values.length > 1 ? 'multiple-source-values'
          : previous == null ? 'available-source-value' : previous === values[0] ? 'same' : 'different-source-value' };
    }
    works.push({ contentId, status: existing ? 'existing-work' : 'new-work', originCount: origins.length,
      metrics, publicationDates: [...new Set(origins.map(row => row.publishedOn).filter(Boolean))],
      measurementDates: [...new Set(origins.map(row => row.metricDate).filter(Boolean))] });
  }
  return { works, summary: { sourceFacts: facts.length, uniqueWorks: works.length,
    existingWorks: works.filter(row => row.status === 'existing-work').length,
    newWorks: works.filter(row => row.status === 'new-work').length,
    repeatedWorkFacts: [...byId.values()].reduce((sum, rows) => sum + rows.length - 1, 0),
    unresolvedLinks: facts.filter(row => !row.contentId).length,
    bindingConflicts: facts.filter(row => row.bindingIssues?.length).length,
    writes: 0, dailyGrowthCalculated: false } };
}
