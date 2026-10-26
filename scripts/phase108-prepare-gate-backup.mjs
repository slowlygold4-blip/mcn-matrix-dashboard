import {readFile,copyFile,chmod,writeFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const files=['test/phase90-topic-source-review.test.mjs','test/phase96-history-focus-peer.test.mjs','test/fixtures/phase96-approved-history-ui.json','test/fixtures/phase93-approved-workspace-ui.json','test/fixtures/phase99-approved-topic-numbers.json'];
const destination=join(root,'data/code-candidates/phase108/gate-preimage');await mkdir(destination,{recursive:true});const rows=[];
for(const file of files){const source=join(root,file),path=join(destination,file.replaceAll('/','__'));await copyFile(source,path,constants.COPYFILE_EXCL);await chmod(path,0o400);rows.push({file,path,sha256:sha(await readFile(source))});}
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase108-gate-preimage.json'),JSON.stringify({at:new Date().toISOString(),rows},null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(rows));
