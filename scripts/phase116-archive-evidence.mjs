import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,chmod,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:31:55Z'));
const groups=[
  {group:'assets',from:'/tmp/phase116-assets-ZNCbok',seal:'evidence-seal.json',sha256:'c63c7a5272f681d8a070de0e938469fb1a76972f2e45ad465d83bc5e01bcd7cb'},
  {group:'integrity',from:'/tmp/phase116-integrity-VKHbTJ',seal:'signed-receipt.json',sha256:'d1471dbe4b0e375397c8cd901c613474c435b33a3fc777760ffc8f63ae659cb7'},
  {group:'runtime',from:'/tmp/phase116-runtime-dQER2e',seal:'independent-seal.json',sha256:'4f3e0bb8227945080d35c9cc46df03013db54ccf0a936a4088511c91d0e68ec1'}
];
const archived=[];
for(const group of groups){
  const sealBytes=await readFile(join(group.from,group.seal));assert.equal(sha(sealBytes),group.sha256);const manifest=JSON.parse(sealBytes);
  for(const row of [...manifest.files,{path:group.seal,bytes:sealBytes.length,sha256:group.sha256}]){
    const file=row.path||row.file;assert.ok(file&&!file.startsWith('/')&&!file.includes('..'));const from=join(group.from,file),bytes=await readFile(from);assert.equal(bytes.length,row.bytes);assert.equal(sha(bytes),row.sha256);
    const dest=join(root,'docs/phase116-evidence',group.group,file);await mkdir(dirname(dest),{recursive:true});await copyFile(from,dest,constants.COPYFILE_EXCL);await chmod(dest,0o400);assert.equal(sha(await readFile(dest)),row.sha256);archived.push({group:group.group,file:dest,bytes:row.bytes,sha256:row.sha256});
  }
}
const result={archivedAt:new Date().toISOString(),archived,productionDataEdits:0,meaning:'Immutable individually verified independent evidence; local browser fixtures are not live platform/public data proof'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase116-evidence-archive.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({archivedAt:result.archivedAt,files:archived.length,bytes:archived.reduce((n,r)=>n+r.bytes,0)}));
