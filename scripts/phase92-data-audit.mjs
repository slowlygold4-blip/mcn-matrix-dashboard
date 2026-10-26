// Phase92 fixed natural data audit: only saved sources; no network, collection, product completion or DB writes.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {checksum,businessDateKey} from '../lib/utils.mjs';
import {validateWorksOnlyEvidence} from '../lib/works-only-observation.mjs';
import {loadVerifiedWorksOnlyRows} from '../lib/works-observation.mjs';
import {buildPostIngestionReview} from '../lib/post-ingestion-review.mjs';
import {normalizePost,normalizeCollection} from '../lib/providers/normalize.mjs';
import {getAccountHistory} from '../lib/account-history.mjs';
import {inspectUpdateSla} from '../lib/update-sla.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const cutoff='2026-10-02T01:21:47.929Z';
const runIds=Array.from({length:33},(_,i)=>2498+i);
const baseline={maxRun:2497,snapshots:43958,posts:16457,post_metrics:113549,works_observations:1705};
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>readFile(join(root,p)),at=v=>Date.parse(v);
const fields=['likes','comments','shares','collects','plays'],vector=o=>Object.fromEntries(fields.map(k=>[k,o[k]??null]));
const inheritedBytes=await read('data/maintenance-journal/2026-10-02-phase91-data-audit.json'),inherited=JSON.parse(inheritedBytes);
assert.equal(sha(inheritedBytes),'f8736eb59a18ccb3a695ed7a876c417249f8d202d3c19132dadee53fd8b203f2');
assert.equal(inherited.fixedCutoffCounts.terminalMaxRun,baseline.maxRun);
for(const k of ['snapshots','posts','post_metrics','works_observations'])assert.equal(inherited.fixedCutoffCounts[k],baseline[k]);
const oldEventFiles=(await readdir(join(root,'data/ingestion-reviews'))).filter(f=>/^run-\d+\.json$/.test(f)&&Number(f.match(/\d+/)[0])<2498).sort();
const oldEventHashes=await Promise.all(oldEventFiles.map(async file=>({file,sha256:sha(await read('data/ingestion-reviews/'+file))})));
const sourceBytes=await read('data/source-poll/manifest.json'),source=JSON.parse(sourceBytes);
const jobs=Object.entries(source.sources).map(([key,v])=>({key,jobId:v.lastJobId??null})).sort((a,b)=>a.key.localeCompare(b.key));
assert.equal(sha(sourceBytes),inherited.source.sha256);assert.equal(checksum(jobs),inherited.source.jobIdProjectionSha256);
const result={startedAt:new Date().toISOString(),fixedTerminalCutoff:cutoff,baseline,runIds,proofs:[],
 firstReadAt:'2026-10-02T01:22:44.650Z',excludedRunningAtFirstRead:[2531],inheritedProofSha256:sha(inheritedBytes),
 source:{sha256:sha(sourceBytes),sourceCount:jobs.length,jobIdProjectionSha256:checksum(jobs),lastFinishedAt:source.lastFinishedAt,
 statusCounts:Object.fromEntries([...new Set(Object.values(source.sources).map(v=>v.lastStatus))].map(s=>[s,Object.values(source.sources).filter(v=>v.lastStatus===s).length]))},
 noNetwork:true,noManualSampling:true,noProductReviewCompletion:true,noDatabaseWrites:true,noTimerOrServiceControl:true,
 backup:{reusedPriorVerificationOnly:true,terminalCutoffRun:2448,containsAuditedRuns:false,noNewBackupOrCopy:true}};
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
try{db.exec('PRAGMA query_only=ON;BEGIN');
  const runs = db.prepare("SELECT * FROM runs WHERE id>=2498 AND julianday(finished_at)<=julianday(?) AND status<>'running' ORDER BY id").all(cutoff);
  assert.deepEqual(runs.map(run => run.id), runIds);
  const verified = loadVerifiedWorksOnlyRows(db, cutoff, null, { runIds });
  for (const run of runs) {
    assert.equal(run.trigger_type, 'works-only');
    const row = db.prepare('SELECT * FROM works_observations WHERE run_id=?').get(run.id); assert.ok(row);
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    const hashes = [sha(row.raw_json), checksum(raw), checksum(canonical), row.source_checksum];
    assert.equal(new Set(hashes).size, 1);
    assert.ok(verified.some(item => item.run_id === run.id && item.target_id === run.target_id));
    const target = db.prepare('SELECT id,locator FROM targets WHERE id=?').get(run.target_id);
    const anchor = db.prepare('SELECT * FROM snapshots WHERE id=?').get(row.anchor_snapshot_id); assert.ok(anchor);
    const anchorRaw = JSON.parse(anchor.raw_json);
    assert.equal(checksum(anchorRaw), row.anchor_checksum); assert.equal(anchor.source_checksum, row.anchor_checksum);
    assert.equal(raw.runId, run.id); assert.equal(raw.targetId, run.target_id);
    assert.equal(raw.anchorSnapshotId, anchor.id); assert.equal(anchor.target_id, run.target_id);
    assert.equal(raw.identity.secUid, target.locator); assert.equal(raw.identity.secUid, anchorRaw.profile.user.sec_uid);
    assert.equal(raw.identity.uid, anchorRaw.profile.user.uid);
    assert.ok(at(anchor.captured_at) <= at(raw.requestStartedAt));
    assert.ok(at(raw.requestStartedAt) - at(anchor.captured_at) <= 8 * 3600000);
    assert.ok(at(run.started_at) <= at(raw.requestStartedAt));
    assert.ok(at(raw.requestFinishedAt) <= at(row.created_at)); assert.ok(at(row.created_at) <= at(run.finished_at));
    assert.ok(at(raw.requestFinishedAt) - at(raw.requestStartedAt) <= 45000);
    let offset = 0; const sourceVectors = [];
    let priorPage = null;
    for (const page of raw.pagination?.pages ?? []) {
      assert.ok(at(page.observedAt) >= at(raw.requestStartedAt));
      assert.ok(at(page.observedAt) <= at(raw.requestFinishedAt));
      if (priorPage) {
        assert.equal(page.requestCursor, priorPage.response.max_cursor);
        assert.equal(priorPage.response.has_more, true);
        assert.ok(Number.isSafeInteger(page.requestCursor) && page.requestCursor > 0);
        assert.ok(at(page.observedAt) >= at(priorPage.observedAt));
      } else assert.equal(page.requestCursor, 0);
      priorPage = page;
      for (const post of raw.posts.slice(offset, offset + page.acceptedCount)) {
        const normalized = normalizePost(post);
        const saved = db.prepare('SELECT * FROM posts WHERE target_id=? AND external_id=?').get(run.target_id, post.aweme_id); assert.ok(saved);
        assert.equal(saved.author_id, raw.identity.secUid); assert.equal(post.author.sec_uid, raw.identity.secUid); assert.equal(post.author.uid, raw.identity.uid);
        assert.equal(saved.external_id, normalized.externalId);
        const metric = db.prepare('SELECT * FROM post_metrics WHERE post_id=? AND captured_at=?').get(saved.id, page.observedAt); assert.ok(metric);
        assert.deepEqual(vector(metric), vector(normalized));
        const currentFieldsMatchObservation = saved.last_seen_at === page.observedAt;
        if (currentFieldsMatchObservation) {
          if (normalized.caption) assert.equal(saved.caption, normalized.caption);
          if (normalized.publishedAt !== null) assert.equal(saved.published_at, normalized.publishedAt);
          assert.equal(checksum(JSON.parse(saved.raw_json)), checksum(post));
        }
        sourceVectors.push({ postId: saved.id, metricId: metric.id, externalIdSha256: sha(post.aweme_id),
          authorIdentitySha256: checksum(raw.identity), observedAt: page.observedAt, firstSeenAt: saved.first_seen_at,
          rawPostSha256: checksum(post), metricVectorSha256: checksum(vector(metric)), exactMetricVector: true,
          currentFieldsMatchObservation, firstSeenAtThisObservation: saved.first_seen_at === page.observedAt });
      }
      offset += page.acceptedCount;
    }
    assert.equal(sourceVectors.length, raw.posts.length);
    if (raw.status === 'unavailable') { assert.equal(raw.posts.length, 0); assert.equal(raw.pagination, null); assert.equal(raw.observedAt, null); }
    const eventBytes = await read(`data/ingestion-reviews/run-${run.id}.json`), event = JSON.parse(eventBytes);
    assert.equal(Object.keys(event).length, 21);
    assert.deepEqual(buildPostIngestionReview({ database: db, runId: run.id, now: new Date(event.reviewedAt) }), event);
    const diagnostic = raw.failureDiagnostics ?? null;
    result.proofs.push({ runId: run.id, targetId: run.target_id, triggerType: run.trigger_type,
      startedAt: run.started_at, finishedAt: run.finished_at, runStatus: run.status, status: row.status,
      coverage: row.coverage, errorCode: row.error_code, sourceSha256: row.source_checksum,
      fourSourceHashes: hashes, fourSourceHashesEqual: true, actualReaderAccepted: true,
      runIdentityAnchorTimeVerified: true, anchorSnapshotId: anchor.id, anchorCapturedAt: anchor.captured_at,
      requestStartedAt: raw.requestStartedAt, requestFinishedAt: raw.requestFinishedAt,
      sourceVectors, sourcePostCount: raw.posts.length,
      pageLedger: raw.pagination, pageLedgerSha256: checksum(raw.pagination), sourceBoundCursorChainVerified: true, sourceBoundNewWorkRows: sourceVectors.filter(x => x.firstSeenAtThisObservation).length,
      originalEventSha256: sha(eventBytes), originalEventFieldCount: 21, exactEventRebuild: true,
      originalProductReviewState: event.productReview.status, failureStage: raw.failureStage ?? null,
      diagnosticSha256: checksum(diagnostic),
      sourceDiagnostics: { httpStatuses: diagnostic?.httpStatuses ?? [], businessStatusCodes: diagnostic?.businessStatusCodes ?? [],
        stopReason: diagnostic?.stopReason ?? null, elapsedMs: diagnostic?.elapsedMs ?? null,
        requests: diagnostic?.requests ?? null, responses: diagnostic?.responses ?? null,
        firstPageRequest: diagnostic?.firstPageRequest ?? null,
        genericFetchFailures: diagnostic?.resourceObservation?.failuresByPhase?.beforeStop?.resources?.fetch ?? null,
        strictlyBoundAuthorPostFailures: diagnostic?.cdpObservation?.failuresByPhase?.beforeStop?.authorPosts ?? null },
      paginationStopReason: raw.pagination?.stopReason ?? null,
      pages: raw.pagination?.pages?.map(page => ({ requestCursor: page.requestCursor,
        responseCursor: page.response.max_cursor, rawCount: page.rawCount, truncated: page.truncated,
        observedAt: page.observedAt, acceptedCount: page.acceptedCount, hasMore: page.response.has_more })) ?? [],
      observedRequestState: { firstPageRequestState: diagnostic?.firstPageRequest?.state ?? null,
        requestCandidateCount: diagnostic?.requests?.candidate ?? null, requestMatchedCount: diagnostic?.requests?.matched ?? null,
        rejectedFirstCursorCount: diagnostic?.requests?.rejected?.firstCursor ?? null,
        activationStructureReason: diagnostic?.firstPageActivation?.structure?.reason ?? null },
      startedAfterPhase91Reload: at(run.started_at) > at("2026-10-02T01:13:39Z") });
  }

 result.fixedCutoffCounts={
 snapshots:db.prepare('SELECT count(*) n FROM snapshots WHERE julianday(captured_at)<=julianday(?)').get(cutoff).n,
 posts:db.prepare('SELECT count(*) n FROM posts WHERE julianday(first_seen_at)<=julianday(?)').get(cutoff).n,
 post_metrics:db.prepare('SELECT count(*) n FROM post_metrics WHERE julianday(captured_at)<=julianday(?)').get(cutoff).n,
 works_observations:db.prepare('SELECT count(*) n FROM works_observations WHERE julianday(request_finished_at)<=julianday(?)').get(cutoff).n,
 terminalMaxRun:db.prepare('SELECT max(id) n FROM runs WHERE julianday(finished_at)<=julianday(?)').get(cutoff).n};
 assert.equal(result.fixedCutoffCounts.terminalMaxRun,2530);
 result.fixedDelta=Object.fromEntries(['snapshots','posts','post_metrics','works_observations'].map(k=>[k,result.fixedCutoffCounts[k]-baseline[k]]));
 const sla=inspectUpdateSla(db,{now:new Date(cutoff),includeTargets:true});
 for(const list of [sla.coreAccounts.targets,sla.works.daily.targets,sla.topics.targets])assert.equal(new Set(list.map(x=>x.targetId)).size,list.length);
 result.fixedCutoffCoverage={checkedAt:sla.checkedAt,businessDate:sla.businessDate,profile:sla.coreAccounts.daily,works:sla.works.daily.counts,topics:sla.topics.daily,actualProductionReader:true};
 result.settings=db.prepare("SELECT key,value,updated_at FROM settings WHERE key IN ('publicPostsPerAccount','browserWorksMode','browserWorksHardLimit','browserWorksRequestThreshold') ORDER BY key").all();
 result.sourceVersions=[...new Set(result.proofs.map(p=>JSON.parse(db.prepare('SELECT raw_json FROM works_observations WHERE run_id=?').get(p.runId).raw_json).version))];
 result.queryOnly=db.prepare('PRAGMA query_only').get().query_only;result.totalChanges=db.prepare('SELECT total_changes() n').get().n;
 assert.equal(result.queryOnly,1);assert.equal(result.totalChanges,0);db.exec('ROLLBACK');
}finally{db.close();}
const vectors=result.proofs.flatMap(p=>p.sourceVectors);
result.auditTotals={terminalRunCount:runIds.length,acceptedRunCount:result.proofs.filter(p=>p.status==='accepted').length,
 unavailableRunCount:result.proofs.filter(p=>p.status==='unavailable').length,exactMetricVectors:vectors.length,
 distinctObservedWorks:new Set(vectors.map(v=>v.postId)).size,
 distinctFirstSeenWorks:new Set(vectors.filter(v=>v.firstSeenAtThisObservation).map(v=>v.postId)).size,
 newProfileSnapshotsFromTheseWorksOnlyRuns:0,
 laterPageMetricObservations:result.proofs.reduce((s,p)=>s+p.pages.slice(1).reduce((n,v)=>n+v.acceptedCount,0),0),
 laterPageFirstSeenWorks:result.proofs.reduce((s,p)=>s+p.sourceVectors.filter(v=>p.pages.slice(1).some(page=>page.observedAt===v.observedAt)&&v.firstSeenAtThisObservation).length,0)};
assert.equal(result.fixedDelta.snapshots,0);assert.equal(result.fixedDelta.posts,result.auditTotals.distinctFirstSeenWorks);
assert.equal(result.fixedDelta.post_metrics,vectors.length);assert.equal(result.fixedDelta.works_observations,runIds.length);
result.strict403RunIds=result.proofs.filter(p=>p.status==='unavailable'&&p.errorCode==='blocked'&&p.sourceDiagnostics.httpStatuses.includes(403)&&p.sourceDiagnostics.requests?.matched===1&&p.sourceDiagnostics.responses?.matched===1).map(p=>p.runId);
result.noBoundRunIds=result.proofs.filter(p=>p.status==='unavailable'&&p.sourceDiagnostics.firstPageRequest?.state==='no-bound-request').map(p=>p.runId);
result.truncatedRuns=result.proofs.filter(p=>p.pages.some(x=>x.truncated)).map(p=>({runId:p.runId,rawRows:p.pageLedger.pages.reduce((n,v)=>n+v.rawCount,0),accepted:p.sourcePostCount,terminalHasMore:p.pages.at(-1).hasMore,stopReason:p.paginationStopReason}));
result.emptyAdvancing=[];for(const proof of result.proofs)for(let i=0;i<proof.pages.length;i++){const p=proof.pages[i];if(p.rawCount===0&&p.hasMore===true&&Number.isSafeInteger(p.responseCursor)&&p.responseCursor>0&&p.responseCursor!==p.requestCursor){const next=proof.pages[i+1];if(next)assert.equal(next.requestCursor,p.responseCursor);result.emptyAdvancing.push({runId:proof.runId,page:i+1,continued:!!next,metricsAfter:proof.pages.slice(i+1).reduce((s,v)=>s+v.acceptedCount,0),firstSeenAfter:proof.sourceVectors.filter(v=>proof.pages.slice(i+1).some(x=>x.observedAt===v.observedAt)&&v.firstSeenAtThisObservation).length});}}
for(const p of result.proofs)assert.equal(sha(await read('data/ingestion-reviews/run-'+p.runId+'.json')),p.originalEventSha256);
for(const p of oldEventHashes)assert.equal(sha(await read('data/ingestion-reviews/'+p.file)),p.sha256);
assert.equal(sha(await read('data/source-poll/manifest.json')),sha(sourceBytes));
result.oldOriginalEventPreservation={fileCount:oldEventHashes.length,manifestSha256:checksum(oldEventHashes),files:oldEventHashes,unchangedBeforeAfter:true};
result.originalEventsByteUnchanged=true;result.sourceManifestByteUnchanged=true;result.nextStrictAuditFromRunId=2531;
result.noPerRunLoadedCodeAttestation=true;result.noWholePageV2NaturalBenefitClaim=true;result.noPlatformCompletenessClaim=true;
result.auditConstructionErrors=['Read-only file search with unmatched shell wildcard aborted before reads; switched to explicit filenames.'];
result.finishedAt=new Date().toISOString();result.auditScriptSha256=sha(await read('scripts/phase92-data-audit.mjs'));
const serialized=JSON.stringify(result,null,2)+'\n';assert.doesNotMatch(serialized,/https?:\/\/|Bearer\s|Authorization\s*[:=]|Cookie\s*[:=]/i);
const output=join(root,'data/maintenance-journal/2026-10-02-phase92-data-audit.json');await writeFile(output,serialized,{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,sha256:sha(serialized),runIds,totals:result.auditTotals,fixedCounts:result.fixedCutoffCounts,delta:result.fixedDelta,coverage:result.fixedCutoffCoverage,strict403:result.strict403RunIds,noBound:result.noBoundRunIds,settings:result.settings,sourceVersions:result.sourceVersions,emptyAdvancing:result.emptyAdvancing,truncatedRuns:result.truncatedRuns}));

