import { targetPlatform } from './target-platform.mjs';

// This bounds admission, not the roster: every new tick replans the entire
// persisted queue. Manual full-refresh requests retain their exact scope.
export const CONTINUOUS_COLLECTION_BATCH_LIMIT = 64;

export function selectContinuousCollectionBatch(targets, dueIds, now = new Date(), limit = CONTINUOUS_COLLECTION_BATCH_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid continuous collection batch limit');
  const asOf = now.getTime();
  if (!Number.isFinite(asOf)) throw new RangeError('Invalid continuous collection batch time');
  const due = new Set(dueIds);
  const lastAttempt = (target) => {
    const at = Date.parse(target.last_checked_at);
    // Missing or invalid attempt times cannot park a target behind the queue.
    return Number.isFinite(at) && at <= asOf ? at : -Infinity;
  };
  const ordered = targets.filter(target => target.enabled && target.provider !== 'manual' && due.has(Number(target.id)))
    .sort((a, b) => Number(b.type === 'hashtag') - Number(a.type === 'hashtag')
      || (lastAttempt(a) < lastAttempt(b) ? -1 : lastAttempt(a) > lastAttempt(b) ? 1 : 0)
      || Number(a.id) - Number(b.id));
  const selected = ordered.filter(target => target.type === 'hashtag').slice(0, limit).map(target => Number(target.id));
  const byPlatform = new Map();
  for (const target of ordered) {
    if (target.type === 'hashtag') continue;
    const platform = targetPlatform(target);
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(target);
  }
  // A small platform roster must not wait behind thousands of authors on
  // another platform. Oldest attempts lead each lane; no extra concurrency.
  for (let index = 0; selected.length < limit; index++) {
    let added = false;
    for (const lane of byPlatform.values()) {
      if (selected.length === limit) break;
      if (lane[index]) { selected.push(Number(lane[index].id)); added = true; }
    }
    if (!added) break;
  }
  return selected;
}
