import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as XLSX from '@e965/xlsx';
import { syncWorkSourceWorkbook } from '../lib/work-source-sync.mjs';
import { readKnownWorkSourceFacts } from '../lib/work-source-store.mjs';

const T1='2026-10-29T02:00:00.000Z',T2='2026-10-29T03:00:00.000Z';
const url='https://fixture.feishu.cn/sheets/FixtureWorkbook123456';
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'mcn-source-sync-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const databasePath=join(directory,'fixture.sqlite');new DatabaseSync(databasePath).close();
  const state={revision:1,calls:[],infoCalls:0,changedDuringExport:false,changedRegion:false,truncated:false,clock:T1};
  const commandRunner=async(_command,args,options)=>{
    state.calls.push(args);
    let data;
    if(args[1]==='+workbook-info'){
      state.infoCalls++;
      data={token:'FixtureWorkbook123456',revision:state.revision+(state.changedDuringExport && state.infoCalls%2===0?1:0),modified_time:'2026-10-20T00:00:00.000Z',
        title:state.title || 'Fixture',sheets:[{sheet_id:'abc123',sheet_name:'作品'}]};
    }else if(args[1]==='+csv-get')data={revision:state.revision+(state.changedRegion?1:0),current_region:state.truncated?'A1:C50':'A1:C2'};
    else if(args[1]==='+workbook-export'){
      const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
        ['视频id','播放','点赞'],['7684947825248082873',20,3]]),'作品');
      writeFileSync(join(options.cwd,'source.xlsx'),XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}));data={};
    }else throw new Error('unexpected CLI path');
    return {stdout:JSON.stringify({ok:true,data})};
  };
  const run=options=>syncWorkSourceWorkbook({sourceUrl:url,databasePath,command:'/fixture-cli',commandRunner,
    now:()=>Date.parse(state.clock),...options});
  const countTables=()=>{const db=new DatabaseSync(databasePath,{readOnly:true});try{return db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;}finally{db.close();}};
  return {state,run,databasePath,countTables};
}

test('check mode observes metadata only and creates no source tables',async t=>{
  const f=fixture(t),result=await f.run({mode:'check'});
  assert.equal(result.status,'would-read');assert.equal(f.state.calls.length,1);assert.equal(f.countTables(),0);
});

test('preview reads the whole file and used region but never writes the database',async t=>{
  const f=fixture(t),result=await f.run({mode:'preview'});
  assert.equal(result.status,'would-import');assert.equal(result.factCount,1);assert.equal(result.contentImported,false);
  assert.equal(f.state.calls.filter(a=>a[1]==='+csv-get').length,1);assert.equal(f.countTables(),0);
});

test('commit requires a validated backup then retains original bytes and actual dates',async t=>{
  const f=fixture(t);let backups=0;
  const result=await f.run({mode:'commit',beforeCommit:async()=>{backups++;return {validated:true};}});
  assert.equal(backups,1);assert.equal(result.status,'imported');assert.equal(result.contentImported,true);
  const db=new DatabaseSync(f.databasePath,{readOnly:true});
  try{const saved=readKnownWorkSourceFacts(db,{asOf:T1});assert.equal(saved.facts[0].plays,20);
    assert.equal(saved.facts[0].metricDate,null);assert.equal(saved.facts[0].sourceReadAt,T1);}finally{db.close();}
});

test('unchanged editions skip full export and keep the old read time rather than fabricating a new observation',async t=>{
  const f=fixture(t),beforeCommit=async()=>({validated:true});await f.run({mode:'commit',beforeCommit});
  const before=f.state.calls.length;f.state.clock=T2;
  const again=await f.run({mode:'commit',beforeCommit:async()=>{throw new Error('unexpected second backup');}});
  assert.equal(again.status,'unchanged');assert.equal(again.sourceReadAt,T1);assert.equal(again.checkedAt,T2);
  assert.equal(f.state.calls.length-before,1);assert.equal(again.metadataOnlyCheck,true);
});

test('an edition change during region probes or export, or a truncated export, never imports partial data',async t=>{
  for(const field of ['changedDuringExport','changedRegion','truncated']){
    const f=fixture(t);f.state[field]=true;
    await assert.rejects(f.run({mode:'commit',beforeCommit:async()=>({validated:true})}),/changed|truncated/);
    assert.equal(f.countTables(),0);
  }
});

test('missing/failed backup approval prevents writes after preflight',async t=>{
  const f=fixture(t);
  await assert.rejects(f.run({mode:'commit'}),/verified-backup-required/);
  await assert.rejects(f.run({mode:'commit',beforeCommit:async()=>({validated:false})}),/verified-backup-required/);
  assert.equal(f.countTables(),0);
});

test('local stored evidence corruption cannot be hidden behind an unchanged cloud revision',async t=>{
  const f=fixture(t);await f.run({mode:'commit',beforeCommit:async()=>({validated:true})});
  const db=new DatabaseSync(f.databasePath);db.exec('DELETE FROM work_source_version_facts');db.close();
  const start=f.state.calls.length;
  await assert.rejects(f.run({mode:'preview'}),/corrupt/);
  assert.equal(f.state.calls.length-start,1);
});

test('unchanged cloud revision cannot hide a changed workbook identity or title',async t=>{
  const f=fixture(t);await f.run({mode:'commit',beforeCommit:async()=>({validated:true})});
  f.state.title='别的来源';
  await assert.rejects(f.run({mode:'check'}),/same-revision-metadata-drift/);
});
