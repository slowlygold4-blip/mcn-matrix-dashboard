import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {normalizeCollection} from '../lib/providers/normalize.mjs';
import {getAccountHistory} from '../lib/account-history.mjs';
import {dailyProfileCoverage} from '../lib/profile-daily-coverage.mjs';
import {getAccountInsight,getProductInsights} from '../lib/product-insights.mjs';
import {exportPublicReplica} from '../lib/public-replica-export.mjs';
const sec='MS4wLjABAAAAProfileDayEndFixture123456789';
const asOf='2026-10-30T04:00:00.000Z';
function fixture(t){
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());
 const target=database.createTarget({type:'account',provider:'public-web',locator:sec,label:'同刻冲突测试',metadata:{platform:'douyin'}});
 database.db.prepare('UPDATE targets SET created_at=? WHERE id=?').run('2026-09-01T00:00:00.000Z',target.id);
 const add=(at,followers,likes=100,posts=2)=>{
  const raw={capturedAt:at,profile:{user:{sec_uid:sec,uid:'12345',follower_count:followers,total_favorited:likes,aweme_count:posts}},
   worksCoverage:'unavailable',worksErrorCode:'deferred',works:{aweme_list:[]}};
  const run=database.beginRun('fixture',target.id,1);
  database.saveCollection(target,run,normalizeCollection(target,raw,{capturedAt:at}));
  database.db.prepare('UPDATE runs SET started_at=?,finished_at=?,status=? WHERE id=?').run(at,at,'success',run);
  database.db.prepare('UPDATE audits SET created_at=? WHERE run_id=?').run(at,run);
 };
 return {database,target,add,read:(options={})=>getAccountHistory(database,target.id,{kind:'daily',asOf,order:'asc',pageSize:100,...options}),
  coverage:()=>dailyProfileCoverage(database.db,[{id:target.id,type:'account',platform:'douyin'}],asOf).platforms[0]};
}

test('a same-instant follower conflict is missing in account history and daily telemetry, never last-row-wins',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',11,104,3);f.add('2026-10-30T02:00:00.000Z',12,104,3);
 const row=f.read().items.at(-1),coverage=f.coverage();
 assert.equal(coverage.followers.conflicting,1);assert.equal(coverage.followers.comparable,0);
 assert.equal(row.followers,null);assert.equal(row.followersAt,null);assert.equal(row.followersChecksum,null);
 assert.equal(row.followersDelta,null);assert.equal(row.followersBaselineAt,null);
 assert.equal(row.likes,104);assert.equal(row.likesDelta,4);assert.equal(row.postsDelta,1);
 assert.equal(row.sampleCount,2);assert.equal(f.read().pagination.total,2);
});

const options={period:'day',reference:new Date(asOf),timeZone:'Asia/Shanghai'};
test('account details, matrix totals and daily curves also withhold conflicting follower endpoints',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',11,104,3);f.add('2026-10-30T02:00:00.000Z',12,104,3);
 const account=getAccountInsight(f.database,f.target.id,options).account;
 assert.equal(account.metrics.followers.value,null);assert.equal(account.metrics.followers.delta,null);
 assert.equal(account.metrics.followers.currentChecksum,null);assert.match(account.metrics.followers.reason,/冲突/);
 assert.equal(account.metrics.likes.delta,4);assert.equal(account.metrics.posts.delta,1);
 const point=account.trend.find(p=>p.date==='2026-10-30');
 assert.equal(point.followers,null);assert.equal(point.followersAt,null);assert.equal(point.followersDelta,null);
 assert.equal(point.likesDelta,4);assert.equal(point.sampleCount,2);
 const summary=getProductInsights(f.database,options).summary;
 assert.equal(summary.metrics.followers.value,null);assert.equal(summary.metrics.followers.delta,null);
 assert.equal(summary.metrics.likes.delta,4);
});

test('old baseline loading retains all same-instant receipts rather than selecting only the last row',t=>{
 const f=fixture(t);f.add('2026-09-01T02:00:00Z',10,100,2);f.add('2026-09-01T02:00:00.000Z',20,100,2);
 f.add('2026-10-30T02:00:00.000Z',null,105,3);
 const account=getAccountInsight(f.database,f.target.id,options).account;
 assert.equal(account.metrics.followers.value,null);assert.equal(account.metrics.followers.delta,null);
 assert.match(account.metrics.followers.reason,/冲突/);assert.equal(account.metrics.likes.value,105);
});

test('recorded-window fallback cannot revive a contradictory day as a complete comparison cohort',t=>{
 const f=fixture(t);f.add('2026-10-28T02:00:00Z',10,100,2);f.add('2026-10-28T02:00:00.000Z',20,100,2);
 f.add('2026-10-30T02:00:00.000Z',30,105,3);
 const result=getProductInsights(f.database,{...options,period:'custom',startDate:'2026-10-28',endDate:'2026-10-30'});
 assert.equal(result.recordedWindow,null);assert.equal(result.summary.metrics.followers.delta,null);
});

test('a contradictory prior day is not a usable baseline even when the requested page excludes that day',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00Z',10,100,2);f.add('2026-10-29T02:00:00.000Z',20,100,2);
 f.add('2026-10-30T02:00:00.000Z',15,105,3);
 const row=f.read({startDate:'2026-10-30',endDate:'2026-10-30'}).items[0];
 assert.equal(row.followers,15);assert.equal(row.followersDelta,null);assert.equal(row.followersBaselineChecksum,null);
 assert.equal(row.likesDelta,5);assert.equal(f.coverage().followers.missingBaseline,1);
});

test('a later missing follower does not hide an unresolved tie, while a later real observation resolves it',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',11,104,3);f.add('2026-10-30T02:00:00.000Z',12,104,3);
 f.add('2026-10-30T03:00:00.000Z',null,106,3);
 assert.equal(f.read().items.at(-1).followers,null);assert.equal(f.coverage().followers.conflicting,1);
 f.add('2026-10-30T03:00:01.000Z',0,null,null);
 const row=f.read().items.at(-1);assert.equal(row.followers,0);assert.equal(row.followersDelta,-10);
 assert.equal(row.followersAt,'2026-10-30T03:00:01.000Z');assert.equal(row.likesDelta,6);
 assert.equal(f.coverage().followers.comparable,1);assert.equal(f.coverage().followers.conflicting,0);
});

test('likes and inventory conflicts are isolated; proxy growth is unavailable rather than fabricated',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',12,110,3);f.add('2026-10-30T02:00:00.000Z',12,111,4);
 const row=f.read().items.at(-1);assert.equal(row.followersDelta,2);
 for(const key of ['likes','likesAt','likesChecksum','likesDelta','posts','postsDelta','estimatedPlays','estimatedPlaysDelta'])assert.equal(row[key],null,key);
 assert.equal(f.coverage().totalLikes.conflicting,1);
});

test('equal observations with different timestamp spelling remain comparable and reads preserve all original rows',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',12,110,3);f.add('2026-10-30T02:00:00.000Z',12,110,3);
 const before=f.database.db.prepare('SELECT * FROM snapshots ORDER BY id').all();
 const row=f.read().items.at(-1);assert.equal(row.followersDelta,2);assert.equal(row.likesDelta,10);assert.equal(row.postsDelta,1);
 assert.equal(f.coverage().followers.comparable,1);assert.equal(f.coverage().followers.conflicting,0);
 assert.deepEqual(f.database.db.prepare('SELECT * FROM snapshots ORDER BY id').all(),before);
});

test('complementary partial receipts retain the matching checksum for each independent metric',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',0,null,null);f.add('2026-10-30T02:00:00.000Z',null,105,3);
 const receipts=f.database.db.prepare('SELECT followers,source_checksum FROM snapshots WHERE captured_at LIKE ? ORDER BY id').all('2026-10-30%');
 const row=f.read().items.at(-1),account=getAccountInsight(f.database,f.target.id,options).account;
 assert.equal(row.followersDelta,-10);assert.equal(row.likesDelta,5);
 assert.equal(row.followersChecksum,receipts[0].source_checksum);assert.equal(row.likesChecksum,receipts[1].source_checksum);
 assert.equal(account.metrics.followers.currentChecksum,receipts[0].source_checksum);
 assert.equal(account.metrics.likes.currentChecksum,receipts[1].source_checksum);
});

test('sealed public daily rows withhold three conflicting counters and preserve their genuine prior day',t=>{
 const f=fixture(t);f.add('2026-10-29T02:00:00.000Z',10,100,2);
 f.add('2026-10-30T02:00:00Z',11,104,3);f.add('2026-10-30T02:00:00.000Z',12,105,4);
 f.database.db.exec('BEGIN');let result;
 try{result=exportPublicReplica(f.database,{asOf});}finally{f.database.db.exec('ROLLBACK');}
 const rows=result.partitions.find(p=>p.path===`daily/${f.target.id}.json`).items;
 const point=rows.find(p=>p.date==='2026-10-30'),baseline=rows.find(p=>p.date==='2026-10-29');
 for(const metric of ['followers','likes','posts']){
  assert.equal(point[metric],null);assert.equal(point[`${metric}Delta`],null);
  assert.equal(point[`${metric}At`],null);assert.equal(point[`${metric}Checksum`],null);
 }
 assert.equal(baseline.followers,10);assert.equal(baseline.likes,100);assert.equal(point.sampleCount,2);
});
