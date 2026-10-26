import { runInNewContext } from 'node:vm';

// Offline DOM geometry only. The production structural projection is executed,
// not replaced with a hand-written eligible response or accepted works rows.
export function evaluateQualifiedPagination(fn, arg, address) {
  if (fn.name !== 'observeFirstPageActivation') return { observation: 'observed', readyState: 'interactive' };
  const rect = { left: 100, top: 100, right: 800, bottom: 600, width: 700, height: 500 };
  const region = { scrollTop: 0, clientHeight: 500, scrollHeight: 3000, parentElement: null,
    contains: node => node === region, getBoundingClientRect: () => rect };
  const document = { readyState: 'interactive', scrollingElement: region,
    querySelectorAll: selector => selector.includes('user-post-list') ? [region] : [],
    elementFromPoint: () => region };
  return runInNewContext(`(${fn.toString()})(arg)`, { arg, document, URL, location: new URL(address),
    window: { innerWidth: 1280, innerHeight: 720 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto' }) });
}
