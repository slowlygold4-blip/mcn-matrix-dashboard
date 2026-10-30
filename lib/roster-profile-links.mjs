import { readStoredDouyinAliasMatches } from './roster-alias-history.mjs';
import {readSourceProfileTargets} from './source-profile-targets.mjs';
import {readLatestSourceJobs} from './table-source-jobs.mjs';
import {readCurrentCreatorSourceLinks,withCreatorSourceLinkSnapshot} from './creator-source-current-links.mjs';

const normalized = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const unique = values => [...new Set(values.filter(Boolean))];
const conflicting = item => item.platform !== 'douyin' || item.targetId != null || /^target:/.test(item.key || '')
  || item.identityCorrection != null
  || item.supplement?.status === 'conflict' || /定位锚点已变/.test(item.identityStatus || '')
  || (item.reviewReasons || []).some(reason => /(?:身份|账号|作者|发布者).*(?:不一致|冲突|不同作者)|定位锚点已变/.test(String(reason)));

/** Read projection only: attach a submitted current handle to an existing
 * monitored canonical account. Never create/enable a target, certify works,
 * rewrite the workbook, or count two entries as two monitored authors.
 */
export function linkRosterProfiles(db, sourceItems, options = {}) {
  const pending = sourceItems.filter(item => !conflicting(item) && item.accountIds?.length);
  if (!pending.length) return { items: sourceItems, linkedEntryCount: 0 };
  const evidence = readStoredDouyinAliasMatches(db, unique(pending.flatMap(item => item.accountIds)), options);
  return mergeRosterIdentityLinks(sourceItems, evidence);
}

/** Use the same validated source identity links as the public foundation.
 * Derived merges retain every source row; no job receipt or target is edited.
 */
export function linkRosterSourceProfiles(db,sourceItems,{reference=new Date().toISOString()}={}){
  const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!has('author_resolution_jobs')||!has('targets')||!sourceItems.some(item=>!conflicting(item)&&item.accountIds?.length))
    return {items:sourceItems,linkedEntryCount:0};
  return withCreatorSourceLinkSnapshot(db,()=>{
    const sources=readLatestSourceJobs(db,reference);
    const imported=has('creator_source_imports')?db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(reference):null;
    const baseLinks=imported?readCurrentCreatorSourceLinks(db,{imported,reference}).accountLinks:[];
    const ids=readSourceProfileTargets(db,{sources,reference,baseLinks});
    if(!ids.size)return {items:sourceItems,linkedEntryCount:0};
    const targets=new Map(db.prepare("SELECT id,locator,enabled FROM targets WHERE type='account' AND provider='public-web'").all().map(row=>[row.id,row]));
    const matches=[];
    for(const [handle,claims] of ids){
      if(claims.length!==1)continue;const target=targets.get(claims[0]);
      if(!target||!/^MS4wLj[\w-]{12,220}$/.test(target.locator))continue;
      matches.push({submittedAccountId:handle,targetId:target.id,canonicalAccountId:target.locator,
        targetEnabled:!!target.enabled,submittedWorksVerified:false,mode:'current-source-profile-identity'});
    }
    return mergeRosterIdentityLinks(sourceItems,{status:'ok',matches},{identityStatus:'来源身份已核验并关联现有账号；采样时效与作品覆盖另查'});
  });
}

/** Pure projection step. Only call with evidence from the validated database
 * reader, never a browser request or an imported 'verified' field. */
export function mergeRosterIdentityLinks(sourceItems, evidence, {identityStatus='提交号已有同账号改号历史凭据；沿用原监控及历史，采样时效与作品核验另查'}={}) {
  if (evidence.status !== 'ok') return { items: sourceItems, linkedEntryCount: 0 };
  const proofs = new Map(evidence.matches.map(proof => [proof.submittedAccountId, proof]));
  const items = sourceItems.map(item => structuredClone(item)), byTarget = new Map();
  for (const item of items.filter(item => item.targetId && item.platform === 'douyin')) {
    if (!byTarget.has(item.targetId)) byTarget.set(item.targetId, []);
    byTarget.get(item.targetId).push(item);
  }
  const removed = new Set();
  for (const item of items) {
    if (conflicting(item) || !item.accountIds?.length) continue;
    const matches = item.accountIds.map(value => proofs.get(normalized(value)));
    if (matches.some(value => !value) || new Set(matches.map(value => value.targetId)).size !== 1) continue;
    const proof = matches[0], targets = byTarget.get(proof.targetId);
    if (targets?.length !== 1) continue;
    const target = targets[0];
    if (target.monitorStatus !== (proof.targetEnabled ? 'enabled' : 'paused')) continue;
    // Identity does not resolve conflicting ownership of a matrix/theme.
    if (item.theme?.key !== target.theme?.key) continue;
    const expectedUrl = `https://www.douyin.com/user/${proof.canonicalAccountId}`;
    if (item.profileLinks?.some(url => url !== expectedUrl)) continue;
    for (const field of ['accountIds', 'sourceTitles', 'sourceLinks', 'evidenceLinks']) {
      target[field] = unique([...(target[field] || []), ...(item[field] || [])]);
    }
    for(const field of ['creatorSourceRows','creatorSourceAccountIds'])if(item[field]?.length)
      target[field]=unique([...(target[field]||[]),...item[field]]);
    target.originalNames = unique([...(target.originalNames || []), item.name, ...(item.originalNames || [])]);
    // These labels came from the same confirmed source/theme. Keep them on the
    // visible row as well as in the source evidence, so filtering loses nothing.
    target.classifications = [...new Map([...(target.classifications || []), ...(item.classifications || [])]
      .map(value => [value.key, value])).values()];
    target.boards = [...new Map([...(target.boards || []), ...(item.boards || [])]
      .map(value => [JSON.stringify([value.name, value.category, value.tier, value.organization]), value])).values()];
    for (const source of item.sources || []) {
      const same = (target.sources || []).find(existing => source.liveJobId
        ? existing.liveJobId === source.liveJobId
        : !existing.liveJobId && existing.url === source.url && existing.fileName === source.fileName
          && existing.sheetName === source.sheetName && existing.readAt === source.readAt);
      if (same) same.rows = unique([...(same.rows || []), ...(source.rows || [])]);
      else (target.sources ??= []).push(source);
    }
    target.linkedSourceEntries = [...(target.linkedSourceEntries || []), {
      key: item.key, accountIds: item.accountIds, boards: item.boards || [], classifications: item.classifications || [],
      theme: item.theme, reviewReasons: item.reviewReasons || [], proofs: matches,
    }];
    target.identityStatus = identityStatus;
    target.profileLinks = unique([...(target.profileLinks || []), expectedUrl]);
    removed.add(item.key);
  }
  return { items: items.filter(item => !removed.has(item.key)), linkedEntryCount: removed.size };
}
