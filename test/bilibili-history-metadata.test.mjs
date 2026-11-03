import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {getAccountHistory} from '../lib/account-history.mjs';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';
import {checksum} from '../lib/utils.mjs';

const completed='2026-10-28T16:00:02.000Z',before='2026-10-28T15:59:59.000Z',after='2026-10-28T16:00:01.000Z';
const ids=['BV1fi416bEpi','BV1H5sf6NEP6'];
function fixture(t){
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const target=database.createTarget({type:'account',provider:'public-web',label:'offline metadata',locator:'525138167',metadata:{platform:'bilibili'}});
 database.db.prepare('UPDATE targets SET created_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z',target.id);
 const raw={capturedAt:completed,profile:{user:{uid:target.locator,follower_count:2,total_favorited:15,aweme_count:2}},
  provenance:{mode:'bilibili-public-card-relation-wbi-view'},worksCoverage:'limited',
  works:{aweme_list:ids.map((aweme_id,i)=>({aweme_id,desc:'saved work '+i,author:{uid:target.locator},
   create_time:Date.parse(i?'2026-09-20T02:00:00.000Z':'2026-07-30T14:20:57.000Z')/1000,
   share_url:'https://www.bilibili.com/video/'+aweme_id,statistics:{digg_count:i?0:10}}))},
  workObservationTimes:{version:1,transport:'bilibili-official-http',startedAt:'2026-10-28T15:59:57.000Z',completedAt:completed,
   observations:ids.map((contentId,i)=>({contentId,observedAt:i?after:before,source:'view'}))}};
 database.saveCollection(target,null,normalizeCollection(target,raw,{capturedAt:completed}));
 const read=(options={})=>getAccountHistory(database,target.id,{kind:'works',asOf:completed,pageSize:100,...options}).items;
 return {database,target,raw,read};
}

test('per-work HTTP clocks retain exact title, URL and publication date in history and the public ledger',t=>{
 const {database,target,read}=fixture(t),changes=database.db.prepare('SELECT total_changes() n').get().n;
 const rows=read(),byId=new Map(rows.map(r=>[r.externalId,r]));
 assert.equal(byId.get(ids[0]).publishedAt,'2026-07-30T14:20:57.000Z');
 assert.equal(byId.get(ids[1]).publishedAt,'2026-09-20T02:00:00.000Z');
 assert.equal(byId.get(ids[0]).lastObservedAt,before);assert.equal(byId.get(ids[1]).lastObservedAt,after);
 assert.equal(byId.get(ids[0]).caption,'saved work 0');assert.equal(byId.get(ids[1]).likes,0);
 assert.equal(byId.get(ids[0]).url,'https://www.bilibili.com/video/'+ids[0]);
 const replica=exportPublicReplica(database,{asOf:completed});
 const works=replica.partitions.find(p=>p.kind==='works'&&p.targetId===target.id).items;
 assert.equal(works.find(r=>r.externalId===ids[0]).publicationDateBasis,'platform-timestamp');
 const publishing=replica.partitions.find(p=>p.path==='publishing.json');
 assert.equal(publishing.count,1,'a proved July work must not reappear as an undated work after the September start');
 assert.equal(replica.partitions.filter(p=>p.kind==='publishingShard').flatMap(p=>p.items)[0].contentId,ids[1]);
 assert.equal(database.db.prepare('SELECT total_changes() n').get().n,changes,'metadata recovery must remain read-only');
});

for(const kind of ['checksum','clock','owner','vector'])test(`unbound ${kind} cannot borrow current metadata`,t=>{
 const {database,raw,read}=fixture(t);
 if(kind==='clock')raw.workObservationTimes.observations[0].observedAt=after;
 if(kind==='owner')raw.works.aweme_list[0].author.uid='99999';
 if(kind==='vector')raw.works.aweme_list[0].statistics.digg_count=99;
 database.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=?').run(JSON.stringify(raw),kind==='checksum'?'invalid':checksum(raw));
 const row=read().find(r=>r.externalId===ids[0]);
 assert.equal(row.publishedAt,null);assert.equal(row.caption,null);assert.equal(row.url,null);assert.equal(row.likes,10);
});

test('future containers and excluded snapshot caps never provide publication metadata',t=>{
 const {read}=fixture(t);
 const current=read({asOf:'2026-10-28T16:00:00.000Z'}).find(r=>r.externalId===ids[0]);
 assert.equal(current.publishedAt,null);assert.equal(current.likes,10);
 const capped=read({snapshotMaxId:0,postMaxId:2,postMetricMaxId:2}).find(r=>r.externalId===ids[0]);
 assert.equal(capped.publishedAt,null);assert.equal(capped.likes,10);
});
