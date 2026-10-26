import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readBrowserWorksSettings} from '../lib/browser-works-settings.mjs';
const root=new URL('../',import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFileSync(new URL(p,root));
const expected={'data/maintenance-journal/2026-10-02-phase92-data-audit.json':'803ffce096b07632394dd350ab800b8aaa901f053953c81ee51a63e58f480211',
 'data/maintenance-journal/2026-10-02-phase92-data-mcn-endpoints.json':'410f032066840d47c977a968bf5168701c6d4fd3301773ee9e362661b31066bb',
 'data/maintenance-journal/2026-10-02-phase92-data-causal-proof.json':'cf8c6cd5343aeffc06d755aea5d70b79fc2adeee302782c0a6706b08d3d2d7af'};
const artifacts=Object.entries(expected).map(([path,hash])=>{const b=read(path);assert.equal(sha(b),hash);const s=statSync(new URL(path,root));assert.equal(s.mode&511,0o600);return {path,sha256:hash,bytes:b.length,mode:'600'};});
const audit=JSON.parse(read(artifacts[0].path));
for(const p of audit.proofs)assert.equal(sha(read('data/ingestion-reviews/run-'+p.runId+'.json')),p.originalEventSha256);
for(const p of audit.oldOriginalEventPreservation.files)assert.equal(sha(read('data/ingestion-reviews/'+p.file)),p.sha256);
assert.equal(sha(read('data/source-poll/manifest.json')),audit.source.sha256);
const db=new DatabaseSync(new URL('data/douyin-monitor.sqlite',root).pathname,{readOnly:true});let settings,policy;
try{db.exec('PRAGMA query_only=ON;BEGIN');settings=db.prepare("SELECT key,value,updated_at FROM settings WHERE key IN ('publicPostsPerAccount','publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold') ORDER BY key").all();
 assert.deepEqual(settings.map(v=>({...v})),[{key:'publicPostsPerAccount',value:'30',updated_at:'2026-09-04T07:53:16.606Z'}]);
 policy=readBrowserWorksSettings(Object.fromEntries(settings.map(s=>[s.key,s.value])));
 assert.deepEqual(policy,{mode:'legacy',hardLimit:100,requestThreshold:30});
 assert.equal(db.prepare('PRAGMA query_only').get().query_only,1);assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');}finally{db.close();}
const out={checkedAt:new Date().toISOString(),artifacts,settings,actualProductionSettingsReader:policy,
 correctPersistedKeyProjection:true,newPolicyRows:0,
 auditProjectionLimitation:'Initial audit settings projection used three non-production browser* key names; only original publicPostsPerAccount was established there. This NEW proof reads actual publicWorks* keys and actual reader; original receipt and script remain unchanged.',
 originalEventsReverified:audit.proofs.length,oldOriginalEventsReverified:audit.oldOriginalEventPreservation.fileCount,sourceManifestSha256:audit.source.sha256,
 nextStrictAuditFromRunId:2531,queryOnly:true,totalChanges:0,noCollectionNoNetworkNoCompletion:true};
const text=JSON.stringify(out,null,2)+'\n';const path=new URL('data/maintenance-journal/2026-10-02-phase92-data-final-proof.json',root);
writeFileSync(path,text,{flag:'wx',mode:0o600});console.log(JSON.stringify({path:path.pathname,sha256:sha(text),artifacts,settings,policy,next:2531}));

