import assert from 'node:assert/strict';
import {open,readFile,writeFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),mode=process.argv[2];assert.ok(['raw','adapted'].includes(mode));
const files=['phase60-product-peer','phase63-visual-contract','phase64-trend-tooltip-peer','phase73-chart-split','phase90-topic-source-review','public-date-range-peer-20261001'].map(x=>'test/'+x+'.test.mjs');
const startedAt=new Date().toISOString(),logPath=join(root,`data/maintenance-journal/2026-10-02-phase114-focused-${mode}.log`),fd=await open(logPath,'wx',0o600);
const child=spawn(process.execPath,['--test','--test-concurrency=2',...files],{cwd:root,stdio:['ignore',fd.fd,fd.fd]});
const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});await fd.close();await chmod(logPath,0o400);const bytes=await readFile(logPath),text=bytes.toString();
const result={mode,startedAt,finishedAt:new Date().toISOString(),outcome,logPath,sha256:createHash('sha256').update(bytes).digest('hex')};for(const key of ['tests','pass','fail','cancelled','skipped'])result[key]=Number(text.match(new RegExp('(?:#|ℹ) '+key+' (\\d+)'))?.[1]);
await writeFile(join(root,`data/maintenance-journal/2026-10-02-phase114-focused-${mode}.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify(result));if(mode==='adapted'){assert.equal(outcome.code,0);assert.equal(result.pass,result.tests);assert.equal(result.fail,0);}
