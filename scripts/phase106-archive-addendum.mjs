import assert from 'node:assert/strict';
import {readFile,copyFile,chmod,writeFile,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const entries=[
  ['runtime','post-install-independent-0713.json','2a6e0dcba8e9182db2a999a7d60c45aa171e797f9075eb792c0b866c70bad7ea'],
  ['runtime','post-install-addendum.md','711d46a113a9ee861ee17935bb681dbcc6edb74361f7213e3731146d6259949c']
];
const records=[];
for(const [group,name,expected] of entries){
 const from='/tmp/phase106-runtime-lPm8lo/'+name,to=join(root,'docs/phase106-evidence',group,name);
 const bytes=await readFile(from);assert.equal(sha(bytes),expected);
 await copyFile(from,to,constants.COPYFILE_EXCL);await chmod(to,0o400);
 assert.equal(sha(await readFile(to)),expected);records.push({from,to,bytes:bytes.length,sha256:expected});
}
for(const name of ['old-main-reject.tap','approved-candidate.tap']){
 const from='/tmp/phase106-integrity-WrHr5b/'+name,to=join(root,'docs/phase106-evidence/integrity',name);
 const bytes=await readFile(from);assert.equal(sha(await readFile(to)),sha(bytes));records.push({from,to,bytes:bytes.length,sha256:sha(bytes)});
}
await writeFile(join(root,'docs/phase106-evidence/addendum-archive.json'),JSON.stringify({at:new Date().toISOString(),records,originalSignedReportsUnchanged:true},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({records:records.length,originalSignedReportsUnchanged:true}));
