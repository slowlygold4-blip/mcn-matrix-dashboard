import {publishedFixture} from './helpers/published-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTableFoundationManifest} from '../lib/table-foundation-manifest.mjs';

const current=()=>publishedFixture().foundation;

test('published foundation validates without mutation or a fixed number of sheets',()=>{
 const index=current(),before=structuredClone(index);
 assert.equal(validateTableFoundationManifest(index),index);
 assert.deepEqual(index,before);
 index.sheetCoverage.push({id:'21',name:'新增登记表',rows:12,restricted:false});
 index.stats.sheets=index.sheetCoverage.length;
 assert.equal(validateTableFoundationManifest(index),index);
 index.sheetCoverage=[];index.stats.sheets=0;
 assert.equal(validateTableFoundationManifest(index),index);
});

test('additional sealed JSON partitions are compatible with the six required partitions',()=>{
 const index=current();
 index.files.push({path:'future/author-aliases.json',count:0,bytes:100,sha256:'a'.repeat(64)});
 index.stats.futureInformation='non-count extension';
 assert.equal(validateTableFoundationManifest(index),index);
});

test('sheet count mismatch, duplicate identity and invalid sheet metadata fail clearly',()=>{
 const cases=[
  [x=>x.stats.sheets++,/实际数量/],
  [x=>x.sheetCoverage[1].id=x.sheetCoverage[0].id,/ID 重复/],
  [x=>x.sheetCoverage[0].id='',/工作表信息/],
  [x=>x.sheetCoverage[0].rows=-1,/工作表信息/],
  [x=>x.sheetCoverage[0].restricted='false',/工作表信息/],
 ];
 for(const [change,message] of cases){const index=current();change(index);assert.throws(()=>validateTableFoundationManifest(index),message);}
});

test('required partitions and their declared statistics cannot be omitted or drift apart',()=>{
 for(const path of ['authors.json','works.json','sources.json','observations.json','other-authors.json','other-works.json']){
  const missing=current();missing.files=missing.files.filter(file=>file.path!==path);
  assert.throws(()=>validateTableFoundationManifest(missing),/缺少/);
  const drift=current();drift.files.find(file=>file.path===path).count++;
  assert.throws(()=>validateTableFoundationManifest(drift),/记录数量不符/);
 }
});

test('duplicate paths, unsafe paths and invalid seals are rejected even on extra partitions',()=>{
 const duplicate=current();duplicate.files.push({...duplicate.files[0]});
 assert.throws(()=>validateTableFoundationManifest(duplicate),/路径重复/);
 for(const invalidPath of ['../outside.json','/outside.json','https://example.com/x.json','nested//file.json','./file.json','file.json?x=1','%2e%2e/out.json']){
  const index=current();index.files.push({...index.files[0],path:invalidPath});
  assert.throws(()=>validateTableFoundationManifest(index),/分区路径/);
 }
 for(const [field,value] of [['count',null],['count',-1],['count',0.5],['bytes',0],['bytes','12'],['sha256','bad']]){
  const index=current();index.files[0][field]=value;
  assert.throws(()=>validateTableFoundationManifest(index),/校验信息/);
 }
});

test('schema and counts fail closed without interpreting missing values as zero',()=>{
 for(const value of [null,{},[],{version:2}])assert.throws(()=>validateTableFoundationManifest(value),/版本/);
 for(const value of [null,undefined,-1,1.5,'20',Number.MAX_SAFE_INTEGER+1]){
  const index=current();index.stats.sheets=value;
  assert.throws(()=>validateTableFoundationManifest(index),/非负整数/);
 }
 for(const field of ['revision','generatedAt']){const index=current();index[field]='';assert.throws(()=>validateTableFoundationManifest(index),/修订或生成时间/);}
 const invalidTime=current();invalidTime.generatedAt='not-a-date';assert.throws(()=>validateTableFoundationManifest(invalidTime),/生成时间/);
});

test('pending author partition is optional for older revisions, but sealed when declared',()=>{
 const old=current();
 delete old.stats.pendingAuthors;
 old.files=old.files.filter(file=>file.path!=='pending-authors.json');
 assert.equal(validateTableFoundationManifest(old),old);
 const newer=structuredClone(old);
 newer.stats.pendingAuthors=141;
 newer.files.push({path:'pending-authors.json',count:141,bytes:512,sha256:'b'.repeat(64)});
 assert.equal(validateTableFoundationManifest(newer),newer);
 const missing=structuredClone(newer);missing.files.pop();
 assert.throws(()=>validateTableFoundationManifest(missing),/待核验作者分区/);
 const mismatch=structuredClone(newer);mismatch.files.at(-1).count=140;
 assert.throws(()=>validateTableFoundationManifest(mismatch),/数量不符/);
});
