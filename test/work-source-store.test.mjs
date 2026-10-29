import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from '@e965/xlsx';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { prepareWorkSourceEdition, commitWorkSourceEdition, readWorkSourceEditions,
  readKnownWorkSourceFacts, WORK_SOURCE_TABLES } from '../lib/work-source-store.mjs';

const a='7684947825248082873', b='7692714095128218918';
const T1='2026-10-29T02:00:00.000Z', T2='2026-10-29T03:00:00.000Z';
function input(revision=1, values=[[a,20,3],[b,30,4]], readAt=T1) {
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['视频id','播放','点赞'],...values]),'作品');
  const buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
  const before={url:'https://fixture.feishu.cn/sheets/FixtureWorkbook123456?sheet=abcdef',revision,
    modifiedAt:'2026-10-20T00:00:00.000Z',title:'Fixture',sheets:[{id:'one',name:'作品',region:`A1:C${values.length+1}`} ]};
  return {buffer,before,after:structuredClone(before),readAt};
}
const now=value=>()=>Date.parse(value);
const open=t=>{const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');t.after(()=>db.close());return db;};
const counts=db=>Object.fromEntries(WORK_SOURCE_TABLES.map(name=>[name,db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n]));

test('stage requires stable revision, clocks, sheet identity and complete used regions',()=>{
  for(const mutate of [x=>x.after.revision++,x=>x.after.modifiedAt=T1,x=>x.after.sheets[0].id='other']){
    const x=input();mutate(x);assert.throws(()=>prepareWorkSourceEdition(x,{now:now(T1)}),/source-changed-during-read/);
  }
  const truncated=input();truncated.before.sheets[0].region='A1:C40';truncated.after=structuredClone(truncated.before);
  assert.throws(()=>prepareWorkSourceEdition(truncated,{now:now(T1)}),/export-truncated/);
  const missing=input();missing.before.sheets.push({id:'two',name:'缺页',region:'A1:B2'});missing.after=structuredClone(missing.before);
  assert.throws(()=>prepareWorkSourceEdition(missing,{now:now(T1)}),/sheet-count-mismatch/);
});

test('invalid input and dry run create no schema or data',t=>{
  const db=open(t),x=input();
  assert.equal(commitWorkSourceEdition(db,x,{now:now(T1),dryRun:true}).status,'would-import');
  x.after.revision++;
  assert.throws(()=>commitWorkSourceEdition(db,x,{now:now(T1)}),/changed-during-read/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n,0);
});

test('initial commit stores complete original, immutable rows, membership and head',t=>{
  const db=open(t),x=input(),result=commitWorkSourceEdition(db,x,{now:now(T1)});
  assert.equal(result.status,'imported');assert.equal(result.factCount,2);
  assert.deepEqual(counts(db),{work_source_artifacts:1,work_source_versions:1,work_source_fact_blobs:2,work_source_version_facts:2,work_source_heads:1});
  const row=db.prepare('SELECT * FROM work_source_artifacts').get();
  assert.equal(createHash('sha256').update(row.content).digest('hex'),row.sha256);
  assert.ok(Buffer.from(row.content).equals(x.buffer));
  assert.equal(readKnownWorkSourceFacts(db,{asOf:T1}).facts[0].metricDate,null);
});

test('same revision is idempotent and unchanged rows reuse content storage across editions',t=>{
  const db=open(t),x=input();commitWorkSourceEdition(db,x,{now:now(T1)});
  const before=counts(db),changes=db.prepare('SELECT total_changes() n').get().n;
  assert.equal(commitWorkSourceEdition(db,x,{now:now(T1)}).status,'unchanged');
  assert.deepEqual(counts(db),before);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
  const next=commitWorkSourceEdition(db,input(2,[[a,21,3],[b,30,4]],T2),{now:now(T2)});
  assert.equal(next.newBlobs,1);assert.equal(next.reusedBlobs,1);
  assert.equal(counts(db).work_source_fact_blobs,3);
  assert.equal(counts(db).work_source_versions,2);
});

test('byte-different XLSX packaging with identical facts is not a new business observation',async t=>{
  const db=open(t),x=input();commitWorkSourceEdition(db,x,{now:now(T1)});
  const zip=await JSZip.loadAsync(x.buffer);zip.file('packaging-only.txt','no business data changed');
  x.buffer=await zip.generateAsync({type:'nodebuffer'});
  const result=commitWorkSourceEdition(db,x,{now:now(T2)});
  assert.equal(result.status,'unchanged');assert.equal(result.artifactByteMatch,false);
  assert.equal(counts(db).work_source_artifacts,1);
});

test('same revision with changed facts or source clock is rejected, not overwritten',t=>{
  const db=open(t);commitWorkSourceEdition(db,input(),{now:now(T1)});const before=counts(db);
  assert.throws(()=>commitWorkSourceEdition(db,input(1,[[a,99,3],[b,30,4]],T2),{now:now(T2)}),/content-drift/);
  const clock=input();clock.before.modifiedAt='2026-10-21T00:00:00.000Z';clock.after=structuredClone(clock.before);
  assert.throws(()=>commitWorkSourceEdition(db,clock,{now:now(T2)}),/clock-drift/);
  assert.deepEqual(counts(db),before);
});

test('lower revisions and backward modification clocks fail both preflight and commit',t=>{
  const db=open(t);commitWorkSourceEdition(db,input(2),{now:now(T1)});
  for(const dryRun of [true,false]) assert.throws(()=>commitWorkSourceEdition(db,input(1),{now:now(T1),dryRun}),/regression/);
  const x=input(3);x.before.modifiedAt='2026-10-19T00:00:00.000Z';x.after=structuredClone(x.before);
  assert.throws(()=>commitWorkSourceEdition(db,x,{now:now(T1)}),/regression/);
});

test('transaction failure rolls back new artifact, edition, rows and head together',t=>{
  const db=open(t);commitWorkSourceEdition(db,input(),{now:now(T1)});const before=counts(db);
  db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON work_source_version_facts WHEN NEW.version_id<>1 AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(()=>commitWorkSourceEdition(db,input(2,[[a,55,3],[b,66,4]],T2),{now:now(T2)}),/injected/);
  assert.deepEqual(counts(db),before);
  assert.equal(readWorkSourceEditions(db,{asOf:T2})[0].revision,1);
});

test('past cutoff sees the past edition, and source removal never deletes accumulated works',t=>{
  const db=open(t);commitWorkSourceEdition(db,input(),{now:now(T1)});
  commitWorkSourceEdition(db,input(2,[[a,21,3]],T2),{now:now(T2)});
  assert.deepEqual(readWorkSourceEditions(db,{asOf:'2026-10-29T01:59:59.999Z'}),[]);
  const past=readKnownWorkSourceFacts(db,{asOf:T1});assert.equal(past.versions[0].revision,1);
  assert.deepEqual(past.facts.map(r=>r.plays),[20,30]);
  const current=readKnownWorkSourceFacts(db,{asOf:T2});assert.equal(current.facts.length,2);
  assert.equal(current.facts.find(r=>r.contentId===a).plays,21);
  assert.equal(current.facts.find(r=>r.contentId===b).presentInLatestEdition,false);
  assert.notEqual(current.fingerprint,past.fingerprint);
});

test('corrupt artifacts, rows and incomplete membership cannot pass repeated import',t=>{
  for(const kind of ['artifact','fact','membership']){
    const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
    try{
      commitWorkSourceEdition(db,input(),{now:now(T1)});
      if(kind==='artifact')db.exec("UPDATE work_source_artifacts SET content=x'00'");
      if(kind==='fact')db.exec("UPDATE work_source_fact_blobs SET fact_json='{}'");
      if(kind==='membership')db.exec('DELETE FROM work_source_version_facts WHERE ordinal=1');
      assert.throws(()=>commitWorkSourceEdition(db,input(),{now:now(T1)}),/corrupt/);
    }finally{db.close();}
  }
});

test('invalid or future clocks never create a source observation',t=>{
  const db=open(t);
  for(const value of ['2026-02-30T00:00:00.000Z',null,'2026-10-29T03:00:00.000Z']){
    const x=input();x.readAt=value;assert.throws(()=>commitWorkSourceEdition(db,x,{now:now(T1)}),/clock/);
  }
});
