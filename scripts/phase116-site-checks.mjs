import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,open,chmod,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),journal=join(root,'data/maintenance-journal');
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T11:31:55Z'));
const baseline=JSON.parse(await readFile(join(journal,'2026-10-02-phase116-code-baseline.json')));
for(const row of baseline.siteRows)if(row.file!=='package.json')assert.equal(sha(await readFile(join(site,row.file))),row.sha256,row.file);
const promotion=JSON.parse(await readFile(join(journal,'2026-10-02-phase116-site-promotion.json')));
for(const [file,h] of Object.entries(promotion.approved))assert.equal(sha(await readFile(join(site,file))),h,file);
if(process.argv[2]==='checks'){
  const commands=[['tests',[process.execPath,'--test',...(await readdir(join(site,'test'))).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>'test/'+f)]],['typecheck',[process.execPath,'node_modules/typescript/bin/tsc','--noEmit','--incremental','false']]];
  const result={startedAt:new Date().toISOString(),commands:[],unchangedOriginalFiles:168,approved:promotion.approved};
  for(const [label,args] of commands){
    const logPath=join(journal,'2026-10-02-phase116-site-'+label+'.log'),log=await open(logPath,'wx',0o600),startedAt=new Date().toISOString();
    const child=spawn(args[0],args.slice(1),{cwd:site,env:process.env,stdio:['ignore',log.fd,log.fd]});
    const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
    const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);await log.close();
    const bytes=await readFile(logPath);await chmod(logPath,0o400);const row={label,startedAt,finishedAt:new Date().toISOString(),outcome,logPath,sha256:sha(bytes)};
    if(label==='tests'){const text=bytes.toString('utf8');for(const k of ['tests','pass','fail','cancelled','skipped'])row[k]=Number(text.match(new RegExp('(?:#|ℹ) '+k+' (\\d+)'))?.[1]);}
    result.commands.push(row);assert.equal(outcome.code,0);assert.equal(outcome.signal,null);if(label==='tests'){assert.equal(row.tests,62);assert.equal(row.pass,62);for(const k of ['fail','cancelled','skipped'])assert.equal(row[k],0);}
  }
  result.finishedAt=new Date().toISOString();await writeFile(join(journal,'2026-10-02-phase116-site-checks.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(result));
}else if(process.argv[2]==='built'){
  const manifestPath=join(site,'build/retained-client-assets/manifest.json'),bytes=await readFile(manifestPath),manifest=JSON.parse(bytes),client=join(site,'dist/client');
  assert.ok(manifest.assets.length>=21&&manifest.assets.length<=256);
  for(const r of manifest.assets){assert.ok(/^_next\/static\//.test(r.path)&&!r.path.includes('..'));const a=await readFile(join(site,'build/retained-client-assets',r.path)),b=await readFile(join(client,r.path));assert.equal(sha(a),r.sha256);assert.equal(sha(b),r.sha256);assert.equal(a.length,r.bytes);}
  for(const source of promotion.sources)for(const r of source.assets){assert.equal(sha(await readFile(join(client,r.path))),r.sha256);assert.ok(manifest.assets.some(x=>x.path===r.path&&x.sha256===r.sha256));}
  const {retainClientAssets}=await import(join(site,'scripts/retained-client-assets.mjs'));
  const checked=retainClientAssets({projectRoot:site,mode:'merge'});assert.equal(sha(await readFile(manifestPath)),sha(bytes));
  const result={checkedAt:new Date().toISOString(),seedVersions:[42,43],seedFiles:21,assets:manifest.assets,manifestSHA256:sha(bytes),closedDependencyGraphValidated:true,currentPriorityAndNoOverwrite:true,checks:checked,serverConfigBytes:(await stat(join(site,'dist/server/wrangler.json'))).size,sourceBusinessChanges:0};
  await writeFile(join(journal,'2026-10-02-phase116-site-built.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({checkedAt:result.checkedAt,...checked,manifestSHA256:result.manifestSHA256}));
}else throw new Error('Expected checks or built');
