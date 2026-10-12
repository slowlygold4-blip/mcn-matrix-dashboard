/**
 * Pure projection of an ALREADY parsed and bounded RENDER_DATA document.
 * Self-contained so the identical function body can be embedded in the owner's
 * existing browser read. Fixed slots are hints, not profile/works evidence.
 * It never emits identifiers, arbitrary keys, text, metrics or action eligibility.
 */
export function projectProfileBootstrapStructure(value, secUid) {
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

/** Second boundary: strictly reconstruct fixed fields, never spread input. */
export function sanitizeProfileBootstrapStructure(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || value.attribution !== 'bootstrap-structure-not-works-evidence') return null;
    const observation = value.observation === 'observed' ? 'observed' : 'unavailable';
    const out = { version: 1, attribution: 'bootstrap-structure-not-works-evidence', observation };
    if (observation !== 'observed') return out;
    const kinds = ['missing', 'null', 'array', 'object', 'scalar', 'unknown'];
    for (const key of ['rootKind', 'appKind', 'loaderDataKind', 'appUserKind', 'appUserInfoKind',
      'appUserDetailKind', 'appPostKind', 'appVideoDetailKind']) out[key] = kinds.includes(value[key]) ? value[key] : 'unknown';
    for (const key of ['rootKeyCount', 'numericBranchCount', 'knownRootKeyCount', 'otherRootKeyCount',
      'identitySlotCount', 'identityMatchCount', 'identityConflictCount', 'postArrayCount', 'postItemCount']) {
      const n = value[key], max = key === 'postItemCount' ? 10_000 : 1000;
      out[key] = Number.isSafeInteger(n) && n >= 0 && n <= max ? n : null;
    }
    return out;
  } catch { return null; }
}
