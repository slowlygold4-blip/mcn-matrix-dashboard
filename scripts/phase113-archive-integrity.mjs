import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const source='/tmp/phase113-integrity-73VMSO',archive=join(root,'docs/phase113-evidence/integrity');
const sha=b=>createHash('sha256').update(b).digest('hex');
const fileSHA=async path=>{const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');};
const signedBytes=await readFile(join(source,'signed-receipt.json'));
assert.equal(sha(signedBytes),'3574622fcb8556de223f0dcc321b70cf1a39f3ffdae4cfffbb5cf7577d15d38c');
const signed=JSON.parse(signedBytes);
assert.deepEqual(signed.fixedRunIds,Array.from({length:20},(_,i)=>2807+i));
await mkdir(archive,{recursive:true});const evidence=[];
for(const name of [...Object.keys(signed.files),'signed-receipt.json']){
  assert.ok(!name.includes('/'));const bytes=await readFile(join(source,name));
  if(signed.files[name])assert.equal(sha(bytes),signed.files[name]);
  await writeFile(join(archive,name),bytes,{flag:'wx',mode:0o400});
  assert.equal(sha(await readFile(join(archive,name))),sha(bytes));
  evidence.push({file:join(archive,name),sha256:sha(bytes),bytes:bytes.length});
}
for(const original of signed.originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${original.runId}.json`))),original.sha256);
const receipt=JSON.parse(await readFile(join(source,'backup.json')));
const restored=join(source,'restored.sqlite');assert.equal(await fileSHA(restored),receipt.sha256);
assert.equal((await stat(restored)).size,receipt.bytes);
const db=new DatabaseSync(restored,{readOnly:true}),restore={};
try{
 db.exec('PRAGMA query_only=ON;BEGIN');assert.equal(db.prepare('SELECT total_changes() n').get().n,0);
 restore.quickCheck=db.prepare('PRAGMA quick_check').get().quick_check;assert.equal(restore.quickCheck,'ok');
 restore.integrityCheck=db.prepare('PRAGMA integrity_check').get().integrity_check;assert.equal(restore.integrityCheck,'ok');
 restore.foreignKeyViolations=db.prepare('PRAGMA foreign_key_check').all().length;assert.equal(restore.foreignKeyViolations,0);
 restore.counts=Object.fromEntries(Object.keys(receipt.validation.counts).map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
 assert.deepEqual(restore.counts,receipt.validation.counts);assert.equal(db.prepare('SELECT total_changes() n').get().n,0);db.exec('ROLLBACK');
}finally{db.close();}
assert.equal(await fileSHA(restored),receipt.sha256);
const result={checkedAt:new Date().toISOString(),evidence,originals:signed.originals,restored,
 backupPath:receipt.backupPath,backupSHA256:receipt.sha256,bytes:receipt.bytes,restore,
 persistentDatabaseCopyCreated:false,reason:'Existing data/backups about70GiB; preserve originals and verified private consistent snapshot without another long-term duplicate',
 mainDatabaseWrites:false,originalEventsEdited:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase113-integrity-archive.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({checkedAt:result.checkedAt,evidenceFiles:evidence.length,originals:signed.originals.length,bytes:receipt.bytes,tables:Object.keys(restore.counts).length,persistentDatabaseCopyCreated:false}));
