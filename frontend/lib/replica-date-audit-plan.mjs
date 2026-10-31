import {createHash} from 'node:crypto';
export const DATE_AUDIT_CONTRACT='date-source-chunks-v1';
export const DATE_AUDIT_CHUNK_SIZE=256;
const demand=value=>{if(!value)throw Object.assign(Error('invalid-date-audit-plan'),{code:'date-audit-input'});};
export function dateAuditPlan(manifest){
 demand(manifest&&Array.isArray(manifest.files)&&typeof manifest.asOf==='string'
  &&Number.isFinite(Date.parse(manifest.asOf))&&new Date(manifest.asOf).toISOString()===manifest.asOf);
 const daily=manifest.files.filter(f=>f.kind==='daily');
 demand(daily.length<=100000&&daily.every(f=>Number.isSafeInteger(f.targetId)&&f.targetId>0
  &&f.path===`daily/${f.targetId}.json`&&Number.isSafeInteger(f.count)&&f.count>=0
  &&Number.isSafeInteger(f.bytes)&&f.bytes>0&&/^[a-f0-9]{64}$/.test(f.sha256))
  &&new Set(daily.map(f=>f.targetId)).size===daily.length);
 return {asOf:manifest.asOf,manifestHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
  totalDaily:daily.length,chunkCount:Math.ceil(daily.length/DATE_AUDIT_CHUNK_SIZE)};
}
export function dateAuditReceipt(plan,chunkIndex){
 demand(Number.isSafeInteger(chunkIndex)&&chunkIndex>=0&&chunkIndex<plan.chunkCount);
 const start=chunkIndex*DATE_AUDIT_CHUNK_SIZE,end=Math.min(plan.totalDaily,start+DATE_AUDIT_CHUNK_SIZE);
 return {contract:DATE_AUDIT_CONTRACT,...plan,chunkIndex,start,end,verifiedDaily:end-start};
}
export const dateAuditReceiptKey=receipt=>`__replica_date_audits/v1/${receipt.manifestHash}/${receipt.chunkIndex}.json`;
