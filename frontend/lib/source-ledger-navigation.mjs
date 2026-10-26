import {sourcePublicationDate} from './source-ledger-filters.mjs';

const fields = {view:'sourceView',query:'sourceQuery',track:'sourceTrack',linkage:'sourceLinkage',sort:'sourceSort',page:'sourcePage',startDate:'sourceStart',endDate:'sourceEnd',mainTableOnly:'sourceMainOnly'};
const known = new Set([...Object.values(fields),'sourceAuthor','sourceAuthorName','sourceAuthorIds','sourceReturn']);
export const sourceLedgerDefaults = Object.freeze({view:'authors',query:'',track:'all',linkage:'all',sort:'plays',page:1,startDate:'',endDate:'',mainTableOnly:false,authorFocus:null,returnSelection:null});

function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw Error(`来源列表链接的${label}无效。`);
  return value;
}

/** Reject malformed source state, while allowing one open-ended date and showing reversed ranges in the date controls. */
export function sourceLedgerSelection(search, allowReturn = true) {
  const params = new URLSearchParams(search), result = {...sourceLedgerDefaults};
  const owned = new URLSearchParams([...params].filter(([key])=>key.startsWith('source')));
  if(owned.toString().length>10000)throw Error('来源列表链接过长，请缩短搜索内容或作者范围后再试。');
  for (const key of params.keys()) if (key.startsWith('source')) {
    if (!known.has(key)) throw Error(`来源列表链接含有不支持的参数：${key.slice(0,40)}。`);
    if (params.getAll(key).length !== 1) throw Error(`来源列表链接含有重复参数：${key}。`);
  }
  for (const [field, key] of Object.entries(fields)) if (params.has(key)) result[field] = params.get(key);
  if (!['authors','works'].includes(result.view)) throw Error('来源列表链接的类型无效，请选择作者或作品。');
  if (!['all','linked','sourceOnly'].includes(result.linkage)) throw Error('来源列表链接的采样关联条件无效。');
  if (!['plays','likes','row'].includes(result.sort)) throw Error('来源列表链接的排序无效。');
  text(result.query,200,'搜索内容');text(result.track,200,'赛道');
  if (!result.track) throw Error('来源列表链接的赛道不能为空。');
  const rawPage=String(result.page);
  if (!/^[1-9]\d{0,5}$/.test(rawPage)) throw Error('来源列表链接的页码无效。');
  result.page=Number(rawPage);
  for (const key of ['startDate','endDate']) if (result[key] && !sourcePublicationDate(result[key])) throw Error('来源列表链接的作品发布日期无效。');
  if(params.has('sourceMainOnly')&&!['0','1'].includes(result.mainTableOnly))throw Error('来源列表链接的总表范围无效。');
  result.mainTableOnly = result.mainTableOnly === '1';
  if (params.has('sourceAuthor') || params.has('sourceAuthorName') || params.has('sourceAuthorIds')) {
    const id=text(params.get('sourceAuthor')??'',120,'作者账号');
    if(!id.trim()||result.view!=='works')throw Error('来源列表链接的作者作品范围无效。');
    const name=text(params.get('sourceAuthorName')??id,160,'作者名称');
    let ids;
    if(params.has('sourceAuthorIds')){
      try{ids=JSON.parse(params.get('sourceAuthorIds'));}catch{throw Error('来源列表链接的作者账号列表无效。');}
      if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||!ids.includes(id))throw Error('来源列表链接的作者账号列表无效。');
      for(const value of ids)if(!text(value,120,'作者账号').trim())throw Error('来源列表链接的作者账号无效。');
    }
    result.authorFocus={name,douyinId:id,...(ids?{douyinIds:ids}:{})};
  }
  if(params.has('sourceReturn')) {
    if(!allowReturn)throw Error('来源列表链接不能嵌套返回条件。');
    const back=params.get('sourceReturn');
    if(back.length>4000)throw Error('来源列表返回条件过长。');
    const backParams=new URLSearchParams(back);
    if([...backParams.keys()].some(key=>!key.startsWith('source')))throw Error('来源列表返回条件包含其他页面参数。');
    result.returnSelection=sourceLedgerSelection(back,false);
    if(!result.authorFocus||result.returnSelection.view!=='authors')throw Error('来源列表返回条件无效。');
  }
  return result;
}

function localPath(path) {
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\r\n\\]/.test(path))throw Error('来源列表页面地址无效。');
  return new URL(path,'https://dashboard.invalid');
}

function encodedSelection(selection, allowReturn = true) {
  const params=new URLSearchParams();
  for(const [field,key]of Object.entries(fields)){
    const value=selection[field]??sourceLedgerDefaults[field];
    if(value!==sourceLedgerDefaults[field])params.set(key,field==='mainTableOnly'?(value?'1':'0'):String(value));
  }
  if(selection.authorFocus){const author=selection.authorFocus;params.set('sourceAuthor',author.douyinId);params.set('sourceAuthorName',author.name);if(author.douyinIds)params.set('sourceAuthorIds',JSON.stringify(author.douyinIds));}
  if(selection.returnSelection){if(!allowReturn)throw Error('来源列表链接不能嵌套返回条件。');params.set('sourceReturn',encodedSelection(selection.returnSelection,false).toString());}
  sourceLedgerSelection(params.toString(),allowReturn);
  return params;
}

/** Internal navigation preserves workspace state so returning to another tab restores its context. */
export function sourceLedgerSelectionPath(path, selection) {
  const url=localPath(path);
  for(const key of [...url.searchParams.keys()])if(key.startsWith('source'))url.searchParams.delete(key);
  for(const [key,value]of encodedSelection(selection))url.searchParams.append(key,value);
  return url.pathname+url.search+url.hash;
}

/** Preserve invalid/duplicate source fields too: the source UI must show their errors rather than silently discard them. */
export function preserveSourceSelection(path, search) {
  const url=localPath(path);
  const current=new URLSearchParams(search);
  for(const key of [...url.searchParams.keys()])if(key.startsWith('source'))url.searchParams.delete(key);
  for(const [key,value]of current)if(key.startsWith('source'))url.searchParams.append(key,value);
  return url.pathname+url.search+url.hash;
}

/** A public source link contains only filters that actually apply to the source ledger. */
export function sourceLedgerShareLink(href, selection) {
  const url=new URL(href);
  if(!['http:','https:'].includes(url.protocol))throw Error('当前页面无法生成可分享链接。');
  url.username='';url.password='';
  // board/theme/classification and account dates belong to the account workspace.
  // No account category is a proven one-to-one mapping to a source-table track.
  // sourceReturn, when present, is separately validated as source-only state.
  url.search='';
  url.hash='source';
  return url.origin+sourceLedgerSelectionPath(url.pathname+url.search+url.hash,selection);
}
