import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PublicWebProvider} from '../lib/providers/public-web.mjs';
import {WorksRequestPolicy,WORKS_ENDPOINT} from '../lib/works-request-policy.mjs';
import {MonitorDatabase} from '../lib/database.mjs';
import {readPersistedWorksRequestPolicies} from '../lib/works-policy-persistence.mjs';
const NOW=Date.parse('2026-10-30T00:00:01.000Z'),past='2026-10-30T00:00:00Z',future='2026-10-30T00:00:02.000Z';
const wait=(extra={})=>({version:1,endpoint:WORKS_ENDPOINT,scope:'endpoint-transport',anonymous:{
 transport:'anonymous-http',attempted:true,deferred:false,errorCode:'rate_limited',cooldownErrorCode:'rate_limited',
 nextEligibleAt:new Date(NOW+7200000).toISOString(),reason:'upstream-error',retryAfterStatus:'valid',...extra}});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE targets(id INTEGER,type TEXT,provider TEXT); CREATE TABLE snapshots(id INTEGER,target_id INTEGER,raw_json TEXT,captured_at TEXT); CREATE TABLE runs(id INTEGER,trigger_type TEXT,details_json TEXT,started_at TEXT,finished_at TEXT); CREATE TABLE works_observations(id INTEGER,raw_json TEXT,observed_at TEXT,created_at TEXT); INSERT INTO targets VALUES(1,\'account\',\'public-web\')');
 const profile=(id,at,policy)=>db.prepare('INSERT INTO snapshots VALUES(?,1,?,?)').run(id,JSON.stringify({worksRequestPolicy:policy}),at);
 const provider=()=>new PublicWebProvider({}, {database:{db},worksRequestPolicyOptions:{now:()=>NOW},execFileImpl:()=>{throw Error('no processes');},fetchImpl:()=>{throw Error('no network');}});
 return {db,profile,provider};
}
test('a later fractional-second policy wins over an older whole-second compatibility record',t=>{
 const f=fixture(t);f.profile(1,past,wait({errorCode:null,cooldownErrorCode:null,nextEligibleAt:null}));
 f.profile(2,'2026-10-30T00:00:00.900Z',wait());
 assert.equal(f.provider().worksRequestPolicy.decision('anonymous-http').nextEligibleAt,new Date(NOW+7200000).toISOString());
});
for(const source of ['profile','ledger-observed','ledger-created','run-start','run-finish'])
 test('future '+source+' cannot restore a wait or an indefinite hold',t=>{
  const f=fixture(t),policy=wait({retryAfterStatus:'too-long',nextEligibleAt:null});
  if(source==='profile')f.profile(1,future,policy);
  else if(source.startsWith('ledger'))f.db.prepare('INSERT INTO works_observations VALUES(1,?,?,?)').run(JSON.stringify({worksRequestPolicy:policy}),source==='ledger-observed'?future:past,source==='ledger-created'?future:past);
  else f.db.prepare('INSERT INTO runs VALUES(1,\'works-only\',?,?,?)').run(JSON.stringify([{requestPolicy:policy}]),source==='run-start'?future:past,future);
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(f.provider().worksRequestPolicy.decision('anonymous-http').deferred,false);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 });
test('valid long upstream waits survive newer policy-free records and caller-owned transactions',t=>{
 const f=fixture(t);f.profile(1,past,wait());f.profile(2,'2026-10-30T00:00:00.900Z',null);
 f.db.exec('BEGIN');const before=f.db.prepare('SELECT total_changes() n').get().n;
 const result=f.provider().worksRequestPolicy.decision('anonymous-http');
 assert.equal(result.nextEligibleAt,new Date(NOW+7200000).toISOString());
 assert.equal(f.db.isTransaction,true);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);f.db.exec('ROLLBACK');
});
test('clock rollback cannot count future failures as distinct failures in the current window',()=>{
 let now=NOW;const p=new WorksRequestPolicy({now:()=>now});
 p.record('anonymous-http',{targetKey:'future',errorCode:'blocked'});now-=1000;
 p.record('anonymous-http',{targetKey:'current-a',errorCode:'blocked'});
 const result=p.record('anonymous-http',{targetKey:'current-b',errorCode:'blocked'});
 assert.equal(result.nextEligibleAt,null);
});
test('the normal database schema indexes chronological latest-snapshot reads without a temporary sort',t=>{
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const plan=database.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM snapshots WHERE target_id=? AND julianday(captured_at)<=julianday(?) ORDER BY julianday(captured_at) DESC,id DESC LIMIT 1').all(1,past);
 assert.ok(plan.some(row=>row.detail.includes('idx_snapshots_target_epoch_id')));
 assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')));
});
test('large old histories parse only the newest 1000 valid payloads from each recovery ledger',t=>{
 const f=fixture(t);f.db.exec('DELETE FROM targets;BEGIN');
 const ledger=f.db.prepare('INSERT INTO works_observations VALUES(?,?,?,?)');
 const run=f.db.prepare('INSERT INTO runs VALUES(?,\'works-only\',?,?,?)');
 for(let id=1;id<=5000;id++){
  ledger.run(id,JSON.stringify({worksRequestPolicy:wait()}),past,past);
  run.run(id,JSON.stringify([{requestPolicy:wait()}]),past,past);
 }
 f.db.exec('COMMIT');let decoded=0;
 f.db.function('json_valid',{deterministic:true},value=>{decoded++;try{JSON.parse(value);return 1;}catch{return 0;}});
 const policies=[...readPersistedWorksRequestPolicies(f.db,new Date(NOW).toISOString())];
 assert.equal(policies.length,2000);assert.ok(decoded<=4000,'old payloads must not be decoded merely to sort their timestamps');
});
