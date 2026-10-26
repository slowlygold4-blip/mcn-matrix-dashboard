import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),candidate='/tmp/phase116-assets-ZNCbok/site';
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:31:55Z'));
const approved={
  'package.json':'c51d8e03fd1833c8729fab8c1f874cff94242a346cbf891bd18a4cc79aa85845',
  'scripts/retained-client-assets.mjs':'34db1dd33342dd5bb8ac4fdaca16f10f55d557a2a7b5be8032d62ba0a4897b2a',
  'test/retained-client-assets.test.mjs':'bd06554e72c01282e66a80befa22624835f81c1dc2914f5b73973cffe4ffa24d'
};
const baseline=JSON.parse(await readFile(join(root,'data/maintenance-journal/2026-10-02-phase116-code-baseline.json')));
for(const [file,h] of Object.entries(approved))assert.equal(sha(await readFile(join(candidate,file))),h,file);
if(process.argv[2]==='patch'){
  for(const row of baseline.siteRows)assert.equal(sha(await readFile(join(site,row.file))),row.sha256,row.file);
  const before=await readFile(join(site,'package.json'),'utf8'),after=await readFile(join(candidate,'package.json'),'utf8');
  assert.equal(after,before.replace('"build": "node scripts/run-framework.mjs build"','"build": "node scripts/retained-client-assets.mjs capture && node scripts/run-framework.mjs build && node scripts/retained-client-assets.mjs merge && node scripts/retained-client-assets.mjs capture"'));
  let patch='*** Begin Patch\n*** Update File: '+join(site,'package.json')+'\n@@\n-    "build": "node scripts/run-framework.mjs build",\n+    "build": "node scripts/retained-client-assets.mjs capture && node scripts/run-framework.mjs build && node scripts/retained-client-assets.mjs merge && node scripts/retained-client-assets.mjs capture",\n';
  for(const file of ['scripts/retained-client-assets.mjs','test/retained-client-assets.test.mjs']){
    await assert.rejects(stat(join(site,file)),{code:'ENOENT'});
    const text=await readFile(join(candidate,file),'utf8');patch+='*** Add File: '+join(site,file)+'\n'+text.trimEnd().split('\n').map(line=>'+'+line).join('\n')+'\n';
  }
  process.stdout.write(patch+'*** End Patch\n');
}else if(process.argv[2]==='seed'){
  for(const [file,h] of Object.entries(approved))assert.equal(sha(await readFile(join(site,file))),h,file);
  const entries=new Map(),sources=[];
  for(const [version,archive] of [[42,join(root,'data/code-candidates/phase108/site-public-build.tar')],[43,join(root,'data/code-candidates/phase114/site-deployment.tar.gz')]]){
    const paths=execFileSync('/usr/bin/tar',['-tf',archive],{encoding:'utf8'}).split('\n').filter(p=>/^dist\/client\/_next\/static\/.*\.(?:js|css)$/.test(p));
    assert.equal(paths.length,12);const rows=[];
    for(const member of paths){
      const name=member.slice('dist/client/'.length);assert.ok(!name.includes('..'));const bytes=execFileSync('/usr/bin/tar',['-xOf',archive,member],{maxBuffer:10*1024*1024});
      const candidateBytes=await readFile(join(candidate,'build/retained-client-assets',name));assert.equal(sha(bytes),sha(candidateBytes));
      if(entries.has(name))assert.equal(sha(entries.get(name)),sha(bytes));else entries.set(name,bytes);
      rows.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
    }
    sources.push({version,archive,assets:rows});
  }
  assert.equal(entries.size,21);const directory=join(site,'build/retained-client-assets');await assert.rejects(stat(directory),{code:'ENOENT'});
  for(const [name,bytes] of entries){const dest=join(directory,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes,{flag:'wx',mode:0o644});}
  const manifest={version:1,assets:[...entries].sort(([a],[b])=>a.localeCompare(b)).map(([path,bytes])=>({path,bytes:bytes.length,sha256:sha(bytes)}))};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(join(directory,'manifest.json'),manifestBytes,{flag:'wx',mode:0o644});
  const result={promotedAt:new Date().toISOString(),approved,seed:{files:21,bytes:[...entries.values()].reduce((n,b)=>n+b.length,0),manifestSHA256:sha(manifestBytes)},sources,existingSourceChangeOnly:'package.json',sourceDataWrites:0,retainedPrivateCandidateBuilds:false};
  await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase116-site-promotion.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
  console.log(JSON.stringify({promotedAt:result.promotedAt,...result.seed,existingSourceChangeOnly:result.existingSourceChangeOnly}));
}else throw new Error('Expected patch or seed');
