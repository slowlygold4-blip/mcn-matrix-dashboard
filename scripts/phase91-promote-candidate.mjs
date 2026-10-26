// Exact mechanical release of reviewed bytes, after the isolated full gate.
import assert from 'node:assert/strict';
import {readFile,copyFile,mkdir,writeFile,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),stage='/tmp/mcn-phase90-collector-VaHXS7';
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await readFile(join(stage,'phase91-candidate-manifest.json')));
const journal=join(root,'data/maintenance-journal/2026-10-02-phase91-');
const full=await readFile(journal+'stage-full-verified.txt','utf8'),n=Number(/ℹ tests (\d+)\b/.exec(full)?.[1]);
assert.ok(n>=4035);assert.equal(Number(/ℹ pass (\d+)\b/.exec(full)?.[1]),n-1);
for(const key of ['fail','cancelled'])assert.match(full,new RegExp('ℹ '+key+' 0\\b'));
assert.match(full,/ℹ skipped 1\b/);assert.match(full,/real existing2211\/2215\/2216.*production archive absent/);
const archive=await readFile(journal+'stage-archive-recheck.txt','utf8');
for(const [key,value] of [['tests',1],['pass',1],['fail',0],['cancelled',0],['skipped',0]])assert.match(archive,new RegExp('ℹ '+key+' '+value+'\\b'));
const ux=JSON.parse(await readFile(join(root,'data/maintenance-journal/phase91ux/candidate-chrome-sealed.json')));
assert.equal(ux.passed,true);assert.equal(ux.cases.length,6);assert.deepEqual(ux.errors,[]);
const files=manifest.files.map(x=>({...x}));
for(const path of ['public/rebuild.html','public/rebuild.js','public/rebuild.css'])files.push({path,preimage:sha(await readFile(join(root,'data/backups/phase91-code-20261002',path.slice(7)))),candidate:ux.sourceHashes[path]});
files.push({path:'public/works-settings.js',preimage:ux.sourceHashes['public/works-settings.js'],candidate:ux.sourceHashes['public/works-settings.js']});
for(const f of files){assert.equal(sha(await readFile(join(stage,f.path))),f.candidate);if(f.preimage)assert.equal(sha(await readFile(join(root,f.path))),f.preimage);else{try{await access(join(root,f.path));throw Error('new target already exists '+f.path);}catch(e){if(e.code!=='ENOENT')throw e;}}}
for(const f of manifest.newTests)assert.equal(sha(await readFile(join(stage,f.path))),f.sha256);
for(const f of files.filter(f=>f.preimage&&!f.path.startsWith('public/'))){const path=join(root,'data/backups/phase91-code-20261002',f.path);await mkdir(dirname(path),{recursive:true});await copyFile(join(root,f.path),path,constants.COPYFILE_EXCL);assert.equal(sha(await readFile(path)),f.preimage);}
for(const f of files)await copyFile(join(stage,f.path),join(root,f.path));
for(const f of manifest.newTests)await copyFile(join(stage,f.path),join(root,f.path),constants.COPYFILE_EXCL);
for(const f of files)assert.equal(sha(await readFile(join(root,f.path))),f.candidate);
await writeFile(journal+'promotion.json',JSON.stringify({promotedAt:new Date().toISOString(),files,newTests:manifest.newTests,stageTests:n,stageArchiveSeparatePass:true,productionDataWrites:false,activation:false,longLivedMainNotYetReloaded:true},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({copiedFiles:files.length,stageTests:n,configurationNotActivated:true,runtimeReloadStillRequired:true}));
