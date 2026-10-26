import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),sha=b=>createHash('sha256').update(b).digest('hex');
assert.ok(Date.now()<Date.parse('2026-10-02T08:22:06Z'));
const bytes=await readFile(join(root,'docs/phase108-evidence/integrity/data-audit.json'));
assert.equal(sha(bytes),'2fda5de2e820faae66bfb881a50fc5f2806fd6b1c4aa2b22788246f3a2d795f5');
const audit=JSON.parse(bytes),fixedRunIds=Array.from({length:29},(_,i)=>2731+i);assert.deepEqual(audit.fixedRunIds,fixedRunIds);assert.equal(audit.originalEventsByteUnchanged,true);assert.equal(audit.changesBefore,0);assert.equal(audit.changesAfter,0);
const evidence=['data/maintenance-journal/2026-10-02-phase108.md','docs/phase108-product-review.md','data/maintenance-journal/2026-10-02-phase108-main-retry-full-tests.log','data/maintenance-journal/2026-10-02-phase108-main-full-tests.log','docs/phase108-evidence/integrity/data-audit.json','docs/phase108-evidence/integrity/data-review.md','docs/phase108-evidence/integrity/frontend-installed-review.md','docs/phase108-evidence/runtime/review.md','docs/phase108-evidence/candidate/final.json','data/maintenance-journal/2026-10-02-phase108-final-audit.json','data/maintenance-journal/2026-10-02-phase108-runtime-final.json','docs/phase108-native-acceptance.md','docs/phase108-evidence/gate-correction/legacy-gate-installed-review.md','data/maintenance-journal/2026-10-02-phase108-public-release.json'];
const evidenceChecks=[];for(const reference of evidence){assert.equal((await stat(join(root,reference))).isFile(),true);const b=await readFile(join(root,reference));assert.ok(b.length);evidenceChecks.push({reference,bytes:b.length,sha256:sha(b)});}
const tests=await readFile(join(root,evidence[2]),'utf8');for(const re of [/ℹ pass 4290\b/,/ℹ fail 0\b/,/ℹ cancelled 0\b/,/ℹ skipped 0\b/])assert.match(tests,re);
const originals=[];for(const runId of fixedRunIds){const p=audit.proofs.find(r=>r.runId===runId);assert.ok(p);assert.equal(p.event.exactObjectEqual,true);assert.equal(p.event.independentlyRebuiltFields,20);assert.equal(p.event.reviewedAtTimeBoundOnly,true);assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${runId}.json`))),p.event.sha256);originals.push({runId,sha256:p.event.sha256});}
const completions=[];for(const runId of fixedRunIds){const r=await completePostIngestionProductReview({ledgerDir:join(root,'data/ingestion-reviews'),runId,evidence});completions.push({runId,status:r.status,path:r.path,completedAt:r.completion.completedAt});}
for(const p of originals)assert.equal(sha(await readFile(join(root,`data/ingestion-reviews/run-${p.runId}.json`))),p.sha256);
const receipt={phase:108,finishedAt:new Date().toISOString(),fixedRunIds,count:completions.length,evidenceChecks,originals,originalEventsByteUnchanged:true,completions,meaning:'Fixed completed persisted-data and product review only; not all issues fixed, not real user retention; no run2760 or later reviewed here.'};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase108-product-completion.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o400});console.log(JSON.stringify({count:receipt.count,created:completions.filter(r=>r.status==='created').length,finishedAt:receipt.finishedAt}));
