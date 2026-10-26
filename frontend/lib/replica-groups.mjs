import {aggregate,fields} from './replica-model.mjs';
/** Group the exact endpoint rows already used by the operating cards. No cumulative-counter subtraction. */
export function groupEndpointRows(rows,dimension='theme'){
 if(!['theme','content'].includes(dimension)||!Array.isArray(rows)||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('无效或重复的分类账号');
 const groups=new Map();
 for(const row of rows){
  if(row.enabled!==true)continue;
  const entries=dimension==='theme'?[row.classification.theme]:row.classification.labels;
  const seen=new Set();
  for(const entry of entries){
   if(typeof entry?.key!=='string'||!entry.key||typeof entry.label!=='string'||!entry.label)throw Error('分类缺少来源确认的名称');
   if(seen.has(entry.key))continue;seen.add(entry.key);
   let group=groups.get(entry.key);
   if(!group){group={key:entry.key,label:entry.label,rows:[]};groups.set(entry.key,group);}
   if(group.label!==entry.label)throw Error('同一分类名称冲突，未合并数据');
   group.rows.push(row);
  }
 }
 return [...groups.values()].map(g=>({key:g.key,label:g.label,count:g.rows.length,metrics:aggregate(g.rows)}));
}
export function orderEndpointGroups(groups,key='followers.delta',direction='desc'){
 if(!['asc','desc'].includes(direction)||!(key==='label'||key==='count'||fields.some(k=>key===k+'.value'||key===k+'.delta')))throw Error('无效分类排序');
 return [...groups].sort((a,b)=>{
  // Missing endpoint values remain last in either direction; zero and decreases are real values.
  const read=g=>key==='label'?g.label:key==='count'?g.count:g.metrics[key.split('.')[0]][key.split('.')[1]];
  const x=read(a),y=read(b);if(x===null||y===null)return x===null&&y===null?a.key.localeCompare(b.key):x===null?1:-1;
  return (typeof x==='number'?x-y:String(x).localeCompare(String(y),'zh-CN'))*(direction==='asc'?1:-1)||a.key.localeCompare(b.key);
 });
}
