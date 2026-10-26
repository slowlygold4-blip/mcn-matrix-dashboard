// Fixed backup, read-only transaction; only verifies topics, never stages a replica.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';
import {readCommittedTargetPublication,releaseCommittedTargetPublication} from '../lib/committed-target-publication.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const backup=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase98-backup.json'),'utf8'));
const approval=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase98-root-approved-source.json'),'utf8'));
for(const row of approval.files)assert.equal(createHash('sha256').update(await readFile(join(root,row.path))).digest('hex'),row.sha256);
const startedAt=new Date().toISOString(),asOf=backup.finishedAt??startedAt;
const db=new DatabaseSync(backup.restoredPath,{readOnly:true});
let receipt;
try{
  db.exec('PRAGMA query_only=ON;BEGIN');
  const before=exportPublicReplica(db,{asOf}).topics;
  receipt=readCommittedTargetPublication(db,{asOf});
  const after=exportPublicReplica(db,{asOf,committedPublication:receipt}).topics;
  assert.equal(receipt.runningTopicCount,4);assert.equal(before.items.length,68);assert.equal(after.items.length,68);
  const previous=new Map(before.items.map(row=>[row.targetId+':'+row.date,row]));
  let historical=0;const changed=[];
  for(const row of after.items){const old=previous.get(row.targetId+':'+row.date);assert.ok(old);assert.equal(row.sourceChecksum,old.sourceChecksum);assert.equal(row.capturedAt,old.capturedAt);
    if(row.date!=='2026-10-02'){assert.deepEqual(row,old);historical++;continue;}
    assert.equal(old.participants,null);assert.equal(old.views,null);
    const stored=db.prepare('SELECT hashtag_participants participants,hashtag_views views FROM snapshots WHERE id=?').get(row.id);
    assert.equal(row.participants,stored.participants);assert.equal(row.views,stored.views);
    const prior=after.items.filter(p=>p.targetId===row.targetId&&p.date==='2026-10-01')[0];assert.ok(prior);
    assert.equal(row.participantsDelta,row.participants-prior.participants);assert.equal(row.viewsDelta,row.views-prior.views);
    assert.equal(row.participantsBaselineAt,prior.capturedAt);assert.equal(row.viewsBaselineChecksum,prior.sourceChecksum);
    changed.push({label:after.topics.find(topic=>topic.id===row.targetId)?.label,before:old,after:row});
  }
  assert.equal(historical,64);assert.equal(changed.length,4);
  assert.equal(db.prepare('SELECT total_changes() n').get().n,0);assert.equal(db.prepare('PRAGMA query_only').get().query_only,1);
  const result={startedAt,finishedAt:new Date().toISOString(),asOf,scope:'fixed backup topic projection only; account output not staged',readOnly:true,noCollection:true,originalRunNotFinished:true,topicRows:68,historicalRowsExactlyUnchanged:historical,restoredCurrentRows:changed,receiptCounts:{profile:receipt.runningProfileCount,topic:receipt.runningTopicCount,total:receipt.runningSnapshotCount},files:approval.files};
  await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase98-root-topic-readback.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({asOf,topicRows:68,historicalRowsExactlyUnchanged:historical,changed:changed.map(c=>({label:c.label,participants:c.after.participants,views:c.after.views,participantsDelta:c.after.participantsDelta,viewsDelta:c.after.viewsDelta})),totalChanges:0}));
}finally{if(receipt)releaseCommittedTargetPublication(receipt);try{db.exec('ROLLBACK');}catch{}db.close();}
