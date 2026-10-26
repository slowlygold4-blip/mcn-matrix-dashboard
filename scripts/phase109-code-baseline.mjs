import assert from 'node:assert/strict';
import {readdir,readFile,mkdir,writeFile,copyFile,chmod,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
assert.ok(Date.now()<Date.parse('2026-10-02T08:46:59Z'));
const entries=[];
async function scan(directory){for(const item of await readdir(join(root,directory),{withFileTypes:true})){const file=join(directory,item.name);if(item.isDirectory())await scan(file);else if(item.isFile()&&/\.(?:mjs|js|json|html|css|ts|tsx)$/.test(file)){const bytes=await readFile(join(root,file));entries.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}}}
for(const dir of ['public','lib','test','scripts','extension']){try{await scan(dir);}catch(error){if(error.code!=='ENOENT')throw error;}}
for(const file of ['server.mjs','package.json','package-lock.json']){const bytes=await readFile(join(root,file));entries.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
const file='test/phase105-reading-context.test.mjs',destination=join(root,'data/code-candidates/phase109/preimage',file);await mkdir(join(destination,'..'),{recursive:true,mode:0o700});await copyFile(join(root,file),destination,constants.COPYFILE_EXCL);await chmod(destination,0o400);
assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'),entries.find(row=>row.file===file).sha256);
const result={createdAt:new Date().toISOString(),entries:entries.sort((a,b)=>a.file.localeCompare(b.file)),approvedExistingChanges:['public/console-model.js','public/rebuild.js',file],approvedNewTests:['test/phase109-visible-ranking.test.mjs'],oldTestPreimage:destination,originalTestsRetained:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase109-code-baseline.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({createdAt:result.createdAt,files:entries.length,oldTests:entries.filter(row=>row.file.startsWith('test/')).length,oldTestPreimage:destination}));
