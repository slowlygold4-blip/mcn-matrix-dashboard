import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRollingIssues} from '../lib/collection-issues.mjs';
import {safeProgress} from '../lib/collection-control.mjs';

const since='2026-11-03T12:00:00.000Z',asOf='2026-11-04T12:00:00.000Z';
function fixture(){return {runtimeAI:false,observedAt:asOf,rolling:{since,notUpdated:3,workIssues:3,
 issues:{version:1,since,asOf,missingProfileTargetIds:[8,2],missingTopicTargetIds:[10],
  workIssueGroups:[{code:'blocked',targetIds:[8,3]},{code:'transport-cooldown',targetIds:[4]}]}}};}

test('shared projection preserves every issue ID, strips private fields and leaves input untouched',()=>{
 const input=fixture();input.rolling.issues.raw={token:'PRIVATE_SENTINEL'};
 input.rolling.issues.workIssueGroups[0].message='PRIVATE_SENTINEL';
 const original=structuredClone(input),output=safeRollingIssues(input);
 assert.deepEqual(output,{version:1,since,asOf,missingProfileTargetIds:[2,8],missingTopicTargetIds:[10],
  workIssueGroups:[{code:'blocked',targetIds:[3,8]},{code:'transport-cooldown',targetIds:[4]}]});
 assert.equal(JSON.stringify(output).includes('PRIVATE_SENTINEL'),false);
 assert.deepEqual(input,original);
 assert.deepEqual(safeProgress(input).rolling.issues,output);
});

test('legacy absence stays absent; verified zero issues stays explicitly empty',()=>{
 const old=fixture();delete old.rolling.issues;
 assert.equal(safeRollingIssues(old),null);
 assert.equal(Object.hasOwn(safeProgress(old).rolling,'issues'),false);
 const empty=fixture();empty.rolling.notUpdated=0;empty.rolling.workIssues=0;
 empty.rolling.issues.missingProfileTargetIds=[];empty.rolling.issues.missingTopicTargetIds=[];
 empty.rolling.issues.workIssueGroups=[];
 assert.deepEqual(safeRollingIssues(empty),{version:1,since,asOf,missingProfileTargetIds:[],missingTopicTargetIds:[],workIssueGroups:[]});
});

test('new or private-looking error codes collapse to safe unknown without losing memberships',()=>{
 const input=fixture();input.rolling.issues.workIssueGroups=[
  {code:'new_provider_code',targetIds:[8]},
  {code:'PRIVATE_SENTINEL https://private.example/?token=secret',targetIds:[3]},
  {code:'unknown',targetIds:[4]},
 ];
 const result=safeRollingIssues(input);
 assert.deepEqual(result.workIssueGroups,[{code:'unknown',targetIds:[3,4,8]}]);
 assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);
 input.rolling.reasons=[{code:'PRIVATE_SENTINEL',count:1},null];
 assert.deepEqual(safeProgress(input).rolling.reasons,[{code:'unknown',count:1},{code:'unknown',count:0}]);
 assert.equal(JSON.stringify(safeProgress(input)).includes('PRIVATE_SENTINEL'),false);
});

test('invalid clocks, missing evidence and count disagreements reject the whole issue payload',async t=>{
 const cases=[
  ['null',x=>x.rolling.issues=null],['array',x=>x.rolling.issues=[]],['version',x=>x.rolling.issues.version=2],
  ['since mismatch',x=>x.rolling.issues.since='2026-11-03T11:00:00.000Z'],
  ['asOf mismatch',x=>x.rolling.issues.asOf='2026-11-04T11:00:00.000Z'],
  ['invalid clock',x=>x.observedAt=x.rolling.issues.asOf='2026-11-31T12:00:00.000Z'],
  ['non-canonical clock',x=>x.observedAt=x.rolling.issues.asOf='2026-11-04T12:00:00Z'],
  ['not 24 hours',x=>x.rolling.since=x.rolling.issues.since='2026-11-02T12:00:00.000Z'],
  ['missing count mismatch',x=>x.rolling.notUpdated=2],['work count mismatch',x=>x.rolling.workIssues=4],
  ['string count',x=>x.rolling.workIssues='3'],['negative count',x=>x.rolling.notUpdated=-1],
  ['missing profile list',x=>delete x.rolling.issues.missingProfileTargetIds],
  ['missing topic list',x=>delete x.rolling.issues.missingTopicTargetIds],
  ['missing groups',x=>delete x.rolling.issues.workIssueGroups],
  ['non-string code',x=>x.rolling.issues.workIssueGroups[0].code={}],
  ['missing group list',x=>delete x.rolling.issues.workIssueGroups[0].targetIds],
 ];
 for(const [name,change]of cases)await t.test(name,()=>{
  const input=fixture();change(input);
  assert.throws(()=>safeRollingIssues(input),/^Error: invalid telemetry$/);
  assert.throws(()=>safeProgress(input),/^Error: invalid telemetry$/);
 });
});

test('target IDs must be positive safe integers and globally unique in their scope',async t=>{
 const cases=[
  ['zero',x=>x.rolling.issues.missingProfileTargetIds[0]=0],
  ['negative',x=>x.rolling.issues.missingProfileTargetIds[0]=-1],
  ['fraction',x=>x.rolling.issues.missingProfileTargetIds[0]=1.5],
  ['string',x=>x.rolling.issues.missingProfileTargetIds[0]='8'],
  ['unsafe integer',x=>x.rolling.issues.missingProfileTargetIds[0]=Number.MAX_SAFE_INTEGER+1],
  ['repeated missing ID',x=>x.rolling.issues.missingProfileTargetIds=[8,8]],
  ['missing account/topic overlap',x=>x.rolling.issues.missingTopicTargetIds=[8]],
  ['repeated work ID within group',x=>x.rolling.issues.workIssueGroups[0].targetIds=[8,8]],
  ['repeated work ID across groups',x=>x.rolling.issues.workIssueGroups[1].targetIds=[8]],
  ['topic in work group',x=>x.rolling.issues.workIssueGroups[1].targetIds=[10]],
 ];
 for(const [name,change]of cases)await t.test(name,()=>{
  const input=fixture();change(input);assert.throws(()=>safeRollingIssues(input),/^Error: invalid telemetry$/);
 });
});

test('list, group and total-reference limits reject rather than truncate',()=>{
 const ids=(n,start=1)=>Array.from({length:n},(_,i)=>i+start);
 const long=fixture();long.rolling.issues.missingProfileTargetIds=ids(20_001);
 long.rolling.issues.missingTopicTargetIds=[];long.rolling.notUpdated=20_001;
 assert.throws(()=>safeRollingIssues(long),/^Error: invalid telemetry$/);
 const groups=fixture();groups.rolling.issues.workIssueGroups=Array.from({length:33},(_,i)=>({code:'unknown',targetIds:[100+i]}));
 groups.rolling.workIssues=33;assert.throws(()=>safeRollingIssues(groups),/^Error: invalid telemetry$/);
 const total=fixture();total.rolling.issues.missingProfileTargetIds=ids(15_000);total.rolling.issues.missingTopicTargetIds=[];
 total.rolling.notUpdated=15_000;total.rolling.issues.workIssueGroups=[{code:'unknown',targetIds:ids(15_001)}];
 total.rolling.workIssues=15_001;assert.throws(()=>safeRollingIssues(total),/^Error: invalid telemetry$/);
 total.rolling.issues.workIssueGroups[0].targetIds.pop();total.rolling.workIssues--;
 assert.equal(safeRollingIssues(total).workIssueGroups[0].targetIds.length,15_000);
 const merged=fixture();merged.rolling.notUpdated=0;merged.rolling.workIssues=20_001;
 merged.rolling.issues.missingProfileTargetIds=[];merged.rolling.issues.missingTopicTargetIds=[];
 merged.rolling.issues.workIssueGroups=[{code:'new_one',targetIds:ids(10_000)},
  {code:'new_two',targetIds:ids(10_001,10_001)}];
 assert.throws(()=>safeRollingIssues(merged),/^Error: invalid telemetry$/);
});
