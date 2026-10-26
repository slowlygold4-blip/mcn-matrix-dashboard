// Ordinary publisher must create the generation; this script only reads it.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),json=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const state=await json('data/public-replica-publisher/state.json');
const asOf=state.active?.asOf??state.publishedAsOf;
assert.ok(Date.parse(asOf)>Date.parse('2026-10-02T04:06:11.163Z'),'ordinary Phase98 generation not created yet');
const prior='data/public-replica-staging/publisher-2026-10-02T03-44-04-754Z',next='data/public-replica-staging/publisher-'+asOf.replace(/[:.]/g,'-');
const readDays=async directory=>{const m=await json(directory+'/manifest.json'),items=[];for(const file of m.files.filter(f=>f.path.startsWith('daily/')))items.push(...(await json(directory+'/'+file.path)).items);return{manifest:m,items};};
const [before,after]=await Promise.all([readDays(prior),readDays(next)]);
const indexed=new Map(after.items.map(row=>[row.targetId+':'+row.date,row]));
const core=['followers','likes','posts','followersDelta','likesDelta','postsDelta','estimatedPlays','estimatedPlaysDelta','estimatedPlaysProxy'];
const evidence=['id','capturedAt','sourceChecksum','followersAt','followersChecksum','followersBaselineAt','followersBaselineChecksum','likesAt','likesChecksum','likesBaselineAt','likesBaselineChecksum','postsAt','postsChecksum','postsBaselineAt','postsBaselineChecksum'];
let oldDays=0,currentChanged=0;
for(const row of before.items){const fresh=indexed.get(row.targetId+':'+row.date);assert.ok(fresh,'missing retained daily '+row.targetId+':'+row.date);
  if(row.date!=='2026-10-02'){for(const key of [...core,...evidence])assert.deepEqual(fresh[key],row[key],'historical daily drift '+row.targetId+':'+row.date+':'+key);oldDays++;}
  else if(core.some(key=>JSON.stringify(fresh[key])!==JSON.stringify(row[key]))){assert.ok(Date.parse(fresh.capturedAt)>=Date.parse(row.capturedAt));currentChanged++;}
}
for(const row of after.items){assert.equal(row.estimatedPlaysProxy,true);assert.equal(row.estimatedPlays,row.likes===null?null:row.likes*100);assert.equal(row.estimatedPlaysDelta,row.likesDelta===null?null:row.likesDelta*100);}
const oldTopics=await json(prior+'/topics.json'),newTopics=await json(next+'/topics.json');
assert.equal(newTopics.items.length,68);const oldTopicsIndex=new Map(oldTopics.items.map(row=>[row.targetId+':'+row.date,row]));
let historicalTopics=0;const currentTopics=[];
for(const row of newTopics.items){const old=oldTopicsIndex.get(row.targetId+':'+row.date);assert.ok(old);assert.equal(row.sourceChecksum,old.sourceChecksum);assert.equal(row.capturedAt,old.capturedAt);
  if(row.date!=='2026-10-02'){assert.deepEqual(row,old);historicalTopics++;continue;}
  assert.equal(old.participants,null);assert.equal(old.views,null);assert.ok(Number.isSafeInteger(row.participants)&&Number.isSafeInteger(row.views));
  const baseline=newTopics.items.find(p=>p.targetId===row.targetId&&p.date==='2026-10-01');assert.ok(baseline);
  assert.equal(row.participantsDelta,row.participants-baseline.participants);assert.equal(row.viewsDelta,row.views-baseline.views);
  assert.equal(row.participantsBaselineAt,baseline.capturedAt);assert.equal(row.viewsBaselineChecksum,baseline.sourceChecksum);
  currentTopics.push({label:newTopics.topics.find(t=>t.id===row.targetId)?.label,...row});
}
assert.equal(historicalTopics,64);assert.equal(currentTopics.length,4);
const result={finishedAt:new Date().toISOString(),asOf,scope:'immutable staged-generation audit; not online readback',priorAsOf:before.manifest.asOf,priorDailyRows:before.items.length,currentDailyRows:after.items.length,historicalDailyCoreAndSourceFieldsUnchanged:oldDays,currentDayRowsWithCoreChanges:currentChanged,oldDailyRowsMissing:0,historicalTopicRowsExactlyUnchanged:historicalTopics,currentTopics,estimatedPlaysRule:'likes delta ×100, explicitly proxy not actual',noWritesToDatabaseOrPublisher:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase98-staged-history.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
