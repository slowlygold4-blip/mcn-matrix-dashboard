import assert from 'node:assert/strict';
import {readdir,readFile,copyFile,chmod,mkdir,writeFile,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
const group=process.argv[2],sources={integrity:'/tmp/phase109-integrity-v1C5n3',runtime:'/tmp/phase109-runtime-wQuWde',candidate:'/tmp/phase109-ranking-4n4W9T'};
assert.ok(Object.hasOwn(sources,group));assert.ok(Date.now()<Date.parse('2026-10-02T08:51:59Z'));
const destination=join(root,'docs/phase109-evidence',group);await mkdir(destination,{recursive:true,mode:0o700});const records=[];
for(const entry of await readdir(sources[group],{withFileTypes:true})){
 if(!entry.isFile()||!/[.](json|mjs|md|log|tap|patch|tar[.]gz|png|jpg)$/.test(entry.name))continue;
 assert.match(entry.name,/^[a-zA-Z0-9._-]+$/);const source=join(sources[group],entry.name),file=join(destination,entry.name),bytes=await readFile(source);assert.ok(bytes.length<20*1024*1024);
 await copyFile(source,file,constants.COPYFILE_EXCL);await chmod(file,0o400);assert.equal(sha(await readFile(file)),sha(bytes));records.push({source,file,bytes:bytes.length,sha256:sha(bytes)});
}
assert.ok(records.length>0&&records.length<80);
const receipt={at:new Date().toISOString(),group,records,originalFilesNotChanged:true,meaning:'Exclusive conservation of all top-level independent evidence, including original failed runs; copying is not itself a passing review.'};
await writeFile(join(root,`docs/phase109-evidence/${group}-archive.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({group,count:records.length,at:receipt.at}));
