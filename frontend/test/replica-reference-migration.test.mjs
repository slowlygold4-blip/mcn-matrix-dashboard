import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{DatabaseSync}from'node:sqlite';
test('append-only storage-reference migration preserves existing generations and files',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec(readFileSync(new URL('../drizzle/0000_wild_mentallo.sql',import.meta.url),'utf8'));db.exec("INSERT INTO replica_files VALUES('old','catalog.json','sealed-hash',9);INSERT INTO replica_generations VALUES('old','{\"sealed\":true}','old-clock')");
 const before={files:db.prepare('SELECT * FROM replica_files').all(),generations:db.prepare('SELECT * FROM replica_generations').all()};
 db.exec(readFileSync(new URL('../drizzle/0001_swift_morph.sql',import.meta.url),'utf8'));
 assert.deepEqual({files:db.prepare('SELECT * FROM replica_files').all(),generations:db.prepare('SELECT * FROM replica_generations').all()},before);assert.equal(db.prepare('SELECT count(*) n FROM replica_file_references').get().n,0);assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0],'ok');
 }finally{db.close();}
});
