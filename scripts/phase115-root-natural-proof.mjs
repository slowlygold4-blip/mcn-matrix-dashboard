import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const startedAt=new Date().toISOString();assert.ok(Date.now()<Date.parse('2026-10-02T11:09:14Z'));
const promotion=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase115-settings-promoted.json')));
const before=JSON.parse(await readFile(promotion.beforePath));
assert.equal(sha(await readFile(promotion.beforePath)),promotion.beforeSHA256);
const db=new DatabaseSync(join(root,'data/douyin-monitor.sqlite'),{readOnly:true});
const result={startedAt,promotionSavedAt:promotion.savedAt,sourceRows:[],verifiedFieldCount:0,sourceBenefitProven:false,oldHistoricalRowsRecovered:false,manualCollection:false,sourcePoll:false,productionWrites:false};
try{
  db.exec('PRAGMA query_only=ON;BEGIN');
  const changed=new Set(['publicWorksPageMode','publicWorksPageHardLimit','publicWorksRequestThreshold']);
  const rows=db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();
  assert.equal(sha(JSON.stringify(rows.filter(r=>!changed.has(r.key)))),before.otherRowsSHA256);
  for(const r of promotion.afterRows)assert.deepEqual({...rows.find(x=>x.key===r.key)},r);
  const observations=db.prepare("SELECT w.*,r.started_at,r.finished_at,r.status AS run_status,r.trigger_type FROM works_observations w JOIN runs r ON r.id=w.run_id WHERE w.request_started_at>=? AND r.trigger_type='works-only' ORDER BY w.id LIMIT 20").all(promotion.savedAt);
  for(const row of observations){
    const raw=JSON.parse(row.raw_json),p=raw.pagination;assert.equal(sha(row.raw_json),row.source_checksum);
    assert.equal(raw.requestedLimit,100);
    const item={runId:row.run_id,targetId:row.target_id,runStartedAt:row.started_at,runFinishedAt:row.finished_at,status:row.status,coverage:row.coverage,errorCode:row.error_code,sourceChecksum:row.source_checksum,requestedLimit:raw.requestedLimit,pagination:p??null,posts:raw.posts?.length??0,metricFieldsVerified:0,extraOverLegacyCap:0};
    if(p){
      assert.ok(p.version===2||(p.version===3&&p.baseVersion===2));assert.equal(p.hardItemLimit,100);assert.equal(p.requestThreshold,30);
      assert.equal(p.collectedCount,item.posts);assert.ok(item.posts<=100);
      let offset=0;
      for(const page of p.pages){
        for(const source of raw.posts.slice(offset,offset+page.acceptedCount)){
          const post=db.prepare('SELECT id FROM posts WHERE target_id=? AND external_id=?').get(row.target_id,source.aweme_id);assert.ok(post);
          const metric=db.prepare('SELECT likes,comments,shares,collects,plays FROM post_metrics WHERE post_id=? AND captured_at=?').get(post.id,page.observedAt);assert.ok(metric);
          for(const[field,key]of Object.entries({likes:'digg_count',comments:'comment_count',shares:'share_count',collects:'collect_count',plays:'play_count'})){assert.equal(metric[field],source.statistics?.[key]??null);item.metricFieldsVerified++;}
        }
        offset+=page.acceptedCount;
      }
      assert.equal(offset,item.posts);
      if(row.status==='accepted'&&item.posts>30){item.extraOverLegacyCap=item.posts-30;result.sourceBenefitProven=true;}
    }
    result.verifiedFieldCount+=item.metricFieldsVerified;result.sourceRows.push(item);
  }
  result.sourcesConsumed=result.sourceRows.some(r=>r.pagination!==null);
  result.queryOnly=db.prepare('PRAGMA query_only').get().query_only;result.totalChanges=db.prepare('SELECT total_changes() n').get().n;
  assert.equal(result.queryOnly,1);assert.equal(result.totalChanges,0);db.exec('ROLLBACK');
}finally{db.close();}
result.finishedAt=new Date().toISOString();
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-root-natural-proof.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({finishedAt:result.finishedAt,sourcesConsumed:result.sourcesConsumed,sourceBenefitProven:result.sourceBenefitProven,fields:result.verifiedFieldCount,sourceRows:result.sourceRows.map(({pagination,...item})=>({...item,version:pagination?.version??null,hardItemLimit:pagination?.hardItemLimit??null,requestThreshold:pagination?.requestThreshold??null,pages:pagination?.pages?.length??0}))}));
