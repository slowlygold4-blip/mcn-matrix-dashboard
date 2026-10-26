// Append independent review receipts only for this actually reviewed batch.
// Original deterministic events, source DB and all older history are untouched.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {completePostIngestionProductReview} from '../lib/post-ingestion-review.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),ledger=join(root,'data/ingestion-reviews'),ids=[2384],hash=b=>createHash('sha256').update(b).digest('hex');
const evidence=['data/maintenance-journal/2026-10-02-phase82.md','data/maintenance-journal/2026-10-02-phase82-main-final-verified.txt','data/maintenance-journal/2026-10-02-phase82-firstscreen-final.json','docs/phase82-firstscreen-peer.md','data/maintenance-journal/2026-10-02-phase82-provenance-final.json','docs/phase82-provenance-peer.md','docs/phase82-cloud-execution-peer.md','data/maintenance-journal/2026-10-02-phase82-public-readback.json'];
for(const path of evidence)assert.ok((await stat(join(root,path))).isFile());
const original=[];for(const runId of ids){const bytes=await readFile(join(ledger,'run-'+runId+'.json')),event=JSON.parse(bytes);assert.equal(event.runId,runId);assert.equal(event.triggerType,'works-only');assert.equal(event.snapshotCount,0);assert.equal(event.worksOnly.accepted,0);original.push({runId,sha256:hash(bytes)});}
const results=[];for(const {runId,sha256}of original){const result=await completePostIngestionProductReview({ledgerDir:ledger,runId,evidence});assert.equal(hash(await readFile(join(ledger,'run-'+runId+'.json'))),sha256);const completion=JSON.parse(await readFile(result.path));assert.equal(completion.runId,runId);assert.equal(completion.status,'completed');results.push({runId,status:result.status,originalSha256:sha256,originalPreserved:true});}
const proof={checkedAt:new Date().toISOString(),results,evidence,laterRunsNotReviewed:true,notAllIssuesFixed:true,noOriginalEventRewrite:true};
await writeFile(join(root,'data/maintenance-journal/2026-10-02-phase82-reviewed-events.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(proof));
