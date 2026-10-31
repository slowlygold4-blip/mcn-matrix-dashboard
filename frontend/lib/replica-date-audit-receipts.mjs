// Server-issued proofs only. Public uploads cannot address this private prefix.
import {auditDatePublication} from './replica-date-audit.mjs';
import {dateAuditPlan,dateAuditReceipt,dateAuditReceiptKey} from './replica-date-audit-plan.mjs';
async function receiptExists(bucket,expected,{signal}={}){
 signal?.throwIfAborted();const object=await bucket.get(dateAuditReceiptKey(expected));
 if(!object)return false;
 if(typeof object.size==='number'&&object.size>4096){await object.body?.cancel().catch(()=>{});return false;}
 const text=await object.text();signal?.throwIfAborted();
 return text===JSON.stringify(expected)+'\n';
}
export async function auditDateChunk({manifest,chunkIndex,bucket,readText,signal}){
 const plan=dateAuditPlan(manifest),receipt=dateAuditReceipt(plan,chunkIndex);
 if(await receiptExists(bucket,receipt,{signal}))return receipt;
 const result=await auditDatePublication({manifest,readText,signal,sourceRange:{start:receipt.start,end:receipt.end}});
 if(result.verifiedDaily!==receipt.verifiedDaily||result.fullySourceBound!==false)throw Error('date-audit-result-invalid');
 signal?.throwIfAborted();await bucket.put(dateAuditReceiptKey(receipt),JSON.stringify(receipt)+'\n',
  {httpMetadata:{contentType:'application/json'}});return receipt;
}
export async function requireDateAuditReceipts({manifest,bucket,signal}){
 const plan=dateAuditPlan(manifest);
 if(!plan.chunkCount)throw Object.assign(Error('date-audit-empty'),{code:'date-audit-incomplete'});
 for(let index=0;index<plan.chunkCount;index++)if(!await receiptExists(bucket,dateAuditReceipt(plan,index),{signal}))
  throw Object.assign(Error('date-audit-incomplete'),{code:'date-audit-incomplete'});
 return {fullySourceBound:true,verifiedDaily:plan.totalDaily};
}
