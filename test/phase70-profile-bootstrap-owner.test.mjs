import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeBrowserFirstScreen, sanitizeBrowserRenderDiagnostics } from '../lib/browser-render-diagnostics.mjs';
import { sanitizeBrowserWorksDiagnostics } from '../lib/douyin-browser-diagnostics.mjs';
import { projectProfileBootstrapStructure, sanitizeProfileBootstrapStructure } from '../lib/phase70-profile-bootstrap-structure.mjs';
const SEC = 'MS4wLjABAAAAphase70OwnerSyntheticProfile';
const OTHER = 'MS4wLjABAAAAphase70WrongSyntheticProfile';
const SECRET = 'P70_PRIVATE_PAYLOAD_NO_EXPORT';
function observe(value, { readyState = 'interactive', status = 200, gate = false, encoded = true } = {}) {
  let textReads = 0;
  const script = { get textContent() { textReads++; return typeof value === 'string' ? value : encoded ? encodeURIComponent(JSON.stringify(value)) : JSON.stringify(value); } };
  const sandbox = { location: { origin: 'https://www.douyin.com', pathname: `/user/${SEC}` },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { readyState, body: { childElementCount: 10 },
      get cookie() { throw Error(SECRET); },
      querySelector: selector => selector.includes('RENDER_DATA') ? script : null,
      querySelectorAll: selector => selector === 'script' || selector === 'script[type="application/json"]' ? [script]
        : gate && selector.includes('captcha') ? [{ getClientRects: () => [1] }] : [] } };
  const screen = JSON.parse(JSON.stringify(vm.runInNewContext(`(${observeBrowserFirstScreen.toString()})(${JSON.stringify({secUid: SEC, documentStatus: status})})`, sandbox)));
  return { screen, textReads };
}
const fixture = { app: { userInfo: { secUid: SEC, nickname: SECRET }, post: { data: [{ id: '7300000000000070070', desc: SECRET }] },
  videoDetail: { userInfo: { secUid: OTHER } } }, [SECRET]: { raw: SECRET } };
test('static embedded projector exactly matches independently tested pure function apart from line indentation', () => {
  const unindent = source => source.split('\n').map(line => line.trim()).join('\n');
  assert.ok(unindent(observeBrowserFirstScreen.toString()).includes(unindent(projectProfileBootstrapStructure.toString())));
});
test('actual serialized first-screen read uses same bounded parsed JSON for passive bootstrap projection', () => {
  const { screen, textReads } = observe(fixture);
  assert.equal(textReads, 1); assert.equal(screen.render.parseState, 'unknown'); assert.equal(screen.render.candidateCount, 0);
  assert.deepEqual(screen.render.bootstrapStructure, sanitizeProfileBootstrapStructure(projectProfileBootstrapStructure(fixture, SEC)));
  assert.doesNotMatch(JSON.stringify(screen), new RegExp(`${SECRET}|${SEC}|${OTHER}|7300000000000070070`));
});
test('actual first-screen plain/percent parsing yields identical non-accepting diagnostics', () => {
  const plain = observe(fixture, { encoded: false }).screen, percent = observe(fixture).screen;
  assert.equal(plain.render.encoding, 'plain'); assert.equal(percent.render.encoding, 'percent');
  assert.deepEqual(plain.render.bootstrapStructure, percent.render.bootstrapStructure);
  assert.equal('works' in plain, false); assert.equal('eligible' in plain, false);
});
test('legacy author-bound render counting is preserved without becoming collected works', () => {
  const value = { 41: { user: { user: { secUid: SEC } }, post: { data: [{ id: '7300000000000070070', authorInfo: { secUid: SEC } }] } } };
  const render = observe(value).screen.render;
  assert.equal(render.parseState, 'legacy-user-post'); assert.equal(render.workCandidateCount, 1);
  assert.deepEqual(render.bootstrapStructure, sanitizeProfileBootstrapStructure(projectProfileBootstrapStructure(value, SEC)));
});
test('parent and child canonical boundaries preserve only fixed bootstrap enums/counts', () => {
  const render = observe(fixture).screen.render;
  assert.deepEqual(sanitizeBrowserRenderDiagnostics(render).bootstrapStructure, render.bootstrapStructure);
  const parent = sanitizeBrowserWorksDiagnostics({version: 1, firstScreen: {observation: 'observed', render}});
  assert.deepEqual(parent.firstScreen.render.bootstrapStructure, render.bootstrapStructure);
  assert.doesNotMatch(JSON.stringify(parent), new RegExp(SECRET));
});
test('old stored diagnostics remain byte-shape compatible without invented bootstrap history', () => {
  const old = {version: 1, parseState: 'unknown', encoding: 'percent', identityBasis: 'sec-uid-only', profileIdentity: 'unknown', candidateCount: 0};
  assert.equal('bootstrapStructure' in sanitizeBrowserRenderDiagnostics(old), false);
  assert.equal('bootstrapStructure' in sanitizeBrowserWorksDiagnostics({version: 1, firstScreen: {render: old}}).firstScreen.render, false);
});
test('gate/non2xx/loading/malformed/overlimit JSON cannot expose a bootstrap projection', () => {
  for (const [value, options] of [[fixture,{gate:true}], [fixture,{status:403}], [fixture,{status:401}],
    [fixture,{readyState:'loading'}], ['%E0%A4%A',{}], ['{broken',{}],
    [Object.fromEntries(Array.from({length:1001},(_,i)=>[i,SECRET])),{}]]) {
    const {screen,textReads} = observe(value,options); assert.equal('bootstrapStructure' in screen.render, false);
    assert.equal(textReads, options.gate || options.status || options.readyState ? 0 : 1);
  }
});
