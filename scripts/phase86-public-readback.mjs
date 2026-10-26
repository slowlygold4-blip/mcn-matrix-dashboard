// Verify the newly published ordinary data generation, not a new deployment.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePublicReplicaPublication} from '../lib/public-replica-sync.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),site=fileURLToPath(new URL('../../mcn-public-site/',import.meta.url));
const origin='https://mcn-matrix-observatory.slowlygold4.chatgpt.site',exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const proof={startedAt:new Date().toISOString(),origin,assets:[],parts:[],cookieOrAuthSupplied:false,userAgentOverride:false,challengeHandled:false,
  noDeploymentAtReadback:true,cloudUIAcceptance:false,allNetworksClaim:false,macOffFreshSamplingClaim:false};
async function get(path){const {stdout}=await exec('/usr/bin/curl',['-sS','--max-time','20','-w','\n%{http_code}',origin+path],{encoding:'buffer',maxBuffer:20_000_000});
  assert.equal(stdout.subarray(-4,-3).toString(),'\n');assert.equal(Number(stdout.subarray(-3).toString()),200);return stdout.subarray(0,-4);}
const html=(await get('/')).toString();assert.match(html,/MCN|矩阵/);
const paths=[...new Set([...html.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(m=>m[1]).filter(p=>/^\/_next\/static\/(?:chunks|css)\/[A-Za-z0-9._-]+\.(?:js|css)$/.test(p)))];
assert.ok(paths.length>=2);
for(const path of paths){const expected=await readFile(join(site,'dist/client',path)),actual=await get(path);assert.equal(hash(actual),hash(expected));assert.equal(actual.length,expected.length);proof.assets.push({path,bytes:actual.length,sha256:hash(actual)});}
const metadata=JSON.parse(await get('/api/replica'));assert.equal(metadata.readOnly,true);assert.equal(metadata.collectionRequiresLocalComputer,true);
const asOf=metadata.manifest.asOf;assert.match(asOf,/^2026-10-01T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const directory=join(root,'data/public-replica-staging','publisher-'+asOf.replace(/[:.]/g,'-'));
const manifest=JSON.parse(await readFile(join(directory,'manifest.json')));
const publication=await preparePublicReplicaPublication({manifest,files:await Promise.all(manifest.files.map(async f=>({...f,content:await readFile(join(directory,f.path),'utf8')})))},{dateIndex:true});
assert.deepEqual(metadata.manifest,publication.manifest);
for(const path of ['catalog.json','topics.json','summary.json',...['daily','works','workMetrics'].map(kind=>publication.files.find(f=>f.kind===kind)?.path).filter(Boolean),'date-summary-index.json']){
  const file=publication.files.find(f=>f.path===path);assert.ok(file);const body=await get('/api/replica?'+new URLSearchParams({generation:asOf,part:path}));
  assert.equal(body.length,file.bytes);assert.equal(hash(body),file.sha256);assert.equal(JSON.parse(body).asOf,asOf);proof.parts.push({path,bytes:body.length,sha256:file.sha256});
}
Object.assign(proof,{asOf,publishedAt:metadata.publishedAt,manifestFiles:metadata.manifest.files.length,counts:metadata.manifest.counts,finishedAt:new Date().toISOString()});
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase86-public-readback.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({asOf,publishedAt:proof.publishedAt,assets:proof.assets.length,parts:proof.parts.length,manifestFiles:proof.manifestFiles,exactReadback:true,noDeploymentAtReadback:true}));
