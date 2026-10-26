import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),sha=b=>createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase114-code-baseline.json')));
const hookFiles=['test/phase60-product-peer.test.mjs','test/phase63-visual-contract.test.mjs','test/phase64-trend-tooltip-peer.test.mjs','test/phase73-chart-split.test.mjs','test/public-date-range-peer-20261001.test.mjs'];
let patch='*** Begin Patch\n';const rows=[];
for(const file of [...hookFiles,'test/phase90-topic-source-review.test.mjs']){
 const bytes=await readFile(join(root,file)),before=bytes.toString();assert.equal(sha(bytes),baseline.entries.find(x=>x.file===file).sha256);
 const pre=join(root,'data/code-candidates/phase114/main-preimage',file);await mkdir(dirname(pre),{recursive:true});await writeFile(pre,bytes,{flag:'wx',mode:0o400});
 let after=before;
 if(hookFiles.includes(file)){
  const anchor=before.split('\n').find(line=>line.includes('const react={'));assert.ok(anchor);const changed=anchor.replace('const react={','const react={useId:()=>"phase114-test-reading",');assert.equal(before.split(anchor).length,2);after=before.replace(anchor,changed);
  patch+=`*** Update File: ${join(root,file)}\n@@\n-${anchor}\n+${changed}\n`;
 }else{
  const anchor=" const currentSource=readFileSync(join(site,'app/page.tsx'),'utf8'),old=readFileSync(join(root,'data/backups/phase90-code-20261002/page.tsx'),'utf8');";
  const replacement=" let currentSource=readFileSync(join(site,'app/page.tsx'),'utf8');const old=readFileSync(join(root,'data/backups/phase90-code-20261002/page.tsx'),'utf8');\n const trendApproved=JSON.parse(readFileSync(join(root,'test/fixtures/phase114-approved-trend-ui.json'),'utf8'));\n assert.equal(hash(currentSource),trendApproved.sources['app/page.tsx'].after);\n for(const delta of trendApproved.pageDeltas){assert.equal(currentSource.split(delta.after).length,2);currentSource=currentSource.replace(delta.after,delta.before);}\n assert.equal(hash(currentSource),trendApproved.sources['app/page.tsx'].before);";
  assert.equal(before.split(anchor).length,2);after=after.replace(anchor,replacement);
  const cssAnchor=" let css=readFileSync(join(site,'app/replica.css'),'utf8');",cssReplacement=cssAnchor+"\n assert.equal(hash(css),trendApproved.sources['app/replica.css'].after);\n assert.equal(css.split(trendApproved.addedCss).length,2);css=css.replace(trendApproved.addedCss,'');\n assert.equal(hash(css),trendApproved.sources['app/replica.css'].before);";
  assert.equal(before.split(cssAnchor).length,2);after=after.replace(cssAnchor,cssReplacement);
  for(const [a,b] of [[anchor,replacement],[cssAnchor,cssReplacement]])patch+=`*** Update File: ${join(root,file)}\n@@\n-${a}\n+${b.split('\n').join('\n+')}\n`;
 }
 rows.push({file,beforeSHA256:sha(bytes),afterSHA256:sha(after),preimage:pre});
}
patch+='*** End Patch\n';
await writeFile(join(root,'data/code-candidates/phase114/main-adapters.patch'),patch,{flag:'wx',mode:0o400});
await writeFile(join(root,'data/code-candidates/phase114/main-adapter-rows.json'),JSON.stringify(rows,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({files:rows.length,patch:'data/code-candidates/phase114/main-adapters.patch',preservedBusinessAssertions:true}));
