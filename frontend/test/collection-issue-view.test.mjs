import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionIssueSnapshot,collectionIssueRevision,collectionIssueView} from '../lib/collection-issue-view.mjs';
const asOf='2026-11-04T12:00:00.000Z',since='2026-11-03T12:00:00.000Z';
function status(){return {observedAt:asOf,rolling:{since,notUpdated:3,workIssues:2,issues:{version:1,asOf,since,
 missingProfileTargetIds:[1,2],missingTopicTargetIds:[9],workIssueGroups:[{code:'blocked',targetIds:[2,3]}]}}};}

test('membership follows producer 24-hour IDs, not catalog freshness or selected matrix; unknown IDs and topics remain',()=>{
 const s=status(),accounts=[{id:1,label:'甲',platform:'douyin',coverage:{profileObservedAt:asOf}},{id:2,label:'乙',platform:'bilibili'}],before=JSON.stringify(s);
 const snapshot=collectionIssueSnapshot(s,accounts,[{id:9,label:'#话题'}]);
 assert.equal(snapshot.state,'ready');assert.equal(snapshot.missingTotal,3);assert.equal(snapshot.workIssues,2);
 assert.deepEqual(collectionIssueView(snapshot,{filter:'missing'}).rows.map(r=>r.id),[1,2,9]);
 assert.deepEqual(collectionIssueView(snapshot,{filter:'works'}).rows.map(r=>r.id),[2,3]);
 assert.equal(snapshot.rows.find(r=>r.id===3).catalogued,false);assert.equal(snapshot.rows.find(r=>r.id===3).label,'账号 #3');
 assert.equal(snapshot.rows.find(r=>r.id===9).kind,'topic');assert.equal(snapshot.rows.length,4);
 accounts[0].label='后来改名';s.rolling.issues.missingProfileTargetIds.pop();
 assert.equal(snapshot.rows[0].label,'甲');assert.equal(snapshot.missingTotal,3,'open snapshot does not change with input mutation');
 assert.notEqual(JSON.stringify(s),before);
});

test('legacy and inconsistent lists remain unavailable instead of fabricated empty lists',()=>{
 assert.equal(collectionIssueSnapshot({observedAt:asOf,rolling:{notUpdated:5}}).state,'missing');
 const bad=status();bad.rolling.notUpdated=99;
 assert.equal(collectionIssueSnapshot(bad).state,'invalid');
 const stale=status();stale.rolling.issues.asOf='2026-11-04T11:59:59.000Z';
 assert.equal(collectionIssueSnapshot(stale).state,'invalid');
});

test('search and pagination reach all producer members with bounded rendering and preserved zero results',()=>{
 const s=status();s.rolling.notUpdated=4101;s.rolling.workIssues=0;s.rolling.issues.missingProfileTargetIds=Array.from({length:4100},(_,i)=>i+1);
 s.rolling.issues.missingTopicTargetIds=[5000];s.rolling.issues.workIssueGroups=[];
 const snapshot=collectionIssueSnapshot(s,[{id:4081,label:' 精确作者Ａ '},{id:4100,label:'末尾作者'}]);
 const last=collectionIssueView(snapshot,{page:206});assert.deepEqual([last.pageCount,last.from,last.to,last.rows[0].id],[206,4101,4101,5000]);
 const all=[];for(let page=1;page<=last.pageCount;page++)all.push(...collectionIssueView(snapshot,{page}).rows.map(r=>r.id));
 assert.equal(new Set(all).size,4101);assert.equal(collectionIssueView(snapshot,{query:'精确作者a',page:99}).rows[0].id,4081);
 const empty=collectionIssueView(snapshot,{query:'无匹配作者'});assert.deepEqual([empty.filteredCount,empty.page,empty.from,empty.to],[0,1,0,0]);
 assert.throws(()=>collectionIssueView(snapshot,{filter:'arbitrary'}));
});

test('live membership or reason changes invalidate a frozen list; a new heartbeat clock alone does not',()=>{
 const first=status(),second=status();second.observedAt='2026-11-04T12:00:15.000Z';second.rolling.issues.asOf=second.observedAt;
 second.rolling.since='2026-11-03T12:00:15.000Z';second.rolling.issues.since=second.rolling.since;
 assert.equal(collectionIssueRevision(first),collectionIssueRevision(second));
 second.rolling.issues.missingProfileTargetIds=[1,4];assert.notEqual(collectionIssueRevision(first),collectionIssueRevision(second));
 const reason=status();reason.rolling.issues.workIssueGroups[0].code='rate_limited';assert.notEqual(collectionIssueRevision(first),collectionIssueRevision(reason));
 assert.deepEqual(collectionIssueView(collectionIssueSnapshot(reason),{filter:'reason:rate_limited'}).rows.map(r=>r.id),[2,3]);
});
