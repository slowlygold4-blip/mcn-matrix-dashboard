import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)), source='/tmp/phase111-reading-D61sD2';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T09:31:08Z'));
const manifest=JSON.parse(await readFile(join(source,'manifest.json')));
const log=await readFile(join(source,'full-regression.log'));
assert.match(log.toString(),/ℹ tests 4298\s+ℹ suites 0\s+ℹ pass 4298\s+ℹ fail 0\s+ℹ cancelled 0\s+ℹ skipped 0/);
const archive=join(root,'docs/phase111-evidence/candidate'); await mkdir(archive,{recursive:true});
for(const name of ['manifest.json','candidate.patch','full-regression.log','original-red-v2.log','new-green-v3.log']) {
  const bytes=await readFile(join(source,name));await writeFile(join(archive,name),bytes,{flag:'wx',mode:0o400});assert.equal(sha(await readFile(join(archive,name))),sha(bytes));
}
const rows=[...manifest.files]; rows.push({file:'test/phase111-reading-browser.test.mjs',beforeSHA256:null,afterSHA256:'af71acb99102234756d77ac20e3e7c13b2f8ff8da51fdadf2029ccf00793a2b7',source:'/tmp/phase111-runtime-dmfhYK/phase111-reading-browser.test.mjs'});
const parts=['*** Begin Patch'];
for(const row of rows){
  const nextPath=row.source||join(source,'main',row.file), bytes=await readFile(nextPath);assert.equal(sha(bytes),row.afterSHA256,row.file);
  if(row.beforeSHA256){
    assert.equal(sha(await readFile(join(root,row.file))),row.beforeSHA256,row.file);
    assert.equal(sha(await readFile(join(root,'data/code-candidates/phase111/preimage',row.file))),row.beforeSHA256,row.file);
    let diff;try{execFileSync('diff',['-u',join(root,row.file),nextPath],{encoding:'utf8'});}catch(e){assert.equal(e.status,1);diff=e.stdout;}
    assert.ok(diff);parts.push('*** Update File: '+join(root,row.file));
    parts.push(diff.split('\n').slice(2).filter(line=>!line.startsWith('\\ No newline')).map(line=>line.startsWith('@@')?'@@':line).join('\n').trimEnd());
  }else{
    try{await readFile(join(root,row.file));assert.fail('New test target already exists');}catch(e){assert.equal(e.code,'ENOENT');}
    parts.push('*** Add File: '+join(root,row.file));parts.push(bytes.toString().trimEnd().split('\n').map(line=>'+'+line).join('\n'));
  }
}
parts.push('*** End Patch');
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase111-approved-files.json'),JSON.stringify({approvedAt:new Date().toISOString(),rows,candidateTests:4298,candidateFullSHA256:sha(log),noBackendChanges:true},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({patch:parts.join('\n')}));
