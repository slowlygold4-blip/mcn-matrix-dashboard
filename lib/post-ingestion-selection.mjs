const fields=new Set(['state','order','limit','afterRunId','beforeRunId']);
const invalid=()=>{throw Object.assign(new Error('审查列表筛选无效'),{status:400,code:'INVALID_REVIEW_SELECTION'});};
function integer(value,max,optional=false){
 if(optional&&value==null)return null;
 if(typeof value==='string'&&!/^[1-9]\d*$/.test(value))invalid();
 if(!['string','number'].includes(typeof value))invalid();
 const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)invalid();return n;
}

/** Empty input preserves the original oldest-pending maintenance response.
 * Explicit selection is bounded by run ID, not by event arrival time. */
export function normalizePostIngestionSelection(input){
 if(input==null)return null;
 const entries=input instanceof URLSearchParams?[...input.entries()]
  :typeof input==='object'&&!Array.isArray(input)&&[Object.prototype,null].includes(Object.getPrototypeOf(input))?Object.entries(input):invalid();
 if(!entries.length)return null;
 const seen=new Set(),value={};
 for(const[key,item]of entries){if(!fields.has(key)||seen.has(key))invalid();seen.add(key);value[key]=item;}
 const selection={state:value.state??'pending',order:value.order??'oldest',limit:integer(value.limit===undefined?20:value.limit,100),
  afterRunId:integer(value.afterRunId,Number.MAX_SAFE_INTEGER,true),beforeRunId:integer(value.beforeRunId,Number.MAX_SAFE_INTEGER,true)};
 if(!['pending','completed','all'].includes(selection.state)||!['oldest','newest'].includes(selection.order)
  ||selection.afterRunId!==null&&selection.beforeRunId!==null&&selection.afterRunId>=selection.beforeRunId)invalid();
 return selection;
}

export function selectPostIngestionFiles(pending,completed,selection){
 const runId=file=>Number(/^run-(\d+)\.json$/.exec(file)?.[1]);
 const matching=(selection.state==='pending'?pending:selection.state==='completed'?completed:[...pending,...completed])
  .filter(file=>{const id=runId(file);if(!Number.isSafeInteger(id)||id<1)throw Error('Invalid review event filename');
   return(selection.afterRunId===null||id>selection.afterRunId)&&(selection.beforeRunId===null||id<selection.beforeRunId);})
  .sort((a,b)=>(runId(a)-runId(b))*(selection.order==='oldest'?1:-1));
 const selected=matching.slice(0,selection.limit),hasMore=matching.length>selected.length;
 const next=hasMore?Object.fromEntries(Object.entries({...selection,
  [selection.order==='oldest'?'afterRunId':'beforeRunId']:runId(selected.at(-1))}).filter(([,value])=>value!==null)):null;
 return {selected,pagination:{...selection,matched:matching.length,returned:selected.length,hasMore,next,
  cursorBasis:'exclusive-run-id-not-arrival-time'}};
}
