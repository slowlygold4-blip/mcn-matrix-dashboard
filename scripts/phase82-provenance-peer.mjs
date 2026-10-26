// Bounded read-only audit. Only this phase's new safe structural report is written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checksum } from '../lib/utils.mjs';
import { validateWorksOnlyEvidence } from '../lib/works-only-observation.mjs';
import { loadVerifiedWorksOnlyRows } from '../lib/works-observation.mjs';
import { buildPostIngestionReview } from '../lib/post-ingestion-review.mjs';
import { normalizePost } from '../lib/providers/normalize.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = process.argv[2] ?? 'initial';
assert.match(label, /^(?:initial|final)$/);
const output = join(root, `data/maintenance-journal/2026-10-02-phase82-provenance-${label}.json`);
assert.equal(fs.existsSync(output), false);
const hash = value => createHash('sha256').update(value).digest('hex');
const hashFile = async path => { const h=createHash('sha256');for await(const chunk of fs.createReadStream(path))h.update(chunk);return h.digest('hex'); };
const read = path => JSON.parse(fs.readFileSync(join(root, path), 'utf8'));
const num = value => Number.isFinite(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
// No arbitrary raw strings: enum values must have the bounded diagnostic grammar.
const code = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : null;
const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;
const numericFields = (value, keys) => Object.fromEntries(keys.map(key => [key, num(value?.[key])]));
const structure = value => value ? { readyState: code(value.readyState), bodyPresent: bool(value.bodyPresent),
  ...numericFields(value, ['bodyChildCount', 'scriptCount', 'jsonScriptCount', 'worksAnchorCount']),
  renderDataPresent: bool(value.renderDataPresent), nextDataPresent: bool(value.nextDataPresent) } : null;
const projectDiagnostic = d => ({
  requests: numericFields(d.requests, ['candidate', 'matched']),
  responses: numericFields(d.responses, ['matched', 'invalidBodies', 'bodyTimeouts']),
  httpStatuses: (d.httpStatuses ?? []).filter(v => Number.isInteger(v) && v >= 100 && v <= 599),
  boundRequestFailedCount: num(d.runtime?.boundRequestFailedCount),
  activation: { state: code(d.firstPageActivation?.state), ...numericFields(d.firstPageActivation, ['attemptCount', 'probeCount', 'actionCount']),
    reason: code(d.firstPageActivation?.structure?.reason), ...numericFields(d.firstPageActivation?.structure, ['regionCount', 'visibleRegionCount', 'leafRegionCount']) },
  firstRequest: { present: Boolean(d.firstPageRequest), kind: code(d.firstPageRequest?.kind), state: code(d.firstPageRequest?.state), attemptCount: num(d.firstPageRequest?.attemptCount) },
  firstScreen: structure(d.firstScreen), terminalScreen: structure(d.terminalStructure?.structure),
  bootstrap: d.firstScreen?.render?.bootstrapStructure ? { ...numericFields(d.firstScreen.render.bootstrapStructure,
    ['rootKeyCount', 'identitySlotCount', 'identityMatchCount', 'identityConflictCount', 'postArrayCount', 'postItemCount']),
    appPostKind: code(d.firstScreen.render.bootstrapStructure.appPostKind), loaderDataKind: code(d.firstScreen.render.bootstrapStructure.loaderDataKind) } : null,
  lifecycle: { ...numericFields(d.lifecycle, ['generation', 'domContentLoadedCount', 'loadCount', 'firstScreenAttemptCount']), lastAcceptedFirstScreenSource: code(d.lifecycle?.lastAcceptedFirstScreenSource) },
  resources: Object.fromEntries(['document', 'script', 'stylesheet', 'xhr', 'fetch'].map(key => [key, {
    ...numericFields(d.resourceObservation?.resources?.[key], ['requested', 'finished', 'failed', 'unresolvedAtClose']),
    statuses: (d.resourceObservation?.resources?.[key]?.statusCounts ?? []).flatMap(x => Number.isInteger(x.status) && x.status >= 100 && x.status <= 599 ? [{status:x.status,count:num(x.count)}] : []) }])),
  beforeStopBlockedClient: num(d.resourceObservation?.failuresByPhase?.beforeStop?.kinds?.['blocked-client']),
  cdpAuthorPostFailures: numericFields(d.cdpObservation?.failuresByPhase?.beforeStop?.authorPosts, ['current-document', 'prior-document', 'unbound']),
  stopReason: code(d.stopReason), elapsedMs: num(d.elapsedMs),
});
const evidence = { startedAt: new Date().toISOString(), scope: 'existing-source-read-only', observationLimit: 80, cases: [], events: [] };
const phase81 = read('data/maintenance-journal/2026-10-02-phase81-runtime.json');
const oldReviews = read('data/maintenance-journal/2026-10-02-phase81-reviewed-events.json');
const backupProof = read('data/maintenance-journal/2026-10-02-phase81-backup.json');
const previousHashes = new Map(oldReviews.results.map(x => [x.runId, x.originalSha256]));
const db = new DatabaseSync(join(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const identities = new Map(), beforeEventHashes = new Map();
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const recent = db.prepare('SELECT * FROM works_observations ORDER BY id DESC LIMIT 64').all();
  const older = db.prepare('SELECT * FROM works_observations WHERE run_id IN (2069,2233,2234,2235,2238,2245)').all();
  const rows = [...new Map([...recent, ...older].map(x => [x.id, x])).values()].sort((a,b) => a.run_id-b.run_id);
  assert.ok(rows.length <= 80);
  const verified = loadVerifiedWorksOnlyRows(db, new Date().toISOString(), null, { runIds: rows.map(x => x.run_id) });
  assert.equal(verified.length, rows.length);
  for (const row of rows) {
    const raw = JSON.parse(row.raw_json), canonical = validateWorksOnlyEvidence(raw);
    for (const value of [hash(row.raw_json), checksum(raw), checksum(canonical)]) assert.equal(value, row.source_checksum);
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(row.run_id);
    assert.equal(run.target_id, row.target_id); assert.equal(run.trigger_type, 'works-only');
    assert.ok(run.finished_at); assert.notEqual(run.status, 'running'); assert.equal(run.target_count, 1);
    const anchor = db.prepare('SELECT * FROM snapshots WHERE id=? AND target_id=?').get(raw.anchorSnapshotId, row.target_id);
    assert.ok(anchor); assert.equal(checksum(JSON.parse(anchor.raw_json)), raw.anchorChecksum);
    const anchorRaw = JSON.parse(anchor.raw_json);
    assert.equal(anchorRaw.profile.user.sec_uid, raw.identity.secUid); assert.equal(anchorRaw.profile.user.uid, raw.identity.uid);
    const anchorAgeMs = Date.parse(raw.requestStartedAt)-Date.parse(anchor.captured_at);
    assert.ok(anchorAgeMs >= 0 && anchorAgeMs <= 8*3600000);
    identities.set(row.run_id, raw.identity);
    let matchedMetrics = 0, newDistinctWorks = 0;
    for (const post of raw.posts) {
      const normalized = normalizePost(post);
      const stored = db.prepare('SELECT id,author_id,first_seen_at FROM posts WHERE target_id=? AND external_id=?').get(row.target_id, post.aweme_id);
      assert.ok(stored); assert.equal(stored.author_id, raw.identity.secUid);
      const metrics = db.prepare('SELECT likes,comments,shares,plays,collects FROM post_metrics WHERE post_id=? AND captured_at=?').all(stored.id,raw.observedAt);
      assert.equal(metrics.length,1);
      for (const key of ['likes','comments','shares','plays','collects']) assert.equal(metrics[0][key],normalized[key] ?? null);
      matchedMetrics++;
      newDistinctWorks += Number(Date.parse(stored.first_seen_at)>=Date.parse(run.started_at) && Date.parse(stored.first_seen_at)<=Date.parse(run.finished_at));
    }
    const diag = projectDiagnostic(raw.failureDiagnostics ?? {});
    const classification = raw.status === 'accepted' ? 'accepted-limited' : diag.requests.matched > 0 && diag.responses.matched > 0 && diag.httpStatuses.includes(403) ? 'bound-http-403'
      : diag.firstScreen?.readyState === 'loading' && diag.firstScreen?.bodyPresent === false ? 'loading-no-body'
      : diag.activation.reason === 'region-absent' && diag.requests.matched === 0 ? 'region-absent-no-bound-request' : 'other-unavailable';
    evidence.cases.push({ runId:row.run_id,targetId:row.target_id,observationId:row.id,status:code(row.status),coverage:code(row.coverage),
      sourceSha256:row.source_checksum,requestStartedAt:raw.requestStartedAt,requestFinishedAt:raw.requestFinishedAt,
      anchorAgeMs,rawParsedCanonicalStoredHashEqual:true,actualRunAnchorIdentityTimeVerified:true,
      posts:raw.posts.length,newDistinctWorks,matchedMetrics,classification,diag,
      pagination:raw.pagination ? {requestCount:raw.pagination.requestCount,stopReason:code(raw.pagination.stopReason),
        pages:raw.pagination.pages.map(p=>({requestCursor:p.requestCursor,responseCursor:p.response.max_cursor,hasMore:p.response.has_more,acceptedCount:p.acceptedCount,observedAt:p.observedAt}))} : null });
    const eventPath = join(root,`data/ingestion-reviews/run-${row.run_id}.json`);
    if (fs.existsSync(eventPath)) {
      const bytes=fs.readFileSync(eventPath),event=JSON.parse(bytes);beforeEventHashes.set(row.run_id,hash(bytes));
      assert.deepEqual(buildPostIngestionReview({database:db,runId:row.run_id,now:new Date(event.reviewedAt)}),event);
      if(previousHashes.has(row.run_id))assert.equal(hash(bytes),previousHashes.get(row.run_id));
      evidence.events.push({runId:row.run_id,sha256:hash(bytes),rebuiltExact:true,fieldCount:Object.keys(event).length,
        snapshotCount:event.snapshotCount,accepted:event.worksOnly.accepted,independentReceiptExists:fs.existsSync(join(root,`data/ingestion-reviews/reviewed-${row.run_id}.json`)),
        comparedToPhase81:previousHashes.has(row.run_id)});
    }
  }
  evidence.sameIdentityComparisons = [[2233,2369],[2234,2370],[2235,2371],[2238,2374],[2069,2245,2381]].map(group=>{
    for(const id of group.slice(1))assert.deepEqual(identities.get(id),identities.get(group[0]));
    return {runIds:group,identityExact:true};
  });
  evidence.classificationCounts=Object.fromEntries([...new Set(evidence.cases.map(x=>x.classification))].map(c=>[c,evidence.cases.filter(x=>x.classification===c).length]));
  evidence.newOrdinaryRuns=db.prepare('SELECT id,status,trigger_type,started_at,finished_at FROM runs WHERE id>2383 ORDER BY id LIMIT 80').all();
  evidence.openRuns=db.prepare("SELECT id,status,trigger_type,started_at FROM runs WHERE status='running' OR finished_at IS NULL").all();
  evidence.historyCounts=Object.fromEntries(['targets','snapshots','posts','post_metrics','works_observations'].map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  evidence.newBusinessSincePhase81=Object.fromEntries(['snapshots','posts','post_metrics','works_observations'].map(t=>[t,evidence.historyCounts[t]-backupProof.validation.counts[t]]));
  evidence.maxRunId=db.prepare('SELECT MAX(id) n FROM runs').get().n;
  const restoredPath=backupProof.restoredPath;
  assert.match(restoredPath,/^\/var\/folders\/[^\n]+\/T\/mcn-phase81-restore-[A-Za-z0-9]+\/restored\.sqlite$/);
  assert.equal(fs.statSync(restoredPath).mode & 0o777,0o400);
  const backupManifest=JSON.parse(fs.readFileSync(backupProof.backupPath+'.manifest.json','utf8'));
  assert.equal(backupManifest.sha256,backupProof.sha256);
  assert.deepEqual(backupManifest.validation.counts,backupProof.validation.counts);
  assert.equal(fs.statSync(backupProof.backupPath).size,backupProof.bytes);
  const currentRestoredSha256=await hashFile(restoredPath),currentOriginalBackupSha256=await hashFile(backupProof.backupPath);
  assert.equal(currentRestoredSha256,backupProof.sha256);assert.equal(currentOriginalBackupSha256,backupProof.sha256);
  const restore=new DatabaseSync(restoredPath,{readOnly:true}); restore.exec('PRAGMA query_only=ON; BEGIN');
  try{
    assert.equal(restore.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.equal(restore.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(restore.prepare('PRAGMA foreign_key_check').all().length,0);
    const counts={};for(const [table,n]of Object.entries(backupProof.validation.counts)){
      assert.match(table,/^[a-z_]+$/);counts[table]=restore.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;assert.equal(counts[table],n);
    }
    const tables=restore.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),tables);
    for(const {name}of tables){assert.match(name,/^[a-z_]+$/);restore.prepare(`SELECT 1 FROM ${name} LIMIT 1`).all();}
    evidence.backup={reusedPhase81PrivateCopy:true,restorePath:restoredPath,originalBackupPath:backupProof.backupPath,bytes:fs.statSync(restoredPath).size,
      phase81FullFileSha256:backupProof.sha256,phase81FullFileHashCheckedAt:backupProof.finishedAt,
      repeatedFullFileHash:true,currentRestoredSha256,currentOriginalBackupSha256,currentFullFileHashCheckedAt:new Date().toISOString(),
      quickCheck:'ok',integrityCheck:'ok',foreignKeyViolations:0,readableTables:tables.length,counts,
      schemaSha256:hash(JSON.stringify(tables)),currentSchemaEqual:true,maxRunId:restore.prepare('SELECT MAX(id) n FROM runs').get().n,totalChanges:restore.prepare('SELECT total_changes() n').get().n};
    assert.equal(evidence.backup.totalChanges,0);assert.equal(evidence.backup.bytes,backupProof.bytes);
  }finally{restore.exec('ROLLBACK');restore.close();}
  db.prepare('ATTACH DATABASE ? AS old').run(`file:${restoredPath}?mode=ro`);
  evidence.preservation={};
  for(const table of ['snapshots','post_metrics','works_observations','author_resolution_import_sources','account_events']){
    const changed=db.prepare(`SELECT COUNT(*) n FROM (SELECT * FROM old.${table} EXCEPT SELECT * FROM main.${table})`).get().n;
    evidence.preservation[table]={missingOrChangedOldRows:changed};assert.equal(changed,0);
  }
  const columns='id,target_id,external_id,author_id,first_seen_at';
  evidence.preservation.postIdentityAndFirstSeenMissingOrChanged=db.prepare(`SELECT COUNT(*) n FROM (SELECT ${columns} FROM old.posts EXCEPT SELECT ${columns} FROM main.posts)`).get().n;
  assert.equal(evidence.preservation.postIdentityAndFirstSeenMissingOrChanged,0);
  evidence.queryOnly=db.prepare('PRAGMA query_only').get().query_only;evidence.totalChanges=db.prepare('SELECT total_changes() n').get().n;
  assert.equal(evidence.queryOnly,1);assert.equal(evidence.totalChanges,0);
}finally{db.exec('ROLLBACK');db.close();}

const get=async path=>{const response=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);return response.json();};
const [health,status,queue]=await Promise.all([get('/api/health'),get('/api/monitoring-status'),get('/api/ingestion-reviews')]);
const sla=status.updateSla,scheduler=status.scheduler;
evidence.runtime={checkedAt:new Date().toISOString(),health:{ok:bool(health.ok),status:code(health.status),runtimeAI:bool(health.runtimeAI)},businessDate:sla.businessDate,
  profileDaily:sla.coreAccounts.daily,profileFresh8h:sla.coreAccounts.fresh8h,worksDaily:sla.works.daily,worksFresh8h:sla.works.fresh8h,topicDaily:sla.topics.daily,topicFresh8h:sla.topics.fresh8h,
  scheduler:{running:bool(scheduler.running),scheduleState:code(scheduler.scheduleState),scheduleIntervalHours:num(scheduler.scheduleIntervalHours),
    slotTimes:scheduler.slotTimes.filter(x=>['02:00','10:00','18:00'].includes(x)),timeZone:scheduler.timeZone==='Asia/Shanghai'?'Asia/Shanghai':null,
    nextRunAt:instant(scheduler.nextRunAt),lastTickAt:instant(scheduler.lastTickAt),lastSuccessfulTickAt:instant(scheduler.lastSuccessfulTickAt),hasLastError:Boolean(scheduler.lastError),
    scheduledWorksCompleteTargetCount:num(scheduler.scheduledWorksCompleteTargetCount),scheduledWorksLimitedTargetCount:num(scheduler.scheduledWorksLimitedTargetCount),
    scheduledWorksAwaitingNextSlotTargetCount:num(scheduler.scheduledWorksAwaitingNextSlotTargetCount),currentRunPresent:Boolean(scheduler.currentRun)},
  queue:{pending:num(queue.totalPending),completed:num(queue.totalCompleted),missing:num(queue.queue?.pendingCount),failed:num(queue.queue?.failedCount)}};
const sourceBytes=fs.readFileSync(join(root,'data/source-poll/manifest.json')),source=JSON.parse(sourceBytes);
assert.equal(hash(sourceBytes),phase81.source.sha256);assert.equal(source.lastFinishedAt,phase81.source.lastFinishedAt);
const sourceEntries=Object.values(source.sources),previousMarkers=new Map(phase81.source.markers.map(x=>[x.key,x]));
evidence.source={sha256:hash(sourceBytes),lastFinishedAt:instant(source.lastFinishedAt),unchangedFromPhase81:true,entries:sourceEntries.map(s=>{
  const marker={key:s.key,lastStatus:s.lastStatus,lastCheckedAt:s.lastCheckedAt,jobId:s.jobId??s.lastJobId??null};assert.deepEqual(marker,previousMarkers.get(s.key));
  return {keySha256:hash(s.key),status:code(s.lastStatus),checkedAt:instant(s.lastCheckedAt),jobPresent:Boolean(marker.jobId),markerSha256:hash(JSON.stringify(marker)),unchanged:true};
}),status:code(status.sourcePoller.status),total:num(status.sourcePoller.sourceCount),checkedToday:num(status.sourcePoller.checkedTodayCount),successfulToday:num(status.sourcePoller.successfulTodayCount),blocked:num(status.sourcePoller.blockedCount)};
const processes=execFileSync('ps',['-axo','pid,ppid,command'],{encoding:'utf8'}).split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);return m?[{pid:+m[1],ppid:+m[2],command:m[3]}]:[];});
const expected=new Map([[48392,'server.mjs'],[26001,'scripts/source-poller.mjs --loop'],[61526,'scripts/public-replica-publisher.mjs']]);
evidence.services=[...expected].map(([pid,relative])=>{const p=processes.find(p=>p.pid===pid);assert.ok(p);assert.equal(p.ppid,1);assert.ok(p.command.endsWith(join(root,relative)));return{pid,ppid:p.ppid,projectPathVerified:true,role:relative.split('/').at(-1).split('.')[0],directChildren:processes.filter(c=>c.ppid===pid).map(c=>({pid:c.pid,ppid:c.ppid}))};});
for(const [runId,sha]of beforeEventHashes)assert.equal(hash(fs.readFileSync(join(root,`data/ingestion-reviews/run-${runId}.json`))),sha);
evidence.productionHashes=Object.fromEntries(['scripts/douyin_browser_collector.mjs','lib/browser-first-page-activation.mjs','lib/browser-first-works-request.mjs'].map(path=>[path,hash(fs.readFileSync(join(root,path)))]));
evidence.originalEventsUnchanged=true;evidence.noCollectionSourcePollExportImportOrTimerTriggered=true;evidence.finishedAt=new Date().toISOString();
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,startedAt:evidence.startedAt,finishedAt:evidence.finishedAt,observations:evidence.cases.length,classifications:evidence.classificationCounts,
  newRuns:evidence.newOrdinaryRuns,newBusinessSincePhase81:evidence.newBusinessSincePhase81,maxRunId:evidence.maxRunId,sourceUnchanged:evidence.source.unchangedFromPhase81,originalEventsUnchanged:true,queryOnly:1,totalChanges:0}));
