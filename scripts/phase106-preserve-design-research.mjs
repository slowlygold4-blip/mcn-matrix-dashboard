import {readFile,copyFile,chmod,writeFile,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const entries=[
 ['okx-data-presentation-review.md','b3f575be5b266a64e2ad6278680eeefe5585424438328a1cb18a80aba226f3d9'],
 ['okx-data-presentation-sources.json','81ef69fa59d924cffd5d8e03c8a48f83fa8bf1f59686afdfb4d8d5ee35526276'],
 ['okx-data-presentation-evidence.mjs','09f0da3476aea786409dd8497fdca0726d7b34ac1456d80e89c1ffe07299517d']
],records=[];
for(const [name,expected] of entries){
 const from='/tmp/phase106-integrity-WrHr5b/'+name,to=join(root,'docs/phase106-evidence/integrity',name),bytes=await readFile(from);
 assert.equal(sha(bytes),expected);await copyFile(from,to,constants.COPYFILE_EXCL);await chmod(to,0o400);assert.equal(sha(await readFile(to)),expected);records.push({from,to,sha256:expected,bytes:bytes.length});
}
const tokens=join(root,'docs/reference-evidence/okx-20261002-phase104/code/tokens.json'),bytes=await readFile(tokens);
const bag=JSON.parse(bytes);for(const key of ['colors','typography','spacing','radius','shadow'])assert.ok(Array.isArray(bag[key]));
records.push({file:tokens,sha256:sha(bytes),bytes:bytes.length,meaning:'Prior actual public-CSS extraction remains immutable; not a new screenshot-derived measurement'});
await writeFile(join(root,'docs/phase106-evidence/design-archive.json'),JSON.stringify({at:new Date().toISOString(),records,noFrontendChangeThisRound:true},null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({records:records.length,noFrontendChangeThisRound:true}));
