import test from 'node:test';
import assert from 'node:assert/strict';
import {MonitorDatabase} from '../lib/database.mjs';
import {readPublicTableFoundation} from '../lib/public-table-foundation.mjs';
import {tableFoundationPartitions} from '../lib/public-table-foundation.mjs';
import {auditFoundationPublication,foundationPartValid} from '../lib/replica-foundation.mjs';
import {createHash} from 'node:crypto';
const at='2026-10-29T06:00:00.000Z';
function fixture(t){
 const database=new MonitorDatabase(':memory:');t.after(()=>database.close());const db=database.db;
 db.exec(`CREATE TABLE creator_source_imports(id INTEGER,source_sha256 TEXT,source_url TEXT,source_revision TEXT,source_modified_at TEXT,imported_at TEXT,metadata_json TEXT,source_row_count INTEGER);
 CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);
 CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,sheet_name TEXT,row_count INTEGER,restricted INTEGER,headers_json TEXT);
 CREATE TABLE creator_source_account_links(import_id INTEGER,author_row INTEGER,target_id INTEGER,matched_id TEXT,matched_at TEXT);
 CREATE TABLE creator_source_work_links(import_id INTEGER,work_row INTEGER,target_id INTEGER);`);
 const imported=id=>db.prepare('INSERT INTO creator_source_imports VALUES(?,?,?,?,?,?,?,?)').run(id,'a'.repeat(64),'https://private.feishu.cn/sheets/secret','1','2026-10-21T00:00:00Z',id===1?'2026-10-22T00:00:00Z':'2026-10-30T00:00:00Z','{}',3);
 imported(1);
 const row=(sheet,number,values,importId=1)=>db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(importId,sheet,number,JSON.stringify(values));
 row('08',2,['作者A','a_id',null,null,null,null,1,1,0,0,0,100,2,null,null]);
 row('09',2,['7300000000000000001']);
 const observation=(index,likes,plays,time)=>{const values=Array(14).fill(null);values[2]='作者A';values[3]='a_id';values[5]=String(7300000000000000001n+BigInt(index));values[8]=likes;values[9]=plays;values[13]=time;row('10',index+2,values);};
 const job=(id,time,rows,extra={})=>db.prepare(`INSERT INTO author_resolution_jobs(id,actor_name,client_ip,file_name,sheet_name,status,phase,total_authors,request_json,created_at,finished_at,updated_at) VALUES(?,'fixture','local','fixture.xlsx','','completed','done',?,?,?,?,?)`)
  .run(id,rows.length,JSON.stringify({fileName:'fixture.xlsx',sourceUrl:'https://private.feishu.cn/sheets/'+id,sourceTitle:'资料 cookie=PRIVATE_SECRET https://private.feishu.cn/docx/secret',sourceRevision:1,rows,...extra}),time,time,time);
 return {db,imported,row,observation,job,read:(cutoff=at,options={})=>readPublicTableFoundation(db,cutoff,options)};
}
test('supplementary sources come from the current DB without writes, zero-filling or metadata-only target bindings',t=>{
 const {db,job,observation,read}=fixture(t);
 job('one','2026-10-28T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'新增作者',douyinId:'new_id',videoId:'7300000000000000002'}]);
 observation(0,0,0,'2026-10-23T00:00:00Z');observation(1,null,'',null);
 db.prepare("INSERT INTO targets(type,label,locator,provider,metadata_json,created_at,updated_at) VALUES('account','untrusted','MS4wLjABAAAAFalseHandleOnly','public-web',?,'2026-10-01','2026-10-01')").run(JSON.stringify({douyinId:'new_id'}));
 const changes=db.prepare('SELECT total_changes() n').get().n,result=read();
 assert.equal(result.stats.additionalAuthors,1);assert.equal(result.stats.additionalWorks,1);assert.deepEqual(result.authors[0].targetIds,[]);
 assert.deepEqual(result.observations.map(o=>[o.likes,o.plays,o.observedAt]),[[0,0,null],[null,null,null]]);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 for(const forbidden of ['PRIVATE_SECRET','private.feishu.cn','metadata_json','sourceUrl'])assert.equal(JSON.stringify(result).includes(forbidden),false,forbidden);
});

test('completed source history is streamed while revision selection remains exact',t=>{
 const {db,job}=fixture(t),common={sourceUrl:'https://private.feishu.cn/sheets/same-source'};
 job('first','2026-10-25T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'older',douyinId:'old_id'}],{...common,sourceRevision:2});
 job('second','2026-10-26T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'latest',douyinId:'latest_id'}],{...common,sourceRevision:3});
 job('third','2026-10-27T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'lower',douyinId:'lower_id'}],{...common,sourceRevision:1});
 let iterators=0,visited=0,payloadReads=0;
 const wrapped={
  get isTransaction(){return db.isTransaction;},exec:db.exec.bind(db),
  prepare(sql){
   const statement=db.prepare(sql);
   if(sql.startsWith('SELECT id,created_at,finished_at,')&&sql.includes('FROM author_resolution_jobs'))return {
    all(){throw Error('eager-source-history-read');},
    *iterate(...args){iterators++;for(const row of statement.iterate(...args)){visited++;yield row;}}
   };
   if(sql==='SELECT request_json FROM author_resolution_jobs WHERE id=?')return {get(...args){payloadReads++;return statement.get(...args);}};
   return statement;
  }
 };
 const result=readPublicTableFoundation(wrapped,at);
 assert.equal(iterators,1);assert.equal(visited,3);
 assert.equal(payloadReads,1,'only the selected source edition materializes its complete registration rows');
 assert.deepEqual(result.authors.map(row=>row.douyinId),['latest_id']);
 assert.equal(result.stats.sourceDocuments,1);
});

test('duplicate JSON metadata keys and row fields preserve the original last-key semantics',t=>{
 const {db,job,read}=fixture(t),url='https://private.feishu.cn/sheets/duplicate-key-source';
 const entry=id=>({platform:'douyin',board:'一条小团团切片矩阵',name:'fixture',douyinId:id});
 job('baseline','2026-10-25T00:00:00Z',[entry('baseline_id')],{sourceUrl:url,sourceRevision:2});
 job('duplicate','2026-10-26T00:00:00Z',[],{});
 const replace=raw=>db.prepare('UPDATE author_resolution_jobs SET request_json=? WHERE id=?').run(raw,'duplicate');
 replace('{"sourceUrl":'+JSON.stringify(url)+',"sourceRevision":100,"sourceRevision":1,"rows":'+JSON.stringify([entry('wrong_id')])+'}');
 assert.deepEqual(read().authors.map(row=>row.douyinId),['baseline_id']);
 replace('{"sourceUrl":'+JSON.stringify(url)+',"sourceRevision":3,"rows":null,"rows":'+JSON.stringify([entry('last_rows_id')])+'}');
 assert.deepEqual(read().authors.map(row=>row.douyinId),['last_rows_id']);
 replace('{"sourceUrl":'+JSON.stringify(url)+',"sourceRevision":3,"rows":'+JSON.stringify([entry('wrong_id')])+',"rows":null}');
 assert.deepEqual(read().authors.map(row=>row.douyinId),['baseline_id']);
 replace('{"sourceUrl":'+JSON.stringify(url)+',"sourceRevision":3,"rows":'+JSON.stringify([entry('wrong_id')])+',"ro\\u0077s":null}');
 assert.deepEqual(read().authors.map(row=>row.douyinId),['baseline_id']);
});

test('malformed jobs and non-array rows retain the original inclusion rules',t=>{
 const {db,job,read}=fixture(t);
 job('valid','2026-10-25T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'fixture',douyinId:'valid_id'}]);
 job('invalid','2026-10-26T00:00:00Z',[],{});
 for(const raw of ['{broken','123','[]','{"rows":null}','{"rows":{}}']){
  db.prepare('UPDATE author_resolution_jobs SET request_json=? WHERE id=?').run(raw,'invalid');
  assert.deepEqual(read().authors.map(row=>row.douyinId),['valid_id']);
 }
 // A null top-level payload used to fail the projection. Optimization must
 // not silently convert that existing source-integrity failure into success.
 db.prepare('UPDATE author_resolution_jobs SET request_json=? WHERE id=?').run('null','invalid');
 assert.throws(()=>read(),TypeError);
});
test('future jobs, imports and metric observations cannot enter an earlier export cutoff',t=>{
 const {imported,row,observation,job,read}=fixture(t);
 imported(2);row('08',2,['未来作者','future_id',null,null,null,null,1,1,0,0,0,200,3,null,null],2);
 job('future','2026-10-30T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'未来作者',douyinId:'future_id'}]);
 observation(0,999,999,'2026-10-30T00:00:00Z');
 const result=read();assert.equal(result.stats.baseAuthors,1);assert.equal(result.stats.sourceDocuments,0);assert.equal(result.stats.sourceMetricObservations,0);assert.equal(JSON.stringify(result).includes('future_id'),false);
});

test('original column header determines whether a timestamp is submission or measurement evidence',t=>{
 const {db,observation,read}=fixture(t);
 const headers=Array(14).fill('');headers[13]='提交时间';
 db.prepare('INSERT INTO creator_source_sheets(import_id,sheet_id,sheet_name,row_count,restricted,headers_json) VALUES(1,\'10\',\'作品记录\',1,0,?)').run(JSON.stringify(headers));
 observation(0,5,50,'2026-10-23T00:00:00Z');
 const submitted=read().observations[0];assert.equal(submitted.observedAt,null);assert.equal(submitted.recordedAt,'2026-10-23T00:00:00.000Z');assert.equal(submitted.timeBasis,'submission-time');
 headers[13]='指标采样时间';db.prepare('UPDATE creator_source_sheets SET headers_json=?').run(JSON.stringify(headers));
 const measured=read().observations[0];assert.equal(measured.timeBasis,'metric-observation');assert.equal(measured.observedAt,measured.recordedAt);
});
test('publication clocks alone do not create a new content revision; changing a source does',t=>{
 const {job,read}=fixture(t),first=read();
 assert.equal(read('2026-10-29T07:00:00.000Z').revision,first.revision);
 job('new','2026-10-29T05:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'作者B',douyinId:'b_id'}]);
 assert.notEqual(read().revision,first.revision);
});
test('all foundation partitions, observation semantics and their common revision are sealed',async t=>{
 const {db,job,observation}=fixture(t);
 job('one','2026-10-28T00:00:00Z',[{platform:'douyin',board:'一条小团团切片矩阵',name:'作者B',douyinId:'b_id'}]);
 observation(0,0,null,null);
 const parts=tableFoundationPartitions(db,at),files=parts.map(({path,kind,count,...body})=>{
  const content=JSON.stringify({version:1,asOf:at,timeZone:'Asia/Shanghai',...body})+'\n';
  return {path,kind,count,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex'),content};
 });
 const publication={manifest:{asOf:at,files:files.map(({content,...m})=>m)},readPart:async path=>JSON.parse(files.find(f=>f.path===path).content)};
 for(const file of files)assert.equal(foundationPartValid(JSON.parse(file.content),file,at),true,file.path);
 assert.equal((await auditFoundationPublication(publication)).authors,1);
 const observations=files.find(f=>f.path==='foundation/observations.json'),changed=JSON.parse(observations.content);changed.items[0].plays=0;observations.content=JSON.stringify(changed);
 await assert.rejects(auditFoundationPublication(publication),/revision-conflict/);
});
