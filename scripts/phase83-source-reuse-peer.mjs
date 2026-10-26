// Read-only, bounded source/back-up audit. No provider, probe, browser, exporter or service actions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { buildPostIngestionReview } from '../lib/post-ingestion-review.mjs';
import { sanitizeBrowserRenderDiagnostics } from '../lib/browser-render-diagnostics.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=join(root,'data/maintenance-journal/2026-10-02-phase83-source-reuse-evidence.json');
assert.equal(fs.existsSync(output),false);
const sha=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(join(root,p),'utf8'));
const hashFile=async p=>{const h=createHash('sha256');for await(const c of fs.createReadStream(p))h.update(c);return h.digest('hex');};
const phase82=read('data/maintenance-journal/2026-10-02-phase82-provenance-final.json');
const old2385=read('data/maintenance-journal/2026-10-02-phase82-natural-2385.json');
const backup=phase82.backup;
const evidence={startedAt:new Date().toISOString(),scope:'read-only-existing-sources',events:[],noSupplierProbeBrowserExportImportServiceOrTimer:true};
const eventPaths=[2384,2385].map(id=>join(root,`data/ingestion-reviews/run-${id}.json`));
const before=eventPaths.map(p=>fs.readFileSync(p));
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
try{
 db.exec('PRAGMA query_only=ON; BEGIN');
 const accepted=loadVerifiedWorksOnlyRows(db,new Date().toISOString(),null,{runIds:[2384,2385]});
 assert.equal(accepted.length,2);
 for(const [index,id] of [2384,2385].entries()){
  const row=db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(id),raw=JSON.parse(row.raw_json);
  const canonical=validateWorksOnlyEvidence(raw),event=JSON.parse(before[index]);
  assert.equal(new Set([sha(row.raw_json),checksum(raw),checksum(canonical),row.source_checksum]).size,1);
  assert.deepEqual(buildPostIngestionReview({database:db,runId:id,now:new Date(event.reviewedAt)}),event);
  const prior=id===2385?old2385.originalEventSha256:phase82.events.find(e=>e.runId===id).sha256;
  assert.equal(sha(before[index]),prior);
  const d=raw.failureDiagnostics;
  evidence.events.push({runId:id,sourceSha256:row.source_checksum,eventSha256:prior,eventFields:Object.keys(event).length,
   fourHashesEqual:true,actualReaderAccepted:true,originalEventRebuildExact:true,status:row.status,coverage:row.coverage,
   posts:raw.posts.length,matchedWorksRequests:d.requests.matched,httpStatuses:d.httpStatuses,
   actions:d.firstPageActivation.actionCount,render:sanitizeBrowserRenderDiagnostics(d.firstScreen?.render),
   controls:id===2385?old2385.controls:null});
  if(id===2385){assert.equal(row.source_checksum,old2385.sourceSha256);assert.deepEqual(d.firstPageActivation.structure.controls,old2385.controls);}
 }
 evidence.currentCounts=Object.fromEntries(['targets','snapshots','posts','post_metrics','works_observations'].map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
 evidence.maxRunId=db.prepare('SELECT MAX(id) n FROM runs').get().n;
 assert.match(backup.restorePath,/^\/var\/folders\/[^\n]+\/T\/mcn-phase81-restore-[A-Za-z0-9]+\/restored\.sqlite$/);
 assert.equal(fs.statSync(backup.restorePath).mode&0o777,0o400);
 const hashes=await Promise.all([hashFile(backup.restorePath),hashFile(backup.originalBackupPath)]);
 assert.deepEqual(hashes,[backup.phase81FullFileSha256,backup.phase81FullFileSha256]);
 const copy=new DatabaseSync(backup.restorePath,{readOnly:true});
 try{
  copy.exec('PRAGMA query_only=ON; BEGIN');
  assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check,'ok');
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(copy.prepare('PRAGMA foreign_key_check').all().length,0);
  const counts={};for(const [table,n]of Object.entries(backup.counts)){assert.match(table,/^[a-z_]+$/);counts[table]=copy.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;assert.equal(counts[table],n);}
  evidence.backup={reusedExistingPrivateCopy:true,bytes:fs.statSync(backup.restorePath).size,sha256:hashes[0],originalSha256:hashes[1],
   quickCheck:'ok',integrityCheck:'ok',foreignKeyViolations:0,manifestCounts:counts,maxRunId:copy.prepare('SELECT MAX(id) n FROM runs').get().n,
   totalChanges:copy.prepare('SELECT total_changes() n').get().n};
  assert.equal(evidence.backup.totalChanges,0);
 }finally{copy.exec('ROLLBACK');copy.close();}
 db.prepare('ATTACH DATABASE ? AS old').run(`file:${backup.restorePath}?mode=ro`);
 evidence.oldHistory={};
 for(const table of ['snapshots','post_metrics','works_observations','author_resolution_import_sources','account_events']){
  const n=db.prepare(`SELECT COUNT(*) n FROM (SELECT * FROM old.${table} EXCEPT SELECT * FROM main.${table})`).get().n;
  assert.equal(n,0);evidence.oldHistory[table]=n;
 }
 const cols='id,target_id,external_id,author_id,first_seen_at';
 evidence.oldHistory.postsIdentityFirstSeen=db.prepare(`SELECT COUNT(*) n FROM (SELECT ${cols} FROM old.posts EXCEPT SELECT ${cols} FROM main.posts)`).get().n;
 assert.equal(evidence.oldHistory.postsIdentityFirstSeen,0);
 evidence.queryOnly=db.prepare('PRAGMA query_only').get().query_only;evidence.totalChanges=db.prepare('SELECT total_changes() n').get().n;
 assert.equal(evidence.queryOnly,1);assert.equal(evidence.totalChanges,0);
}finally{db.exec('ROLLBACK');db.close();}
for(const [i,p]of eventPaths.entries())assert.equal(sha(fs.readFileSync(p)),sha(before[i]));
evidence.originalEventsUnchanged=true;
const sourceSha=sha(fs.readFileSync(join(root,'data/source-poll/manifest.json')));
assert.equal(sourceSha,phase82.source.sha256);evidence.sourceManifest={sha256:sourceSha,equalPhase82:true};
const jixuanRoot='/Users/tyke/skill-hub/data/douyin_monitor';
const latest=JSON.parse(fs.readFileSync(join(jixuanRoot,'latest.json'),'utf8'));
const history=fs.readdirSync(join(jixuanRoot,'history')).filter(x=>/^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
evidence.jixuanSaved={generated:latest.generated,count:latest.count,ok:latest.ok,fail:latest.fail,historyFiles:history.length,lastDailyFilename:history.at(-1),
 freshCollectionPerformed:false,worksFieldIsProfileInventory:true};
const get=async path=>{const r=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json();};
const [health,status]=await Promise.all([get('/api/health'),get('/api/monitoring-status')]);
const safeCoverage=c=>({total:c.total,complete:c.complete,missing:c.missing,status:c.status});
evidence.runtime={checkedAt:new Date().toISOString(),health:{ok:health.ok,status:health.status,runtimeAI:health.runtimeAI},businessDate:status.updateSla.businessDate,
 profileDaily:safeCoverage(status.updateSla.coreAccounts.daily),worksDaily:safeCoverage(status.updateSla.works.daily),topicDaily:safeCoverage(status.updateSla.topics.daily)};
evidence.finishedAt=new Date().toISOString();
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(evidence));
