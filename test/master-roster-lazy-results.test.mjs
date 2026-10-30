import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {buildMasterRosterSnapshot,installMasterRoster,readMasterRoster} from '../lib/master-roster.mjs';
const SEC='MS4wLjABAAAAcanonicalfixture123456';
function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
 CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,file_name TEXT,sheet_name TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,result_json TEXT);`);
 db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(1,'account','{"platform":"douyin"}',SEC,'current name',0);
 installMasterRoster(db,buildMasterRosterSnapshot({exportedAt:'2026-10-02T19:00:00Z',entities:[
  {key:'submitted:frozen',platform:'douyin',names:['frozen'],ids:['frozen_id'],sources:[]},
 ]},{fileName:'frozen.xlsx',sha256:'a'.repeat(64)}));
 return db;
}
function job(db,rows,result,{id='latest',url='https://example.feishu.cn/wiki/current'}={}){
 db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run(id,'source.json','sheet','completed',
  '2026-10-08T17:00:00Z','2026-10-08T17:01:00Z',JSON.stringify({sourceType:'lark-bitable',sourceUrl:url,
   sourceSheetId:'table1',sourceReadAt:'2026-10-08T17:00:00Z',sourceTitle:'fixture source',sheetName:'sheet',rows}),
  typeof result==='string'?result:JSON.stringify(result));
}
function traced(db){
 const trace={resultReads:0,resultBytes:0};
 const wrapped=new Proxy(db,{get(target,key){
  if(key==='prepare')return sql=>{const stmt=target.prepare(sql);if(!/SELECT\s+(?:request_json\s*,\s*)?result_json\s+FROM author_resolution_jobs WHERE id=\?/i.test(sql))return stmt;
   return new Proxy(stmt,{get(s,k){if(k==='get')return(...args)=>{const row=s.get(...args);trace.resultReads++;trace.resultBytes+=Buffer.byteLength(row?.result_json??'');return row;};const v=Reflect.get(s,k,s);return typeof v==='function'?v.bind(s):v;}});
  };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});return {db:wrapped,trace};
}
const ready=()=>({sourceRow:1,platform:'douyin',name:'source name',locator:SEC,status:'ready'});
const receipt=()=>({ok:true,created:[{id:1,locator:SEC,metadata:{platform:'douyin'}}]});

test('ID-only sources do not fetch or decode multi-megabyte job results and never bind by mutable metadata',t=>{
 const db=setup(t);job(db,[{sourceRow:1,name:'registered',douyinId:'registered_id'}],{ok:true,padding:'x'.repeat(2*1024*1024)});
 const reader=traced(db),before=db.prepare('SELECT total_changes() n').get().n;
 const value=readMasterRoster(reader.db);assert.equal(reader.trace.resultReads,0);assert.equal(reader.trace.resultBytes,0);
 assert.equal(value.items.find(x=>x.accountIds.includes('registered_id')).targetId,null);
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});

test('eligible canonical-only rows share exactly one job-result read and preserve current pause/name/source rows',t=>{
 const db=setup(t);job(db,[ready(),{...ready(),sourceRow:2,name:'second alias'}],receipt());
 const reader=traced(db),value=readMasterRoster(reader.db),bound=value.items.find(x=>x.targetId===1);
 assert.equal(reader.trace.resultReads,1);assert.equal(bound.name,'current name');assert.equal(bound.monitorStatus,'paused');
 assert.deepEqual(bound.sources[0].rows,['1','2']);assert.equal(bound.liveSourceBinding.kind,'completed-job-canonical-target');
});

test('missing/ambiguous locators and excluded rows cannot force a large result read',t=>{
 const db=setup(t);db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(2,'account','{"platform":"douyin"}',SEC,'duplicate',1);
 job(db,[ready(),{sourceRow:2,name:'name only'},{...ready(),sourceRow:3,status:'identity_conflict'},
  {...ready(),sourceRow:4,locator:'https://evil.test/user/'+SEC}],receipt());
 const reader=traced(db),value=readMasterRoster(reader.db);
 assert.equal(reader.trace.resultReads,0);assert.ok(value.items.filter(x=>x.liveSource).every(x=>x.targetId===null));
});

test('malformed canonical locators cannot throw or force a receipt read',t=>{
 const db=setup(t);job(db,[null,{},[],42,{toString:null}].map((locator,index)=>({sourceRow:index+1,name:'registered',locator})),{ok:false});
 const reader=traced(db),value=readMasterRoster(reader.db);
 assert.equal(reader.trace.resultReads,0);
 assert.ok(value.items.filter(x=>x.liveSource).every(x=>x.targetId===null));
});

test('malformed or unsuccessful results are read at most once and never promote canonical rows',t=>{
 for(const result of ['{broken',null,{ok:false},{created:receipt().created}]){
  const id='job-'+String(result?.ok??typeof result),url='https://example.feishu.cn/wiki/'+id;
  const db=setup(t);job(db,[ready(),{...ready(),sourceRow:2}],result,{id,url});
  const reader=traced(db),value=readMasterRoster(reader.db);assert.equal(reader.trace.resultReads,1);
  assert.ok(value.items.filter(x=>x.liveSource).every(x=>x.targetId===null));
 }
});

test('one job result is never reused for a different source job',t=>{
 const db=setup(t);const other='MS4wLjABAAAAanothercanonicalfixture123456';
 db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?)').run(2,'account','{"platform":"douyin"}',other,'other',1);
 job(db,[ready()],receipt(),{id:'a',url:'https://example.feishu.cn/wiki/a'});
 job(db,[{...ready(),locator:other,name:'unproved'}],{ok:false},{id:'b',url:'https://example.feishu.cn/wiki/b'});
 const reader=traced(db),value=readMasterRoster(reader.db);assert.equal(reader.trace.resultReads,2);
 assert.ok(value.items.some(x=>x.targetId===1));assert.equal(value.items.some(x=>x.targetId===2),false);
});

test('a later read observes edited receipts and never retains a successful binding in a process cache',t=>{
 const db=setup(t);job(db,[ready()],receipt());
 const reader=traced(db);assert.ok(readMasterRoster(reader.db).items.some(x=>x.targetId===1));
 db.prepare('UPDATE author_resolution_jobs SET result_json=? WHERE id=?').run('{"ok":false}','latest');
 assert.equal(readMasterRoster(reader.db).items.some(x=>x.targetId===1),false);assert.equal(reader.trace.resultReads,2);
});
