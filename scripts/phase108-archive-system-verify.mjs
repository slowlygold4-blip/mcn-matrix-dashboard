import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),site=join(root,'../mcn-public-site'),archive=join(root,'data/code-candidates/phase108/site-public-build.tar'),sha=b=>createHash('sha256').update(b).digest('hex');
const names=execFileSync('/usr/bin/tar',['-tf',archive],{encoding:'utf8'}).trim().split('\n').filter(n=>!n.endsWith('/'));assert.equal(names.length,70);const rows=[];
for(const name of names){assert.ok(name.startsWith('dist/')&&!name.includes('..'));const bytes=execFileSync('/usr/bin/tar',['-xOf',archive,name],{maxBuffer:16*1024*1024}),local=await readFile(join(site,name));assert.equal(sha(bytes),sha(local),name);rows.push({name,bytes:bytes.length,sha256:sha(bytes)});}
const record={at:new Date().toISOString(),localCompressedSHA256:sha(await readFile(archive)),regularFiles:70,matchedFiles:70,rows,nativeArchiveByteRelationVerified:false,oldHandwrittenParserEvidencePreserved:true};
await writeFile(join(root,'docs/phase108-evidence/archive-boundary/root-system-tar-verification.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({at:record.at,matched:70,sha256:record.localCompressedSHA256,nativeArchiveByteRelationVerified:false}));
