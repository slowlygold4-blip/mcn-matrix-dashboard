import assert from 'node:assert/strict';
import {copyFile,readFile,constants} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
assert.ok(Date.now()<Date.parse('2026-10-02T07:49:34Z'));
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const [file,expected] of [['rebuild.js','954cea94f937f02c6199c7c9f0242cfcdcf9782f476d458fb5fc36f2d174fd8a'],['rebuild.css','aa149ba75883d897292d8c6241be63ec0bcc547e2c4e553518ce8a541c3232d3']]){
 const path=join(root,'public',file);assert.equal(sha(await readFile(path)),expected);
 const staged=join(root,'public','.phase107-approved-'+file);
 await copyFile(path,staged,constants.COPYFILE_EXCL);assert.equal(sha(await readFile(staged)),expected);
}
console.log('Two exact original source copies staged; production source unchanged.');
