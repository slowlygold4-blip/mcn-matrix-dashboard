import assert from 'node:assert/strict';
import {readFile,mkdir,copyFile,chmod,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),from='/var/folders/bf/j1_z4gd95szd7by48xbzql5r0000gn/T/phase114-runtime-lhmfm0',to=join(root,'docs/phase114-evidence/runtime'),sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(join(from,'independent-seal.json'));assert.equal(sha(bytes),'e038d93b8f6e5dca311ad180d2c47b4b46e8ae327d2f9e9be529540d87b18893');const seal=JSON.parse(bytes);
assert.equal(seal.browserChecks.total,151);assert.equal(seal.allOwnBrowsersClosed,true);assert.equal(seal.oldUnchanged,163);assert.equal(seal.oldTestsUnchanged,12);
const archive=[];for(const row of [...seal.files,{path:'independent-seal.json',sha256:sha(bytes)}]){assert.ok(!row.path.startsWith('/')&&!row.path.split('/').includes('..'));const source=join(from,row.path),dest=join(to,row.path);assert.equal(sha(await readFile(source)),row.sha256);await mkdir(dirname(dest),{recursive:true});await copyFile(source,dest,constants.COPYFILE_EXCL);await chmod(dest,0o400);assert.equal(sha(await readFile(dest)),row.sha256);archive.push({file:dest,sha256:row.sha256});}
for(const suffix of ['final-point','final-home-overview']){const r=JSON.parse(await readFile(join(to,'independent-evidence',suffix,'result.json')));assert.equal(r.errors.length,0);assert.ok(r.checksPassed>0);}
const approved=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase114-approved-files-revised.json')));for(const row of seal.changed)assert.equal(approved.siteRows.find(x=>x.file===row.file).afterSHA256,row.afterSha256);
for(const name of ['adapters-audit.json','adapters-review.md']){const source=join('/tmp/phase114-integrity-zu6cnY',name),dest=join(root,'docs/phase114-evidence/integrity',name);await copyFile(source,dest,constants.COPYFILE_EXCL);await chmod(dest,0o400);assert.equal(sha(await readFile(source)),sha(await readFile(dest)));}
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase114-runtime-archive.json'),JSON.stringify({archivedAt:new Date().toISOString(),archive,sourceBoundToInstalledApproval:true},null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({archived:archive.length,checks:151,oldSourcesUnchanged:163}));
