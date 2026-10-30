// Shared identity projection for supplementary data and the canonical roster.
// This does not create targets, enable collection or certify submitted works.
import {readStoredDouyinProfileIdentityMatches} from './profile-identity-proof.mjs';
import {readSupplementProfileIdentityLinks,submittedIdentity} from './supplement-profile-identity-links.mjs';

export function readSourceProfileTargets(db,{sources,reference,baseLinks=[]}){
 const targetIds=new Map();
 const append=(handle,id)=>{
  const key=submittedIdentity(handle);if(!key)return;
  const ids=targetIds.get(key)||[];if(!ids.includes(id))ids.push(id);targetIds.set(key,ids);
 };
 for(const link of baseLinks)append(link.matched_id,link.target_id);
 const saved=readSupplementProfileIdentityLinks(db,{sources,reference,baseLinks});
 for(const link of saved.links)append(link.matched_id,link.target_id);
 // A rejected durable receipt must not be rescued by the fresh fallback.
 const recorded=new Set(saved.recordedIds);
 const submitted=[...new Set(sources.flatMap(source=>source.request.rows
  .filter(row=>row?.platform==='douyin').map(row=>row.douyinId))
  .filter(value=>typeof value==='string'&&value.trim()))]
  .filter(value=>!recorded.has(submittedIdentity(value)));
 if(submitted.length){
  const proofs=readStoredDouyinProfileIdentityMatches(db,submitted,{reference});
  for(const proof of proofs.matches)append(proof.submittedAccountId,proof.targetId);
 }
 return targetIds;
}
