// Actual ordinary runs only. Read-only canonical/source/event verification.
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
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});const proofs=[];
try{
  db.exec('PRAGMA query_only=ON; BEGIN');
  const runs=db.prepare("SELECT * FROM runs WHERE id>2385 AND trigger_type='works-only' AND finished_at IS NOT NULL ORDER BY id LIMIT 20").all();
  assert.ok(runs.length,'no new terminal ordinary works run yet');
  for(const run of runs){
    const row=db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(run.id);assert.ok(row);
    const raw=JSON.parse(row.raw_json),canonical=validateWorksOnlyEvidence(raw);
    const hashes=[sha(row.raw_json),checksum(raw),checksum(canonical),row.source_checksum];assert.equal(new Set(hashes).size,1);
    const verified=loadVerifiedWorksOnlyRows(db,new Date().toISOString(),null,{runId:run.id});assert.equal(verified.length,1);
    const eventBytes=await readFile(join(root,`data/ingestion-reviews/run-${run.id}.json`)),event=JSON.parse(eventBytes);
    assert.deepEqual(buildPostIngestionReview({database:db,runId:run.id,now:new Date(event.reviewedAt)}),event);
    const diag=raw.failureDiagnostics;
    proofs.push({runId:run.id,startedAt:run.started_at,finishedAt:run.finished_at,runStatus:run.status,status:row.status,coverage:row.coverage,
      originalEventSha256:sha(eventBytes),sourceSha256:hashes[0],fourSourceHashesMatch:true,actualReaderAccepted:true,exactEventRebuild:true,
      eventFieldCount:Object.keys(event).length,postsInObservation:raw.posts.length,
      diagnostics:diag?{elapsedMs:diag.elapsedMs,stopReason:diag.stopReason,generation:diag.lifecycle?.generation,
        navigation:diag.navigation,firstScreenReadyState:diag.firstScreen?.readyState,terminal:diag.terminalStructure?.structure,
        requests:diag.requests,responses:diag.responses,httpStatuses:diag.httpStatuses,
        activation:diag.firstPageActivation}:null,
      newProfiles:db.prepare('SELECT count(*) n FROM snapshots WHERE captured_at>=? AND captured_at<=?').get(run.started_at,run.finished_at).n,
      newPosts:db.prepare('SELECT count(*) n FROM posts WHERE first_seen_at>=? AND first_seen_at<=?').get(run.started_at,run.finished_at).n,
      newMetrics:db.prepare('SELECT count(*) n FROM post_metrics WHERE captured_at>=? AND captured_at<=?').get(run.started_at,run.finished_at).n});
  }
  assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('COMMIT');
}finally{db.close();}
for(const proof of proofs)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${proof.runId}.json`))),proof.originalEventSha256);
const result={checkedAt:new Date().toISOString(),proofs,noManualCollection:true,noOriginalEventRewrite:true,noRecoveryClaimFromOfflineTests:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase83-natural-runs.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
