import {readdir,readFile,lstat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const generationName=asOf=>'publisher-'+asOf.replace(/[:.]/g,'-');
export function chooseReplicaRetention(entries,{now=Date.now(),keep=4,minAgeMs=6*3600000,protectedNames=[]}={}){
 const safe=entries.filter(x=>/^publisher-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(x.name)&&Number.isFinite(x.time));
 safe.sort((a,b)=>b.time-a.time||b.name.localeCompare(a.name));
 const retained=new Set([...protectedNames,...safe.slice(0,Math.max(2,keep)).map(x=>x.name)]);
 return safe.filter(x=>!retained.has(x.name)&&now-x.time>minAgeMs);
}
// Only immutable generated publications are eligible. User source files/databases never enter here.
export async function prunePublicReplicaStaging({dataDir,dryRun=true,now=Date.now()}={}){
 const root=join(resolve(dataDir),'public-replica-staging');
 const rootStat=await lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Error('unsafe-staging-root');
 const statePath=join(resolve(dataDir),'public-replica-publisher','state.json');
 const loadState=async()=>{const s=await lstat(statePath);if(s.isSymbolicLink()||!s.isFile())throw Error('unsafe-publisher-state');return JSON.parse(await readFile(statePath,'utf8'));};
 const state=await loadState();if(state.status!=='success'||!state.publishedAsOf)return {status:'deferred',reason:'publisher-not-successful',removed:[]};
 const protectedNames=[generationName(state.publishedAsOf)];
 if(state.active?.directory)protectedNames.push(state.active.directory.split('/').pop());
 const entries=[];
 for(const e of await readdir(root,{withFileTypes:true})){
  if(!e.isDirectory()||e.isSymbolicLink()||!e.name.startsWith('publisher-'))continue;
  const p=join(root,e.name),m=join(p,'manifest.json');
  try{const st=await lstat(m);if(!st.isFile()||st.isSymbolicLink())continue;
   const manifest=JSON.parse(await readFile(m,'utf8'));if(typeof manifest.asOf!=='string'||generationName(manifest.asOf)!==e.name)continue;
   entries.push({name:e.name,time:Date.parse(manifest.asOf)});
  }catch{} // Incomplete or unknown directories are not garbage-collected.
 }
 const candidates=chooseReplicaRetention(entries,{now,protectedNames});const removed=[];
 for(const e of candidates){
  const fresh=await loadState();if(fresh.status!=='success'||fresh.active)break;
  if(fresh.publishedAsOf&&generationName(fresh.publishedAsOf)===e.name)continue;
  const p=join(root,e.name),s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink())continue;
  if(!dryRun)await rm(p,{recursive:true,force:false});removed.push(e.name);
 }
 return {status:dryRun?'planned':'pruned',dryRun,retention:{keepLatest:4,minAgeHours:6},eligible:entries.length,removed};
}
