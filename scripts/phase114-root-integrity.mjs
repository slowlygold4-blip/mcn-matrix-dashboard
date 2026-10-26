import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,copyFile,chmod} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {join,basename} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),privateRoot='/tmp/phase114-integrity-zu6cnY';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function shaFile(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');}
const startedAt=new Date().toISOString(),receiptBytes=await readFile(join(privateRoot,'signed-receipt.json'));
assert.equal(sha(receiptBytes),'51b73bf4ee424608a38d1e052b3d735942bf1a4cf32859d796b09c401e3918ab');
const receipt=JSON.parse(receiptBytes),archive=join(root,'docs/phase114-evidence/integrity');await mkdir(archive,{recursive:true});
const archived=[];
for(const [file,hash] of [...Object.entries(receipt.files),['signed-receipt.json',sha(receiptBytes)]]){
 assert.equal(file,basename(file));const from=join(privateRoot,file),to=join(archive,file);assert.equal(await shaFile(from),hash);
 await copyFile(from,to,constants.COPYFILE_EXCL);await chmod(to,0o400);assert.equal(await shaFile(to),hash);archived.push({file,hash});
}
const restore=JSON.parse(await readFile(join(archive,'restore-check.json'))),checks=[];
for(const old of restore.checks){
 assert.equal(await shaFile(old.path),receipt.restoredSHA256);const db=new DatabaseSync(old.path,{readOnly:true});
 const check={path:old.path,sha256:receipt.restoredSHA256};
 try{db.exec('PRAGMA query_only=ON;BEGIN');check.counts=Object.fromEntries(Object.keys(old.counts).map(table=>[table,db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));assert.deepEqual(check.counts,old.counts);
 check.quick=db.prepare('PRAGMA quick_check').all();check.integrity=db.prepare('PRAGMA integrity_check').all();assert.deepEqual(check.quick.map(x=>x.quick_check),['ok']);assert.deepEqual(check.integrity.map(x=>x.integrity_check),['ok']);
 check.foreignKeyViolations=db.prepare('PRAGMA foreign_key_check').all().length;check.totalChanges=db.prepare('SELECT total_changes() n').get().n;check.queryOnly=db.prepare('PRAGMA query_only').get().query_only;assert.equal(check.foreignKeyViolations,0);assert.equal(check.totalChanges,0);assert.equal(check.queryOnly,1);db.exec('ROLLBACK');}finally{db.close();}
 assert.equal(await shaFile(old.path),receipt.restoredSHA256);checks.push(check);
}
for(const row of receipt.originals)assert.equal(await shaFile(join(root,`data/ingestion-reviews/run-${row.runId}.json`)),row.sha256);
const result={startedAt,finishedAt:new Date().toISOString(),archived,checks,fixedRunIds:receipt.fixedRunIds,originalsUnchanged:true,noProductionDataWrites:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase114-root-integrity.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({finishedAt:result.finishedAt,archived:archived.length,checks:checks.length,events:receipt.fixedRunIds.length}));
