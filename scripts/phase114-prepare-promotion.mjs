import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),privateRoot='/var/folders/bf/j1_z4gd95szd7by48xbzql5r0000gn/T/phase114-site-RN6uek';
const folder=process.argv[2];assert.match(folder,/^phase114-evidence(?:-[a-z0-9]+)*$/);const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T10:36:29Z'));
const manifestPath=join(privateRoot,folder,'candidate-manifest.json'),manifest=JSON.parse(await readFile(manifestPath));assert.equal(manifest.files.length,6);
const baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase114-code-baseline.json'))),siteRows=[];
for(const row of baseline.siteRows)assert.equal(sha(await readFile(join(site,row.file))),row.sha256,row.file);
for(const row of manifest.files){const bytes=await readFile(join(privateRoot,row.file));assert.equal(sha(bytes),row.afterSha256);assert.equal(bytes.length,row.bytes);if(row.beforeSha256)assert.equal(baseline.siteRows.find(x=>x.file===row.file).sha256,row.beforeSha256);else assert.equal(row.file,'test/phase114-selected-trend.test.mjs');siteRows.push({file:row.file,beforeSHA256:row.beforeSha256,afterSHA256:row.afterSha256});}
assert.equal(manifest.unchangedOriginalCount,163);assert.equal(manifest.oldTestFilesUnchanged,12);for(const check of manifest.checks){assert.equal(check.status,0);assert.equal(sha(await readFile(check.log)),check.sha256);}
const patchBytes=await readFile(manifest.patch.file);assert.equal(sha(patchBytes),manifest.patch.sha256);
const archive=join(root,'docs/phase114-evidence/candidate');await mkdir(archive,{recursive:true});
for(const file of ['candidate-manifest.json','candidate.patch',...manifest.checks.map(x=>basename(x.log))]){const from=join(privateRoot,folder,file),to=join(archive,file);await copyFile(from,to,constants.COPYFILE_EXCL);await chmod(to,0o400);assert.equal(sha(await readFile(from)),sha(await readFile(to)));}
const beforePage=(await readFile(join(root,'data/code-candidates/phase114/site-preimage/app/page.tsx'))).toString(),afterPage=(await readFile(join(privateRoot,'app/page.tsx'))).toString();
const pageBefore=beforePage.split('\n').find(x=>x.includes('const workspaceGrowth=')),pageAfter=afterPage.split('\n').find(x=>x.includes('const workspaceGrowth='));assert.equal(beforePage.replace(pageBefore,pageAfter),afterPage);
const beforeCss=(await readFile(join(root,'data/code-candidates/phase114/site-preimage/app/replica.css'))).toString(),afterCss=(await readFile(join(privateRoot,'app/replica.css'))).toString();
const anchor='.trend-tooltip small {display:block;color:var(--mcn-muted);}\n';assert.equal(beforeCss.split(anchor).length,2);assert.equal(afterCss.split(anchor).length,2);
const next='.metric-cell__label,.filters label,.period-toolbar label {font-size:14px;}';const tail=afterCss.split(anchor)[1];const addedCss=tail.slice(0,tail.indexOf(next));assert.ok(addedCss.startsWith('.trend-selected'));assert.equal(afterCss.replace(addedCss,''),beforeCss);
const fixture={sources:Object.fromEntries(siteRows.filter(x=>['app/page.tsx','app/replica.css'].includes(x.file)).map(x=>[x.file,{before:x.beforeSHA256,after:x.afterSHA256}])),pageDeltas:[{before:pageBefore,after:pageAfter}],addedCss};
const fixtureText=JSON.stringify(fixture,null,2)+'\n';
let patch='*** Begin Patch\n';const lines=patchBytes.toString().split('\n');for(let i=0;i<lines.length;i++){const line=lines[i];if(line.startsWith('--- ')){const old=line.slice(4),fresh=lines[++i].slice(4).replace(/^b\//,'');patch+=old==='/dev/null'?`*** Add File: ${join(site,fresh)}\n`:`*** Update File: ${join(site,fresh)}\n`;}else if(line.startsWith('@@')){if(!line.includes('-0,0'))patch+='@@\n';}else if(/^[ +\-]/.test(line))patch+=line+'\n';}
patch+=`*** Add File: ${join(root,'test/fixtures/phase114-approved-trend-ui.json')}\n`+fixtureText.trimEnd().split('\n').map(x=>'+'+x).join('\n')+'\n*** End Patch\n';
await writeFile(join(root,'data/code-candidates/phase114/promotion.patch'),patch,{flag:'wx',mode:0o400});
const mainRows=JSON.parse(await readFile(join(root,'data/code-candidates/phase114/main-adapter-rows.json')));mainRows.push({file:'test/fixtures/phase114-approved-trend-ui.json',beforeSHA256:null,afterSHA256:sha(fixtureText)});
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase114-approved-files.json'),JSON.stringify({approvedAt:new Date().toISOString(),siteRows,mainRows,manifestSHA256:sha(await readFile(manifestPath)),preservedOldBusinessAssertions:true,noMainProductChanges:true},null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({approvedFiles:siteRows.length,mainAdapters:mainRows.length,patch:'data/code-candidates/phase114/promotion.patch'}));
