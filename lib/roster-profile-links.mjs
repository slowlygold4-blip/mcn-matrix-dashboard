import { readStoredDouyinAliasMatches } from './roster-alias-history.mjs';

const normalized = value => String(value ?? '').normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
const unique = values => [...new Set(values.filter(Boolean))];
const conflicting = item => item.platform !== 'douyin' || item.targetId != null || /^target:/.test(item.key || '')
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

/** Pure projection step. Only call with evidence from the validated database
 * reader, never a browser request or an imported 'verified' field. */
export function mergeRosterIdentityLinks(sourceItems, evidence) {
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
    target.identityStatus = '提交号已有同账号改号历史凭据；沿用原监控及历史，采样时效与作品核验另查';
    target.profileLinks = unique([...(target.profileLinks || []), expectedUrl]);
    removed.add(item.key);
  }
  return { items: items.filter(item => !removed.has(item.key)), linkedEntryCount: removed.size };
}
