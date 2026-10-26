import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,chmod,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex'),images=[];
assert.ok(Date.now()<Date.parse('2026-10-02T08:51:59Z'));
for(const name of ['daily-ascending-200','daily-page2-200','daily-author-detail-200','public-overview-fresh']){const original=join(root,'docs/phase109-evidence/root-native',name+'.png'),copy=join(root,'docs/phase109-evidence/root-native',name+'.jpg'),bytes=await readFile(original);assert.equal(bytes.subarray(0,3).toString('hex'),'ffd8ff');const fileType=execFileSync('/usr/bin/file',['-b',original],{encoding:'utf8'}).trim();assert.match(fileType,/^JPEG image data,/);await copyFile(original,copy,constants.COPYFILE_EXCL);await chmod(copy,0o400);assert.equal(sha(await readFile(copy)),sha(bytes));images.push({original,copy,bytes:bytes.length,sha256:sha(bytes),fileType,actualMime:'image/jpeg',byteEqual:true});}
const helper=join(root,'scripts/phase109-final-audit.mjs'),helperSHA256=sha(await readFile(helper));
const result={finishedAt:new Date().toISOString(),images,initialAssumptionFailure:{helper,helperSHA256,actual:'JPEG original screenshot bytes',assumed:'PNG based on filename',toolError:"AssertionError: '���' !== 'PNG'",productFailure:false},originalScreenshotsByteUnchanged:true,noImageEdit:true,noReencoding:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase109-native-image-boundary.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({finishedAt:result.finishedAt,copies:images.length,actualMime:'image/jpeg',originalBytesUnchanged:true,helperSHA256}));
