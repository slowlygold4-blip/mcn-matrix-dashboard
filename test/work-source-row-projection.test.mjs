import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import * as XLSX from '@e965/xlsx';
import {createHash} from 'node:crypto';
import {commitWorkSourceEdition,readKnownWorkSourceFacts,verifyWorkSourceEdition} from '../lib/work-source-store.mjs';
import {readWorkSourceWorkbook} from '../lib/work-source-workbook.mjs';
import {recoveredWorkSourceRows} from '../lib/work-source-row-projection.mjs';
import {workSourceLinkPlan} from '../lib/work-source-link-batch.mjs';
import {resolveWorkSourceLink,commitWorkLinkReceipt} from '../lib/work-source-link-receipts.mjs';
import {sourceNeedsInitialCheck,sourceReadContract} from '../lib/source-poller-status.mjs';
const id='7684947825248082873',other='7692714095128218918';
const t1='2026-10-29T02:00:00.000Z',t2='2026-10-29T03:00:00.000Z';
const clock=date=>()=>Date.parse(date),hash=value=>createHash('sha256').update(value).digest('hex');
function input(revision=1){
 const workbook=XLSX.utils.book_new(),rows=[['作品链接','点赞','发布日期'],
 [`https://www.douyin.com/video/${id}`,0,'2026-09-12'],
 ['share https://v.douyin.com/one/',3,'2026-09-13'],
 ['Click to view',4,'2026-09-14'],
 ['https://v.douyin.com/conflict-a/',5,'2026-09-15'],
 ['https://v.douyin.com/',6,'2026-09-16']];
 const sheet=XLSX.utils.aoa_to_sheet(rows);
 sheet.A3.l={Target:'mailto:share@example.test'};
 sheet.A4.l={Target:'https://v.douyin.com/two/'};
 sheet.A5.l={Target:'https://v.douyin.com/conflict-b/'};
 if(revision===2){sheet.A3={t:'s',v:'https://v.douyin.com/one/'};sheet.B3.v=12;delete sheet.A4;delete sheet.B4;delete sheet.C4;}
 XLSX.utils.book_append_sheet(workbook,sheet,'作品');
 const buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
 const before={url:'https://fixture.feishu.cn/sheets/RecoveryOriginal123456',revision,modifiedAt:'2026-10-20T00:00:00.000Z',title:'Fixture',sheets:[{id:'one',name:'作品',region:'A1:C6'}]};
 return {buffer,before,after:structuredClone(before),readAt:revision===1?t1:t2};
}
function fixture(t){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());const original=input();const result=commitWorkSourceEdition(db,original,{now:clock(t1)});return {db,original,result};}

test('the strict original edition remains byte-stable while a read-only projection recovers only independently usable link fields',t=>{
 const {db,original}=fixture(t),before=db.prepare('SELECT * FROM work_source_versions').all(),changes=db.prepare('SELECT total_changes() n').get().n;
 assert.equal(readWorkSourceWorkbook(original.buffer).facts.length,1);
 const recovered=recoveredWorkSourceRows(db,1);assert.equal(recovered.length,2);
 assert.deepEqual(recovered.map(row=>row.fact.row),[3,4]);
 assert.ok(recovered.every(row=>row.fact.metricDate===null&&row.fact.linkEvidenceIssues.length===1&&row.proof.sourceSha256===hash(original.buffer)));
 assert.equal(readKnownWorkSourceFacts(db,{asOf:t1}).facts.length,3);
 assert.equal(readKnownWorkSourceFacts(db,{asOf:'2026-10-29T01:59:59.000Z'}).facts.length,0);
 assert.deepEqual(db.prepare('SELECT * FROM work_source_versions').all(),before);
 assert.equal(db.prepare('SELECT count(*) n FROM work_source_version_facts').get().n,1);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal(commitWorkSourceEdition(db,original,{now:clock(t2)}).status,'unchanged','re-importing the same upstream revision must not become content drift');
 assert.equal(verifyWorkSourceEdition(db,1).factCount,1);
});

test('a later real source edition supersedes a recovered work without discarding other last-known original rows',t=>{
 const {db}=fixture(t);commitWorkSourceEdition(db,input(2),{now:clock(t2)});
 const old=readKnownWorkSourceFacts(db,{asOf:t1}),current=readKnownWorkSourceFacts(db,{asOf:t2});
 assert.equal(old.facts.find(row=>row.url==='https://v.douyin.com/one/').likes,3);
 assert.equal(current.facts.length,3);
 const newer=current.facts.find(row=>row.url==='https://v.douyin.com/one/');assert.equal(newer.likes,12);assert.equal(newer.sourceVersionId,2);
 const retained=current.facts.find(row=>row.url==='https://v.douyin.com/two/');assert.equal(retained.sourceVersionId,1);assert.equal(retained.presentInLatestEdition,false);
});

test('the existing link planner and receipts accept exact recovered row proofs, keep raw membership immutable, and reject forged membership',async t=>{
 const {db}=fixture(t),plan=workSourceLinkPlan(db,{versionId:1,now:clock(t2)});assert.equal(plan.items.length,2);
 const row=plan.items[0];const receipt=await resolveWorkSourceLink({...row,now:clock(t2),fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://www.douyin.com/video/'+other}})});
 assert.equal(receipt.status,'resolved');
 assert.throws(()=>commitWorkLinkReceipt(db,{...receipt,sourceFactSha256:'f'.repeat(64)},{backupValidated:true,now:clock(t2)}),/source-proof-missing/);
 const result=commitWorkLinkReceipt(db,receipt,{backupValidated:true,now:clock(t2)});assert.equal(result.status,'resolved');
 assert.equal(workSourceLinkPlan(db,{versionId:1,now:clock(t2)}).items.length,1);
 assert.equal(verifyWorkSourceEdition(db,1).factCount,1);
 assert.equal(db.prepare('SELECT count(*) n FROM work_source_version_facts').get().n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM work_source_versions').get().n,1);
});

test('cached projections cannot authorize a receipt after the immutable original artifact has been corrupted',async t=>{
 const {db}=fixture(t),row=workSourceLinkPlan(db,{versionId:1,now:clock(t2)}).items[0];
 const receipt=await resolveWorkSourceLink({...row,now:clock(t2),fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://www.douyin.com/video/'+other}})});
 db.prepare('UPDATE work_source_artifacts SET content=?').run(Buffer.from('corrupt fixture'));
 assert.throws(()=>commitWorkLinkReceipt(db,receipt,{backupValidated:true,now:clock(t2)}),/artifact-corrupt/);
 assert.equal(db.prepare('SELECT count(*) n FROM work_source_link_receipts').get().n,0);
 assert.throws(()=>readKnownWorkSourceFacts(db,{asOf:t2}),/artifact-corrupt/);
});

test('only affected source policies need one initial recheck; a pending owned job is not duplicated',()=>{
 const source={sourceType:'lark-work-source',sourceUrl:'https://fixture.feishu.cn/sheets/RecoveryOriginal123456',readPolicy:'authorized-work-facts',resolveWorkLinks:true};
 assert.equal(sourceNeedsInitialCheck(source,{lastStatus:'unchanged',readContract:'before-row-projection'}),true);
 assert.equal(sourceNeedsInitialCheck(source,{lastStatus:'unchanged',readContract:sourceReadContract(source)}),false);
 assert.equal(sourceNeedsInitialCheck(source,{lastStatus:'pending',readContract:'before-row-projection'}),false);
 const old={sourceType:'lark-sheet',sourceUrl:'https://fixture.feishu.cn/sheets/Unrelated',readPolicy:'author-table'};
 assert.equal(sourceNeedsInitialCheck(old,{lastStatus:'unchanged',readContract:sourceReadContract(old)}),false);
});

test('recovery still rejects conflicting IDs, root links and oversized fields rather than guessing an identity',()=>{
 const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([
  ['作品链接','点赞'],['https://www.douyin.com/video/'+id,1],['https://v.douyin.com/',2],['x'.repeat(1001),3]]);
 sheet.A2.l={Target:'https://www.douyin.com/video/'+other};
 sheet.A3.l={Target:'mailto:invalid@example.test'};
 sheet.A4.l={Target:'https://v.douyin.com/valid/'};
 XLSX.utils.book_append_sheet(workbook,sheet,'作品');
 const parsed=readWorkSourceWorkbook(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),{recoverLinkEvidence:true});
 assert.equal(parsed.facts.length,0);
 assert.deepEqual(parsed.rejected.map(row=>row.reason),['conflicting-work-identities','invalid-work-url','oversized-work-link-evidence']);
});
