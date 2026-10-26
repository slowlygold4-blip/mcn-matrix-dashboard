import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from '../scripts/douyin_browser_collector.mjs';

const secUid = 'MS4wLjABAAAAofflineReadinessFixture';
const profile = `https://www.douyin.com/user/${secUid}`;
function fixture(scenario) {
  const page = new EventEmitter();
  page.address = profile; page.ready = 'loading'; page.reads = 0;
  const frame = { url: () => page.address };
  page.url = frame.url; page.mainFrame = () => frame;
  page.evaluate = async () => { page.reads++; return { observation: 'observed', readyState: page.ready, bodyPresent: page.ready !== 'loading', scriptCount: 12 }; };
  page.commit = (status = 200) => {
    const request = { isNavigationRequest: () => true, method: () => 'GET', frame: () => frame, url: () => profile };
    page.address = profile; page.ready = 'loading'; page.emit('request', request);
    page.emit('response', { request: () => request, status: () => status, url: () => profile });
    page.emit('framenavigated', frame);
  };
  page.history = () => { page.address = `${profile}?ordinary=history`; page.emit('framenavigated', frame); };
  page.domReady = () => { page.ready = 'interactive'; page.emit('domcontentloaded'); };
  page.goto = async () => { page.commit(); scenario(page); };
  return page;
}
const run = (page, options = {}) => collectOne(page, { key: 'fixture', secUid, limit: 30 }, { timeoutMs: 100, ...options });

test('same-document profile navigation reserves second probe for DOM readiness', async () => {
  const page = fixture(p => { setTimeout(p.history, 10); setTimeout(p.domReady, 25); });
  const result = await run(page);
  assert.equal(page.reads, 2);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.equal(result.failureDiagnostics.firstScreen.bodyPresent, true);
  assert.equal(result.failureDiagnostics.stopReason, 'no-bound-request');
  assert.deepEqual(result.posts, []);
});

test('repeated ordinary history events cannot spend the reserved DOM-ready probe', async () => {
  const page = fixture(p => { setTimeout(() => { p.history(); p.history(); p.history(); }, 10); setTimeout(p.domReady, 25); });
  const result = await run(page);
  assert.equal(page.reads, 2);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
});

test('new document retains its own two probes and discards old pending observation', async () => {
  let resolveOld;
  const page = fixture(p => { setTimeout(p.commit, 10); setTimeout(p.history, 20); setTimeout(p.domReady, 30);
    setTimeout(() => resolveOld({ observation: 'observed', readyState: 'complete', scriptCount: 999 }), 45); });
  const evaluate = page.evaluate;
  page.evaluate = async (...args) => {
    if (!resolveOld) { page.reads++; return new Promise(resolve => { resolveOld = resolve; }); }
    return evaluate(...args);
  };
  const result = await run(page);
  assert.equal(page.reads, 3);
  assert.equal(result.failureDiagnostics.firstScreen.readyState, 'interactive');
  assert.equal(result.failureDiagnostics.firstScreen.scriptCount, 12);
});

test('HTTP refusal and abort do not permit late readiness probes', async () => {
  for (const mode of ['refusal', 'abort']) {
    const controller = new AbortController();
    const page = fixture(p => { setTimeout(() => mode === 'refusal' ? p.commit(403) : controller.abort(), 10);
      setTimeout(() => { p.history(); p.domReady(); }, 25); });
    const result = await run(page, { signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(page.reads, 1);
    assert.deepEqual(result.posts, []);
    assert.equal(result.errorCode, mode === 'refusal' ? 'blocked' : 'collector_error');
  }
});
