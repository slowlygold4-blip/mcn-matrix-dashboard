import {filterTuantuanRoster} from './tuantuan-roster.mjs';

// A roster is the population. Availability of snapshots never removes an author.
export function allAuthorOverview(roster, metricRows=[], classification='all') {
 if(!roster)return null;
 const rows=filterTuantuanRoster(roster.rows,{classification});
 const byId=new Map(metricRows.map(row=>[row.id,row]));
 const comparable=(row,field)=>row.accounts.length>0&&row.accounts.every(account=>{
  const value=byId.get(account.id)?.metrics?.[field]?.delta;
  return typeof value==='number'&&Number.isFinite(value);
 });
 return {...roster,rows,fullCount:roster.counts.all,counts:{...roster.counts,all:rows.length},availability:{
  sourceOnly:rows.filter(row=>!row.accounts.length).length,
  followers:rows.filter(row=>comparable(row,'followers')).length,
  likes:rows.filter(row=>comparable(row,'likes')).length,
  posts:rows.filter(row=>comparable(row,'posts')).length,
 }};
}
