import {isIndependentStreamer} from './matrix-scope.mjs';
import {rosterProfileExport} from './tuantuan-roster-metrics.mjs';
/** Join an imported author to a published account only through persisted target IDs. */
export function buildTuantuanRoster(authors, accounts, supplements=[], pending=[]) {
 if (![authors,accounts,supplements,pending].every(Array.isArray)) throw Error('团团名册输入无效');
 const allAuthors=[...authors,...supplements,...pending];
 // The public account catalog also carries thousands of source-only identity
 // rows. They are not collection targets and are represented by the sealed
 // source partitions, never by a second "paused monitor" account row.
 const themed = accounts.filter(account => account?.classification?.theme?.key === 'tuantuan'
  && !isIndependentStreamer(account) && account.platform === 'douyin' && Number.isSafeInteger(account.id) && account.sourceOnly !== true);
 const byId = new Map(themed.map(account => [account.id, account]));
 if (byId.size !== themed.length) throw Error('团团监控账号编号重复');
 const byTarget = new Map();
 for (const author of allAuthors) {
  if (!Array.isArray(author?.targetIds)) throw Error('团团来源作者缺少关联数组');
  for (const id of author.targetIds.filter(id => byId.has(id))) {
   const items=byTarget.get(id) ?? [];items.push(author);byTarget.set(id,items);
  }
 }
 const aliases = new Map(),merged = new Set();
 const identity = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
 for (const [id,items] of byTarget) {
  if (items.length !== 2 || items.some(item => item.targetIds.length !== 1 || item.targetIds[0] !== id)) continue;
  const base=items.find(item => Number.isInteger(item.row)),supplement=items.find(item => !Number.isInteger(item.row));
  if (!base || !supplement || merged.has(supplement) || !identity(base.name)
   || identity(base.name) !== identity(supplement.name)
   || identity(base.douyinId) === identity(supplement.douyinId)
   || ['posts','plays','likes','followers'].some(field => supplement[field] != null)) continue;
  aliases.set(base,supplement);merged.add(supplement);
 }
 const canonical=allAuthors.filter(author => !merged.has(author)).map(author => {
  const alias=aliases.get(author);
  return alias?{...author,douyinIds:[author.douyinId,alias.douyinId],
   sourceTitles:[...new Set([...(author.sourceTitles ?? []),...(alias.sourceTitles ?? [])])]}:author;
 });
 const seenAuthors = new Set(), seenRows = new Set(), linkedIds = new Set();
 const rows = canonical.map(author => {
  const douyinId = String(author?.douyinId ?? '').trim();
  const pendingKey = author?.sourceOnly === true && typeof author?.rowKey === 'string'
   && /^(?:(?:submitted|live-source):douyin:[a-f0-9]{64}|roster:[a-f0-9]{64})$/.test(author.rowKey) ? author.rowKey : '';
  if ((!douyinId && !pendingKey) || (douyinId && seenAuthors.has(douyinId))
   || !Array.isArray(author?.targetIds) || (pendingKey && (seenRows.has(pendingKey)
    || author.targetIds.length || !Array.isArray(author.sourceRows) || !author.sourceRows.length)))
   throw Error('团团来源作者身份重复或缺失');
  if (douyinId) seenAuthors.add(douyinId);
  if (pendingKey) seenRows.add(pendingKey);
  const linked = [...new Set(author.targetIds)].map(id => byId.get(id)).filter(Boolean);
  for (const account of linked) linkedIds.add(account.id);
  return { key: pendingKey ? `source-row:${pendingKey}` : `source:${douyinId}`, source: author, accounts: linked };
 });
 for (const account of themed) if (!linkedIds.has(account.id)) rows.push({ key: `account:${account.id}`, source: null, accounts: [account] });
 return {
  rows,
  counts: {
   all: rows.length,
   source: canonical.length,
   baseSource: authors.length,
   supplementSource: supplements.length,
   pendingSource: pending.length,
   reconciledAliases: merged.size,
   monitored: themed.length,
   monitoredEnabled: themed.filter(account => account.enabled).length,
   monitoredPaused: themed.filter(account => !account.enabled).length,
   linkedSource: canonical.filter(author => author.targetIds.some(id => byId.has(id))).length,
   linkedTargets: linkedIds.size,
   platformOnly: themed.length - linkedIds.size,
   sourceWithoutThemeLink: canonical.filter(author => !author.targetIds.some(id => byId.has(id))).length,
  },
 };
}

function rosterRowMode(row) {
 return row.accounts.some(account => account.enabled) ? 'monitored'
  : row.accounts.length ? 'paused' : 'source-only';
}

export function filterTuantuanRoster(rows, {query='', mode='all', classification='all'}={}) {
 const normalized = String(query).normalize('NFKC').toLocaleLowerCase().trim();
 const sourceField = {slice:'slicePosts',original:'creationPosts','ai-remix':'aiPosts'}[classification];
 return rows.filter(row => {
  const source = row.source, accounts = row.accounts;
  if (['monitored', 'paused', 'source-only'].includes(mode) && rosterRowMode(row) !== mode) return false;
  if (classification !== 'all') {
   const sourceMatches = sourceField && Number(source?.[sourceField]) > 0;
   const accountMatches = accounts.some(account => account.classification?.labels?.some(label => label.key === classification));
   if (!sourceMatches && !accountMatches) return false;
  }
  return !normalized || [source?.name,source?.douyinId,source?.submittedAccountId,...(source?.douyinIds ?? []),...accounts.map(account => account.label)].some(value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().includes(normalized));
 });
}

/** Count author rows, not linked targets; the three status ranges partition all. */
export function rosterModeCounts(rows, classification='all') {
 const filtered = filterTuantuanRoster(rows, {classification});
 const counts = {all: filtered.length, monitored: 0, paused: 0, 'source-only': 0};
 for (const row of filtered) counts[rosterRowMode(row)]++;
 return counts;
}

export function sourceRosterMetric(source, field) {
 if (!source || !Number.isSafeInteger(source[field]) || source[field] < 0) return null;
 if (field !== 'posts' && source.posts === 0 && source[field] === 0) return null;
 return source[field];
}

export function tuantuanRosterExport(rows, context={}) {
 if (!Array.isArray(rows)) throw Error('团团名册导出需要作者记录');
 return [
  ['作者','抖音号','监控状态','监控目标 ID','表格作品','表格累计播放','表格累计点赞','来源证据','数据口径',
   '最新粉丝数','粉丝采样日期','最新主页获赞','获赞采样日期','对比区间','粉丝变化','主页获赞变化','作品存量变化','区间核对状态','主页与排序口径'],
  ...rows.map(row => {
   const source=row.source,accounts=row.accounts ?? [];
   return [source?.name || accounts[0]?.label || '',source?.identifierStatus==='unusable'
    ? `待核验原号：${source.submittedAccountId}`
    : (source?.douyinIds ?? [source?.douyinId]).filter(Boolean).join(' / '),
    accounts.some(account=>account.enabled)?'启用主页监控':accounts.length?'监控暂停':'仅表格来源',
    accounts.map(account=>account.id).join(' / '),sourceRosterMetric(source,'posts'),
    sourceRosterMetric(source,'plays'),sourceRosterMetric(source,'likes'),
    Array.isArray(source?.sourceTitles)?source.sourceTitles.join(' / '):source?'团团作者总表':'仅监控名册',
    source?'表格累计值，非日新增；主页指标另见监控账号':'表格未登记；仅有主页监控名册',
    ...rosterProfileExport(row,context)];
  }),
 ];
}

/** The all-matrix view retains other themes without inventing source identities. */
export function includeOtherMatrixAccounts(roster,accounts){
 if(!roster)return null;
 const linked=new Set(roster.rows.flatMap(row=>row.accounts.map(account=>account.id)));
 const extras=accounts.filter(account=>!isIndependentStreamer(account)&&Number.isSafeInteger(account.id)&&account.sourceOnly!==true&&!linked.has(account.id));
 const unique=new Map(extras.map(account=>[account.id,account]));
 if(unique.size!==extras.length)throw Error('矩阵账号编号重复');
 return {...roster,rows:[...roster.rows,...extras.map(account=>({key:`account:${account.id}`,source:null,accounts:[account]}))],counts:{...roster.counts,all:roster.counts.all+extras.length,monitored:roster.counts.monitored+extras.length,monitoredEnabled:roster.counts.monitoredEnabled+extras.filter(account=>account.enabled).length,monitoredPaused:roster.counts.monitoredPaused+extras.filter(account=>!account.enabled).length,platformOnly:roster.counts.platformOnly+extras.length}};
}
