/** Fixed, passive DOM projection. No clicks, dismissal, input values or stored text. */
export function observeBrowserAccessGate() {
  const observation = { version: 1, candidateCount: 0, visibleCount: 0, excludedNavigationCount: 0,
    excludedDecorationCount: 0, decision: 'clear' };
  // Diagnostic-only fixed enums from checks already performed below. Never
  // retain node labels, attributes, URLs, geometry or exception messages.
  let worksRegion = 'not-inspected';
  const result = (blocked, decision, reason) => {
    observation.decision = decision;
    if (decision === 'unknown') observation.detail = { version: 1, reason, worksRegion };
    return { blocked, observation };
  };
  try {
    const width = window.innerWidth, height = window.innerHeight;
    if (!(width > 0 && height > 0)) return result(true, 'unknown', 'viewport-invalid');
    const selectors = '[role="dialog"],dialog,[aria-modal="true"],[class*="captcha"],[id*="captcha"],[class*="verify"],[id*="verify"],[class*="login"],[id*="login"],input[type="password"],input[type="tel"],form[action*="/login"],iframe[src*="/captcha/"]';
    const nodes = document.querySelectorAll(selectors);
    observation.candidateCount = Math.min(101, nodes.length);
    if (nodes.length > 100) return result(true, 'limit');
    const rectOf = node => {
      const rect = node.getBoundingClientRect();
      if (!['left', 'right', 'top', 'bottom', 'width', 'height'].every(key => Number.isFinite(rect[key]))) throw new Error('unknown geometry');
      return rect;
    };
    const visible = node => {
      const style = getComputedStyle(node), rect = rectOf(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
    };
    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const matches = (node, selector) => typeof node.matches === 'function' && node.matches(selector);
    const labelOf = node => {
      if (typeof node.getAttribute !== 'function') return null;
      const aria = node.getAttribute('aria-label');
      if (aria !== null) return aria.length <= 40 ? aria.trim() : null;
      const walker = document.createTreeWalker(node, 4);
      let value = '', part, seen = 0;
      while ((part = walker.nextNode())) {
        if (++seen > 8 || typeof part.nodeValue !== 'string' || part.nodeValue.length > 40 || value.length + part.nodeValue.length > 40) return null;
        value += part.nodeValue;
      }
      return value.trim();
    };
    let inspectedRegion = false, region = null;
    const knownWorksRegion = () => {
      if (inspectedRegion) return region;
      inspectedRegion = true;
      worksRegion = 'projection-error';
      const regions = document.querySelectorAll('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]');
      const regionCount = regions.length;
      if (regionCount > 8) { worksRegion = 'limit'; return null; }
      const shown = [...regions].filter(visible);
      const leaves = shown.filter(node => !shown.some(other => node !== other && node.contains(other)));
      if (leaves.length !== 1) {
        worksRegion = !regionCount ? 'absent' : !shown.length ? 'not-visible' : 'ambiguous';
        return null;
      }
      const candidate = leaves[0], rect = rectOf(candidate);
      // Match activation's bounded scrolling-owner lookup. A long list can
      // extend beyond an overflow container; its viewport midpoint may be
      // outside the actually visible works even when that visible area is clear.
      let scroller = null, ancestor = candidate;
      for (let i = 0; ancestor && i < 12; i++, ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.scrollHeight > ancestor.clientHeight + 1 && /^(auto|scroll)$/.test(style.overflowY)) { scroller = ancestor; break; }
      }
      if (!scroller) {
        const root = document.scrollingElement;
        if (root && root.scrollHeight > root.clientHeight + 1) scroller = root;
      }
      // No identified owner retains the prior viewport-only observation;
      // activation still independently requires a scrollable container.
      const bounds = !scroller || scroller === document.scrollingElement
        ? { left: 0, top: 0, right: width, bottom: height } : rectOf(scroller);
      const left = Math.max(0, rect.left, bounds.left), right = Math.min(width, rect.right, bounds.right);
      const top = Math.max(0, rect.top, bounds.top), bottom = Math.min(height, rect.bottom, bounds.bottom);
      if (right - left < 8 || bottom - top < 8) { worksRegion = 'small-area'; return null; }
      const hit = document.elementFromPoint(Math.floor((left + right) / 2), Math.floor((top + bottom) / 2));
      if (!hit || !(hit === candidate || candidate.contains(hit))) { worksRegion = 'occluded'; return null; }
      worksRegion = 'confirmed';
      region = { node: candidate, rect }; return region;
    };
    let unknownReason = null;
    for (const node of nodes) {
      if (!visible(node)) continue;
      observation.visibleCount++;
      // These are always gates. An innocuous-looking child inside one cannot
      // turn its surrounding challenge into an exempt navigation control.
      if (matches(node, '[role="dialog"],dialog,[aria-modal="true"]')) return result(true, 'modal');
      if (matches(node, '[class*="captcha"],[id*="captcha"],iframe[src*="/captcha/"]')) return result(true, 'challenge');
      if (matches(node, 'input[type="password"],input[type="tel"],form[action*="/login"]')) return result(true, 'credential-form');
      if (typeof node.closest !== 'function' || typeof node.querySelectorAll !== 'function') return result(true, 'unknown', 'dom-method-unavailable');
      if (node.closest('[role="dialog"],dialog,[aria-modal="true"],[class*="captcha"],[id*="captcha"],form[action*="/login"]')) return result(true, 'gate-ancestor');
      if (node.querySelectorAll('input,textarea,iframe,dialog,[role="dialog"],[aria-modal="true"],[class*="captcha"],[id*="captcha"],[contenteditable="true"]').length) return result(true, 'gate-descendant');
      // An earlier unknown candidate remains a denial, but must not mask a
      // later real gate. Inspect every remaining visible candidate's hard
      // checks before returning uncertainty; missing methods still fail closed.
      if (unknownReason !== null) continue;
      // Narrow positive exception: a small top-of-page semantic header/nav
      // control, outside a unique and hit-tested visible works region. A class
      // name alone, an absent list, or a merely transparent overlay is not enough.
      const container = node.closest('header,nav,[role="banner"],[role="navigation"]');
      const works = knownWorksRegion(), rect = rectOf(node);
      // Preserve the previous short-circuit check order and action decision.
      if (!container) { unknownReason = 'navigation-absent'; continue; }
      if (!visible(container)) { unknownReason = 'navigation-not-visible'; continue; }
      if (!works) { unknownReason = 'works-region-unavailable'; continue; }
      if (intersects(rect, works.rect)) { unknownReason = 'works-overlap'; continue; }
      if (rect.top < 0 || rect.bottom > Math.min(180, height * 0.25) || rect.bottom > works.rect.top) {
        unknownReason = 'outside-top-zone'; continue;
      }
      if (rect.left < 0 || rect.right > width) { unknownReason = 'outside-viewport'; continue; }
      if (rect.width > 240 || rect.height > 64) { unknownReason = 'oversize'; continue; }
      let control = matches(node, 'button,a,[role="button"],[role="link"]') ? node : null;
      if (!control && matches(node, 'div,span')) {
        const controls = node.querySelectorAll('button,a,[role="button"],[role="link"]');
        if (controls.length === 1 && visible(controls[0])) {
          const inner = rectOf(controls[0]);
          if (['left','right','top','bottom'].every(key => Math.abs(inner[key] - rect[key]) <= 2)) control = controls[0];
        }
      }
      if (control && /^(?:登录|登录\s*[\/／·]\s*注册|登录抖音|立即登录|Log\s*in|Sign\s*in)$/iu.test(labelOf(control) ?? '')) {
        observation.excludedNavigationCount++; continue;
      }
      if (rect.width <= 64 && rect.height <= 64 && matches(node, 'img,svg,[role="img"]')
        && /^(?:已认证|认证标识|官方认证|Verified|Verified\s+badge)$/iu.test(labelOf(node) ?? '')) {
        observation.excludedDecorationCount++; continue;
      }
      unknownReason = 'control-unrecognized';
    }
    if (unknownReason !== null) return result(true, 'unknown', unknownReason);
    return result(false, 'clear');
  } catch { return result(true, 'unknown', 'projection-error'); }
}

/** Playwright serializes each projection; module closures do not survive.
 * Inline ONLY this fixed local helper at module initialization, never page or
 * user strings. Both exports remain ordinary self-contained named functions. */
export function withBrowserAccessGate(projection) {
  if (!['observeFirstPageActivation', 'requestBrowserFirstPage'].includes(projection?.name)) throw new Error('Unknown browser projection');
  const source = Function.prototype.toString.call(projection), marker = '/* MCN_FIXED_ACCESS_GATE */';
  if (source.split(marker).length !== 2) throw new Error('Browser gate projection marker is missing or repeated');
  const compiled = source.replace(marker, `const observeBrowserAccessGate = ${Function.prototype.toString.call(observeBrowserAccessGate)};`);
  return Function(`"use strict"; return (${compiled});`)();
}

export function sanitizeBrowserAccessGateObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const decisions = new Set(['clear','limit','modal','challenge','credential-form','gate-ancestor','gate-descendant','unknown']);
  if (!decisions.has(value.decision)) return null;
  const keys = ['candidateCount','visibleCount','excludedNavigationCount','excludedDecorationCount'];
  if (keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > (key === 'candidateCount' ? 101 : 100))
    || value.visibleCount > value.candidateCount || value.excludedNavigationCount + value.excludedDecorationCount > value.visibleCount) return null;
  const reasons = new Set(['viewport-invalid','dom-method-unavailable','navigation-absent','navigation-not-visible',
    'works-region-unavailable','works-overlap','outside-top-zone','outside-viewport','oversize','control-unrecognized','projection-error']);
  const regions = new Set(['not-inspected','projection-error','limit','absent','not-visible','ambiguous','small-area','occluded','confirmed']);
  const detail = value.decision === 'unknown' && value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail)
    && value.detail.version === 1 && reasons.has(value.detail.reason) && regions.has(value.detail.worksRegion)
    ? { version: 1, reason: value.detail.reason, worksRegion: value.detail.worksRegion } : null;
  return { version: 1, ...Object.fromEntries(keys.map(key => [key, value[key]])), decision: value.decision,
    ...(detail ? { detail } : {}) };
}
