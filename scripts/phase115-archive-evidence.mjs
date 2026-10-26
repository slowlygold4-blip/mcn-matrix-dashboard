import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:09:14Z'));
const receipts=[
  {group:'collector',from:'/tmp/phase115-collector-5BG2PE',name:'signed-receipt.json',expected:'aabc821dc30975210cada789662dba0a713d326a59883f9914f288c67f4686f4'},
  {group:'integrity',from:'/tmp/phase115-integrity-pUZZsw',name:'signed-receipt.json',expected:'bfd0ddc54268746f6625d20072cd5439e5b386516956f9a4d544c327905b0263'},
  {group:'runtime',from:'/tmp/phase115-runtime-xnXx5Y',name:'evidence-manifest.json'}
];
const archived=[];
for(const item of receipts){
  const seal=await readFile(join(item.from,item.name));if(item.expected)assert.equal(sha(seal),item.expected);
  const parsed=JSON.parse(seal),rows=Array.isArray(parsed.files)?parsed.files:Object.entries(parsed.files).map(([path,value])=>({path,...value}));
  for(const row of rows){
    const file=row.path||row.name;assert.ok(file&&!file.startsWith('/')&&!file.split('/').includes('..'));
    const bytes=await readFile(join(item.from,file));assert.equal(sha(bytes),row.sha256,file);assert.equal(bytes.length,row.bytes,file);
    const target=join(root,'docs/phase115-evidence',item.group,file);await mkdir(dirname(target),{recursive:true});
    await copyFile(join(item.from,file),target,constants.COPYFILE_EXCL);await chmod(target,0o400);
    assert.equal(sha(await readFile(target)),row.sha256,file);archived.push({group:item.group,file:target,sha256:row.sha256,bytes:row.bytes});
  }
  const target=join(root,'docs/phase115-evidence',item.group,item.name);
  await copyFile(join(item.from,item.name),target,constants.COPYFILE_EXCL);await chmod(target,0o400);assert.equal(sha(await readFile(target)),sha(seal));
  archived.push({group:item.group,file:target,sha256:sha(seal),bytes:seal.length});
}
const result={archivedAt:new Date().toISOString(),archived,productionSourceEdits:0,credentialsRead:false,databaseCopied:false};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-evidence-archive.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({archivedAt:result.archivedAt,files:archived.length}));
