import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const site='/Users/tyke/Documents/Codex/2026-08-31/bi-a/outputs/mcn-public-site';
assert.equal(execFileSync('git',['status','--short'],{cwd:site,encoding:'utf8'}).trim(),'');
const files=execFileSync('git',['ls-files','-z'],{cwd:site,encoding:'utf8'}).split('\0').filter(Boolean);
const privateDir=await mkdtemp(join(tmpdir(),'phase114-site-'));
const rows=[];
for(const file of files){const bytes=await readFile(join(site,file));await mkdir(dirname(join(privateDir,file)),{recursive:true});await writeFile(join(privateDir,file),bytes,{flag:'wx'});rows.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});}
await symlink(join(site,'node_modules'),join(privateDir,'node_modules'),'dir');
const manifest={createdAt:new Date().toISOString(),site,privateDir,head:execFileSync('git',['rev-parse','HEAD'],{cwd:site,encoding:'utf8'}).trim(),rows};
await writeFile(join(privateDir,'phase114-originals.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({privateDir,files:rows.length,head:manifest.head}));
