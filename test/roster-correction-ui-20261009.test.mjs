import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MonitorDatabase } from '../lib/database.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement } from '../lib/master-roster-supplement.mjs';
import { runQueuedAuthorisedImport } from '../lib/authorised-import-queue.mjs';
import { canCorrectRosterAccountId, createRosterSupplementWorkflow, mountRosterSupplementDialog, validateMasterRoster, filterMasterRoster } from '../public/master-roster.js';

const SHA = 'a'.repeat(64), DIGEST = 'b'.repeat(64), UUID = '91fdbe72-b76d-477f-aeb0-33ad48ed53ba';
const VIDEO = '7684617087687331118', WORK = `https://www.douyin.com/video/${VIDEO}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function snapshot() {
  return { snapshotAt: '2026-10-09T18:00:00.000Z', workbook: { fileName: '原总表.xlsx', sha256: SHA },
    summary: { total: 1, registered: 0, enabled: 0, paused: 0, pending: 1 }, items: [{ key: 'submitted:douyin:wrong_id',
      platform: 'douyin', name: '<原始作者>', accountIds: ['wrong_id'], targetId: null, monitorStatus: 'pending',
      originalNames: [], identityStatus: '待核对', profileLinks: [], sourceLinks: [], sourceTitles: ['原始来源'],
      reviewReasons: ['缺少可验证的作者资料'], theme: { key: 'original', label: '原主题' }, classifications: [] }] };
}
function receipt(body, overrides = {}) {
  return { previewSha256: DIGEST, entry: snapshot().items[0], evidence: body.evidence,
    review: { canSubmit: true, status: 'resolvable', reason: '等待作品作者身份核验' },
    ...(body.correctedAccountId ? { requiresCorrectionConfirmation: true,
      correction: { originalAccountId: 'wrong_id', correctedAccountId: body.correctedAccountId } } : {}), ...overrides };
}
function setup({ api, canEdit = () => true } = {}) {
  const calls = [], source = snapshot();
  const workflow = createRosterSupplementWorkflow({ canEdit, randomUUID: () => UUID, api: async (path, options) => {
    const body = JSON.parse(options.body); calls.push({ path, options, body });
    return api ? api(path, body, options) : path.endsWith('/preview') ? receipt(body) : { job: { id: UUID, status: 'queued' } };
  } });
  workflow.open(source, source.items[0]);
  return { workflow, calls, source };
}
function correct(f, id = 'correct_id') { assert.equal(f.workflow.setCorrectionMode(true), true); f.workflow.editCorrectedAccountId(id); f.workflow.edit(WORK); }

test('ordinary supplement remains the default exact v1 request with no correction or confirmation fields', async () => {
  const f = setup(), before = structuredClone(f.source); assert.equal(f.workflow.state.correctionMode, false);
  assert.equal(f.workflow.state.correctedAccountId, ''); f.workflow.edit(WORK); await f.workflow.preview();
  assert.deepEqual(f.calls[0].body, { workbookSha256: SHA, entryKey: f.source.items[0].key, evidence: WORK });
  assert.equal(f.calls.length, 1); await f.workflow.submit();
  assert.deepEqual(f.calls[1].body, { ...f.calls[0].body, previewSha256: DIGEST }); assert.deepEqual(f.source, before);
});
test('explicit correction preserves textual IDs and needs matched preview then a separate confirmation call', async () => {
  const f = setup(), before = structuredClone(f.source); correct(f, ' @００１２３ ');
  await assert.rejects(f.workflow.submit(), /先预览/); assert.equal(f.calls.length, 0);
  const preview = await f.workflow.preview(); assert.equal(f.calls.length, 1); assert.equal(f.workflow.state.job, null);
  assert.deepEqual(preview.correction, { originalAccountId: 'wrong_id', correctedAccountId: '00123' });
  assert.equal(f.calls[0].body.correctedAccountId, '00123'); assert.equal(Object.hasOwn(f.calls[0].body, 'correctionConfirmed'), false);
  await f.workflow.submit(); assert.equal(f.calls[1].body.correctionConfirmed, true);
  assert.equal(f.calls[1].body.correctedAccountId, '00123'); assert.equal(f.calls[1].options.headers['Idempotency-Key'], UUID);
  assert.deepEqual(f.source, before); assert.equal(f.source.items[0].accountIds[0], 'wrong_id');
});
test('correction eligibility excludes frozen conflicts, canonical anchors, current targets, pauses, live sources and active tasks', () => {
  const item = snapshot().items[0]; assert.equal(canCorrectRosterAccountId(item), true);
  for (const changed of [{ platform: 'bilibili' }, { monitorStatus: 'paused', targetId: 7 }, { targetId: 7 }, { liveSource: true }, { readOnly: true },
    { accountIds: [] }, { accountIds: ['one', 'two'] }, { profileLinks: ['https://www.douyin.com/user/MS4wLjAAAAAAAAAAAAAAAAAAAA'] },
    { locators: ['MS4wLjAAAAAAAAAAAAAAAAAAAA'] }, { key: 'target:7' }, { reviewReasons: ['作品作者不符'] },
    ...['queued', 'running', 'awaiting-verification', 'conflict', 'linked'].map(status => ({ supplement: { status } }))]) {
    assert.equal(canCorrectRosterAccountId({ ...item, ...changed }), false, JSON.stringify(changed));
  }
});
test('blank or invalid or unchanged corrected IDs and non-work evidence cannot generate a request', async () => {
  const f = setup(); correct(f);
  for (const id of ['', ' ', 'wrong_id', ' @WRONG_ID ', '0', '...', 'correct_id\n', 'bad id', '名字', 'https://www.douyin.com/user/abc', 'x'.repeat(101)]) {
    f.workflow.editCorrectedAccountId(id); await assert.rejects(f.workflow.preview());
  }
  f.workflow.editCorrectedAccountId('correct_id');
  for (const evidence of [VIDEO, 'correct_id', 'https://www.douyin.com/user/MS4wLjAAAAAAAAAAAAAAAAAAAA', 'https://evil.example/video/' + VIDEO,
    'http://www.douyin.com/video/' + VIDEO, WORK + '?access_token=[REDACTED]', 'https://u:p@www.douyin.com/video/' + VIDEO, WORK + '\n' + WORK]) {
    f.workflow.edit(evidence); await assert.rejects(f.workflow.preview());
  }
  assert.equal(f.calls.length, 0);
});
test('old or mismatched correction preview fails closed and cannot approve a different identity', async () => {
  for (const changed of [{ correction: undefined, requiresCorrectionConfirmation: undefined }, { requiresCorrectionConfirmation: false },
    { correction: { originalAccountId: 'other', correctedAccountId: 'correct_id' } },
    { correction: { originalAccountId: 'wrong_id', correctedAccountId: 'another' } },
    { correction: { originalAccountId: 'wrong_id', correctedAccountId: 123 } }]) {
    const f = setup({ api: async (_, body) => receipt(body, changed) }); correct(f);
    await assert.rejects(f.workflow.preview(), /更正预览/); assert.equal(f.workflow.state.canSubmit, false);
    await assert.rejects(f.workflow.submit(), /先预览/); assert.equal(f.calls.length, 1);
  }
  const ordinary = setup({ api: async (_, body) => receipt({ ...body, correctedAccountId: 'correct_id' }) }); ordinary.workflow.edit(WORK);
  await assert.rejects(ordinary.workflow.preview(), /更正预览/); assert.equal(ordinary.workflow.state.canSubmit, false);
});
test('editing either field or changing mode revokes approval and never reuses an old-mode preview', async () => {
  for (const mutate of [f => f.workflow.editCorrectedAccountId('new_id'), f => f.workflow.edit(WORK + '?x=2'), f => f.workflow.setCorrectionMode(false)]) {
    const f = setup(); correct(f); await f.workflow.preview(); mutate(f);
    assert.equal(f.workflow.state.preview, null); await assert.rejects(f.workflow.submit(), /先预览/);
  }
  const wait = deferred(), f = setup({ api: async () => wait.promise }); correct(f);
  const pending = f.workflow.preview(), oldBody = f.calls[0].body; f.workflow.setCorrectionMode(false); wait.resolve(receipt(oldBody));
  assert.equal(await pending, null); assert.equal(f.workflow.state.canSubmit, false);
  const ordinary = setup(); correct(ordinary); ordinary.workflow.setCorrectionMode(false); await ordinary.workflow.preview();
  assert.equal(Object.hasOwn(ordinary.calls[0].body, 'correctedAccountId'), false);
});
test('permission loss and dialog lifecycle invalidate late corrections; no guessed correction survives reopen', async () => {
  let allowed = true; const wait = deferred(), f = setup({ canEdit: () => allowed, api: async () => wait.promise }); correct(f);
  const pending = f.workflow.preview(); allowed = false; wait.resolve(receipt(f.calls[0].body)); assert.equal(await pending, null);
  assert.equal(f.workflow.setCorrectionMode(true), false); assert.equal(f.workflow.editCorrectedAccountId('other'), false);
  await assert.rejects(f.workflow.submit(), /只读/); assert.equal(f.calls.length, 1);
  allowed = true; f.workflow.close(); f.workflow.open(f.source, f.source.items[0]);
  assert.equal(f.workflow.state.correctionMode, false); assert.equal(f.workflow.state.correctedAccountId, ''); assert.equal(f.workflow.state.evidence, '');
});
test('uncertain correction submission retains exact intent and idempotency; submit overlap cannot edit or issue another call', async () => {
  let attempts = 0; const wait = deferred(), f = setup({ api: async (path, body) => {
    if (path.endsWith('/preview')) return receipt(body); if (++attempts === 1) throw new Error('offline'); return wait.promise;
  } }); correct(f); await f.workflow.preview(); await assert.rejects(f.workflow.submit(), /offline/);
  const pending = f.workflow.submit(); assert.equal(await f.workflow.submit(), null);
  assert.equal(f.workflow.setCorrectionMode(false), false); assert.equal(f.workflow.editCorrectedAccountId('other'), false);
  assert.deepEqual(f.calls[1].body, f.calls[2].body); assert.equal(f.calls[1].options.headers['Idempotency-Key'], f.calls[2].options.headers['Idempotency-Key']);
  wait.resolve({ job: { id: UUID, status: 'queued' } }); await pending;
});
test('read overlay keeps original ID visible and searchable while preserving pending or paused monitoring state', () => {
  for (const status of ['pending', 'verified']) {
    const source = snapshot(); source.items[0].identityCorrection = { originalAccountId: 'wrong_id', correctedAccountId: '00123', status };
    if (status === 'verified') { source.items[0].monitorStatus = 'paused'; source.items[0].targetId = 7; source.summary = { total: 1, registered: 1, enabled: 0, paused: 1, pending: 0 }; }
    const read = validateMasterRoster(source); assert.deepEqual(read.items[0].accountIds, ['wrong_id']);
    assert.equal(read.summary.enabled, 0); assert.equal(filterMasterRoster(read.items, { query: '00123' }).length, 1);
    assert.equal(filterMasterRoster(read.items, { query: 'wrong_id' }).length, 1);
  }
  for (const change of [{ originalAccountId: 'other' }, { correctedAccountId: 123 }, { status: 'enabled' }]) {
    const source = snapshot(); source.items[0].identityCorrection = { originalAccountId: 'wrong_id', correctedAccountId: '00123', status: 'pending', ...change };
    assert.throws(() => validateMasterRoster(source), /更正回执/);
  }
});

// Offline DOM fixture. No platform, browser, server, or production DB is used.
class Node {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.parent = null; this.listeners = new Map(); this.attrs = new Map(); this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this._text = ''; }
  set innerHTML(_) { throw new Error('No raw HTML in supplement dialog'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get isConnected() { return this === this.doc.body || Boolean(this.parent?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  removeAttribute(key) { this.attrs.delete(key); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
  async emit(type) { for (const fn of this.listeners.get(type) || []) await fn({ target: this, preventDefault() {} }); }
  focus() { this.doc.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
}
async function mounted(run, { api, canEdit = () => true } = {}) {
  const before = { document: globalThis.document, location: globalThis.location };
  const doc = { nodes: [], createElement(tag) { const node = new Node(tag, this); this.nodes.push(node); return node; } };
  doc.body = doc.createElement('body'); globalThis.document = doc; globalThis.location = { href: 'http://localhost:4188/#accounts' };
  const host = doc.createElement('main'), opener = doc.createElement('button'); doc.body.append(host, opener); const calls = [];
  const controller = mountRosterSupplementDialog({ host, canEdit, api: async (path, options) => {
    const body = JSON.parse(options.body); calls.push({ path, options, body });
    return api ? api(path, body) : path.endsWith('/preview') ? receipt(body) : { job: { id: UUID, status: 'queued' } };
  } });
  const source = snapshot(); controller.open(source, source.items[0], opener);
  const field = suffix => doc.nodes.find(node => node.id?.endsWith(suffix));
  const button = label => doc.nodes.find(node => node.tagName === 'button' && node.textContent === label);
  try { await run({ doc, source, controller, calls, opener, field, button, dialog: doc.nodes.find(node => node.tagName === 'dialog') }); }
  finally { controller.destroy(); Object.assign(globalThis, before); }
}
test('actual dialog defaults to ordinary supplement, uses plain text preview and requires the clearly named correction confirmation', async () => {
  await mounted(async f => {
    const evidence = f.field('-evidence'), toggle = f.field('-correction-mode'), corrected = f.field('-corrected-id');
    assert.equal(toggle.checked, false); assert.equal(corrected.value, ''); assert.equal(f.doc.activeElement, evidence); assert.equal(f.calls.length, 0);
    toggle.checked = true; await toggle.emit('change'); assert.equal(f.doc.activeElement, corrected);
    corrected.value = '00123'; await corrected.emit('input'); evidence.value = WORK; await evidence.emit('input');
    assert.equal(f.calls.length, 0); await f.button('预览账号 ID 更正').emit('click'); assert.equal(f.calls.length, 1);
    assert.match(f.dialog.textContent, /原账号 ID：wrong_id/); assert.match(f.dialog.textContent, /拟更正为：00123/); assert.match(f.dialog.textContent, /原名单文字与历史导入不会改写/);
    const confirm = f.button('确认更正 ID 并提交核验'); assert.equal(confirm.hidden, false); assert.equal(confirm.disabled, false);
    await confirm.emit('click'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].body.correctionConfirmed, true);
    assert.match(f.dialog.textContent, /不是采集成功通知/); assert.equal(toggle.disabled, true); assert.equal(corrected.disabled, true);
  });
});
test('correction field errors are accessible and focused; editing clears preview and closing restores focus', async () => {
  await mounted(async f => {
    const evidence = f.field('-evidence'), toggle = f.field('-correction-mode'), corrected = f.field('-corrected-id');
    toggle.checked = true; await toggle.emit('change'); evidence.value = WORK; await evidence.emit('input');
    await f.button('预览账号 ID 更正').emit('click'); assert.equal(f.calls.length, 0); assert.equal(f.doc.activeElement, corrected);
    assert.equal(corrected.attrs.get('aria-invalid'), 'true'); assert.match(corrected.attrs.get('aria-describedby'), /-error/);
    corrected.value = 'correct_id'; await corrected.emit('input'); await f.button('预览账号 ID 更正').emit('click');
    corrected.value = 'other'; await corrected.emit('input'); assert.equal(f.button('确认更正 ID 并提交核验').hidden, true);
    assert.equal(f.button('确认更正 ID 并提交核验').disabled, true);
    await f.dialog.emit('cancel'); assert.equal(f.dialog.open, false); assert.equal(f.doc.activeElement, f.opener);
    f.controller.open(f.source, f.source.items[0], f.opener); assert.equal(toggle.checked, false); assert.equal(corrected.value, '');
  });
});
test('role revocation hides correction approval and retains the draft without another request', async () => {
  let allowed = true;
  await mounted(async f => {
    const toggle = f.field('-correction-mode'), corrected = f.field('-corrected-id'), evidence = f.field('-evidence');
    toggle.checked = true; await toggle.emit('change'); corrected.value = 'correct_id'; await corrected.emit('input'); evidence.value = WORK; await evidence.emit('input');
    await f.button('预览账号 ID 更正').emit('click'); allowed = false; f.controller.syncRole();
    assert.equal(corrected.value, 'correct_id'); assert.equal(evidence.value, WORK); assert.equal(toggle.disabled, true); assert.equal(corrected.disabled, true);
    const confirm = f.button('确认更正 ID 并提交核验'); assert.equal(confirm.hidden, true); await confirm.emit('click'); assert.equal(f.calls.length, 1);
  }, { canEdit: () => allowed });
});
test('turning correction mode off keeps evidence draft, removes approval and sends the next preview as ordinary v1', async () => {
  await mounted(async f => {
    const toggle = f.field('-correction-mode'), corrected = f.field('-corrected-id'), evidence = f.field('-evidence');
    toggle.checked = true; await toggle.emit('change'); corrected.value = 'correct_id'; await corrected.emit('input'); evidence.value = WORK; await evidence.emit('input');
    await f.button('预览账号 ID 更正').emit('click'); toggle.checked = false; await toggle.emit('change');
    assert.equal(evidence.value, WORK); assert.equal(f.doc.activeElement, evidence); assert.equal(corrected.disabled, true);
    assert.equal(f.button('确认提交核对').hidden, true); await f.button('预览补充资料').emit('click');
    assert.equal(f.calls.length, 2); assert.equal(Object.hasOwn(f.calls[1].body, 'correctedAccountId'), false);
    assert.equal(Object.hasOwn(f.calls[1].body, 'correctionConfirmed'), false);
  });
});
test('a correction 409 keeps both drafts but withdraws approval; closing an accepted request never reopens the dialog', async () => {
  await mounted(async f => {
    const toggle = f.field('-correction-mode'), corrected = f.field('-corrected-id'), evidence = f.field('-evidence');
    toggle.checked = true; await toggle.emit('change'); corrected.value = 'correct_id'; await corrected.emit('input'); evidence.value = WORK; await evidence.emit('input');
    await f.button('预览账号 ID 更正').emit('click'); await f.button('确认更正 ID 并提交核验').emit('click');
    assert.equal(corrected.value, 'correct_id'); assert.equal(evidence.value, WORK);
    assert.equal(f.button('确认更正 ID 并提交核验').disabled, true); assert.match(f.dialog.textContent, /读取最新名册/);
  }, { api: async (path, body) => { if (path.endsWith('/preview')) return receipt(body); throw Object.assign(new Error('原资料已变化'), { status: 409 }); } });
  const wait = deferred();
  await mounted(async f => {
    const toggle = f.field('-correction-mode'), corrected = f.field('-corrected-id'), evidence = f.field('-evidence');
    toggle.checked = true; await toggle.emit('change'); corrected.value = 'correct_id'; await corrected.emit('input'); evidence.value = WORK; await evidence.emit('input');
    await f.button('预览账号 ID 更正').emit('click'); const pending = f.button('确认更正 ID 并提交核验').emit('click');
    assert.equal(corrected.disabled, true); await f.dialog.emit('cancel'); assert.equal(f.dialog.open, false);
    wait.resolve({ job: { id: UUID, status: 'queued' } }); await pending;
    assert.equal(f.dialog.open, false); assert.equal(f.doc.activeElement, f.opener); assert.equal(f.calls.length, 2);
    assert.doesNotMatch(f.dialog.textContent, /已收到任务回执/);
  }, { api: async (path, body) => path.endsWith('/preview') ? receipt(body) : wait.promise });
});

test('UI request through real prepare, strict mock worker and read overlay completes correction without rewriting original source or unpausing', async t => {
  const SEC = 'MS4wLjABAAAACorrectionUIAuthor000001';
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const paused of [false, true]) {
    const database = new MonitorDatabase(':memory:'); t.after(() => database.close()); const db = database.db;
    const frozen = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:01:23.853Z', entities: [{
      key: 'submitted:douyin:correction-ui', targetId: null, platform: 'douyin', names: ['原始作者'], ids: ['wrong_id'], locators: [],
      sources: [{ title: '原表', file: '原表.xlsx', rows: ['12'] }], boards: [{ name: '原主题', category: '切片' }],
      classification: { theme: { key: 'original', label: '原主题' }, labels: [{ key: 'slice', label: '切片' }] },
    }] }, { sha256: SHA, fileName: '原总表.xlsx' }); installMasterRoster(db, frozen);
    if (paused) {
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO targets(type,label,locator,provider,enabled,metadata_json,created_at,updated_at)
        VALUES('account','人工暂停原账号',?,'public-web',0,?,?,?)`).run(SEC, JSON.stringify({ platform: 'douyin', preserved: true }), at, at);
    }
    const originalRows = db.prepare('SELECT * FROM master_roster_entries').all(), calls = [];
    let request, evidence;
    const workflow = createRosterSupplementWorkflow({ canEdit: () => true, randomUUID: () => UUID, api: async (path, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      const prepared = await prepareMasterRosterSupplement(db, body);
      if (path.endsWith('/preview')) return prepared.preview;
      assert.equal(body.correctionConfirmed, true); assert.equal(body.previewSha256, prepared.preview.previewSha256);
      assert.equal(prepared.preview.review.canSubmit, true);
      request = { rows: prepared.rows, fileName: prepared.fileName, sheetName: prepared.sheetName,
        boardCatalog: prepared.boardCatalog, masterRosterSupplement: prepared.masterRosterSupplement };
      database.createAuthorResolutionJob({ id: UUID, fileName: request.fileName, sheetName: request.sheetName, request, actorName: '离线 UI 测试' });
      evidence = buildAuthorEvidenceRequests(request.rows)[0];
      database.enqueueAuthorResolutions([evidence], { fileName: request.fileName, sheetName: request.sheetName, sourceMetadata: { sourceType: 'author-spreadsheet' } });
      const result = { ok: true, created: [], queuedEvidenceRequestCount: 1,
        skipped: [{ ...request.rows[0], status: 'unresolved', evidenceRequestKeys: [evidence.key] }], queue: { pendingEvidenceRequestKeys: [evidence.key] } };
      db.prepare("UPDATE author_resolution_jobs SET created_at=?,status='completed',finished_at=?,result_json=? WHERE id=?")
        .run(new Date(Date.now() - 1000).toISOString(), new Date().toISOString(), JSON.stringify(result), UUID);
      return { job: { id: UUID, status: 'completed' } };
    } });
    const source = readMasterRoster(db); workflow.open(source, source.items[0]);
    workflow.setCorrectionMode(true); workflow.editCorrectedAccountId('00123'); workflow.edit(WORK);
    const preview = await workflow.preview(); assert.deepEqual(preview.correction, { originalAccountId: 'wrong_id', correctedAccountId: '00123' });
    assert.equal(db.prepare('SELECT count(*) n FROM author_resolution_jobs').get().n, 0, 'preview does not create jobs');
    await workflow.submit(); assert.equal(calls.length, 2); assert.equal(request.rows[0].douyinId, '00123');
    const queued = validateMasterRoster(readMasterRoster(db)); assert.equal(queued.items[0].monitorStatus, 'pending');
    assert.equal(queued.items[0].identityCorrection.status, 'pending'); assert.deepEqual(queued.items[0].accountIds, ['wrong_id']);
    const savedJob = db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(UUID);
    const savedSources = db.prepare('SELECT * FROM author_resolution_import_sources').all();
    const owner = 'correction-ui-owner', claimed = database.claimDueAuthorResolutions(1, { owner, leaseMs: 60_000 })[0];
    let providerCalls = 0;
    const outcome = await runQueuedAuthorisedImport(database, claimed, { owner,
      createInput: (_job, row) => ({ type: 'account', provider: 'public-web', label: row.name, locator: row.locator,
        metadata: { platform: 'douyin', resolution: row.resolution }, boards: row.boards }),
      provider: { resolveAuthorisedDetail: async ({ items: [input] }) => {
        providerCalls++; assert.equal(input.submittedId, '00123');
        const at = new Date().toISOString(), response = { status_code: 0, aweme_detail: { aweme_id: VIDEO,
          author: { sec_uid: SEC, uid: '1234567890123456', unique_id: '00123' } } };
        const responseSha256 = hash(response), responseSha256Scope = 'public-identity-projection-v1';
        return { status: 'ok', ...input, requestStartedAt: at, requestFinishedAt: at,
          candidate: { videoId: VIDEO, secUid: SEC, uid: '1234567890123456', uniqueId: '00123', shortId: '',
            provenance: 'authorised-browser-natural-detail', observedAt: at, responseSha256, responseSha256Scope },
          evidence: { version: 1, kind: 'natural-main-frame-detail-response', origin: 'https://www.douyin.com', path: '/aweme/v1/web/aweme/detail/',
            method: 'GET', httpStatus: 200, requestedVideoId: VIDEO, observedAt: at, responseSha256, responseSha256Scope, response },
          provenance: { mode: 'authorised-browser-natural-detail', authorisedSessionUsed: true, authenticated: null,
            authenticationStatus: 'not-verified', noChallengeBypass: true, runtimeAI: false, paidAPI: false } };
      } } });
    assert.equal(providerCalls, 1); assert.equal(outcome.status, 'resolved');
    const current = validateMasterRoster(readMasterRoster(db)), item = current.items[0];
    assert.equal(item.monitorStatus, paused ? 'paused' : 'enabled'); assert.equal(item.identityCorrection.status, 'verified');
    assert.deepEqual(item.accountIds, ['wrong_id']); assert.equal(item.identityCorrection.correctedAccountId, '00123');
    assert.equal(canCorrectRosterAccountId(item), false); assert.equal(current.summary.enabled, paused ? 0 : 1);
    assert.deepEqual(db.prepare('SELECT * FROM master_roster_entries').all(), originalRows);
    assert.deepEqual(db.prepare('SELECT request_json,result_json FROM author_resolution_jobs WHERE id=?').get(UUID), savedJob);
    assert.deepEqual(db.prepare('SELECT * FROM author_resolution_import_sources').all(), savedSources);
    assert.equal(db.prepare('SELECT count(*) n FROM snapshots').get().n, 0, 'identity proof is not metrics collection');
    assert.equal(db.prepare('SELECT count(*) n FROM author_resolution_success_receipts').get().n, 1);
    if (paused) assert.equal(db.prepare('SELECT enabled FROM targets WHERE locator=?').get(SEC).enabled, 0);
  }
});
