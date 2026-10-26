// Read-only status and source markers. No supplier/collector invocation.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),now=new Date().toISOString();
const read=async path=>{const response=await fetch('http://127.0.0.1:4188'+path,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);return response.json();};
const [health,status,queue]=await Promise.all(['/api/health','/api/monitoring-status','/api/ingestion-reviews'].map(read));
const sourceBytes=await readFile(join(root,'data/source-poll/manifest.json'));
const source=JSON.parse(sourceBytes),previous=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase79-provenance-runtime-peer.json')));
const sourceSha256=createHash('sha256').update(sourceBytes).digest('hex');assert.equal(sourceSha256,previous.source.sha256);assert.equal(source.lastFinishedAt,previous.source.lastFinishedAt);
const publisher=JSON.parse(await readFile(join(root,'data/public-replica-publisher/lock.json'))),publication=JSON.parse(await readFile(join(root,'data/public-replica-publisher/state.json')));
assert.equal(publisher.pid,61526);assert.equal(publisher.startedAt,'2026-10-01T20:38:54.892Z');
const sla=status.updateSla,src=status.sourcePoller;
const evidence={checkedAt:now,health,businessDate:sla.businessDate,profileDaily:sla.coreAccounts.daily,profileFresh8h:sla.coreAccounts.fresh8h,
 worksDaily:sla.works.daily,worksFresh8h:sla.works.fresh8h,topicDaily:sla.topics.daily,topicFresh8h:sla.topics.fresh8h,scheduler:status.scheduler,
 source:{sha256:sourceSha256,lastFinishedAt:source.lastFinishedAt,allBytesStatusAndJobMarkersUnchangedFromPhase79:true,status:src.status,total:src.sourceCount,checkedToday:src.checkedTodayCount,successfulToday:src.successfulTodayCount,blocked:src.blockedCount,failed:src.failedCount,stale:src.staleCount,
  markers:Object.values(source.sources).map(s=>({key:s.key,lastStatus:s.lastStatus,lastCheckedAt:s.lastCheckedAt,jobId:s.jobId??s.lastJobId??null}))},
 reviewQueue:{totalPending:queue.totalPending,totalCompleted:queue.totalCompleted,missingEvents:queue.queue.pendingCount,failedEvents:queue.queue.failedCount,newRunIds:queue.queue.createdRunIds},
 publisher:{...publisher,currentStatus:publication.status,publishedAsOf:publication.publishedAsOf,activeAsOf:publication.active?.asOf??null,code:publication.code,transportFailure:publication.sync?.transportFailure??null},
 noCollectionTriggered:true,noSourcePollTriggered:true,noNewTimer:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase81-runtime.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({checkedAt:now,profile:sla.coreAccounts.daily,works:sla.works.daily.counts,topics:sla.topics.daily,source:evidence.source.status,sourceUnchanged:true,publisher:evidence.publisher,queue:evidence.reviewQueue}));
