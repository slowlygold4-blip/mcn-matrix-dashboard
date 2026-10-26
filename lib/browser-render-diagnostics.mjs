import { sanitizeProfileBootstrapStructure } from "./phase70-profile-bootstrap-structure.mjs";

/** Runs inside the existing page only. No external closures, requests or script execution. */
export function observeBrowserFirstScreen({ secUid, documentStatus }) {
  function projectProfileBootstrapStructure(value, secUid) {
    const out = { version: 1, attribution: 'bootstrap-structure-not-works-evidence',
      observation: 'observed', rootKind: 'unknown', rootKeyCount: null,
      numericBranchCount: null, knownRootKeyCount: null, otherRootKeyCount: null,
      appKind: 'missing', loaderDataKind: 'missing', appUserKind: 'missing',
      appUserInfoKind: 'missing', appUserDetailKind: 'missing', appPostKind: 'missing',
      appVideoDetailKind: 'missing', identitySlotCount: 0, identityMatchCount: 0,
      identityConflictCount: 0, postArrayCount: 0, postItemCount: 0 };
    const missing = Symbol('missing');
    const kind = input => input === missing ? 'missing' : input === null ? 'null'
      : Array.isArray(input) ? 'array' : typeof input === 'object' ? 'object' : 'scalar';
    const own = (input, key) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return missing;
      const field = Object.getOwnPropertyDescriptor(input, key);
      if (!field) return missing;
      if (!Object.hasOwn(field, 'value')) throw Error('accessor');
      return field.value;
    };
    const identities = new Set(), arrays = new Set();
    const identity = input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || identities.has(input)) return;
      identities.add(input);
      const camel = own(input, 'secUid'), snake = own(input, 'sec_uid');
      const ids = [camel, snake].filter(id => typeof id === 'string' && /^MS4wLj[\w-]{12,220}$/.test(id));
      if (!ids.length) return;
      if (out.identitySlotCount >= 1000) throw Error('limit');
      out.identitySlotCount++;
      if (ids.every(id => id === secUid)) out.identityMatchCount++;
      else out.identityConflictCount++;
    };
    const posts = input => {
      if (!Array.isArray(input) || arrays.has(input)) return;
      if (input.length > 1000 || out.postArrayCount >= 1000 || out.postItemCount + input.length > 10_000) throw Error('limit');
      arrays.add(input); out.postArrayCount++; out.postItemCount += input.length;
    };
    try {
      if (typeof secUid !== 'string' || !/^MS4wLj[\w-]{12,220}$/.test(secUid)) return null;
      out.rootKind = kind(value);
      if (out.rootKind !== 'object') return out;
      const keys = Object.keys(value);
      if (keys.length > 1000) throw Error('limit');
      const known = new Set(['app', 'loaderData', 'user', 'userInfo', 'userDetail', 'post', 'videoDetail']);
      out.rootKeyCount = keys.length;
      out.numericBranchCount = keys.filter(key => /^\d+$/.test(key)).length;
      out.knownRootKeyCount = keys.filter(key => known.has(key)).length;
      out.otherRootKeyCount = keys.length - out.numericBranchCount - out.knownRootKeyCount;
      const app = own(value, 'app');
      out.appKind = kind(app); out.loaderDataKind = kind(own(value, 'loaderData'));
      for (const [key, field] of [['user', 'appUserKind'], ['userInfo', 'appUserInfoKind'],
        ['userDetail', 'appUserDetailKind'], ['post', 'appPostKind'], ['videoDetail', 'appVideoDetailKind']]) {
        out[field] = kind(own(app, key));
      }
      // These are exact *declared* slots, not a recursive search for arbitrary ids.
      for (const container of [value, app]) {
        const user = own(container, 'user'), detail = own(container, 'userDetail');
        identity(user); identity(own(user, 'user')); identity(own(container, 'userInfo'));
        identity(detail); identity(own(detail, 'userInfo'));
        const post = own(container, 'post'); posts(own(post, 'data'));
      }
      for (const key of keys) if (/^\d+$/.test(key)) {
        const branch = own(value, key), user = own(branch, 'user');
        identity(own(user, 'user')); posts(own(own(branch, 'post'), 'data'));
      }
      return out;
    } catch {
      // No partial observation survives an accessor, limit or projection failure.
      return { version: 1, attribution: 'bootstrap-structure-not-works-evidence', observation: 'unavailable' };
    }
  }
  
  if (location.origin !== 'https://www.douyin.com'
    || ![`/user/${secUid}`, `/user/${secUid}/`].includes(location.pathname)) return null;
  const render = { version: 1, parseState: 'deferred', encoding: 'none', identityBasis: 'sec-uid-only',
    profileIdentity: 'unknown', candidateCount: null, postCount: null, authorMatchCount: null,
    authorConflictCount: null, validIdCount: null, duplicateIdCount: null, workCandidateCount: null };
  const result = { observation: 'observed', readyState: document.readyState,
    bodyPresent: Boolean(document.body), bodyChildCount: document.body?.childElementCount ?? 0,
    scriptCount: document.querySelectorAll('script').length,
    jsonScriptCount: document.querySelectorAll('script[type="application/json"]').length,
    renderDataPresent: Boolean(document.querySelector('script[id="RENDER_DATA"]')),
    nextDataPresent: Boolean(document.querySelector('script[id="__NEXT_DATA__"]')),
    worksAnchorCount: document.querySelectorAll('a[href^="/video/"], a[href^="/note/"], a[href^="https://www.douyin.com/video/"], a[href^="https://www.douyin.com/note/"]').length,
    render };
  if (!Number.isInteger(documentStatus) || documentStatus < 200 || documentStatus >= 300
    || !['interactive', 'complete'].includes(document.readyState)) return result;
  const visible = node => Boolean(node?.getClientRects?.().length
    && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none');
  const gated = selector => {
    let count = 0;
    for (const node of document.querySelectorAll(selector)) {
      if (++count > 100) return true; // Uninspected potential gates cannot permit a read.
      if (visible(node)) return true;
    }
    return false;
  };
  if (gated('[id^="captcha"],[class*="captcha"],iframe[src*="/captcha/"],[data-e2e="verify-dialog"]')
    || gated('[role="dialog"] input[type="tel"],[role="dialog"] input[type="password"],form[action*="/login"] input')) {
    render.parseState = 'gated'; return result;
  }
  if (!result.renderDataPresent) { render.parseState = 'absent'; return result; }
  const script = document.querySelector('script#RENDER_DATA[type="application/json"]');
  if (!script) { render.parseState = 'unknown'; return result; }
  const encoded = script.textContent;
  if (typeof encoded !== 'string') { render.parseState = 'invalid-json'; return result; }
  if (encoded.length > 2_000_000) { render.parseState = 'over-limit'; return result; }
  let json = encoded.trim(), value;
  render.encoding = json.startsWith('%') ? 'percent' : 'plain';
  if (render.encoding === 'percent') {
    try { json = decodeURIComponent(json); }
    catch { render.parseState = 'invalid-encoding'; return result; }
  }
  if (json.length > 2_000_000) { render.parseState = 'over-limit'; return result; }
  try { value = JSON.parse(json); }
  catch { render.parseState = 'invalid-json'; return result; }
  const queue = [{ value, depth: 0 }];
  let scheduled = 1;
  while (queue.length) {
    const item = queue.pop();
    if (item.depth > 14) { render.parseState = 'over-limit'; return result; }
    if (!item.value || typeof item.value !== 'object') continue;
    if (Array.isArray(item.value) && item.value.length > 1_000) { render.parseState = 'over-limit'; return result; }
    let keys = 0;
    for (const key in item.value) {
      if (!Object.prototype.hasOwnProperty.call(item.value, key)) continue;
      if (++keys > 1_000 || ++scheduled > 10_000) { render.parseState = 'over-limit'; return result; }
      queue.push({ value: item.value[key], depth: item.depth + 1 });
    }
  }
  render.bootstrapStructure = projectProfileBootstrapStructure(value, secUid);
  render.parseState = 'unknown';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  let branch = null, candidates = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || !/^\d+$/.test(key)) continue;
    const item = value[key];
    if (item && typeof item === 'object' && item.user && Array.isArray(item.post?.data)) {
      branch = item; candidates++;
    }
  }
  render.candidateCount = candidates;
  if (candidates !== 1) { if (candidates > 1) render.parseState = 'ambiguous'; return result; }
  render.parseState = 'legacy-user-post';
  const user = branch.user?.user;
  if (!user || typeof (user.secUid ?? user.sec_uid) !== 'string') return result;
  render.profileIdentity = (user.secUid ?? user.sec_uid) === secUid ? 'sec-uid-match' : 'mismatch';
  if (render.profileIdentity !== 'sec-uid-match') return result;
  render.postCount = branch.post.data.length;
  render.authorMatchCount = 0; render.authorConflictCount = 0;
  render.validIdCount = 0; render.duplicateIdCount = 0; render.workCandidateCount = 0;
  const seen = new Set();
  for (const post of branch.post.data) {
    const matches = post?.authorInfo?.secUid === secUid;
    if (matches) render.authorMatchCount++; else render.authorConflictCount++;
    // This describes the known legacy id field only; no metrics/works are emitted.
    const validId = typeof post?.id === 'string' && /^\d{15,25}$/.test(post.id);
    if (!validId) continue;
    render.validIdCount++;
    if (seen.has(post.id)) { render.duplicateIdCount++; continue; }
    seen.add(post.id);
    if (matches) render.workCandidateCount++;
  }
  return result;
}

const STATES = new Set(['absent', 'deferred', 'invalid-json', 'invalid-encoding', 'over-limit', 'unknown', 'legacy-user-post', 'ambiguous', 'gated']);
const COUNTS = ['candidateCount', 'postCount', 'authorMatchCount', 'authorConflictCount', 'validIdCount', 'duplicateIdCount', 'workCandidateCount'];
/** Second boundary: only small fixed enums/counts may leave the browser. */
export function sanitizeBrowserRenderDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const bootstrapStructure = sanitizeProfileBootstrapStructure(value.bootstrapStructure);
  return { version: 1, parseState: STATES.has(value.parseState) ? value.parseState : 'unknown',
    ...(bootstrapStructure ? { bootstrapStructure } : {}),
    encoding: ['none', 'plain', 'percent'].includes(value.encoding) ? value.encoding : 'none',
    identityBasis: 'sec-uid-only',
    profileIdentity: ['unknown', 'sec-uid-match', 'mismatch'].includes(value.profileIdentity) ? value.profileIdentity : 'unknown',
    ...Object.fromEntries(COUNTS.map(key => [key, Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1_000 ? value[key] : null])) };
}
