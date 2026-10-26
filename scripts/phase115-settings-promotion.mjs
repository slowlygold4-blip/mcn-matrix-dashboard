import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const keys=['publicPostsPerAccount','publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold'];
const changed=new Set(keys.slice(1)),origin='http://127.0.0.1:4188';
assert.ok(Date.now()<Date.parse('2026-10-02T11:09:14Z'));
const tests=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-main-tests-result.json')));
assert.equal(tests.outcome.code,0);assert.equal(tests.pass,tests.tests);assert.ok(tests.tests>=4307);
for(const key of ['fail','cancelled','skipped'])assert.equal(tests[key],0);
assert.equal(sha(await readFile(tests.logPath)),tests.sha256);
const approval=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-settings-approval.json')));
assert.equal(approval.approved,true);assert.equal(approval.claim,'configuration-only; no historical recovery or complete-coverage promotion');
assert.equal(tests.sha256,approval.rootFullTests.logSHA256);
assert.equal(sha(await readFile(join(root,'docs/phase115-evidence/collector/signed-receipt.json'))),approval.independentReceiptSHA256);
assert.equal(sha(await readFile(join(root,'docs/phase115-evidence/collector/collector-review.md'))),approval.independentReportSHA256);
function readRows(){
  const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON;BEGIN');
    const rows=db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();
    const result={rows:rows.filter(row=>keys.includes(row.key)),otherRowsSHA256:sha(JSON.stringify(rows.filter(row=>!changed.has(row.key))))};
    assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');return result;
  }finally{db.close();}
}
const before=readRows(),beforePath=join(root,'data/maintenance-journal/2026-10-02-phase115-settings-before.json');
assert.equal(before.rows.find(row=>row.key==='publicPostsPerAccount')?.value,'30');
const storedMode=before.rows.find(row=>row.key==='publicWorksPageMode');assert.ok(!storedMode||storedMode.value==='legacy');
await writeFile(beforePath,JSON.stringify({capturedAt:new Date().toISOString(),...before,meaning:'Exact four-field rows, including absence; other settings only hashed; no secrets stored'},null,2)+'\n',{flag:'wx',mode:0o400});
const auth=await fetch(origin+'/api/auth/session',{signal:AbortSignal.timeout(10000)});assert.equal(auth.status,200);
const session=await auth.json();assert.equal(session.user.role,'admin');assert.equal(session.localOwner,true);assert.ok(session.csrfToken);
const cookie=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie);
const get=async path=>{const response=await fetch(origin+path,{headers:{Cookie:cookie},signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);return response.json();};
const echoBefore=await get('/api/settings');assert.equal(echoBefore.publicWorksPageMode,'legacy');assert.equal(echoBefore.publicPostsPerAccount,'30');
assert.deepEqual(readRows(),before,'Settings changed during review; refuse overwrite');
const submitted={publicWorksPageMode:'whole-page-v2',publicWorksPageHardLimit:100,publicWorksRequestThreshold:30};
const response=await fetch(origin+'/api/settings',{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json'},body:JSON.stringify(submitted),signal:AbortSignal.timeout(10000)});
assert.equal(response.status,200);const returned=await response.json();
const echoAfter=await get('/api/settings');for(const [key,value]of Object.entries(submitted)){assert.equal(returned[key],String(value));assert.equal(echoAfter[key],String(value));}
assert.equal(echoAfter.publicPostsPerAccount,'30');const after=readRows();
assert.equal(after.otherRowsSHA256,before.otherRowsSHA256,'Non-approved setting row changed');
assert.deepEqual(after.rows.find(row=>row.key==='publicPostsPerAccount'),before.rows.find(row=>row.key==='publicPostsPerAccount'));
const result={savedAt:new Date().toISOString(),submitted,echoBefore,echoAfter,beforePath,beforeSHA256:sha(await readFile(beforePath)),afterRows:after.rows,otherSettingsUnchanged:true,legacy30Unchanged:true,ordinaryNextSamplesOnly:true,manualCollection:false,sourcePoll:false,restart:false,secretsSaved:false,claim:approval.claim};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-settings-promoted.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({savedAt:result.savedAt,mode:echoAfter.publicWorksPageMode,hardLimit:echoAfter.publicWorksPageHardLimit,requestThreshold:echoAfter.publicWorksRequestThreshold,legacy30Unchanged:true,manualCollection:false}));
