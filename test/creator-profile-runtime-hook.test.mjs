import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const candidates=[process.env.MCN_SITE_ROOT&&process.env.MCN_SITE_ROOT+'/package.json',
 fileURLToPath(new URL('../frontend/package.json',import.meta.url)),fileURLToPath(new URL('../../../outputs/mcn-public-site/package.json',import.meta.url))].filter(Boolean);
let ts;for(const path of candidates){try{ts=createRequire(path)('typescript');break;}catch{}}
assert.ok(ts,'Install frontend dependencies or set MCN_SITE_ROOT');
const source=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const ast=ts.createSourceFile('server.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const functions=new Map();
function visit(node){if(ts.isFunctionDeclaration(node)&&['reconcileCommittedProfileIdentities','reviewCommittedBatch'].includes(node.name?.text))functions.set(node.name.text,node.getText(ast));ts.forEachChild(node,visit);}visit(ast);
function harness(){
 const calls=[],errors=[];let invalidations=0;
 const context=vm.createContext({profileIdentityAdmissionReady:false,database:{},ingestionReviewQueueStatus:{},
  reconcileCreatorProfileIdentityLinks:(_db,options)=>{calls.push(options);return {status:'admitted',admitted:1,eligible:1,remaining:0,receiptIds:[{targetId:999}]};},
  reconcileSupplementProfileIdentityLinks:()=>({status:'up-to-date',admitted:0,remaining:0}),
  consoleReader:{invalidate:()=>invalidations++},console:{error:message=>errors.push(message)},
  ingestionReviewChain:Promise.resolve(),recordPostIngestionReview:async()=>({status:'recorded'}),ingestionReviewDir:'fixture',ingestionReviewStartRunId:1});
 for(const code of functions.values())vm.runInContext(code,context);
 return {context,calls,errors,get invalidations(){return invalidations;}};
}
test('real server helper admits no identities until the successful startup backup gate opens',()=>{
 const h=harness();h.context.reconcileCommittedProfileIdentities(30);assert.equal(h.calls.length,0);
 h.context.profileIdentityAdmissionReady=true;h.context.reconcileCommittedProfileIdentities(30);
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].runId,30);assert.equal(h.invalidations,1);
 assert.equal(h.context.ingestionReviewQueueStatus.profileIdentity.admitted,1);
 assert.equal('receiptIds' in h.context.ingestionReviewQueueStatus.profileIdentity,false,'状态不泄露内部作者关系');
});
test('real committed-run hook waits for review persistence and runs for that exact run',async()=>{
 const h=harness();h.context.profileIdentityAdmissionReady=true;let release;
 h.context.recordPostIngestionReview=()=>new Promise(resolve=>{release=resolve;});
 const work=h.context.reviewCommittedBatch(31);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,0);
 release({status:'recorded'});await work;assert.equal(h.calls[0].runId,31);
});
test('identity admission failure preserves committed collection/review and does not leak private error details',async()=>{
 const h=harness();h.context.profileIdentityAdmissionReady=true;
 h.context.reconcileCreatorProfileIdentityLinks=()=>{throw Error('private-token-and-author-id');};
 const result=await h.context.reviewCommittedBatch(32);
 assert.equal(result.status,'recorded');assert.equal(h.context.ingestionReviewQueueStatus.profileIdentity.status,'retry-required');
 assert.equal(h.errors.some(message=>message.includes('private-token')),false);assert.equal(h.invalidations,0);
});

test('a supplementary receipt failure retains committed base identities and invalidates their view',()=>{
 const h=harness();h.context.profileIdentityAdmissionReady=true;
 h.context.reconcileSupplementProfileIdentityLinks=()=>{throw Error('private-credential');};
 h.context.reconcileCommittedProfileIdentities(33);
 assert.equal(h.invalidations,1);assert.equal(h.context.ingestionReviewQueueStatus.profileIdentity.admitted,1);
 assert.equal(h.context.ingestionReviewQueueStatus.profileIdentity.supplement.status,'retry-required');
 assert.equal(h.errors.some(message=>message.includes('private-credential')),false);
});

test('the real import completion calls reconciliation only after the transaction commit and before queue scheduling',()=>{
 const commit=source.indexOf('database.db.exec("COMMIT");',source.indexOf('database.completeAuthorResolutionJob'));
 const call=source.indexOf('reconcileCommittedProfileIdentities();',commit);
 const schedule=source.indexOf('if (scheduleQueuedEvidence)',commit);
 assert.ok(commit>0&&call>commit&&schedule>call);
 const middle=source.slice(commit,call);
 assert.match(middle,/ROLLBACK/);assert.match(middle,/throw commitError/);
});
