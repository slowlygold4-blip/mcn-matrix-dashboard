import {parseAccountRequest} from './replica-account.mjs';
import {validDate} from './replica-model.mjs';
import {periodNames} from './replica-periods.mjs';
import {preserveSourceSelection} from './source-ledger-navigation.mjs';
import {preserveRosterSelection} from './tuantuan-roster-navigation.mjs';

const tabs = ['overview', 'accounts', 'source', 'topics'];
export const workspaceSortLabels={'label':'作者','followers.value':'粉丝','followers.delta':'粉丝变化','likes.value':'点赞','likes.delta':'点赞变化','posts.value':'作品存量','posts.delta':'作品变化'};
const listDefaults={sort:'followers.delta',order:'desc',query:'',rosterStatus:'enabled'};
function checkList(list){
 if(!list||typeof list.sort!=='string'||!Object.hasOwn(workspaceSortLabels,list.sort)||!['asc','desc'].includes(list.order)
  ||!['enabled','paused','all'].includes(list.rosterStatus)||typeof list.query!=='string'||list.query.length>200||/[\u0000-\u001f\u007f]/.test(list.query))throw Error('矩阵链接的搜索、账号状态或排序无效');
 return list;
}
/** List state never changes the cohort used by operating cards. */
export function workspaceListSelection(search){
 const p=new URLSearchParams(search);if(p.has('account'))return null;
 for(const key of Object.keys(listDefaults))if(p.getAll(key).length>1)throw Error('矩阵链接包含重复列表参数');
 return checkList(Object.fromEntries(Object.entries(listDefaults).map(([key,value])=>[key,p.get(key)??value])));
}

/** Optional B dates are one pair. Legacy A-only links keep their exact shape. */
export function workspaceComparisonSelection(search){
 const p=new URLSearchParams(search);
 const idle={compare:false,otherStart:'',otherEnd:''};
 if(p.has('account'))return idle;
 for(const key of ['compareStart','compareEnd'])if(p.getAll(key).length>1)throw Error('矩阵链接包含重复比较日期');
 const start=p.get('compareStart'),end=p.get('compareEnd');
 if(start===null&&end===null)return idle;
 if(start===null||end===null||!validDate(start)||!validDate(end)||start>end)throw Error('比较区间日期不完整或无效，请选择两个有序日期');
 return {compare:true,otherStart:start,otherEnd:end};
}

/** The address owns the view; account links keep their validated fixed version. */
export function workspaceNavigation(search, hash) {
 const params=new URLSearchParams(search);
 const personal = params.has('account')||params.has('generation')?parseAccountRequest(search):null;
 if(!personal){workspaceSelection(search);workspaceListSelection(search);}
 const tab = personal ? 'accounts' : tabs.includes(hash.slice(1)) ? hash.slice(1) : 'overview';
 return {tab, personal, loadView: personal ? 'account' : tab === 'topics' ? 'topics' : tab === 'source' ? 'source' : 'global'};
}

export function workspacePath(pathname, tab, search='') {
 if (!tabs.includes(tab) || typeof pathname !== 'string' || !pathname.startsWith('/')
  || pathname.startsWith('//') || /[?#\r\n]/.test(pathname)) throw Error('页面地址无效');
 if(new URLSearchParams(search).has('account'))return pathname+'#'+tab;
 return preserveRosterSelection(preserveSourceSelection(workspaceSelectionPath(pathname,tab,workspaceSelection(search),workspaceListSelection(search),workspaceComparisonSelection(search)),search),search);
}

/** Global saved-view links are not account identity links. Never repair malformed dates silently. */
export function workspaceSelection(search){
 const p=new URLSearchParams(search),keys=['board','theme','classification','period','start','end'];
 if(p.has('account'))return null;
 workspaceComparisonSelection(search);
 if(!keys.some(k=>p.has(k)))return null;
 for(const k of keys)if(p.getAll(k).length>1)throw Error('矩阵链接包含重复筛选参数');
 const period=p.get('period')||'since',start=p.get('start'),end=p.get('end');
 if(!Object.hasOwn(periodNames,period))throw Error('矩阵链接统计周期无效');
 if((start===null)!==(end===null)||start!==null&&(!validDate(start)||!validDate(end)||start>end)
  ||period==='custom'&&start===null)throw Error('矩阵链接日期不完整或无效，请选择两个有序日期');
 const selection={board:p.get('board')??'all',theme:p.get('theme')??'all',tag:p.get('classification')??'all',period,start,end};
 for(const k of ['board','theme','tag'])if(!selection[k]||selection[k].length>200||/[\u0000-\u001f\u007f]/.test(selection[k]))throw Error('矩阵链接筛选无效');
 return selection;
}
export function workspaceSelectionScope(selection,accounts,boards){
 if(!selection)return accounts.filter(a=>a.enabled);
 if(selection.board!=='all'&&!boards.some(b=>b.key===selection.board)
  ||selection.theme!=='all'&&!accounts.some(a=>a.classification.theme.key===selection.theme)
  ||selection.tag!=='all'&&!accounts.some(a=>a.classification.labels.some(x=>x.key===selection.tag)))throw Error('链接中的矩阵或分类不存在，请返回账号列表重新选择');
 return accounts.filter(a=>a.enabled&&(selection.board==='all'||a.boardKeys.includes(selection.board))
  &&(selection.theme==='all'||a.classification.theme.key===selection.theme)
  &&(selection.tag==='all'||a.classification.labels.some(x=>x.key===selection.tag)));
}
export function workspaceSelectionPath(pathname,tab,selection,list,comparison){
 if(!tabs.includes(tab)||!pathname.startsWith('/')||pathname.startsWith('//')||/[?#\r\n]/.test(pathname))throw Error('页面地址无效');
 const p=new URLSearchParams();if(selection){for(const [key,value] of [['board',selection.board],['theme',selection.theme],['classification',selection.tag]])if(value!=='all')p.set(key,value);
 p.set('period',selection.period);if(selection.start!==null){p.set('start',selection.start);p.set('end',selection.end);}}
 if(list!==undefined){checkList(list);for(const [key,value] of Object.entries(listDefaults))if(list[key]!==value)p.set(key,list[key]);}
 if(comparison!==undefined){
  if(!comparison||typeof comparison.compare!=='boolean')throw Error('比较状态无效');
  if(comparison.compare){p.set('compareStart',comparison.otherStart);p.set('compareEnd',comparison.otherEnd);workspaceComparisonSelection('?'+p);}
 }
 workspaceSelection('?'+p);workspaceListSelection('?'+p);return pathname+(p.size?'?'+p:'')+'#'+tab;
}

/** Reuse already verified bytes, but never reuse another account publication. */
export function navigationNeedsLoad(route, data) {
 if (!data) return true;
 if (route.personal) return !route.personal.generation || route.personal.generation !== data.manifest?.asOf;
 if (route.tab==='topics' && data.topicsLoaded===false) return true;
 return !['topics','source'].includes(route.tab) && !data.summaryLoaded;
}
