import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {retireUnsentPreparation} from '../lib/public-replica-preparation-recovery.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(){const published='2026-10-30T10:00:00.000Z',active='2026-10-30T11:00:00.000Z',manifest={asOf:published,files:[{path:'catalog.json',sha256:'a'.repeat(64),bytes:10}]},activeManifest={...manifest,asOf:active};
 return {now:'2026-10-30T12:00:00.000Z',state:{version:1,status:'failed',code:'invalid-source',publishedAsOf:published,coveredMarker:'retained',
  active:{asOf:active,directory:'/retained/failed',manifestHash:hash(activeManifest)},sync:{status:'failed',code:'invalid-source',phase:'validate',activated:false,activationState:'not-attempted'}},
  checkpoint:{asOf:published,manifestSha256:hash(manifest),activated:true,completedBatches:[0],readbackFiles:['catalog.json']},activeManifest,
  localPublishedManifest:manifest,publicReadback:{manifest:structuredClone(manifest),readOnly:true,publishedAt:'2026-10-30T10:05:00.000Z'}}}
test('a proven unsent invalid stage can be retired while preserving the verified published baseline and all original inputs',()=>{
 const input=fixture(),before=JSON.stringify(input),next=retireUnsentPreparation(input);
 assert.equal(JSON.stringify(input),before);assert.equal(next.active,null);assert.equal(next.coveredMarker,'retained');
 assert.equal(next.sync.asOf,input.state.publishedAsOf);assert.equal(next.sync.recoveredFromAnonymousPublishedReadback,true);
 assert.equal(next.preparationRecovery.rejectedAsOf,input.activeManifest.asOf);
});
test('derived summary manifests may differ while a changed ordinary source partition never passes',()=>{
 const input=fixture();input.localPublishedManifest={...input.localPublishedManifest,files:[...input.localPublishedManifest.files,{path:'summary.json',sha256:'b'.repeat(64),bytes:20}]};
 input.publicReadback.manifest.files.push({path:'summary.json',sha256:'c'.repeat(64),bytes:30},{path:'summary/000001.json',sha256:'d'.repeat(64),bytes:40});
 input.checkpoint.manifestSha256=hash(input.publicReadback.manifest);assert.equal(retireUnsentPreparation(input).active,null);
 input.localPublishedManifest.files[0]={path:'catalog.json',sha256:'e'.repeat(64),bytes:10};
 assert.throws(()=>retireUnsentPreparation(input),{code:'UNSAFE_PREPARATION_RECOVERY'});
});
test('unknown activation, upload phases, active checkpoints or inconsistent public/local versions never grant retirement',()=>{
 const mutations=[x=>x.state.sync.phase='upload',x=>x.state.sync.activationAttempted=true,x=>x.state.sync.activationState='unknown',
  x=>x.state.sync.activated=true,x=>x.state.code='readback-failed',x=>x.checkpoint.asOf=x.state.active.asOf,
  x=>x.checkpoint.activated=false,x=>x.publicReadback.manifest.files=[],x=>x.checkpoint.manifestSha256='0'.repeat(64),
  x=>x.publicReadback.readOnly=false,x=>x.activeManifest.files=[],x=>x.state.status='syncing',x=>x.publicReadback.publishedAt='2026-10-31T00:00:00.000Z'];
 for(const mutate of mutations){const input=fixture();mutate(input);assert.throws(()=>retireUnsentPreparation(input),{code:'UNSAFE_PREPARATION_RECOVERY'})}
});
