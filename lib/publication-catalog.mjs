import {explicitWorkTopicEvidence} from './work-topic-classification.mjs';
import {publicationIdentity} from './replica-publishing.mjs';
const valid=v=>Number.isSafeInteger(v)&&v>=0;
const point=(value,origin='platform')=>({value:valid(value)?value:null,origin:valid(value)?origin:'unavailable'});
const unique=values=>[...new Set(values.filter(v=>typeof v==='string'&&v))].sort();
// Inputs are already privacy-redacted public projections. Match the ledger's
// tighter display contract without altering source or account history text.
const display=value=>String(value??'').replace(/[<>]/g,'').slice(0,300);
export {publicationIdentity};
export const publicationScope=account=>({theme:account?.classification?.theme?.key||'unassigned',
 boardKeys:unique(account?.boardKeys??[]),labels:unique((account?.classification?.labels??[]).map(l=>l.key))});
const day=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))
 ?new Date(Date.parse(value)+28800000).toISOString().slice(0,10):'';
/** Merge already verified saved work projections. No DB/network/identity guesses.
 * Existing source adoption wins on overlap; sampled counters are not added twice. */
export function buildPublicationCatalog({sourceWorks,accounts,partitions,asOf}){
 const byAccount=new Map(accounts.map(a=>[a.id,a])),rows=new Map(),owners=new Map(),ambiguous=new Set();
 const descriptors=new Map();
 const attach=(row,scope)=>{const key=JSON.stringify(scope);descriptors.set(key,scope);return {...row,_scope:key};};
 for(const work of sourceWorks){
  const account=byAccount.get(work.targetId),scope=account?.classification?.theme?.confirmed?publicationScope(account)
   :{theme:'tuantuan',boardKeys:['一条小团团切片矩阵'],labels:unique(['slice',...(work.registeredAuthorClassifications??[])])};
  const row=attach({contentId:work.contentId,date:work.date,author:display(work.author),title:display(work.title),targetId:work.targetId,
   classifications:work.classifications,origin:work.origin,metrics:work.metrics,platform:'douyin'},scope);
  const key=publicationIdentity(row);if(rows.has(key))throw Error('duplicate-source-publication');rows.set(key,row);
 }
 for(const part of partitions.filter(p=>p.kind==='works')){
  const account=byAccount.get(part.targetId);if(!account||!['douyin','bilibili'].includes(account.platform))continue;
  for(const work of part.items){
   const id=String(work.externalId??'');
   if(!(account.platform==='douyin'?/^\d{1,25}$/.test(id):/^BV[0-9A-Za-z]{10}$/.test(id)))throw Error('invalid-publication-platform-id');
   const key=`${account.platform}:${id}`;
   if(owners.has(key)&&owners.get(key)!==account.id)ambiguous.add(key);else owners.set(key,account.id);
   if(rows.has(key))continue;
   const date=work.publishedOn||day(work.publishedAt);
   const observed=Date.parse(work.lastObservedAt);
   const sourceOnly=work.source==='creator-source';
   const classifications=sourceOnly||Number.isFinite(observed)&&observed<=Date.parse(asOf)?unique(explicitWorkTopicEvidence(work.caption).map(e=>e.key)):[];
   const origin=sourceOnly?'source':'platform',plays=!sourceOnly&&account.platform==='douyin'&&work.plays===0?null:work.plays;
   rows.set(key,attach({contentId:id,date,author:display(account.label),title:display(work.caption),targetId:account.id,
    classifications,origin,platform:account.platform,metrics:{likes:point(work.likes,origin),plays:point(plays,origin)}},publicationScope(account)));
  }
 }
 // Conflicting platform ownership remains in original account history, never
 // gets counted twice or arbitrarily reassigned in the unified work ledger.
 const sourceIds=new Set(sourceWorks.map(w=>'douyin:'+w.contentId));
 for(const key of ambiguous)if(!sourceIds.has(key))rows.delete(key);
 const keys=unique([...rows.values()].map(row=>row._scope)),scopes=keys.map(key=>descriptors.get(key)),ids=new Map(keys.map((key,id)=>[key,id]));
 const items=[...rows.values()].filter(row=>!row.date||row.date>='2026-09-12').map(({_scope,...row})=>({...row,scopeId:ids.get(_scope)}));
 return {rows:items,scopes,ambiguousPlatformWorks:ambiguous.size};
}
