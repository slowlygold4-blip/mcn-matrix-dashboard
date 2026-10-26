import assert from 'node:assert/strict';
import {readFile,copyFile,chmod,mkdir,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),source='/tmp/phase108-integrity-AzcesC',destination=join(root,'docs/phase108-evidence/gate-correction'),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T08:22:06Z'));await mkdir(destination,{recursive:true});const rows=[];
for(const name of ['legacy-gate-review.md','legacy-gate-proposal-review.md','legacy-gate-installed-review.md','legacy-gate-installed-review.json','legacy-installed-check.mjs','legacy-installed-directed.tap']){const from=join(source,name),to=join(destination,name),bytes=await readFile(from);await copyFile(from,to,constants.COPYFILE_EXCL);await chmod(to,0o400);assert.equal(sha(await readFile(to)),sha(bytes));rows.push({name,bytes:bytes.length,sha256:sha(bytes)});}
await writeFile(join(destination,'archive.json'),JSON.stringify({at:new Date().toISOString(),rows,oldEvidenceUntouched:true},null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(rows));
