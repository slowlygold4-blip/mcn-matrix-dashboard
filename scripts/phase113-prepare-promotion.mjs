import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const source='/tmp/phase113-point-reading-gDQp0k';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T10:05:00Z'));
const manifest=JSON.parse(await readFile(join(source,'manifest.json')));
const log=await readFile(join(source,'full-final.log'));
const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(k=>[k,Number(log.toString().match(new RegExp('(?:#|ℹ) '+k+' (\\d+)'))?.[1])]));
assert.ok(counts.tests>=4305);assert.equal(counts.pass,counts.tests);assert.equal(counts.fail,0);assert.equal(counts.cancelled,0);assert.equal(counts.skipped,0);
const baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase113-code-baseline.json')));
for(const row of baseline.entries) assert.equal(sha(await readFile(join(root,row.file))),row.sha256,row.file);
const rows=manifest.files;assert.ok(Array.isArray(rows));
assert.deepEqual(rows.filter(r=>r.beforeSHA256).map(r=>r.file).sort(),['public/rebuild.css','public/rebuild.js']);
assert.ok(rows.filter(r=>!r.beforeSHA256).every(r=>/^test\/phase113-[a-z-]+\.test\.mjs$/.test(r.file)));
const parts=['*** Begin Patch'];
for(const row of rows){
 const nextPath=row.source||join(source,'main',row.file),bytes=await readFile(nextPath);assert.equal(sha(bytes),row.afterSHA256,row.file);
 if(row.beforeSHA256){
  assert.equal(sha(await readFile(join(root,row.file))),row.beforeSHA256,row.file);
  assert.equal(sha(await readFile(join(root,'data/code-candidates/phase113/preimage',row.file))),row.beforeSHA256,row.file);
  let diff;try{execFileSync('diff',['-u',join(root,row.file),nextPath],{encoding:'utf8'});}catch(e){assert.equal(e.status,1);diff=e.stdout;}
  assert.ok(diff);parts.push('*** Update File: '+join(root,row.file));
  parts.push(diff.split('\n').slice(2).filter(l=>!l.startsWith('\\ No newline')).map(l=>l.startsWith('@@')?'@@':l).join('\n').trimEnd());
 }else{
  try{await readFile(join(root,row.file));assert.fail('New target already exists');}catch(e){assert.equal(e.code,'ENOENT');}
  parts.push('*** Add File: '+join(root,row.file));parts.push(bytes.toString().trimEnd().split('\n').map(l=>'+'+l).join('\n'));
 }
}
parts.push('*** End Patch');
const archive=join(root,'docs/phase113-evidence/candidate');await mkdir(archive,{recursive:true});
for(const name of ['manifest.json','candidate.patch','full-regression.log','full-final.log','review.md','completion.json']){
 const bytes=await readFile(join(source,name));await writeFile(join(archive,name),bytes,{flag:'wx',mode:0o400});
 assert.equal(sha(await readFile(join(archive,name))),sha(bytes));
}
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase113-approved-files.json'),JSON.stringify({approvedAt:new Date().toISOString(),rows,candidateTests:counts.tests,candidateFullSHA256:sha(log),noBackendChanges:true},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({patch:parts.join('\n'),counts}));
