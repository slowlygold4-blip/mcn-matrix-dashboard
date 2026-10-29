import { businessDateKey } from './utils.mjs';

// Coverage is about observations on one business date, never carried values
// or the number of HTTP attempts. A profile and its works list are independent.
export function accountCollectionCoverage(account, date, timeZone = 'Asia/Shanghai') {
  const onDate = value => Boolean(value && Number.isFinite(Date.parse(value)) && businessDateKey(value, timeZone) === date);
  const point = (account.trend || []).find(item => item.date === date);
  const profileObserved = ['followers', 'likes', 'posts'].some(key => typeof point?.[key] === 'number' && Number.isFinite(point[key]) && point[key] >= 0);
  const works = account.worksObservation || {};
  let worksState = 'missing';
  if (onDate(works.lastAttemptAt)) {
    if (['complete', 'limited', 'latest-public-window'].includes(works.coverage) && onDate(works.observedAt) && !works.carriedForward)
      worksState = works.coverage === 'latest-public-window' ? 'limited' : works.coverage;
    else if (['retry', 'unavailable'].includes(works.coverage)) worksState = 'unavailable';
    else worksState = 'unknown';
  }
  return { date, profileObserved, worksState };
}

export function summarizeCollectionCoverage(accounts, date) {
  const enabled = accounts.filter(account => account.enabled);
  const works = { complete: 0, limited: 0, unavailable: 0, unknown: 0, missing: 0 };
  let profileObservedCount = 0;
  for (const account of enabled) {
    const item = account.collection;
    if (item?.date === date && item.profileObserved === true) profileObservedCount++;
    const state = item?.date === date && Object.hasOwn(works, item.worksState) ? item.worksState : 'missing';
    works[state]++;
  }
  return { date, total: enabled.length, profileObservedCount, profileMissingCount: enabled.length - profileObservedCount, works };
}
