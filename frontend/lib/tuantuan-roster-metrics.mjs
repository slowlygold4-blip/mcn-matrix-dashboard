/** One metric contract for displayed cells, ranking and CSV. */
export const rosterSortFields = Object.freeze([
 ['plays','作品累计播放'],['likes','作品累计点赞'],['posts','已登记作品'],['name','作者名称'],
 ['followers.value','最新粉丝数'],['likes.value','最新主页获赞'],
 ['followers.delta','粉丝变化'],['likes.delta','主页获赞变化'],['posts.delta','作品存量变化'],
].map(([key,label])=>Object.freeze({key,label})));
export const isRosterCount = value => Number.isSafeInteger(value) && value >= 0;
export const isRosterChange = value => Number.isSafeInteger(value);

export function rosterProfileEntries(row, field) {
 const accounts = row.accounts ?? [];
 const entries = accounts.filter(account=>isRosterCount(account.latest?.[field]?.value))
  .map(account=>({accountId:account.id,label:account.label,value:account.latest[field].value,
   date:account.latest[field].date ?? null,source:false}));
 if(!entries.length && field==='followers' && isRosterCount(row.source?.followers)) {
  entries.push({accountId:null,label:null,value:row.source.followers,date:null,source:true});
 }
 return entries;
}

export function rosterChangeEntries(row, field, {metricById=new Map(),changesReady=false}={}) {
 return (row.accounts ?? []).map(account=>{
  const metric=changesReady?metricById.get(account.id)?.metrics?.[field]:null;
  return {accountId:account.id,label:account.label,value:isRosterChange(metric?.delta)?metric.delta:null,
   baseline:metric?.baseline ?? null,current:metric?.value ?? null};
 });
}

// Multiple associated targets remain separate observations. Rank by the
// largest displayed known value; never add them or manufacture a total.
export function rosterProfileMetric(row, field, context) {
 const [name,kind]=field.split('.');
 const entries=kind==='delta'?rosterChangeEntries(row,name,context):rosterProfileEntries(row,name);
 const values=entries.map(entry=>entry.value).filter(value=>value!==null);
 return values.length?Math.max(...values):null;
}

function exportedEntries(entries, key) {
 if(!entries.length)return null;
 if(entries.length===1)return entries[0][key] ?? null;
 return entries.map(entry=>`${entry.accountId}: ${entry[key] ?? '—'}`).join(' / ');
}

export function rosterProfileExport(row, context={}) {
 const followers=rosterProfileEntries(row,'followers'),likes=rosterProfileEntries(row,'likes');
 return [exportedEntries(followers,'value'),exportedEntries(followers,'date'),
  exportedEntries(likes,'value'),exportedEntries(likes,'date'),context.periodLabel || null,
  ...['followers','likes','posts'].map(field=>exportedEntries(rosterChangeEntries(row,field,context),'value')),
  context.changesReady===true?'已核对':'尚未核对',
  '主页值为最新已保存采样；变化按所选区间；多目标逐个保留，排名取最大已知值'];
}
