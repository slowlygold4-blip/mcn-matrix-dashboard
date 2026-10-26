import {belongsToSourceLinkage, belongsToSourceTrack, sameSourceDouyinId} from './source-ledger-track.mjs';
import {csv} from './replica-model.mjs';

const searchable = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();

export function sourceLedgerRowKey(row, view) {
  return JSON.stringify([row.sourceSupplement ? 'supplement' : 'table', view, view === 'authors' ? row.douyinId : row.contentId, row.row]);
}

/** A calendar date from the source table, never inferred from ingestion time. */
export function sourcePublicationDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function sourceDateRangeError(startDate = '', endDate = '') {
  if (startDate && !sourcePublicationDate(startDate) || endDate && !sourcePublicationDate(endDate)) return '请输入有效的作品发布日期。';
  if (startDate && endDate && startDate > endDate) return '开始日期不能晚于结束日期，请调整后查看。';
  return '';
}

export function belongsToSourceDateRange(row, startDate = '', endDate = '') {
  if (!startDate && !endDate) return true;
  if (sourceDateRangeError(startDate, endDate)) return false;
  const day = sourcePublicationDate(row.publishDate);
  return Boolean(day && (!startDate || day >= startDate) && (!endDate || day <= endDate));
}

/**
 * Filter the entire ledger before paging, so display and export share a result set.
 * @param {Record<string, any>[]} rows
 * @param {{view?:string, query?:string, track?:string, linkage?:string, startDate?:string, endDate?:string, authorIds?:string[], sort?:string, mainTableOnly?:boolean}} options
 */
export function filterSourceLedgerRows(rows, {view = 'works', query = '', track = 'all', linkage = 'all', startDate = '', endDate = '', authorIds = [], sort = 'plays', mainTableOnly = false} = {}) {
  const q = searchable(query).trim();
  return rows.filter(row => {
    const values = view === 'authors' ? [row.name, row.douyinId] : [row.author, row.douyinId, row.contentId, row.title];
    return (!q || values.some(value => searchable(value).includes(q)))
      && belongsToSourceTrack(row, track, view)
      && (view === 'authors' ? belongsToSourceLinkage(row, linkage)
        : (!mainTableOnly || !row.sourceSupplement) && (!authorIds.length || authorIds.some(id => sameSourceDouyinId(row, id))) && belongsToSourceDateRange(row, startDate, endDate));
  }).sort((a, b) => {
    if (sort === 'row') return a.row - b.row;
    const left = a[sort], right = b[sort];
    return left == null && right == null ? a.row - b.row : left == null ? 1 : right == null ? -1 : Number(right) - Number(left) || a.row - b.row;
  });
}

/** Only public fields; identifiers stay strings, missing values stay blank, and csv escapes formula text. */
export function sourceLedgerCsv(rows, view = 'works', {revision = '', importedAt = ''} = {}) {
  const provenance = row => [row.sourceSupplement ? '补充登记表' : '总表', (row.sourceTitles ?? []).join(' / '), String(revision), importedAt];
  const context = ['记录来源', '来源表名称', '总表修订', '总表入库时间（非发布日期）'];
  const headers = view === 'authors'
    ? ['作者', '抖音号', '表格作品数', '切片作品数', '创作作品数', '即梦作品数', '小团团杯作品数', '表格累计播放（非日增长）', '表格累计点赞（非日增长）', '已关联监控目标 ID', ...context]
    : ['作品 ID', '作品标题', '作者', '抖音号', '发布日期（原表）', '原表分类', '赛道', '全部赛道', '表格累计播放（非日增长）', '表格累计点赞（非日增长）', '作品链接', ...context];
  return csv([headers, ...rows.map(row => view === 'authors'
    ? [row.name, String(row.douyinId ?? ''), row.posts, row.slicePosts, row.creationPosts, row.aiPosts, row.cupPosts, row.plays, row.likes, (row.targetIds ?? []).join(' / '), ...provenance(row)]
    : [String(row.contentId ?? ''), row.title, row.author, String(row.douyinId ?? ''), row.publishDate, row.type, row.track, row.tracks, row.plays, row.likes, row.url, ...provenance(row)])]);
}
