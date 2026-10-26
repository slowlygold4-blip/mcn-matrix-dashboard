import {matchesMatrixScope} from './matrix-scope.mjs';
const primaryKeys = ['slice', 'original', 'ai-remix'];

/** Presentation only: preserve every exact source key/label and account membership. */
export function classificationMenu(accounts, {board='all', theme='all', selected='all'}={}) {
 if (!Array.isArray(accounts) || [board,theme,selected].some(value=>typeof value!=='string'||!value||value.length>200||/[\u0000-\u001f\u007f]/.test(value))) throw Error('内容分类筛选无效');
 const ids=new Set(), globalLabels=new Map(), groups=new Map(), scope={total:0,enabled:0,paused:0};
 for(const account of accounts) {
  if(!Number.isSafeInteger(account?.id)||account.id<1||ids.has(account.id)||typeof account.enabled!=='boolean'
   ||!Array.isArray(account.boardKeys)||!Array.isArray(account.classification?.labels)||typeof account.classification?.theme?.key!=='string') throw Error('分类名册无效或账号重复');
  ids.add(account.id);
  const matches=matchesMatrixScope(account,{board,theme});
  if(matches){scope.total++;scope[account.enabled?'enabled':'paused']++;}
  const seen=new Set();
  for(const label of account.classification.labels) {
   if(typeof label?.key!=='string'||!label.key||typeof label.label!=='string'||!label.label) throw Error('分类缺少来源确认的名称');
   if(globalLabels.has(label.key)&&globalLabels.get(label.key)!==label.label) throw Error('同一分类名称冲突，未合并数据');
   globalLabels.set(label.key,label.label);
   if(!matches||seen.has(label.key))continue;
   seen.add(label.key);
   if(!groups.has(label.key))groups.set(label.key,{key:label.key,label:label.label,total:0,enabled:0,paused:0});
   const group=groups.get(label.key);group.total++;group[account.enabled?'enabled':'paused']++;
  }
 }
 if(selected!=='all'&&!globalLabels.has(selected))throw Error('链接中的内容分类不存在，请返回账号列表重新选择');
 const primary=primaryKeys.filter(key=>groups.has(key)).map(key=>groups.get(key));
 const source=[...groups.values()].filter(group=>!primaryKeys.includes(group.key))
  .sort((a,b)=>a.label.localeCompare(b.label,'zh-CN')||(a.key<b.key?-1:a.key>b.key?1:0));
 const retainedSelected=selected!=='all'&&!groups.has(selected)
  ?{key:selected,label:globalLabels.get(selected),total:0,enabled:0,paused:0,outsideScope:true}:null;
 return {primary,source,retainedSelected,scope};
}
