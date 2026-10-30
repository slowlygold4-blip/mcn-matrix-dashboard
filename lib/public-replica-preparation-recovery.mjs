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
