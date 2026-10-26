import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:09:14Z'));
const from='/tmp/phase115-integrity-pUZZsw',sealName='settings-signed-receipt.json',seal=await readFile(join(from,sealName));
assert.equal(sha(seal),'09f10a7c4e3f232b0beea47d9fdbb83676a1e369e6dc4e470129c377757125f6');
const parsed=JSON.parse(seal),refs=[];
const rows=Array.isArray(parsed.files)?parsed.files:Object.entries(parsed.files).map(([path,value])=>({path,...value}));
for(const row of rows){
  const file=row.path||row.name;assert.ok(file&&!file.startsWith('/')&&!file.split('/').includes('..'));
  const bytes=await readFile(join(from,file));assert.equal(sha(bytes),row.sha256);assert.equal(bytes.length,row.bytes);
  const dest=join(root,'docs/phase115-evidence/settings',file);await mkdir(dirname(dest),{recursive:true});
  await copyFile(join(from,file),dest,constants.COPYFILE_EXCL);await chmod(dest,0o400);assert.equal(sha(await readFile(dest)),row.sha256);refs.push({file:dest,sha256:row.sha256});
}
const sealDest=join(root,'docs/phase115-evidence/settings',sealName);await copyFile(join(from,sealName),sealDest,constants.COPYFILE_EXCL);await chmod(sealDest,0o400);assert.equal(sha(await readFile(sealDest)),sha(seal));refs.push({file:sealDest,sha256:sha(seal)});
const assetFrom='/tmp/phase115-assets-L0j66i/review.md',assetTo=join(root,'docs/phase115-evidence/assets/review.md');
assert.equal(sha(await readFile(assetFrom)),'fe663cc141eb859d6d7a99c1c10e3625264c3614a52474653c76e57badb540dd');
await mkdir(dirname(assetTo),{recursive:true});await copyFile(assetFrom,assetTo,constants.COPYFILE_EXCL);await chmod(assetTo,0o400);assert.equal(sha(await readFile(assetFrom)),sha(await readFile(assetTo)));refs.push({file:assetTo,sha256:sha(await readFile(assetTo))});
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase115-addenda-archive.json'),JSON.stringify({archivedAt:new Date().toISOString(),refs,sourceDataEdits:0,siteEdits:0},null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({files:refs.length,assetReport:assetTo}));
