const fields={panel:'rosterPanel',query:'rosterQuery',mode:'rosterMode',sort:'rosterSort',direction:'rosterDirection',page:'rosterPage'};
const known=new Set(Object.values(fields));
// rosterStatus belongs to the separate account-metrics list, not this roster.
const owns=key=>key.startsWith('roster')&&key!=='rosterStatus';
export const rosterDefaults=Object.freeze({panel:'authors',query:'',mode:'all',sort:'plays',direction:'desc',page:1});

/** An invalid roster filter must not prevent opening the independent changes view. */
export function rosterPanelSelection(search=''){
 const params=new URLSearchParams(search);
 const panel=params.get('rosterPanel')??rosterDefaults.panel;
 if(params.getAll('rosterPanel').length>1||!['changes','authors'].includes(panel))throw Error('团团名册链接的显示面板无效。');
 return panel;
}

export function rosterSelection(search=''){
 const params=new URLSearchParams(search),selection={...rosterDefaults};
 const owned=new URLSearchParams([...params].filter(([key])=>owns(key)));
 if(owned.toString().length>3000)throw Error('团团名册链接过长，请缩短搜索内容。');
 for(const key of params.keys())if(owns(key)){
  if(!known.has(key))throw Error('团团名册链接含有不支持的参数：'+key.slice(0,40)+'。');
  if(params.getAll(key).length!==1)throw Error('团团名册链接含有重复参数：'+key+'。');
 }
 for(const [field,key]of Object.entries(fields))if(params.has(key))selection[field]=params.get(key);
 selection.panel=rosterPanelSelection(search);
 if(!['all','monitored','paused','source-only'].includes(selection.mode))throw Error('团团名册链接的作者范围无效。');
 if(!['plays','likes','posts','name'].includes(selection.sort))throw Error('团团名册链接的排序无效。');
 if(!['asc','desc'].includes(selection.direction))throw Error('团团名册链接的排序顺序无效。');
 if(typeof selection.query!=='string'||selection.query.length>200||/[\u0000-\u001f\u007f]/.test(selection.query))throw Error('团团名册链接的搜索内容无效。');
 if(!/^[1-9]\d{0,5}$/.test(String(selection.page)))throw Error('团团名册链接的页码无效。');
 selection.page=Number(selection.page);
 return selection;
}

function localPath(path){
 if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\u0000-\u001f\u007f\\]/.test(path))throw Error('团团名册页面地址无效。');
 return new URL(path,'https://dashboard.invalid');
}

/** A task switch changes only the panel; keep invalid saved filters recoverable. */
export function rosterPanelPath(path,panel){
 if(!['changes','authors'].includes(panel))throw Error('团团名册链接的显示面板无效。');
 const url=localPath(path);
 if(panel!==rosterDefaults.panel)url.searchParams.set('rosterPanel',panel);
 else url.searchParams.delete('rosterPanel');
 return url.pathname+url.search+url.hash;
}

/** Change only the roster namespace, keeping the independent source/account views. */
export function rosterSelectionPath(path,selection){
 const url=localPath(path),next=new URLSearchParams();
 for(const [field,key]of Object.entries(fields)){
  const value=selection[field]??rosterDefaults[field];
  if(value!==rosterDefaults[field])next.set(key,String(value));
 }
 rosterSelection(next.toString());
 for(const key of [...url.searchParams.keys()])if(owns(key))url.searchParams.delete(key);
 for(const [key,value]of next)url.searchParams.append(key,value);
 return url.pathname+url.search+url.hash;
}

/** Keep malformed/duplicate fields intact so the roster can show an explicit error. */
export function preserveRosterSelection(path,search){
 const url=localPath(path);
 for(const key of [...url.searchParams.keys()])if(owns(key))url.searchParams.delete(key);
 for(const [key,value]of new URLSearchParams(search))if(owns(key))url.searchParams.append(key,value);
 return url.pathname+url.search+url.hash;
}
