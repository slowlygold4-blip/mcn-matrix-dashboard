import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeBrowserAccessGate, sanitizeBrowserAccessGateObservation } from '../lib/browser-access-gate.mjs';
import { observeFirstPageActivation, sanitizeFirstPageActivationStructure } from '../lib/browser-first-page-activation.mjs';
import { requestBrowserFirstPage } from '../lib/browser-first-works-request.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';

// Independent no-detail baseline: original admission conditions plus the
// separately approved bounded geometry fix. This suite still proves that
// diagnostic detail alone adds no DOM reads/actions or decision changes.
// The geometry suite independently reproduces the old unclipped-center defect.
function legacyGate() {
  const observation = { version: 1, candidateCount: 0, visibleCount: 0, excludedNavigationCount: 0,
    excludedDecorationCount: 0, decision: 'clear' };
  const result = (blocked, decision) => { observation.decision = decision; return { blocked, observation }; };
  try {
    const width = window.innerWidth, height = window.innerHeight;
    if (!(width > 0 && height > 0)) return result(true, 'unknown');
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
      const regions = document.querySelectorAll('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]');
      if (regions.length > 8) return null;
      const shown = [...regions].filter(visible);
      const leaves = shown.filter(node => !shown.some(other => node !== other && node.contains(other)));
      if (leaves.length !== 1) return null;
      const candidate = leaves[0], rect = rectOf(candidate);
      let scroller = null, ancestor = candidate;
      for (let i = 0; ancestor && i < 12; i++, ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.scrollHeight > ancestor.clientHeight + 1 && /^(auto|scroll)$/.test(style.overflowY)) { scroller = ancestor; break; }
      }
      if (!scroller) {
        const root = document.scrollingElement;
        if (root && root.scrollHeight > root.clientHeight + 1) scroller = root;
      }
      const bounds = !scroller || scroller === document.scrollingElement
        ? { left: 0, top: 0, right: width, bottom: height } : rectOf(scroller);
      const left = Math.max(0, rect.left, bounds.left), right = Math.min(width, rect.right, bounds.right);
      const top = Math.max(0, rect.top, bounds.top), bottom = Math.min(height, rect.bottom, bounds.bottom);
      if (right - left < 8 || bottom - top < 8) return null;
      const hit = document.elementFromPoint(Math.floor((left + right) / 2), Math.floor((top + bottom) / 2));
      if (!hit || !(hit === candidate || candidate.contains(hit))) return null;
      region = { node: candidate, rect }; return region;
    };
    for (const node of nodes) {
      if (!visible(node)) continue;
      observation.visibleCount++;
      if (matches(node, '[role="dialog"],dialog,[aria-modal="true"]')) return result(true, 'modal');
      if (matches(node, '[class*="captcha"],[id*="captcha"],iframe[src*="/captcha/"]')) return result(true, 'challenge');
      if (matches(node, 'input[type="password"],input[type="tel"],form[action*="/login"]')) return result(true, 'credential-form');
      if (typeof node.closest !== 'function' || typeof node.querySelectorAll !== 'function') return result(true, 'unknown');
      if (node.closest('[role="dialog"],dialog,[aria-modal="true"],[class*="captcha"],[id*="captcha"],form[action*="/login"]')) return result(true, 'gate-ancestor');
      if (node.querySelectorAll('input,textarea,iframe,dialog,[role="dialog"],[aria-modal="true"],[class*="captcha"],[id*="captcha"],[contenteditable="true"]').length) return result(true, 'gate-descendant');
      const container = node.closest('header,nav,[role="banner"],[role="navigation"]');
      const works = knownWorksRegion(), rect = rectOf(node);
      if (!container || !visible(container) || !works || intersects(rect, works.rect)
        || rect.top < 0 || rect.bottom > Math.min(180, height * 0.25) || rect.bottom > works.rect.top
        || rect.left < 0 || rect.right > width || rect.width > 240 || rect.height > 64) return result(true, 'unknown');
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
      return result(true, 'unknown');
    }
    return result(false, 'clear');
  } catch { return result(true, 'unknown'); }
}

const SEC = 'MS4wLjABAAAAGateReasonOfflineFixture';
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const defaults = { display: 'block', visibility: 'visible', opacity: '1', overflowY: 'visible' };
function fixture(options = {}) {
  const trace = [], requests = [];
  function element(id, rectangle, extra = {}) {
    const n = { id, style: { ...defaults }, contains: other => { trace.push(['contains', id, other?.id]); return other === n; },
      getBoundingClientRect: () => { trace.push(['rect', id]); return rectangle; }, ...extra };
    for (const key of ['innerText', 'textContent', 'innerHTML', 'value']) Object.defineProperty(n, key, { get() { assert.fail(`sensitive read ${key}`); } });
    return n;
  }
  const navigation = element('nav', box(0, 0, 1280, 100));
  if (options.hiddenNavigation) navigation.style.display = 'none';
  const region = element('region', options.smallRegion ? box(100, 220, 4, 4) : box(100, 220, 1000, 520),
    { scrollTop: 0, scrollHeight: 1500, clientHeight: 520, parentElement: null, style: { ...defaults, overflowY: 'auto' } });
  if (options.hiddenRegion) region.style.display = 'none';
  const tag = options.tag || 'button';
  const gate = element('gate', options.invalidRectangle ? { ...box(1120,20,80,32), left: NaN } : options.box || box(1120,20,80,32), {
    matches: selector => {
      trace.push(['matches', selector]);
      return selector.split(',').some(s => s === tag || ((s === '[role="dialog"]' || s === '[aria-modal="true"]') && options.modal)
        || (s.includes('captcha') && options.captcha) || ((s.startsWith('input[') || s.startsWith('form[')) && options.credential)
        || (s === '[role="img"]' && ['svg','img'].includes(tag)));
    },
    closest: selector => { trace.push(['closest', selector]); return selector.includes('role="dialog"')
      ? (options.ancestorGate ? navigation : null) : options.noNavigation ? null : navigation; },
    querySelectorAll: selector => { trace.push(['gate-query', selector]); return selector.startsWith('input') && options.descendantGate ? [{}] : []; },
    getAttribute: key => { trace.push(['attribute', key]); return key === 'aria-label' ? (options.label ?? '登录') : null; },
  });
  if (options.hiddenGate) gate.style.display = 'none';
  if (options.missingMethod) delete gate.closest;
  const document = { readyState: 'complete', scrollingElement: null,
    querySelectorAll: selector => {
      trace.push(['document-query', selector]);
      if (options.queryError) throw new Error('PRIVATE_SENTINEL');
      if (!selector.includes('user-post-list')) return options.noGate ? [] : options.gateLimit ? Array(101).fill(gate) : [gate];
      if (options.regionError) throw new Error('PRIVATE_SENTINEL');
      return options.noRegion ? [] : options.regionLimit ? Array(9).fill(region) : options.ambiguousRegion
        ? [region, element('region2', box(100, 220, 1000, 520))] : [region];
    },
    elementFromPoint: (x,y) => { trace.push(['hit', x,y]); return options.occluded ? {} : region; },
    createTreeWalker: () => { trace.push(['text-walker']); return { nextNode: () => null }; },
  };
  for (const key of ['cookie', 'body', 'innerText', 'textContent', 'innerHTML']) Object.defineProperty(document,key,{ get() { assert.fail(`broad read ${key}`); } });
  const context = vm.createContext({ URL, URLSearchParams, Date, AbortController, document, location: new URL(`https://www.douyin.com/user/${SEC}`),
    window: { innerWidth: options.invalidViewport ? 0 : 1280, innerHeight: 800,
      fetch: (...args) => { requests.push(args); return Promise.resolve({}); } },
    getComputedStyle: n => { trace.push(['style', n.id]); return n.style; }, setTimeout: () => 1, clearTimeout: () => {} });
  return { trace, requests, evaluate(source, args = {}) {
    context.args = { secUid: SEC, expiresAt: Date.now() + 5000, ...args };
    return JSON.parse(JSON.stringify(vm.runInContext(`(${source})(args)`, context)));
  } };
}

const cases = [
  ['no gate', { noGate: true }, null],
  ['navigation login', {}, null],
  ['verified decoration', { tag:'svg', label:'已认证', box:box(1120,20,24,24) }, null],
  ['modal', { modal:true }, null], ['captcha', { captcha:true }, null],
  ['credentials', { credential:true }, null], ['gate ancestor', { ancestorGate:true }, null],
  ['gate descendant', { descendantGate:true }, null], ['hidden gate', { hiddenGate:true,modal:true }, null],
  ['candidate limit', { gateLimit:true }, null],
  ['invalid viewport', { invalidViewport:true }, ['viewport-invalid','not-inspected']],
  ['missing method', { missingMethod:true }, ['dom-method-unavailable','not-inspected']],
  ['missing navigation', { noNavigation:true }, ['navigation-absent','confirmed']],
  ['hidden navigation', { hiddenNavigation:true }, ['navigation-not-visible','confirmed']],
  ['absent works', { noRegion:true }, ['works-region-unavailable','absent']],
  ['hidden works', { hiddenRegion:true }, ['works-region-unavailable','not-visible']],
  ['ambiguous works', { ambiguousRegion:true }, ['works-region-unavailable','ambiguous']],
  ['works cap', { regionLimit:true }, ['works-region-unavailable','limit']],
  ['small works', { smallRegion:true }, ['works-region-unavailable','small-area']],
  ['occluded works', { occluded:true }, ['works-region-unavailable','occluded']],
  ['overlapping gate', { box:box(400,300,80,32) }, ['works-overlap','confirmed']],
  ['outside top zone', { box:box(1120,180,80,32) }, ['outside-top-zone','confirmed']],
  ['outside viewport', { box:box(1260,20,80,32) }, ['outside-viewport','confirmed']],
  ['oversize gate', { box:box(0,0,400,64) }, ['oversize','confirmed']],
  ['unrecognized control', { label:'PRIVATE_SENTINEL' }, ['control-unrecognized','confirmed']],
  ['unavailable bounded label', { label:'PRIVATE_SENTINEL'.repeat(10) }, ['control-unrecognized','confirmed']],
  ['query exception', { queryError:true }, ['projection-error','not-inspected']],
  ['region exception', { regionError:true }, ['projection-error','projection-error']],
  ['invalid rectangle', { invalidRectangle:true }, ['projection-error','not-inspected']],
];

const currentSource = observeBrowserAccessGate.toString();
const originalSource = legacyGate.toString().replace('function legacyGate()', 'function observeBrowserAccessGate()');
for (const [name, options, expected] of cases) test(`passive detail: ${name}; decision, DOM reads and actions unchanged`, () => {
  for (const projection of [observeBrowserAccessGate, observeFirstPageActivation, requestBrowserFirstPage]) {
    const source = projection.toString();
    assert.ok(source.includes(currentSource));
    const before = fixture(options), after = fixture(options);
    const old = before.evaluate(source.replace(currentSource, originalSource));
    const actual = after.evaluate(source);
    assert.deepEqual(after.trace, before.trace, 'same DOM operations in the same order');
    assert.equal(after.requests.length, before.requests.length, 'same action count');
    const gate = projection === observeBrowserAccessGate ? actual.observation : actual.structure?.gates;
    if (gate) {
      if (expected) assert.deepEqual(gate.detail, { version:1, reason:expected[0], worksRegion:expected[1] });
      else assert.equal(Object.hasOwn(gate, 'detail'), false, 'non-unknown observations keep their old shape');
      delete gate.detail;
    }
    assert.deepEqual(actual, old, 'the only output difference is optional diagnostic detail');
  }
});

test('detail survives both diagnostic sanitizers; unknown properties and raw material never survive', () => {
  const raw = fixture({ noRegion:true }).evaluate(observeFirstPageActivation.toString()).structure;
  raw.gates.detail.label='PRIVATE_SENTINEL'; raw.gates.detail.url=`https://www.douyin.com/user/${SEC}`;
  raw.gates.detail.html='<input value="PRIVATE_SENTINEL">'; raw.gates.detail.coordinates=[100,200];
  const structure=sanitizeFirstPageActivationStructure(raw);
  assert.deepEqual(structure.gates.detail,{version:1,reason:'works-region-unavailable',worksRegion:'absent'});
  const outer=sanitizeBrowserWorksDiagnostics({version:1,continuationActivation:{version:1,probeCount:1,renderRecheckCount:0,
    actionCount:0,lastBranch:'blocked',structure}});
  assert.deepEqual(outer.continuationActivation.structure,structure);
  assert.deepEqual(sanitizeBrowserWorksDiagnostics(outer),outer);
  assert.doesNotMatch(JSON.stringify(outer),/PRIVATE_SENTINEL|https|MS4w|label|coordinates|<input/);
});

test('invalid detail is omitted while legacy observations keep their exact sanitized shape', () => {
  const legacy=fixture({ noRegion:true }).evaluate(originalSource).observation;
  assert.deepEqual(sanitizeBrowserAccessGateObservation(legacy),legacy);
  for (const detail of [null,[],{version:2,reason:'works-region-unavailable',worksRegion:'absent'},
    {version:1,reason:'PRIVATE_SENTINEL',worksRegion:'absent'},
    {version:1,reason:'works-region-unavailable',worksRegion:'PRIVATE_SENTINEL'}])
    assert.deepEqual(sanitizeBrowserAccessGateObservation({...legacy,detail}),legacy);
  const clear={...legacy,decision:'clear',detail:{version:1,reason:'works-region-unavailable',worksRegion:'absent'}};
  assert.equal(Object.hasOwn(sanitizeBrowserAccessGateObservation(clear),'detail'),false);
});
