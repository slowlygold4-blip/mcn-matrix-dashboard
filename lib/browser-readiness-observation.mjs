// Optional readiness qualification for the owner's RESERVED second first-screen.
// No scheduling, networking, actions, text/JSON/storage reads, or works acceptance.
const ATTRIBUTION = 'readiness-qualification-not-works-evidence';
const integer = value => Number.isSafeInteger(value) && value >= 0;

/**
 * Caller supplies current identity facts after its strict 2xx/profile/document
 * join. This predicate never derives identity from readiness, a URL or DOM text.
 * A single late opportunity is owned by the existing loop; short caller budgets
 * keep their original evaluation-count contract. Caller must set attempted=true
 * before starting a read and recheck generation AND document object afterward.
 */
export function shouldObserveReservedFirstScreen(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.active !== true || value.barrier !== false || value.successful !== false
      || value.aborted !== false || value.navigationFailed !== false
      || value.currentDocumentVerified !== true || value.attempted !== false) return false;
    if (!integer(value.generation) || value.generation === 0
      || value.documentGeneration !== value.generation
      || !Number.isInteger(value.documentStatus) || value.documentStatus < 200 || value.documentStatus >= 300) return false;
    if (value.firstScreenCount !== 1 || value.maxFirstScreenObservations !== 2
      || value.worksRequestCount !== 0 || value.pendingReadCount !== 0
      || value.firstScreen?.observation !== 'observed' || value.firstScreen.readyState !== 'loading') return false;
    if (![value.now, value.startedAt, value.deadline, value.totalDeadline].every(integer)
      || value.deadline > value.totalDeadline || value.startedAt > value.now
      || value.totalDeadline - value.startedAt <= 20_000 || value.now - value.startedAt < 1_000) return false;
    const remaining = value.deadline - value.now;
    return remaining >= 1_000 && remaining <= 5_000;
  } catch { return false; }
}

/** Serialized into only the existing private page. Nothing from a URL leaves. */
export function observeReservedFirstScreenReadiness({ secUid } = {}) {
  try {
    if (typeof secUid !== 'string' || !/^MS4wLj[\w-]{12,220}$/.test(secUid)
      || location.origin !== 'https://www.douyin.com'
      || ![`/user/${secUid}`, `/user/${secUid}/`].includes(location.pathname)) return null;
    const result = { version: 1, attribution: 'readiness-qualification-not-works-evidence',
      observation: 'observed', readyState: ['loading', 'interactive', 'complete'].includes(document.readyState)
        ? document.readyState : 'unknown', bodyPresent: Boolean(document.body), accessState: 'unknown' };
    if (!result.bodyPresent || !['interactive', 'complete'].includes(result.readyState)) return result;
    const visibleGate = selector => {
      let count = 0;
      for (const node of document.querySelectorAll(selector)) {
        if (++count > 100) return true;
        const style = getComputedStyle(node);
        if (node?.getClientRects?.().length && style.visibility !== 'hidden' && style.display !== 'none') return true;
      }
      return false;
    };
    // At least the existing activation gate vocabulary, never a narrower
    // login/captcha exemption. This read neither dismisses nor clicks a gate.
    const verification = '[role="dialog"],dialog,[aria-modal="true"],[id*="captcha"],[class*="captcha"],iframe[src*="/captcha/"],[class*="verify"],[id*="verify"],[data-e2e="verify-dialog"]';
    const login = '[class*="login"],[id*="login"],input[type="tel"],input[type="password"],form[action*="/login"] input';
    // One combined inventory retains the existing 100-potential-gate ceiling.
    result.accessState = visibleGate(`${verification},${login}`) ? 'gated' : 'clear';
    return result;
  } catch { return null; }
}

/** Unknown, malformed or gated structures never spend the reserved full probe. */
export function isReservedFirstScreenReady(value) {
  try {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && value.version === 1 && value.attribution === ATTRIBUTION && value.observation === 'observed'
      && ['interactive', 'complete'].includes(value.readyState)
      && value.bodyPresent === true && value.accessState === 'clear');
  } catch { return false; }
}
