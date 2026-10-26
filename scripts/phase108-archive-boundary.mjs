import {readFile,copyFile,chmod,mkdir,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'docs/phase108-evidence/archive-boundary'),sha=b=>createHash('sha256').update(b).digest('hex');await mkdir(out,{recursive:true});const rows=[];
for(const name of ['archive-boundary-review.md','archive-check.json','archive-check.mjs']){const src=join('/tmp/phase108-integrity-AzcesC',name),dest=join(out,name),b=await readFile(src);await copyFile(src,dest,constants.COPYFILE_EXCL);await chmod(dest,0o400);assert.equal(sha(await readFile(dest)),sha(b));rows.push({name,sha256:sha(b),bytes:b.length});}
const check=JSON.parse(await readFile(join(out,'archive-check.json'),'utf8'));assert.equal(check.regularFiles,70);assert.equal(check.files.length,70);for(const row of check.files)assert.equal(row.localEqual,true);
await writeFile(join(out,'archive.json'),JSON.stringify({at:new Date().toISOString(),rows,nativeArchiveByteRelationVerified:false},null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(rows));
