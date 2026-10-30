import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {projectCreatorAuthorFieldOrder,readCreatorAuthorRows,withCreatorAuthorFieldSnapshot} from '../lib/creator-author-field-order.mjs';
const row=(n,values)=>({row_number:n,values_json:JSON.stringify(values)});
const sheet=(id,headers)=>({sheet_id:id,headers_json:JSON.stringify(headers)});
function input(){return {imported:{id:1,source_sha256:'a'.repeat(64)},authors:[row(2,[123456789,'明确姓名','keep-alias',0,7])],sheets:[sheet('08',['作者名','主抖音号','账号别名']),sheet('14',['作者名','填报账号'])],evidenceRows:[{...row(4,['明确姓名','123456789']),sheet_id:'14'}]};}
test('explicit account/name field evidence corrects a displaced pair without editing original cells or hashes',()=>{
 const x=input(),before=JSON.stringify(x),y=projectCreatorAuthorFieldOrder(x);
 assert.equal(y.repairs.length,1);assert.equal(y.rows[0].values[0],'明确姓名');assert.equal(y.rows[0].values[1],'123456789');
 assert.deepEqual(y.rows[0].values.slice(2),['keep-alias',0,7]);assert.equal(y.rows[0].values_json,x.authors[0].values_json);
 assert.equal(y.repairs[0].evidence[0].row,4);assert.equal(y.repairs[0].evidence[0].rowSha256.length,64);
 assert.equal(JSON.stringify(x),before);assert.equal(y.rows[0].canonicalAuthorRow,2);
});
test('a nickname, missing proof, wrong header role, malformed row or conflicting claim cannot justify repair',()=>{
 const mutations=[x=>x.evidenceRows=[],x=>x.evidenceRows[0]= {...row(4,['另一人','123456789']),sheet_id:'14'},
  x=>x.evidenceRows.push({...row(5,['另一人','123456789']),sheet_id:'14'}),
  x=>x.sheets[1]=sheet('14',['作者名','微信号']),x=>x.sheets[1]=sheet('14',['作者名','填报账号','填报账号']),
  x=>x.sheets[0]=sheet('08',['账号','名字']),x=>x.authors[0]=row(2,['像昵称的中文','明确姓名']),
  x=>x.authors[0]={row_number:2,values_json:'broken'},x=>x.authors[0]=row(2,[9007199254740992,'明确姓名'])];
 for(const mutate of mutations){const x=input();mutate(x);assert.equal(projectCreatorAuthorFieldOrder(x).repairs.length,0);}
});
test('valid existing primary IDs are never swapped even when a proposed alternative looks plausible',()=>{
 const x=input();x.authors=[row(2,['123456789','already_valid'])];
 assert.deepEqual(projectCreatorAuthorFieldOrder(x).rows[0].values,['123456789','already_valid']);
});
test('same explicit pair folds only the repaired row into one original primary; conflicting originals remain untouched',()=>{
 const x=input();x.authors[0]=row(2,[123456789,'明确姓名','keep',null,null,null,0,0,0,0,0,0,0]);x.authors.push(row(9,['明确姓名','123456789','other-alias',50]));
 let y=projectCreatorAuthorFieldOrder(x);assert.equal(y.rows[0].canonicalAuthorRow,9);assert.equal(y.rows[1].canonicalAuthorRow,undefined);
 const measured=JSON.parse(x.authors[0].values_json);measured[12]=3;x.authors[0]=row(2,measured);y=projectCreatorAuthorFieldOrder(x);assert.equal(y.repairs.length,0);
 assert.equal(y.rejected[0].reason,'conflicting-original-identity');
 x.authors[0]=row(2,[123456789,'明确姓名','keep',null,null,null,0,0,0,0,0,0,0]);x.authors[1]=row(9,['明确姓名','123456789']);x.authors.push(row(10,['明确姓名','123456789']));assert.equal(projectCreatorAuthorFieldOrder(x).repairs.length,0);
});
test('leading zeros survive string IDs, repeated proofs do not duplicate authors, and unrelated proof changes do not rebind',()=>{
 const x=input();x.authors[0]=row(2,['00123456','明确姓名']);x.evidenceRows=[{...row(4,['明确姓名','00123456']),sheet_id:'14'}];
 x.evidenceRows.push({...row(5,['明确姓名','00123456']),sheet_id:'14'});
 const y=projectCreatorAuthorFieldOrder(x);assert.equal(y.rows[0].values[1],'00123456');assert.equal(y.repairs.length,1);assert.equal(y.repairs[0].evidence.length,2);
 const before=y.fingerprint;x.evidenceRows[0]= {...row(4,['明确姓名','different']),sheet_id:'14'};
 assert.notEqual(projectCreatorAuthorFieldOrder(x).fingerprint,before);
});
test('a renamed zero-only source alias uses its exact account ID, while names alone or measured contradictions cannot merge',()=>{
 const x=input();x.authors[0]=row(2,[123456789,'明确姓名','keep',null,null,null,0,0,0,0,0,0,0]);
 x.authors.push(row(9,['现在的显示名','123456789']));
 let y=projectCreatorAuthorFieldOrder(x);assert.equal(y.repairs.length,1);assert.equal(y.rows[0].canonicalAuthorRow,9);
 assert.equal(y.rows[0].values[0],'明确姓名');assert.equal(y.rows[1].values[0],'现在的显示名');
 const positive=JSON.parse(x.authors[0].values_json);positive[12]=1;x.authors[0]=row(2,positive);assert.equal(projectCreatorAuthorFieldOrder(x).repairs.length,0);
 x.authors[1]=row(9,['明确姓名','different_account']);y=projectCreatorAuthorFieldOrder(x);assert.equal(y.rows[0].canonicalAuthorRow,2,'matching names must not select a different account');
});
test('the real database reader is read only, scoped to one imported workbook, and legacy schema preserves raw identity',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,headers_json TEXT)');
 const x=input();for(const r of x.authors)db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(1,'08',r.row_number,r.values_json);
 for(const r of x.evidenceRows)db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(2,r.sheet_id,r.row_number,r.values_json);
 for(const s of x.sheets)db.prepare('INSERT INTO creator_source_sheets VALUES(?,?,?)').run(1,s.sheet_id,s.headers_json);
 const before=db.prepare('SELECT total_changes() n').get().n;assert.equal(readCreatorAuthorRows(db,x.imported).repairs.length,0);
 db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(1,'14',4,x.evidenceRows[0].values_json);
 const writes=db.prepare('SELECT total_changes() n').get().n;const y=readCreatorAuthorRows(db,x.imported);
 assert.equal(y.repairs.length,1);assert.equal(db.prepare('SELECT total_changes() n').get().n,writes);assert.equal(writes,before+1);
 db.exec('DROP TABLE creator_source_sheets');assert.equal(readCreatorAuthorRows(db,x.imported).rows[0].values[0],123456789);
});

test('snapshot reuse is immutable, bounded to the transaction and invalidates writes and schema changes',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE creator_source_rows(import_id INTEGER,sheet_id TEXT,row_number INTEGER,values_json TEXT);CREATE TABLE creator_source_sheets(import_id INTEGER,sheet_id TEXT,headers_json TEXT)');
 const x=input();for(const r of [...x.authors.map(r=>({...r,sheet_id:'08'})),...x.evidenceRows])db.prepare('INSERT INTO creator_source_rows VALUES(?,?,?,?)').run(1,r.sheet_id,r.row_number,r.values_json);
 for(const s of x.sheets)db.prepare('INSERT INTO creator_source_sheets VALUES(?,?,?)').run(1,s.sheet_id,s.headers_json);
 const prepare=db.prepare.bind(db);let scans=0;
 db.prepare=sql=>{if(sql.includes("sheet_id='08'"))scans++;return prepare(sql);};
 db.exec('BEGIN');withCreatorAuthorFieldSnapshot(db,()=>{
  const first=readCreatorAuthorRows(db,x.imported);for(let i=0;i<30;i++)assert.equal(readCreatorAuthorRows(db,x.imported),first);
  assert.equal(scans,1);assert.equal(Object.isFrozen(first.rows[0].values),true);assert.throws(()=>{first.rows[0].values[1]='forged';},TypeError);
  db.prepare("UPDATE creator_source_rows SET values_json=? WHERE sheet_id='14'").run(JSON.stringify(['另一人','123456789']));
  const changed=readCreatorAuthorRows(db,x.imported);assert.equal(changed.repairs.length,0);assert.equal(scans,2);
  db.exec('DROP TABLE creator_source_sheets');assert.notEqual(readCreatorAuthorRows(db,x.imported),changed);assert.equal(scans,3);
 });db.exec('ROLLBACK');
 db.exec('BEGIN');withCreatorAuthorFieldSnapshot(db,()=>{assert.equal(readCreatorAuthorRows(db,x.imported).repairs.length,1);assert.equal(scans,4);});db.exec('ROLLBACK');
 readCreatorAuthorRows(db,x.imported);readCreatorAuthorRows(db,x.imported);assert.equal(scans,6,'no cache survives the caller snapshot scope');
});
