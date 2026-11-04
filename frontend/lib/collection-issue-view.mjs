import {safeRollingIssues} from './collection-issues.mjs';

export const collectionIssueNames={
 blocked:'作品接口拒绝访问（401/403）',rate_limited:'作品接口限流（429）',login_required:'作品采集需要登录授权',
 'transport-cooldown':'接口冷却中，作品请求暂缓（非本次请求失败）',network_error:'作品请求网络异常',business_error:'作品接口返回业务错误',
 upstream_changed:'作品响应格式变化',collector_error:'作品采集程序异常',unknown:'作品采集原因待核验',
 'page-obstruction':'页面出现遮挡或验证提示','no-bound-request':'页面未返回作品请求',deadline:'作品分页未完成','http-rejection':'作品接口拒绝请求',
};
const text=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().trim();
const validId=id=>Number.isSafeInteger(id)&&id>0;
const names=new Set(['all','missing','works']);

/** Producer membership only: the catalog supplies labels, never 8-hour status. */
export function collectionIssueSnapshot(status,accounts=[],topics=[]){
 let issues;
 try{issues=safeRollingIssues(status);}catch{return {state:'invalid',message:'问题名单与当前采集计数不一致，暂不能展示，请等待下一次上报。'};}
 if(!issues)return {state:'missing',message:'这次上报尚未包含问题名单；不能用其他时间窗口的名单代替。'};
 const accountMap=new Map(accounts.filter(row=>validId(row?.id)).map(row=>[row.id,row]));
 const topicMap=new Map(topics.filter(row=>validId(row?.id)).map(row=>[row.id,row]));
 const rows=new Map();
 const rowFor=(id,kind)=>{
  let row=rows.get(id);
  if(!row){
   const item=(kind==='account'?accountMap:topicMap).get(id);
   row={id,kind,label:typeof item?.label==='string'&&item.label.trim()?item.label.slice(0,200):`${kind==='account'?'账号':'话题'} #${id}`,
    platform:typeof item?.platform==='string'?item.platform:'unknown',profileMissing:false,topicMissing:false,workCode:null,catalogued:!!item};
   rows.set(id,row);
  }
  return row;
 };
 for(const id of issues.missingProfileTargetIds)rowFor(id,'account').profileMissing=true;
 for(const id of issues.missingTopicTargetIds)rowFor(id,'topic').topicMissing=true;
 for(const group of issues.workIssueGroups)for(const id of group.targetIds)rowFor(id,'account').workCode=group.code;
 const signature=JSON.stringify([issues.missingProfileTargetIds,issues.missingTopicTargetIds,issues.workIssueGroups]);
 return {state:'ready',since:issues.since,asOf:issues.asOf,signature,
  missingProfiles:issues.missingProfileTargetIds.length,missingTopics:issues.missingTopicTargetIds.length,
  missingTotal:issues.missingProfileTargetIds.length+issues.missingTopicTargetIds.length,
  workIssues:issues.workIssueGroups.reduce((sum,group)=>sum+group.targetIds.length,0),
  rows:[...rows.values()].sort((a,b)=>a.id-b.id),codes:issues.workIssueGroups.map(group=>group.code)};
}

/** A new heartbeat clock alone does not repeatedly interrupt an open list. */
export function collectionIssueRevision(status){
 const snapshot=collectionIssueSnapshot(status);
 return snapshot.state==='ready'?snapshot.signature:snapshot.state;
}

export function collectionIssueView(snapshot,{filter='missing',query='',page=1,pageSize=20}={}){
 if(!names.has(filter)&&!(filter.startsWith('reason:')&&Object.hasOwn(collectionIssueNames,filter.slice(7))))throw Error('无效的问题筛选');
 if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50)throw Error('无效的问题分页');
 const q=text(query);
 const filtered=(snapshot.rows??[]).filter(row=>(filter==='all'||filter==='missing'&&(row.profileMissing||row.topicMissing)
  ||filter==='works'&&row.workCode||filter.startsWith('reason:')&&row.workCode===filter.slice(7))
  &&(!q||[row.id,row.label].some(value=>text(value).includes(q))));
 const pageCount=Math.max(1,Math.ceil(filtered.length/pageSize));
 const currentPage=Math.min(pageCount,Math.max(1,Number.isSafeInteger(page)?page:1)),offset=(currentPage-1)*pageSize;
 return {rows:filtered.slice(offset,offset+pageSize),filteredCount:filtered.length,page:currentPage,pageCount,pageSize,
  from:filtered.length?offset+1:0,to:Math.min(offset+pageSize,filtered.length)};
}
