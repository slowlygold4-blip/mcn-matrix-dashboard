import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountMasterRoster } from '../public/master-roster.js';

const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
// Reuse only the established fake DOM skeleton, never its refresh assertions or
// a copied production implementation. No browser, local API or production data.
const priorHarness = readFileSync(new URL('./roster-refresh-ui-20261009.test.mjs', import.meta.url), 'utf8');
const { Node, make, fixture } = new Function('assert', 'settle',
  priorHarness.slice(priorHarness.indexOf('class Node {'), priorHarness.indexOf('async function mounted(')) + '\nreturn {Node,make,fixture};')(assert, settle);
const JOB = '91fdbe72-b76d-477f-aeb0-33ad48ed53ba';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function withSubmission(run, { readbackFails = false, closeDuringSubmit = false } = {}) {
  const previous = { document: globalThis.document, Option: globalThis.Option, location: globalThis.location };
  const doc = { nodes: [], createElement(tag) { const node = new Node(tag, this); this.nodes.push(node); return node; } };
  doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  globalThis.document = doc;
  globalThis.Option = class extends Node { constructor(label, value) { super('option', doc); this.textContent = label; this.value = value; } };
  globalThis.location = { href: 'http://fixture.invalid/?theme=tuantuan#accounts' };
  const payload = fixture(), requests = []; let reads = 0, failNext = false, nextRead = null;
  const submitGate = closeDuringSubmit ? deferred() : null;
  const host = make(doc, doc.body, 'main');
  const controller = mountMasterRoster({ host, pageSize: 2, isVisible: () => true, canEdit: () => true,
    fetcher: async () => { reads++; if (failNext) { failNext = false; throw new Error('network unavailable'); }
      if (nextRead) { const gate = nextRead; nextRead = null; return gate.promise; }
      return { ok: true, json: async () => structuredClone(payload) }; },
    api: async (path, options) => {
      requests.push({ path, body: JSON.parse(options.body) });
      const body = requests.at(-1).body;
      if (path.endsWith('/preview')) return { previewSha256: 'b'.repeat(64), entry: payload.items.find(item => item.key === body.entryKey), evidence: body.evidence,
        review: { status: 'resolvable', reason: '等待身份核对', canSubmit: true } };
      assert.equal(path, '/api/master-roster/supplement');
      payload.items[2].supplement = { jobId: JOB, status: 'queued', submittedAt: '2026-10-09T01:00:00Z', reason: '身份核对任务已保存' };
      if (submitGate) await submitGate.promise;
      return { job: { id: JOB, status: 'queued' } };
    } });
  try {
    await controller.ready; const root = host.children[0];
    const status = root.querySelector('[aria-label="监控状态"]'); status.value = 'pending'; await root.emit('change', status);
    const opener = root.querySelector('[data-roster-supplement="item-2"]'); opener.focus(); await root.emit('click', opener);
    const dialog = doc.nodes.find(node => node.tagName === 'dialog'), input = dialog.querySelector('input');
    input.value = 'https://v.douyin.com/fixture/'; await input.emit('input');
    const button = caption => doc.nodes.find(node => node.tagName === 'button' && node.textContent === caption);
    await button('预览补充资料').emit('click'); failNext = readbackFails;
    const submitted = button('确认提交核对').emit('click');
    if (submitGate) { await settle(); dialog.close(); await settle(); submitGate.resolve(); }
    await submitted; await settle();
    assert.equal(requests.length, 2, 'exactly preview then explicit submit, never a duplicate mutation');
    if (dialog.open) dialog.close(); await settle();
    assert.equal(doc.activeElement, opener, 'closing keeps keyboard place');
    await run({ doc, controller, root, payload, opener, dialog, input, requests, button,
      get reads() { return reads; }, set nextRead(value) { nextRead = value; } });
  } finally { controller.destroy(); Object.assign(globalThis, previous); }
}

test('accepted supplement is read back without requiring the user to abandon restored keyboard focus', async () => {
  await withSubmission(async f => {
    await f.controller.requestRefresh({ force: true }); await settle();
    assert.ok(f.reads >= 2, `accepted job must be read back; observed ${f.reads} roster reads`);
    assert.equal(f.opener.textContent, '查看已提交任务'); assert.equal(f.opener.disabled, false);
    assert.equal(f.doc.activeElement, f.opener); assert.match(f.root.textContent, /最新名册回读：待核对/);
    assert.doesNotMatch(f.root.textContent, /最新名册回读：启用监控/);
    await f.root.emit('click', f.opener);
    assert.equal(new URL(globalThis.location.href).searchParams.get('importJob'), JOB);
    assert.equal(new URL(globalThis.location.href).hash, '#import'); assert.equal(f.requests.length, 2);
  });
});

test('durable accepted receipt survives readback failure and recovers with a read-only retry', async () => {
  await withSubmission(async f => {
    assert.equal(f.reads, 2); assert.match(f.root.textContent, /名册读取失败/);
    assert.match(f.root.textContent, /已收到提交回执：等待身份核对/);
    assert.equal(f.opener.dataset.rosterReceipt, JOB); assert.equal(f.opener.disabled, false);
    await f.controller.requestRefresh({ force: true }); await settle();
    assert.equal(f.reads, 3); assert.match(f.root.textContent, /最新名册回读：待核对/);
    assert.equal(f.requests.length, 2); assert.equal(f.doc.activeElement, f.opener);
  }, { readbackFails: true });
});

test('real linked readback is shown in place, then filter totals apply when focus leaves', async () => {
  await withSubmission(async f => {
    const body = f.root.querySelector('tbody'), previousRow = body.children[0], replacements = body.replacements;
    f.payload.items[2].monitorStatus = 'enabled'; f.payload.items[2].targetId = 20;
    f.payload.items[2].supplement.status = 'linked'; f.payload.items[2].supplement.reason = '严格身份收据已确认';
    f.payload.summary = { total: 6, registered: 3, enabled: 3, paused: 0, pending: 3 };
    await f.controller.requestRefresh({ force: true }); await settle();
    assert.equal(body.children[0], previousRow); assert.equal(body.replacements, replacements);
    assert.equal(f.doc.activeElement, f.opener); assert.match(body.textContent, /最新名册回读：启用监控.*严格身份收据已确认/);
    assert.match(f.root.querySelector('.master-roster-counts').textContent, /待核对资料 4/);
    f.doc.body.focus(); await f.root.emit('focusout', f.opener);
    assert.match(f.root.querySelector('.master-roster-counts').textContent, /待核对资料 3/);
    assert.equal(f.root.querySelector('[data-roster-supplement="item-2"]'), null);
  });
});

test('real rejection becomes actionable after applying the buffered snapshot, with reason retained', async () => {
  await withSubmission(async f => {
    f.payload.items[2].supplement.status = 'review-required'; f.payload.items[2].supplement.reason = '作品作者不一致，请换一个作品';
    await f.controller.requestRefresh({ force: true }); await settle();
    assert.equal(f.doc.activeElement, f.opener); assert.match(f.root.textContent, /作品作者不一致/);
    f.doc.body.focus(); await f.root.emit('focusout', f.opener);
    const updated = f.root.querySelector('[data-roster-supplement="item-2"]');
    assert.equal(updated.textContent, '补充身份资料'); assert.equal(updated.disabled, false);
    assert.equal(updated.dataset.rosterReceipt, undefined); assert.match(f.root.textContent, /待核对资料 4/);
  });
});

test('another open unsubmitted draft is never replaced by readback of the accepted row', async () => {
  await withSubmission(async f => {
    const other = f.root.querySelector('[data-roster-supplement="item-3"]'); await f.root.emit('click', other);
    f.input.value = '未提交的新线索'; await f.input.emit('input'); await f.button('预览补充资料').emit('click');
    const review = f.dialog.querySelector('.master-roster-supplement-review'), before = review.textContent;
    f.payload.items[2].supplement.status = 'review-required'; f.payload.items[2].supplement.reason = '回读的失败原因';
    await f.controller.requestRefresh({ force: true }); await settle();
    assert.equal(f.dialog.open, true); assert.equal(f.input.value, '未提交的新线索'); assert.equal(review.textContent, before);
    assert.equal(f.requests.length, 3, 'only first preview+submit and explicit second preview');
    assert.equal(f.button('确认提交核对').disabled, false);
  });
});

test('late old readback cannot replace a newer terminal observation', async () => {
  await withSubmission(async f => {
    const gate = deferred(), old = structuredClone(f.payload); f.nextRead = gate;
    const first = f.controller.requestRefresh({ force: true }); await settle();
    f.payload.items[2].supplement.status = 'review-required'; f.payload.items[2].supplement.reason = '较新的真实终态';
    await f.controller.reload({ deferForInteraction: true });
    gate.resolve({ ok: true, json: async () => old }); await first;
    assert.match(f.root.textContent, /较新的真实终态/); assert.equal(f.doc.activeElement, f.opener);
  });
});

test('closing while submit is in flight does not lose the later durable receipt', async () => {
  await withSubmission(async f => {
    assert.equal(f.dialog.open, false); assert.equal(f.opener.dataset.rosterReceipt, JOB);
    assert.equal(f.opener.textContent, '查看已提交任务'); assert.equal(f.doc.activeElement, f.opener);
    assert.ok(f.reads >= 2); assert.equal(f.requests.length, 2);
  }, { closeDuringSubmit: true });
});
