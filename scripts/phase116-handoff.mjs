import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:36:55Z'));
const source='/tmp/phase116-integrity-VKHbTJ',sealName='completion-check-seal.json',bytes=await readFile(join(source,sealName));assert.equal(sha(bytes),'b151a755b3479b55ba13d436bf5921f117c471a0c8b9602898cffd8d837637f0');
const seal=JSON.parse(bytes),destination=join(root,'docs/phase116-evidence/completion');await mkdir(destination,{recursive:true});const archived=[];
for(const row of seal.files){assert.ok(!row.file.includes('/')&&!row.file.includes('..'));const b=await readFile(join(source,row.file));assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);const file=join(destination,row.file);await copyFile(join(source,row.file),file,constants.COPYFILE_EXCL);await chmod(file,0o400);assert.equal(sha(await readFile(file)),row.sha256);archived.push({file,bytes:b.length,sha256:row.sha256});}
const sealFile=join(destination,sealName);await copyFile(join(source,sealName),sealFile,constants.COPYFILE_EXCL);await chmod(sealFile,0o400);archived.push({file:sealFile,sha256:sha(await readFile(sealFile))});
const bindings=await readFile(join(root,'data/maintenance-journal/2026-10-02-phase116-reviewed-bindings.json'));assert.equal(sha(bindings),seal.receiptSHA256);
const proof=JSON.parse(bindings);for(const row of proof.completions){assert.equal(sha(await readFile(row.file)),row.sha256);assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${row.runId}.json`))),row.originalSHA256);}for(const row of proof.evidence)assert.equal(sha(await readFile(row.file)),row.sha256);
await chmod(join(root,'data/maintenance-journal/2026-10-02-phase116-site-final-safe.json'),0o400);
const stopPath=join(root,'data/maintenance-journal/2026-10-02-phase116-stop.json'),stopBytes=await readFile(stopPath),stop=JSON.parse(stopBytes);assert.equal(stop.goalComplete,false);assert.equal(stop.fixedReviewed,20);
const finishedAt=new Date().toISOString(),actualElapsedSeconds=(Date.parse(finishedAt)-Date.parse('2026-10-02T11:06:55Z'))/1000;assert.ok(actualElapsedSeconds<1800);
const result={finishedAt,actualElapsedSeconds,withinThirtyMinutes:true,archived,independentCompletionVerifiedAt:seal.sealedAt,reviewed:20,evidence:20,originalsUnchanged:true,previousStopSHA256:sha(stopBytes),previousStopAt:stop.finishedAt,remaining:stop.remaining,newProductEditsAfterFreeze:false,lateDiagnosticFailure:'Noninteractive stdin immediately closed and created empty safe-site diagnostic; empty file recoverably renamed with -empty-stdin-attempt suffix; fresh correct whitelist receipt from native Sites readback preserved separately. No credential or data changed.',scopeUnchanged:'U01-U47',goalComplete:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase116-handoff.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({finishedAt,actualElapsedSeconds,independentFilesArchived:archived.length,reviewed:20,next:2867,withinThirtyMinutes:true}));
