const filters=new Set(['all','profile','works','unavailable','unobserved','limited']);
const text=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().trim();
const epoch=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;

export function coverageGapPriority(row){
 if(row.worksUnavailableRecent)return 0;
 if(!row.works.observedAt)return 1;
 if(row.works.status==='unavailable')return 2;
 if(row.works.status==='limited'&&!row.worksFresh)return 3;
 if(row.works.status==='limited')return 4;
 if(!row.worksComplete)return 5;
 return 6;
}

/** Page the entire applied catalog; evidence gaps are never a truncated top-N list. */
export function coverageGapView(rows,{filter='all',query='',page=1,pageSize=20}={}){
 if(!filters.has(filter)||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50)throw Error('无效的完整性筛选');
 const gaps=rows.filter(row=>!row.profileFresh||!row.worksComplete),q=text(query);
 const filtered=gaps.filter(row=>(filter==='all'
  ||filter==='profile'&&!row.profileFresh
  ||filter==='works'&&!row.worksComplete
  ||filter==='unavailable'&&row.worksUnavailableRecent
  ||filter==='unobserved'&&!row.works.observedAt
  ||filter==='limited'&&row.works.status==='limited')
  &&(!q||[row.label,row.id].some(value=>text(value).includes(q))));
 filtered.sort((a,b)=>coverageGapPriority(a)-coverageGapPriority(b)
  ||epoch(b.works.attemptedAt)-epoch(a.works.attemptedAt)||a.id-b.id);
 const pageCount=Math.max(1,Math.ceil(filtered.length/pageSize));
 const currentPage=Math.min(pageCount,Math.max(1,Number.isSafeInteger(page)?page:1));
 const offset=(currentPage-1)*pageSize;
 return {totalGaps:gaps.length,filteredCount:filtered.length,page:currentPage,pageCount,pageSize,
  from:filtered.length?offset+1:0,to:Math.min(offset+pageSize,filtered.length),rows:filtered.slice(offset,offset+pageSize)};
}
