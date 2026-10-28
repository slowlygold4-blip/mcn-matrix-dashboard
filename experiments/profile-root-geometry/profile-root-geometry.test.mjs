import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { observeProfileRootGeometry as observe, sanitizeProfileRootGeometry as sanitize,
  profileRootGeometryIsCandidate as candidate } from './profile-root-geometry.mjs';
const SEC = 'MS4wLjABAAAAphase71SyntheticProfile';
const SECRET = 'P71_PRIVATE_STATE_MUST_NOT_ESCAPE';
function fixture(config = {}) {
  let reads = 0;
  const doc = { readyState: 'interactive' };
  const rect = { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
  const node = (overrides = {}) => ({ ownerDocument: doc, isConnected: true, tagName: 'DIV',
    getBoundingClientRect: () => rect, closest: () => null, ...overrides });
  const hit = node(config.hit), root = node({ tagName: 'HTML', clientHeight: 720, scrollHeight: 2000,
    scrollTop: 0, contains: value => value === hit, ...config.root });
  const body = node({ tagName: 'BODY', contains: value => value === hit, ...config.body });
  doc.documentElement = config.documentElement ?? root; doc.body = config.noBody ? null : body;
  doc.scrollingElement = config.noRoot ? null : config.otherRoot ? node() : config.bodyRoot ? body : root;
  if (config.bodyRoot) Object.assign(body, { clientHeight: 720, scrollHeight: 2000, scrollTop: 0, contains: value => value === hit });
  doc.querySelectorAll = () => { reads++; return config.gates ?? []; };
  doc.elementFromPoint = () => config.noHit ? null : hit;
  Object.defineProperty(doc, 'cookie', { get() { throw Error(SECRET); } });
  Object.defineProperty(doc, 'textContent', { get() { throw Error(SECRET); } });
  Object.assign(doc, config.doc);
  const sandbox = { URL, location: { href: config.url ?? `https://www.douyin.com/user/${SEC}` }, document: doc,
    window: { innerWidth: 1280, innerHeight: 720, ...config.window },
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: 'auto',
      ...(config.style?.(element, { root, hit, body }) ?? {}) }) };
  const out = JSON.parse(JSON.stringify(vm.runInNewContext(`(${observe.toString()})(${JSON.stringify({secUid: config.secUid ?? SEC, documentStatus: config.status ?? 200})})`, sandbox)));
  return { out, reads, root, hit, body };
}
test('serialized standard document root gives only fixed passive enums and no point/author/work authorization', () => {
  const {out,reads} = fixture(); assert.equal(candidate(out), true); assert.equal(reads, 1);
  assert.deepEqual(sanitize(out), out); assert.doesNotMatch(JSON.stringify(out), new RegExp(`${SEC}|${SECRET}`));
  for (const key of ['eligible', 'x', 'y', 'deltaY', 'secUid', 'posts', 'metrics', 'sourceUrl']) assert.equal(key in out, false);
});
test('standards body scrolling root is observed without a CSS-selector fallback', () => assert.equal(candidate(fixture({bodyRoot:true}).out), true));
test('unauthorized location/status/identity never queries the DOM or page JSON', () => {
  for (const config of [{status:403},{url:'https://evil.test/'},{secUid:'invalid'}]) {
    const {out,reads}=fixture(config); assert.equal(reads,0); assert.equal(out.observation,'not-eligible');
    assert.equal(candidate(out),false);
  }
});
for (const [name, config] of Object.entries({ otherAuthor:{url:'https://www.douyin.com/user/MS4wLjABAAAAOtherSyntheticProfile'},
  otherOrigin:{url:`https://evil.test/user/${SEC}`}, login:{url:'https://www.douyin.com/passport/login'},
  credentials:{url:`https://secret@www.douyin.com/user/${SEC}`}, invalidStatus:{status:403}, redirect:{status:302},
  missingIdentity:{secUid:'invalid'}, loading:{doc:{readyState:'loading'}}, missingBody:{noBody:true},
  invalidViewport:{window:{innerWidth:0}}, fractionalViewport:{window:{innerHeight:719.5}}, hugeViewport:{window:{innerHeight:20001}},
  missingRoot:{noRoot:true}, unknownRoot:{otherRoot:true}, detached:{root:{isConnected:false}}, invalidOwner:{root:{ownerDocument:{}}},
  hiddenOverflow:{style:(_, {root})=>({overflowY:'hidden'})}, clippedOverflow:{style:()=>({overflowY:'clip'})},
  noScroll:{root:{scrollHeight:720}}, bottom:{root:{scrollTop:1280}}, negativeTop:{root:{scrollTop:-1}},
  invalidDimensions:{root:{clientHeight:NaN}}, enormousDimensions:{root:{scrollHeight:10000001}},
  missingHit:{noHit:true}, foreignHit:{hit:{ownerDocument:{}}}, detachedHit:{hit:{isConnected:false}},
  controlHit:{hit:{closest:()=>({})}}, buttonHit:{hit:{tagName:'BUTTON'}}, videoHit:{hit:{tagName:'VIDEO'}},
  customHit:{hit:{tagName:'XG-PLAYER'}}, missingClosest:{hit:{closest:null}},
})) test(`fail closed for ${name}`, () => assert.equal(candidate(fixture(config).out), false));
test('visible gates are blocked, not dismissed; aggregate >100 gate cap is conservative', () => {
  const gate = {getBoundingClientRect:()=>({left:0,top:0,right:100,bottom:100,width:100,height:100})};
  for (const gates of [[gate], Array(101).fill(gate)]) assert.equal(candidate(fixture({gates}).out), false);
});
test('hidden gate can remain unacted; unknown style and malformed bounds are unavailable, never positive', () => {
  const gate = {getBoundingClientRect:()=>({left:0,top:0,right:100,bottom:100,width:100,height:100})};
  assert.equal(candidate(fixture({gates:[gate],style:node=>node===gate?{display:'none'}:{}}).out),true);
  for(const style of [{visibility:'maybe'},{opacity:'not-number'},{display:''}]) assert.equal(candidate(fixture({style:()=>style}).out),false);
  assert.equal(candidate(fixture({hit:{getBoundingClientRect:()=>({left:0,top:0,right:Infinity,bottom:1,width:1,height:1})}}).out),false);
});
test('malicious page getters fail closed without sensitive output', () => {
  const out=fixture({doc:{querySelectorAll:()=>{throw Error(SECRET)}}}).out;
  assert.equal(out.observation,'unavailable');assert.equal(candidate(out),false);assert.doesNotMatch(JSON.stringify(out),new RegExp(SECRET));
});
test('visible but non-hit geometry cannot qualify a point reported by an inconsistent DOM', () => {
  const out=fixture({hit:{getBoundingClientRect:()=>({left:0,top:0,right:100,bottom:100,width:100,height:100})}}).out;
  assert.equal(out.hitState,'outside-root'); assert.equal(candidate(out),false);
});
test('geometry is passive even when qualifying: no inputs, work-list selectors, text, identity or point output', () => {
  const source=observe.toString(),{out}=fixture();
  assert.equal(candidate(out),true);assert.doesNotMatch(source,/data-e2e|RENDER_DATA|__NEXT_DATA__|querySelector\(/);
  assert.deepEqual(Object.keys(out).sort(),['accessState','attribution','gateCount','hitState','observation','readyState','rootKind','rootState','version','viewportState'].sort());
});
test('sanitizer rejects attribution/version/getters and removes coordinates/raw extras', () => {
  const good=fixture().out, out=sanitize({...good,x:600,y:400,url:SECRET,rootState:SECRET,gateCount:102});
  assert.equal(out.rootState,'unknown');assert.equal(out.gateCount,null);assert.equal(candidate(out),false);
  assert.equal('x' in out,false);assert.doesNotMatch(JSON.stringify(out),new RegExp(SECRET));
  assert.equal(sanitize({...good,attribution:'works-evidence'}),null);assert.equal(sanitize({...good,version:2}),null);
  Object.defineProperty(good,'accessState',{get(){throw Error(SECRET)}});assert.equal(sanitize(good),null);assert.equal(candidate(good),false);
});
test('unknown, stale and partial geometry cannot qualify; old absence stays absent', () => {
  const good=fixture().out;
  for(const patch of [{observation:'timeout'},{observation:'stale-document'},{accessState:'unknown'},
    {rootState:'unknown'},{hitState:'unknown'},{gateCount:null},{viewportState:'unknown'}])assert.equal(candidate({...good,...patch}),false);
  assert.equal(sanitize(undefined),null);assert.equal(candidate(null),false);
});
test('observer has no network, action, timer, private text or JSON reads', () => {
  const source=observe.toString();
  assert.doesNotMatch(source,/\b(?:fetch|XMLHttpRequest|setTimeout|setInterval|addEventListener|localStorage|sessionStorage)\s*[.(]/);
  assert.doesNotMatch(source,/\.(?:click|wheel|move|goto|reload|evaluate|send|route|textContent|innerHTML|cookie|headers)\s*[.(]/);
  assert.doesNotMatch(source,/JSON\.(?:parse|stringify)/);
});
