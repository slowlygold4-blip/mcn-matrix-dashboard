// Shared browser/heartbeat contract. Target IDs are internal reference keys;
// no labels, account identifiers, raw provider messages or credentials survive.
const CODES=new Set(['blocked','rate_limited','login_required','network_error','business_error',
 'upstream_changed','collector_error','unknown','page-obstruction','no-bound-request',
 'deadline','http-rejection','transport-cooldown']);
const MAX_LIST_IDS=20_000,MAX_TOTAL_REFERENCES=30_000,MAX_GROUPS=32;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const counter=x=>Number.isSafeInteger(x)&&x>=0;
const instant=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const fail=()=>{throw Error('invalid telemetry');};
export const safeWorkIssueCode=code=>CODES.has(code)?code:'unknown';

// Absence is the legacy payload, not an empty verified issue list. Invalid new
// evidence is rejected as a whole, never shortened while keeping its counts.
export function safeRollingIssues(status){
 const rolling=status?.rolling;
 if(!object(rolling)||!Object.hasOwn(rolling,'issues'))return null;
 const value=rolling.issues;
 if(!object(value)||value.version!==1||!instant(value.since)||!instant(value.asOf)
  ||value.since!==rolling.since||value.asOf!==status.observedAt
  ||Date.parse(value.asOf)-Date.parse(value.since)!==86_400_000
  ||!counter(rolling.notUpdated)||!counter(rolling.workIssues)
  ||!Array.isArray(value.workIssueGroups)||value.workIssueGroups.length>MAX_GROUPS)fail();
 let references=0;
 const list=(input,seen)=>{
  if(!Array.isArray(input)||input.length>MAX_LIST_IDS)fail();
  references+=input.length;if(references>MAX_TOTAL_REFERENCES)fail();
  const output=[];
  for(const id of input){
   if(!Number.isSafeInteger(id)||id<=0||seen.has(id))fail();
   seen.add(id);output.push(id);
  }
  return output.sort((a,b)=>a-b);
 };
 const missingSeen=new Set();
 const missingProfileTargetIds=list(value.missingProfileTargetIds,missingSeen);
 const missingTopicTargetIds=list(value.missingTopicTargetIds,missingSeen);
 if(missingSeen.size!==rolling.notUpdated)fail();
 const topicIds=new Set(missingTopicTargetIds),workSeen=new Set(),groups=new Map();
 for(const group of value.workIssueGroups){
  if(!object(group)||typeof group.code!=='string'||!group.code)fail();
  const ids=list(group.targetIds,workSeen);
  if(ids.some(id=>topicIds.has(id)))fail();
  // New upstream codes retain their membership under one safe generic group.
  // Do not echo unknown values or reject the whole heartbeat on code evolution.
  const code=safeWorkIssueCode(group.code);
  if(!groups.has(code))groups.set(code,[]);
  if(groups.get(code).length+ids.length>MAX_LIST_IDS)fail();
  groups.get(code).push(...ids);
 }
 if(workSeen.size!==rolling.workIssues)fail();
 return {version:1,since:value.since,asOf:value.asOf,missingProfileTargetIds,missingTopicTargetIds,
  workIssueGroups:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([code,targetIds])=>({code,
   targetIds:targetIds.sort((a,b)=>a-b)}))};
}
