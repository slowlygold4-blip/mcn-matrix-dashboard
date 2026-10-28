// NEW independent synthetic contract attack. Candidate path is explicit; no production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=new URL('../',import.meta.url);
const {MonitorDatabase}=await import(new URL('lib/database.mjs',root));
const {normalizeCollection}=await import(new URL('lib/providers/normalize.mjs',root));
const {checksum}=await import(new URL('lib/utils.mjs',root));
const {exportPublicReplica}=await import(new URL('lib/public-replica-export.mjs',root));
const {readCommittedTargetPublication,releaseCommittedTargetPublication,assertCommittedTargetPublication,committedTopicAllowed}=await import(new URL('lib/committed-target-publication.mjs',root));
const AS='2026-09-20T12:00:00.000Z',OLD='2026-09-20T01:00:01.000Z',NEW='2026-09-20T02:00:01.000Z';
const NAME='一条小团团OvO',ID='1617668778418189';
function setup(t,{legacyBrowser=false,databasePath=':memory:',closeAfter=true}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(OLD)-1000});const database=new MonitorDatabase(databasePath),db=database.db;if(closeAfter)t.after(()=>database.close());
 const target=database.createTarget({type:'hashtag',label:'#'+NAME,locator:NAME,provider:'public-web'});
 const sample=(at,participants,views,{parent,terminal=false,changeRaw,browser=false}={})=>{
  t.mock.timers.setTime(Date.parse(at)-1000);const runId=database.beginRun('scheduled',null,705);
  const raw=browser?{challengeId:ID,officialName:NAME.toLowerCase(),searchKeyword:NAME,hashtag:NAME,capturedAt:at,provenance:{mode:'douyin-authenticated-browser-search-and-detail',authenticated:true,paidAPI:false,runtimeAI:false}}
   :{scope:'douyin-official-challenge-detail',businessStatusCode:0,challengeId:ID,label:NAME,officialName:NAME.toLowerCase(),participants,views,provenance:{mode:'douyin-official-anonymous-challenge-detail',endpoint:'https://www.douyin.com/aweme/v1/web/challenge/detail/',authenticated:false,runtimeAI:false,paidAPI:false},...(parent?{identityReuse:{scope:'historical-identity-only',snapshotId:parent.snapshot.id,auditId:parent.audit.id,runId:parent.runId,capturedAt:parent.snapshot.captured_at,sourceChecksum:parent.snapshot.source_checksum}}:{})};
  changeRaw?.(raw);let collection=normalizeCollection(target,raw,{capturedAt:at});
  if(browser){const snapshot={followers:null,totalLikes:null,totalPosts:null,hashtagParticipants:participants,hashtagViews:views,hashtagPosts:null,authorCount:null};collection={...collection,snapshot,qualityStatus:'validated',sourceChecksum:checksum({tag:raw.hashtag,snapshot,raw:{challengeId:raw.challengeId,officialName:raw.officialName,searchKeyword:raw.searchKeyword}})};}
  t.mock.timers.setTime(Date.parse(at)+1000);database.saveCollection(target,runId,collection);
  const snapshot=db.prepare('SELECT * FROM snapshots WHERE target_id=? ORDER BY id DESC LIMIT 1').get(target.id),audit=db.prepare('SELECT * FROM audits WHERE run_id=?').get(runId);
  if(terminal){t.mock.timers.setTime(Date.parse(at)+2000);database.finishRun(runId,{status:'success',successCount:1});}
  t.mock.timers.setTime(Date.parse(AS)+1);return {raw,snapshot,audit,runId};
 };
 const parent=sample(OLD,10,100,{terminal:true,browser:legacyBrowser});
 const read=({asOf=AS,receipt=true}={})=>{db.exec('BEGIN');let token;try{if(receipt)token=readCommittedTargetPublication(db,{asOf});const replica=exportPublicReplica(db,{asOf,...(token?{committedPublication:token}:{})});return {token,replica,point:replica.topics.items.find(p=>p.targetId===target.id&&p.date==='2026-09-20')};}finally{if(token)releaseCommittedTargetPublication(token);db.exec('ROLLBACK');}};
 const fresh=opts=>sample(NEW,20,200,{parent,...opts});
 return {database,db,target,parent,sample,fresh,read};
}
for(const legacyBrowser of [false,true])test('running paired exact topic advances two current counters with '+(legacyBrowser?'legacy browser':'anonymous')+' terminal root, without finishing run',t=>{const f=setup(t,{legacyBrowser}),s=f.fresh(),r=f.read();assert.equal(r.point.participants,20);assert.equal(r.point.views,200);assert.equal(r.point.capturedAt,NEW);assert.equal(f.db.prepare('SELECT status FROM runs WHERE id=?').get(s.runId).status,'running');assert.equal(f.db.prepare('SELECT finished_at FROM runs WHERE id=?').get(s.runId).finished_at,null);});
const malformed={
 'unsupported time contract':r=>{r.topicTimeContractVersion=2;r.capturedAt=NEW;},
 'same-name wrong challenge ID':r=>r.challengeId='1111111111111111',
 'missing challenge ID':r=>delete r.challengeId,
 'numeric challenge ID':r=>r.challengeId=1617668778418189,
 'wrong original parent snapshot':r=>r.identityReuse.snapshotId+=999,
 'wrong original parent audit':r=>r.identityReuse.auditId+=999,
 'wrong original parent run':r=>r.identityReuse.runId+=999,
 'wrong original parent hash':r=>r.identityReuse.sourceChecksum='0'.repeat(64),
 'wrong original parent capture':r=>r.identityReuse.capturedAt='2026-09-20T00:00:00.000Z',
 'wrong original parent scope':r=>r.identityReuse.scope='historical-counters',
 'missing identity reuse':r=>delete r.identityReuse,
 'contradictory hashtag alias':r=>r.hashtag='WrongTopic',
 'contradictory challenge_id alias':r=>r.challenge_id='1111111111111111',
 'contradictory normalized participant alias':r=>r.participant_count=999,
 'contradictory normalized view alias':r=>r.view_count=999,
 'wrong official name':r=>r.officialName='WrongTopic',
 'wrong source label':r=>r.label='WrongTopic',
 'wrong endpoint':r=>r.provenance.endpoint='https://example.invalid/detail/',
 'rejected business status':r=>r.businessStatusCode=4,
 'missing business status':r=>delete r.businessStatusCode,
 'challenge refusal':r=>r.captcha_required=true,
 'login refusal':r=>r.need_login=true,
 'runtime AI provenance':r=>r.provenance.runtimeAI=true,
 'paid provenance':r=>r.provenance.paidAPI=true,
 'nested provenance need_login':r=>r.provenance.need_login=true,
 'nested provenance captcha_required':r=>r.provenance.captcha_required=true,
 'nested provenance requestRejected':r=>r.provenance.requestRejected=true,
 'nested provenance httpStatus403':r=>r.provenance.httpStatus=403,
 'nested provenance status_code nonzero':r=>r.provenance.status_code=4,
 'capturedAt conflicts DB time':r=>r.capturedAt='2026-09-20T01:59:59.000Z',
 'negative direct counter':r=>r.views=-1,
 'fractional direct counter':r=>r.views=2.5,
 'boolean direct counter':r=>r.views=true,
 'missing participants is not complete fresh topic':r=>r.participants=null,
 'missing views is not complete fresh topic':r=>r.views=null,
};
test('current writer time-contract version 1 retains the exact parent and current-counter proof',t=>{
 const f=setup(t),s=f.fresh({changeRaw:r=>{r.topicTimeContractVersion=1;r.capturedAt=NEW;}}),r=f.read();
 assert.equal(r.point.participants,20);assert.equal(r.point.views,200);
 assert.equal(f.db.prepare('SELECT status FROM runs WHERE id=?').get(s.runId).status,'running');
});
for(const [name,changeRaw]of Object.entries(malformed))test(name+' never publishes unqualified new topic counters',t=>{const f=setup(t);f.fresh({changeRaw});const r=f.read();assert.notEqual(r.point?.participants,20);assert.notEqual(r.point?.views,200);});
const changedRows={
 'missing current audit':f=>f.db.prepare('DELETE FROM audits WHERE id=?').run(f.current.audit.id),
 'current audit later than asOf':f=>f.db.prepare('UPDATE audits SET created_at=? WHERE id=?').run('2026-09-20T12:00:01.000Z',f.current.audit.id),
 'current audit before capture':f=>f.db.prepare('UPDATE audits SET created_at=? WHERE id=?').run('2026-09-20T02:00:00.000Z',f.current.audit.id),
 'current source hash mismatch':f=>f.db.prepare('UPDATE snapshots SET source_checksum=? WHERE id=?').run('0'.repeat(64),f.current.snapshot.id),
 'current normalized vector tampered':f=>f.db.prepare('UPDATE snapshots SET hashtag_views=999 WHERE id=?').run(f.current.snapshot.id),
 'current audit rejected':f=>f.db.prepare("UPDATE audits SET status='rejected' WHERE id=?").run(f.current.audit.id),
 'current run manual':f=>f.db.prepare("UPDATE runs SET trigger_type='manual' WHERE id=?").run(f.current.runId),
 'current run foreign target':f=>{const other=f.database.createTarget({type:'hashtag',label:'#OtherRun',locator:'OtherRun',provider:'public-web'});f.db.prepare('UPDATE runs SET target_id=? WHERE id=?').run(other.id,f.current.runId);},
 'parent raw bytes changed':f=>f.db.prepare("UPDATE snapshots SET raw_json='{}' WHERE id=?").run(f.parent.snapshot.id),
 'parent audit deleted':f=>f.db.prepare('DELETE FROM audits WHERE id=?').run(f.parent.audit.id),
 'parent not terminal':f=>f.db.prepare("UPDATE runs SET status='running',finished_at=NULL WHERE id=?").run(f.parent.runId),
 'parent finishes after child capture':f=>f.db.prepare('UPDATE runs SET finished_at=? WHERE id=?').run('2026-09-20T03:00:00.000Z',f.parent.runId),
};
for(const [name,mutate]of Object.entries(changedRows))test(name+' cannot authorize current topic',t=>{const f=setup(t);f.current=f.fresh();mutate(f);const r=f.read();assert.notEqual(r.point?.participants,20);assert.notEqual(r.point?.views,200);});
test('topic receipt cannot be copied or reused with foreign database/asOf or after release',t=>{const f=setup(t);f.fresh();f.db.exec('BEGIN');const receipt=readCommittedTargetPublication(f.db,{asOf:AS});assert.throws(()=>exportPublicReplica(f.db,{asOf:AS,committedPublication:{...receipt}}));assert.throws(()=>exportPublicReplica(f.db,{asOf:OLD,committedPublication:receipt}));const other=new MonitorDatabase(':memory:');try{other.db.exec('BEGIN');assert.throws(()=>exportPublicReplica(other.db,{asOf:AS,committedPublication:receipt}));other.db.exec('ROLLBACK');}finally{other.close();}releaseCommittedTargetPublication(receipt);assert.throws(()=>assertCommittedTargetPublication(receipt,f.db,AS));f.db.exec('ROLLBACK');});
test('exact multi-hop parent chain is accepted and historical ancestor mutation invalidates current topic',t=>{const f=setup(t),middle=f.sample('2026-09-20T01:30:01.000Z',15,150,{parent:f.parent,terminal:true});f.fresh({parent:middle});assert.equal(f.read().point.participants,20);f.db.prepare("UPDATE snapshots SET raw_json='{}' WHERE id=?").run(f.parent.snapshot.id);assert.notEqual(f.read().point?.participants,20);});
test('real zero counters are preserved; default no-token contract still excludes running topic',t=>{const f=setup(t);f.sample(NEW,0,0,{parent:f.parent});assert.equal(f.read().point.participants,0);assert.equal(f.read().point.views,0);assert.equal(f.read({receipt:false}).point.participants,null);assert.equal(f.read({receipt:false}).point.views,null);});
for(const [name,mutate]of Object.entries({
 'explicit business refusal at anonymous historical root':r=>r.businessStatusCode=4,
 'explicit login refusal at anonymous historical root':r=>r.need_login=true,
 'explicit captcha refusal at anonymous historical root':r=>r.captcha_required=true,
 'contradictory endpoint at anonymous historical root':r=>r.provenance.endpoint='https://example.invalid/not-official',
 'contradictory challenge alias at historical root':r=>r.challenge_id='1111111111111111',
 'contradictory hashtag alias at historical root':r=>r.hashtag='WrongTopic',
}))test(name+' cannot authorize a fresh child merely through legacy identity selector',t=>{const f=setup(t);mutate(f.parent.raw);const hash=checksum(f.parent.raw);f.db.prepare('UPDATE snapshots SET raw_json=?,source_checksum=? WHERE id=?').run(JSON.stringify(f.parent.raw),hash,f.parent.snapshot.id);f.db.prepare('UPDATE audits SET source_checksum=? WHERE id=?').run(hash,f.parent.audit.id);f.parent.snapshot.source_checksum=hash;f.fresh();assert.notEqual(f.read().point?.participants,20);});
test('current topic cannot borrow a same-hash parent reassigned to another target',t=>{const f=setup(t);f.fresh();const other=f.database.createTarget({type:'hashtag',label:'#Other',locator:'Other',provider:'public-web'});f.db.prepare('UPDATE snapshots SET target_id=? WHERE id=?').run(other.id,f.parent.snapshot.id);f.db.prepare('UPDATE audits SET target_id=? WHERE id=?').run(other.id,f.parent.audit.id);assert.notEqual(f.read().point?.participants,20);});
test('same topic name with two qualified historical challenge IDs is conflict, not proof to choose either',t=>{const f=setup(t);f.sample('2026-09-20T01:30:01.000Z',15,150,{terminal:true,changeRaw:r=>r.challengeId='1111111111111111'});f.fresh();assert.notEqual(f.read().point?.participants,20);});
test('actual committedTopicAllowed becomes false after explicit receipt release',t=>{const f=setup(t),current=f.fresh();f.db.exec('BEGIN');try{const receipt=readCommittedTargetPublication(f.db,{asOf:AS});assert.equal(committedTopicAllowed(receipt,current.snapshot),true);releaseCommittedTargetPublication(receipt);assert.equal(committedTopicAllowed(receipt,current.snapshot),false);}finally{f.db.exec('ROLLBACK');}});
test('topic actual WAL commit stays outside in-flight token/export and fresh same-asOf token sees it',async t=>{const dir=await mkdtemp(join(tmpdir(),'phase98-integrity-wal-')),f=setup(t,{databasePath:join(dir,'synthetic.sqlite'),closeAfter:false});let reader;try{reader=new DatabaseSync(join(dir,'synthetic.sqlite'),{readOnly:true});reader.exec('PRAGMA query_only=ON;BEGIN');const token=readCommittedTargetPublication(reader,{asOf:AS});f.fresh();assert.equal(f.db.prepare('SELECT count(*) n FROM snapshots').get().n,2);const old=exportPublicReplica(reader,{asOf:AS,committedPublication:token});assert.equal(old.topics.items[0].participants,10);assert.equal(reader.prepare('SELECT count(*) n FROM snapshots').get().n,1);releaseCommittedTargetPublication(token);reader.exec('ROLLBACK;BEGIN');assert.throws(()=>assertCommittedTargetPublication(token,reader,AS));const fresh=readCommittedTargetPublication(reader,{asOf:AS});assert.equal(exportPublicReplica(reader,{asOf:AS,committedPublication:fresh}).topics.items[0].participants,20);assert.equal(reader.prepare('SELECT total_changes() n').get().n,0);releaseCommittedTargetPublication(fresh);reader.exec('ROLLBACK');}finally{reader?.close();f.database.close();await rm(dir,{recursive:true,force:true});}});
