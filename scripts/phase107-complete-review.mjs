import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T07:54:34Z'));
const bytes=await readFile(join(root,'docs/phase107-evidence/integrity/data-audit.json'));
assert.equal(sha(bytes),'8350298a904ac835427fdf860ab4082009fb7c00c7a4a715d9ccb5099542d167');
const audit=JSON.parse(bytes),fixedRunIds=Array.from({length:20},(_,i)=>2711+i);
assert.deepEqual(audit.fixedRunIds,fixedRunIds); assert.equal(audit.originalEventsByteUnchanged,true);
assert.equal(audit.changesBefore,0); assert.equal(audit.changesAfter,0);
const evidence=['data/maintenance-journal/2026-10-02-phase107.md','docs/phase107-product-review.md','data/maintenance-journal/2026-10-02-phase107-main-full-tests.log','docs/phase107-evidence/integrity/data-audit.json','docs/phase107-evidence/integrity/data-review.md','docs/phase107-evidence/integrity/frontend-review.md','docs/phase107-evidence/runtime/review-record-final.md','docs/phase107-evidence/candidate/final.json','data/maintenance-journal/2026-10-02-phase107-final-audit.json','data/maintenance-journal/2026-10-02-phase107-runtime-final.json','docs/phase107-native-acceptance.md'];
const evidenceChecks=[];
for(const reference of evidence){assert.equal((await stat(join(root,reference))).isFile(),true);const b=await readFile(join(root,reference));assert.ok(b.length);evidenceChecks.push({reference,bytes:b.length,sha256:sha(b)});}
const tests=await readFile(join(root,evidence[2]),'utf8');
for(const re of [/ℹ pass 4290\b/,/ℹ fail 0\b/,/ℹ cancelled 0\b/,/ℹ skipped 0\b/])assert.match(tests,re);
const originals=[];
for(const runId of fixedRunIds){const p=audit.proofs.find(r=>r.runId===runId);assert.ok(p);assert.equal(p.event.exactObjectEqual,true);assert.equal(p.event.independentlyRebuiltFields,20);assert.equal(p.event.reviewedAtTimeBoundOnly,true);assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${runId}.json`))),p.event.sha256);originals.push({runId,sha256:p.event.sha256});}
const completions=[];
for(const runId of fixedRunIds){const r=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId,evidence});completions.push({runId,status:r.status,path:r.path,completedAt:r.completion.completedAt});}
for(const p of originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${p.runId}.json`))),p.sha256);
const receipt={phase:107,finishedAt:new Date().toISOString(),fixedRunIds,count:completions.length,evidenceChecks,originals,originalEventsByteUnchanged:true,completions,meaning:'Fixed completed review only; not all issues fixed, not real user retention, no run2731 or later reviewed here.'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase107-product-completion.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});
console.log(JSON.stringify({count:receipt.count,created:completions.filter(r=>r.status==='created').length,finishedAt:receipt.finishedAt}));
