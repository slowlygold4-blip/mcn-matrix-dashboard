import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,mkdir,open,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site');
const sha=b=>createHash('sha256').update(b).digest('hex');
const deadline=Date.parse('2026-10-02T11:31:55Z');
assert.ok(Date.now()<deadline,'Phase116 development boundary');
const journal=join(root,'data/maintenance-journal'),basePath=join(journal,'2026-10-02-phase116-code-baseline.json');
const mode=process.argv[2];
if(mode==='baseline'){
  assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),'15f7913736df5536d9dbbcb6df5f2c2bdc46a81d');
  const entries=[];
  async function scan(dir){for(const item of await readdir(join(root,dir),{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())await scan(file);else if(item.isFile()&&/\.(mjs|js|json|html|css|ts|tsx)$/.test(file)){const b=await readFile(join(root,file));entries.push({file,bytes:b.length,sha256:sha(b)});}}}
  for(const dir of ['public','lib','test','scripts'])await scan(dir);
  for(const file of ['server.mjs','package.json','package-lock.json']){const b=await readFile(join(root,file));entries.push({file,bytes:b.length,sha256:sha(b)});}
  const siteRows=[];
  for(const file of execFileSync('git',['ls-files'],{cwd:site,encoding:'utf8'}).trim().split('\n')){
    const b=await readFile(join(site,file));siteRows.push({file,bytes:b.length,sha256:sha(b)});
    if(file==='package.json'){const destination=join(root,'data/code-candidates/phase116/site-preimage',file);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,b,{flag:'wx',mode:0o400});}
  }
  const result={createdAt:new Date().toISOString(),phaseStartedAt:'2026-10-02T11:06:55Z',entries,siteRows,siteHead:'15f7913736df5536d9dbbcb6df5f2c2bdc46a81d',allowedSiteExistingChanges:['package.json'],permittedMainProductChanges:[]};
  await writeFile(basePath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});
  console.log(JSON.stringify({createdAt:result.createdAt,mainFiles:entries.length,siteFiles:siteRows.length,preimage:'package.json'}));
}else if(mode==='tests'){
  const baseline=JSON.parse(await readFile(basePath));
  for(const row of baseline.entries)assert.equal(sha(await readFile(join(root,row.file))),row.sha256,row.file);
  for(const row of baseline.siteRows)if(row.file!=='package.json')assert.equal(sha(await readFile(join(site,row.file))),row.sha256,row.file);
  const files=(await readdir(join(root,'test'))).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>'test/'+f);
  const logPath=join(journal,'2026-10-02-phase116-main-full-tests.log'),log=await open(logPath,'wx',0o600),startedAt=new Date().toISOString();
  const child=spawn(process.execPath,['--test','--test-concurrency=4',...files],{cwd:root,env:{...process.env,PHASE84_REAL45:'1'},stdio:['ignore',log.fd,log.fd]});
  console.log(JSON.stringify({startedAt,pid:child.pid,testFiles:files.length,logPath}));
  const timer=setTimeout(()=>child.kill('SIGTERM'),Math.min(240000,deadline-Date.now()));
  const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer);await log.close();
  const bytes=await readFile(logPath),output=bytes.toString('utf8');
  const result={startedAt,finishedAt:new Date().toISOString(),outcome,logPath,sha256:sha(bytes),testFiles:files.length,mainBaselineChecked:baseline.entries.length,siteOldChecked:baseline.siteRows.length,mainProductChanges:0};
  for(const key of ['tests','pass','fail','cancelled','skipped'])result[key]=Number(output.match(new RegExp('(?:#|ℹ) '+key+' (\\d+)'))?.[1]);
  await writeFile(join(journal,'2026-10-02-phase116-main-tests-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});await chmod(logPath,0o400);
  console.log(JSON.stringify(result));assert.equal(outcome.code,0);assert.equal(outcome.signal,null);assert.ok(result.tests>=4307);assert.equal(result.pass,result.tests);for(const k of ['fail','cancelled','skipped'])assert.equal(result[k],0);
}else throw new Error('Expected baseline or tests');
