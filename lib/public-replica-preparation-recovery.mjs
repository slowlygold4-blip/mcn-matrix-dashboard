import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const fail=()=>{throw Object.assign(new Error('未满足未上传批次恢复条件'),{code:'UNSAFE_PREPARATION_RECOVERY'})};
// Sync derives date/summary shards after the original export is sealed. The
// published manifest therefore differs, while every ordinary source partition
// must retain its bytes/checksum. Its full digest is independently checkpointed.
function samePublishedSource(local,remote){
 if(!Array.isArray(local?.files)||!Array.isArray(remote?.files))return false;
 const descriptor=f=>f&&typeof f.path==='string'&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0;
 if(!local.files.every(descriptor)||!remote.files.every(descriptor))return false;
 const files=new Map(remote.files.map(f=>[f.path,f]));
 return files.size===remote.files.length&&local.files.some(f=>f.path==='catalog.json')
  &&local.files.every(f=>f.path==='summary.json'||files.get(f.path)?.sha256===f.sha256&&files.get(f.path)?.bytes===f.bytes);
}

/** Pure proposal, only after the owned publisher is stopped. The caller must
 * retain the failed stage/control files and supply fresh anonymous readback.
 * Never discard a generation whose upload or activation may have started. */
export function retireUnsentPreparation({state,checkpoint,activeManifest,localPublishedManifest,publicReadback,now=new Date().toISOString()}){
 const active=state?.active,published=state?.publishedAsOf,remote=publicReadback?.manifest;
 if(!iso(now)||state?.version!==1||state.status!=='failed'||state.code!=='invalid-source'
  ||state.sync?.status!=='failed'||state.sync.code!=='invalid-source'||state.sync.phase!=='validate'
  ||state.sync.activated!==false||state.sync.activationState!=='not-attempted'||state.sync.activationAttempted
  ||!iso(active?.asOf)||!iso(published)||active.asOf<=published||active.asOf>now
  ||activeManifest?.asOf!==active.asOf||hash(activeManifest)!==active.manifestHash
  ||checkpoint?.asOf!==published||checkpoint.activated!==true||!Array.isArray(checkpoint.completedBatches)
  ||!Array.isArray(checkpoint.readbackFiles)||!checkpoint.readbackFiles.includes('catalog.json')
  ||localPublishedManifest?.asOf!==published||remote?.asOf!==published||publicReadback.readOnly!==true
  ||!iso(publicReadback.publishedAt)||publicReadback.publishedAt>now
  ||!samePublishedSource(localPublishedManifest,remote)||hash(remote)!==checkpoint.manifestSha256)fail();
 return {...state,active:null,status:'failed',code:'invalid-source',checkedAt:now,
  sync:{status:'success',phase:'complete',asOf:published,manifestSha256:hash(remote),parts:remote.files.length,
   batchesCompleted:checkpoint.completedBatches.length,readbackFiles:[...checkpoint.readbackFiles],
   recoveredFromAnonymousPublishedReadback:true},
  preparationRecovery:{at:now,rejectedAsOf:active.asOf,publishedAsOf:published,reason:'unsent-invalid-source'}};
}

/** Maintenance-only proposal for a proven bad derived view, after its owned
 * publisher has stopped. Uploaded immutable bytes remain quarantined; this
 * never retires a generation whose activation was attempted or is uncertain. */
export function retireRejectedUnactivatedPublication({state,checkpoint,activeManifest,localPublishedManifest,
 publicReadback,rejection,publisherStopped=false,now=new Date().toISOString()}){
 const unsafe=()=>{throw Object.assign(Error('未满足已拒绝发布批次恢复条件'),{code:'UNSAFE_REJECTED_PUBLICATION_RECOVERY'});};
 const active=state?.active,published=state?.publishedAsOf,remote=publicReadback?.manifest;
 const part=activeManifest?.files?.find(f=>f.path===rejection?.path);
 const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const receipts=rejection?.restoredReceiptIds,verified=publicReadback?.verifiedParts;
 if(publisherStopped!==true||!iso(now)||state?.version!==1||state.status!=='failed'||state.code!=='aborted'
  ||state.sync?.status!=='failed'||state.sync.code!=='aborted'||state.sync.phase!=='upload'
  ||state.sync.activated!==false||state.sync.activationState!=='not-attempted'||state.sync.activationAttempted
  ||!iso(active?.asOf)||!iso(published)||active.asOf<=published||active.asOf>now||state.sync.asOf!==active.asOf
  ||activeManifest?.asOf!==active.asOf||hash(activeManifest)!==active.manifestHash
  ||checkpoint?.asOf!==active.asOf||checkpoint.activated!==false||!sha(checkpoint.manifestSha256)
  ||!Array.isArray(checkpoint.batchSha256)||!checkpoint.batchSha256.length||!checkpoint.batchSha256.every(sha)
  ||!Array.isArray(checkpoint.completedBatches)||new Set(checkpoint.completedBatches).size!==checkpoint.completedBatches.length
  ||!checkpoint.completedBatches.every(i=>Number.isSafeInteger(i)&&i>=0&&i<checkpoint.batchSha256.length)
  ||rejection?.reason!=='durable-identity-proof-regression'||rejection.path!=='creator/authors.json'
  ||part?.sha256!==rejection.stagedSha256||!sha(rejection.correctedSha256)||rejection.correctedSha256===part?.sha256
  ||!Array.isArray(receipts)||!receipts.length||receipts.length>1000||new Set(receipts).size!==receipts.length
  ||!receipts.every(id=>Number.isSafeInteger(id)&&id>0)
  ||localPublishedManifest?.asOf!==published||remote?.asOf!==published||publicReadback.readOnly!==true
  ||!iso(publicReadback.publishedAt)||publicReadback.publishedAt>now
  ||!iso(publicReadback.checkedAt)||Date.parse(now)-Date.parse(publicReadback.checkedAt)<0
  ||Date.parse(now)-Date.parse(publicReadback.checkedAt)>60000||!samePublishedSource(localPublishedManifest,remote)
  ||!Array.isArray(verified)||!['catalog.json','creator/authors.json'].every(path=>verified.some(p=>p.path===path))
  ||!verified.every(p=>{const meta=remote.files.find(f=>f.path===p.path);return p.status===200&&meta?.sha256===p.sha256&&meta.bytes===p.bytes;}))unsafe();
 return {...state,active:null,status:'recovered',code:null,checkedAt:now,
  sync:{status:'success',phase:'complete',asOf:published,manifestSha256:hash(remote),parts:remote.files.length,
   batchesCompleted:0,readbackFiles:verified.map(p=>p.path),recoveredFromAnonymousPublishedReadback:true,
   recoveredBaselineOnly:true},
  publicationRejectionRecovery:{at:now,rejectedAsOf:active.asOf,publishedAsOf:published,rejection:structuredClone(rejection)}};
}
