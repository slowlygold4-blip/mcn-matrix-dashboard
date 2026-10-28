/**
 * Passive, self-contained current-document projection. The owner may embed
 * this into its EXISTING read. No actions, requests, text, JSON or private state.
 * This is geometry only; it never proves an author or grants a wheel action.
 */
export function observeProfileRootGeometry({ secUid, documentStatus } = {}) {
  const out = { version: 1, attribution: 'profile-root-geometry-not-works-evidence',
    observation: 'not-eligible', readyState: 'unknown', viewportState: 'unknown',
    accessState: 'unknown', gateCount: null, rootKind: 'unknown', rootState: 'unknown',
    hitState: 'unknown' };
  try {
    if (typeof secUid !== 'string' || !/^MS4wLj[\w-]{12,220}$/.test(secUid)) return out;
    const url = new URL(location.href);
    if (url.origin !== 'https://www.douyin.com' || url.username || url.password
      || ![`/user/${secUid}`, `/user/${secUid}/`].includes(url.pathname)
      || !Number.isInteger(documentStatus) || documentStatus < 200 || documentStatus >= 300) return out;
    out.readyState = ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unknown';
    if (!['interactive', 'complete'].includes(out.readyState) || !document.body || !document.documentElement) return out;
    out.observation = 'observed';
    const width = window.innerWidth, height = window.innerHeight;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 8 || height < 8 || width > 20_000 || height > 20_000) {
      out.viewportState = 'invalid'; return out;
    }
    out.viewportState = 'valid';
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const fields = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height];
      if (!fields.every(Number.isFinite) || rect.width < 0 || rect.height < 0
        || rect.right < rect.left || rect.bottom < rect.top) throw Error('invalid geometry');
      const opacity = Number(style.opacity);
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1
        || !['visible', 'hidden', 'collapse'].includes(style.visibility)
        || typeof style.display !== 'string' || !style.display) throw Error('unknown style');
      return style.display !== 'none' && style.visibility === 'visible' && opacity > 0
        && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
    };
    // Existing activation gates plus the existing captcha-frame guard; no dismissal or interaction.
    const gates = document.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"],[class*="captcha"],[id*="captcha"],[class*="verify"],[id*="verify"],[class*="login"],[id*="login"],input[type="password"],input[type="tel"],iframe[src*="/captcha/"]');
    if (!gates || !Number.isSafeInteger(gates.length) || gates.length < 0) return out;
    out.gateCount = Math.min(101, gates.length);
    if (gates.length > 100) { out.accessState = 'over-limit'; return out; }
    for (const gate of gates) if (visible(gate)) { out.accessState = 'gated'; return out; }
    out.accessState = 'clear';
    const root = document.scrollingElement;
    if (!root) { out.rootKind = 'missing'; out.rootState = 'missing'; return out; }
    if (root !== document.documentElement && root !== document.body) { out.rootKind = 'other'; return out; }
    out.rootKind = root === document.documentElement ? 'document-element' : 'body';
    if (root.ownerDocument !== document || root.isConnected !== true) { out.rootState = 'detached'; return out; }
    const client = root.clientHeight, total = root.scrollHeight, top = root.scrollTop;
    if (![client, total, top].every(Number.isFinite) || client <= 0 || client > 10_000_000
      || total < client || total > 10_000_000 || top < 0 || top > total) { out.rootState = 'invalid'; return out; }
    const rootStyle = getComputedStyle(root);
    if (!visible(root) || !['visible', 'auto', 'scroll', 'overlay'].includes(rootStyle.overflowY)) {
      out.rootState = 'not-scrollable'; return out;
    }
    if (total <= client + 1) { out.rootState = 'not-scrollable'; return out; }
    if (top + client >= total - 1) { out.rootState = 'at-bottom'; return out; }
    out.rootState = 'scrollable';
    const x = Math.floor(width / 2), y = Math.floor(height / 2), hit = document.elementFromPoint(x, y);
    if (!hit) { out.hitState = 'missing'; return out; }
    if (hit.ownerDocument !== document || hit.isConnected !== true || !root.contains(hit)
      || !document.body.contains(hit)) { out.hitState = 'outside-root'; return out; }
    if (!visible(hit)) { out.hitState = 'not-visible'; return out; }
    const hitRect = hit.getBoundingClientRect();
    if (x < hitRect.left || x >= hitRect.right || y < hitRect.top || y >= hitRect.bottom) {
      out.hitState = 'outside-root'; return out;
    }
    const ordinary = ['DIV', 'SPAN', 'P', 'SECTION', 'ARTICLE', 'MAIN', 'UL', 'OL', 'LI', 'BODY',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'FIGCAPTION'];
    if (!ordinary.includes(hit.tagName)) { out.hitState = 'non-content'; return out; }
    if (typeof hit.closest !== 'function') return out;
    if (hit.closest('a,button,input,select,textarea,video,audio,iframe,canvas,[role="button"],[role="link"],[role="dialog"],dialog,[aria-modal="true"],[contenteditable="true"],[contenteditable=""]')) {
      out.hitState = 'control'; return out;
    }
    out.hitState = 'ordinary-content';
    return out;
  } catch {
    // Drop partial positives, exception strings and any geometry coordinates.
    return { version: 1, attribution: 'profile-root-geometry-not-works-evidence', observation: 'unavailable' };
  }
}

/** Fixed egress fields only. Omitted old observations must remain omitted. */
export function sanitizeProfileRootGeometry(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || value.attribution !== 'profile-root-geometry-not-works-evidence') return null;
    const observation = ['observed', 'not-eligible', 'unavailable'].includes(value.observation) ? value.observation : 'unavailable';
    const out = { version: 1, attribution: 'profile-root-geometry-not-works-evidence', observation };
    if (observation === 'unavailable') return out;
    const enums = { readyState: ['loading', 'interactive', 'complete'], viewportState: ['valid', 'invalid'],
      accessState: ['clear', 'gated', 'over-limit'], rootKind: ['missing', 'other', 'document-element', 'body'],
      rootState: ['missing', 'detached', 'invalid', 'not-scrollable', 'at-bottom', 'scrollable'],
      hitState: ['missing', 'outside-root', 'not-visible', 'non-content', 'control', 'ordinary-content'] };
    for (const [key, allowed] of Object.entries(enums)) out[key] = allowed.includes(value[key]) ? value[key] : 'unknown';
    out.gateCount = Number.isSafeInteger(value.gateCount) && value.gateCount >= 0 && value.gateCount <= 101 ? value.gateCount : null;
    return out;
  } catch { return null; }
}

/** Only a geometry predicate, NOT authorization. Owner guards remain mandatory. */
export function profileRootGeometryIsCandidate(value) {
  try {
    return value?.version === 1 && value.attribution === 'profile-root-geometry-not-works-evidence'
      && value.observation === 'observed' && ['interactive', 'complete'].includes(value.readyState)
      && value.viewportState === 'valid' && value.accessState === 'clear'
      && Number.isSafeInteger(value.gateCount) && value.gateCount >= 0 && value.gateCount <= 100
      && ['document-element', 'body'].includes(value.rootKind) && value.rootState === 'scrollable'
      && value.hitState === 'ordinary-content';
  } catch { return false; }
}
