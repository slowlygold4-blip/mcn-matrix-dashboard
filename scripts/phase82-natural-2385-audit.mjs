// Audit the ordinary post-handoff sample. Never initiate a collection or alter it.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {checksum} from '../lib/utils.mjs';
import {validateWorksOnlyEvidence} from '../lib/works-only-observation.mjs';
import {loadVerifiedWorksOnlyRows} from '../lib/works-observation.mjs';
import {buildPostIngestionReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const eventPath=join(root,'data/ingestion-reviews/run-2385.json'),eventBytes=await readFile(eventPath),event=JSON.parse(eventBytes);
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});let proof;
try{
 db.exec('PRAGMA query_only=ON; BEGIN');
 const row=db.prepare('SELECT * FROM works_observations WHERE run_id=2385').get();assert.ok(row);
 const raw=JSON.parse(row.raw_json),canonical=validateWorksOnlyEvidence(raw);
 const hashes=[sha(row.raw_json),checksum(raw),checksum(canonical),row.source_checksum];assert.equal(new Set(hashes).size,1);
 const verified=loadVerifiedWorksOnlyRows(db,new Date().toISOString(),null,{runId:2385});assert.equal(verified.length,1);
 const run=db.prepare('SELECT * FROM runs WHERE id=2385').get();assert.equal(run.trigger_type,'works-only');assert.ok(run.finished_at);assert.equal(run.status,'error');
 assert.equal(row.status,'unavailable');assert.equal(row.coverage,'unavailable');assert.equal(raw.posts.length,0);
 const rebuilt=buildPostIngestionReview({database:db,runId:2385,now:new Date(event.reviewedAt)});assert.deepEqual(rebuilt,event);
 const controls=raw.failureDiagnostics?.firstPageActivation?.structure?.controls;
 assert.ok(controls);assert.equal(controls.attribution,'controls-structure-not-works-evidence');
 assert.equal(controls.observation,'observed');assert.equal(controls.candidateCount,1);assert.equal(controls.worksControlCount,0);
 assert.equal(raw.failureDiagnostics.requests.matched,0);assert.deepEqual(raw.failureDiagnostics.httpStatuses,[]);
 assert.equal(db.prepare('SELECT count(*) n FROM snapshots WHERE captured_at>=? AND captured_at<=?').get(run.started_at,run.finished_at).n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM post_metrics WHERE captured_at>=? AND captured_at<=?').get(run.started_at,run.finished_at).n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM posts WHERE first_seen_at>=? AND first_seen_at<=?').get(run.started_at,run.finished_at).n,0);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,0);
 proof={checkedAt:new Date().toISOString(),runId:2385,startedAt:run.started_at,finishedAt:run.finished_at,status:row.status,coverage:row.coverage,
  originalEventSha256:sha(eventBytes),eventFieldCount:Object.keys(event).length,exactEventRebuild:true,fourSourceHashesMatch:true,
  sourceSha256:hashes[0],actualReaderAccepted:true,currentParentPreservesControls:true,controls,
  firstScreen:{readyState:raw.failureDiagnostics.firstScreen.readyState,bodyPresent:raw.failureDiagnostics.firstScreen.bodyPresent},
  terminal:raw.failureDiagnostics.terminalStructure?.structure,worksRequests:0,worksHttpStatuses:[],actions:raw.failureDiagnostics.firstPageActivation.actionCount,
  newProfiles:0,newPosts:0,newMetrics:0,newFailureObservations:1,
  noManualCollection:true,noNewTimer:true,zeroControlsDoesNotProveNoOtherMarkup:true,noCollectionRecoveryClaim:true};
 db.exec('COMMIT');
}finally{db.close();}
assert.equal(sha(await readFile(eventPath)),proof.originalEventSha256);
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase82-natural-2385.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(proof));
