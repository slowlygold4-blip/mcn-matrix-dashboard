import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { buildMasterRosterSnapshot, installMasterRoster, readMasterRoster } from '../lib/master-roster.mjs';
import { prepareMasterRosterSupplement } from '../lib/master-roster-supplement.mjs';
import { readImportMonitoringStatus } from '../lib/import-monitoring-status.mjs';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { recordImportAuthorisedAttempt } from '../lib/import-authorised-attempts.mjs';
import { validateImportMonitoring } from '../public/import-monitoring.js';
import { resolveRosterSupplementEntry } from '../public/master-roster.js';

const JOB = '11111111-1111-4111-8111-111111111111', SECOND = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64), NOW = new Date('2026-10-09T18:00:00.000Z');
const WORK = 'https://www.douyin.com/video/7684617087687331118';
function fixture(t, { ids = ['000123'], platform = 'douyin', errors = [], duplicate = false, sourceId = '000123', registered = false } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE targets(id INTEGER PRIMARY KEY,type TEXT,provider TEXT,metadata_json TEXT,locator TEXT,label TEXT,enabled INTEGER);
    CREATE TABLE author_resolution_jobs(id TEXT PRIMARY KEY,file_name TEXT,sheet_name TEXT,status TEXT,created_at TEXT,finished_at TEXT,request_json TEXT,result_json TEXT);
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,target_id INTEGER,captured_at TEXT,followers INTEGER,total_likes INTEGER,total_posts INTEGER,quality_status TEXT,source_checksum TEXT,raw_json TEXT,account_status TEXT DEFAULT 'available');`);
  const sec = 'MS4wLjABAAAAabcdefghijklmnop';
  if (registered) db.prepare('INSERT INTO targets VALUES(?,?,?,?,?,?,?)').run(1, 'account', 'public-web', JSON.stringify({ platform }), sec, '同名作者', 0);
  const entity = { key: registered ? 'target:1' : 'original-row-2', targetId: registered ? 1 : null, platform, names: ['同名作者'],
    ids, locators: registered ? [sec] : [], errors, enabled: false,
    sources: [{ file: '原始总表.xlsx', rows: ['12'] }], boards: [{ name: '原分类' }] };
  const snapshot = buildMasterRosterSnapshot({ exportedAt: '2026-10-02T19:00:00Z', entities: [entity,
    ...(duplicate ? [{ ...entity, key: 'different-original-row' }] : [])] }, { fileName: 'frozen.xlsx', sha256: SHA });
  installMasterRoster(db, snapshot);
  const idField = { douyin: 'douyinId', bilibili: 'bilibiliId', xiaohongshu: 'xiaohongshuId', kuaishou: 'kuaishouId' }[platform];
  const request = { fileName: '最新上传.xlsx', sheetName: '作品登记', sourceType: 'author-spreadsheet', uploadSha256: 'b'.repeat(64),
    rows: [{ sourceRow: 2, platform, name: '同名作者', [idField]: sourceId, ...(platform === 'douyin' ? { videoId: '7684617087687331118' } : {}) }] };
  const job = { id: JOB, status: 'completed', request };
  db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run(JOB, request.fileName, request.sheetName, 'completed', '2026-10-09T12:00:00Z', '2026-10-09T12:01:00Z', JSON.stringify(request), '{"ok":true}');
  const capture = () => JSON.stringify(Object.fromEntries(['targets', 'snapshots', 'master_roster_imports', 'master_roster_entries', 'author_resolution_jobs']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  return { db, snapshot, job, capture, read: () => readImportMonitoringStatus(db, job, { now: NOW }),
    detail(item) { return { jobId: JOB, entryKey: item.rosterEntryKey, platform: item.platform, submittedId: item.submittedId }; } };
}

function eventBridge({ snapshot, role = 'editor', viewName = 'import', currentJob = { id: JOB, status: 'completed' } } = {}) {
  const events = new Map(), sent = [], opened = [], navigated = [], accounts = { hidden: viewName !== 'accounts' };
  let roleValue = role, observer, mountOptions;
  const state = { view: viewName, session: { authenticated: true, user: { role } } };
  const doc = { hidden: false, getElementById: key => key === 'accountsView' ? accounts : {},
    addEventListener(type, callback) { const values = events.get(type) || []; values.push(callback); events.set(type, values); },
    dispatchEvent(event) { sent.push(event); for (const callback of events.get(event.type) || []) callback(event); return true; } };
  class Event { constructor(type, { detail } = {}) { this.type = type; this.detail = detail; } }
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8');
  const start = source.indexOf("document.addEventListener?.('mcn:import-monitoring-supplement'");
  const end = source.indexOf("document.addEventListener?.('mcn:master-roster-loaded'", start);
  assert.ok(start >= 0 && end > start, 'execute the actual scoped shell listener, not a copied policy');
  const canEdit = source.match(/function canEdit\(\) \{[^\n]+\}/)?.[0]; assert.ok(canEdit);
  const context = { document: doc, CustomEvent: Event, state, currentImportJob: currentJob,
    setView(value) { state.view = value; accounts.hidden = value !== 'accounts'; navigated.push(value); },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    mountMasterRoster(options) {
      mountOptions = options;
      return { requestRefresh() {}, syncRole() {},
        openSearch(detail) {
          const item = resolveRosterSupplementEntry(snapshot, detail);
          if (options.canEdit() && options.isVisible() && item) opened.push({ detail, item });
          return Promise.resolve(Boolean(item));
        } };
    } };
  vm.createContext(context); vm.runInContext(`${canEdit}\n${source.slice(start, end)}`, context);
  vm.runInContext(readFileSync(new URL('../public/master-roster-entry.js', import.meta.url), 'utf8').replace(/^import[^\n]*\n/, ''), context);
  doc.dispatchEvent(new Event('mcn:master-roster-bind', { detail: { canEdit: () => ['editor', 'admin'].includes(roleValue), api() { assert.fail('event bridge must not submit'); } } }));
  return { doc, sent, opened, navigated, state, accounts, context,
    dispatch(detail) { doc.dispatchEvent(new Event('mcn:import-monitoring-supplement', { detail })); },
    set role(value) { roleValue = value; state.session.user.role = value; },
    get mountOptions() { return mountOptions; }, visibilityChanged() { observer?.(); } };
}

test('strict backend capability flows through the actual shell and entry listener to the exact original identity without writes', async t => {
  const f = fixture(t), before = f.capture(), result = f.read(); validateImportMonitoring(result, JOB);
  const item = result.items[0]; assert.equal(item.status, 'pending'); assert.equal(item.rosterEntryKey, f.snapshot.items[0].key);
  const current = readMasterRoster(f.db); const bridge = eventBridge({ snapshot: current }); bridge.dispatch(f.detail(item));
  assert.deepEqual(bridge.navigated, ['accounts']); assert.equal(bridge.opened.length, 1); assert.equal(bridge.opened[0].item.key, f.snapshot.items[0].key);
  const forwarded = bridge.sent.find(event => event.type === 'mcn:master-roster-open').detail;
  assert.deepEqual(JSON.parse(JSON.stringify(forwarded)), { query: '000123', theme: 'all', entryKey: item.rosterEntryKey, platform: 'douyin', submittedId: '000123' });
  assert.equal(bridge.mountOptions.isVisible(), true); assert.equal(f.capture(), before);
  const preview = await prepareMasterRosterSupplement(f.db, { workbookSha256: SHA, entryKey: item.rosterEntryKey, evidence: WORK });
  assert.equal(preview.preview.entry.key, item.rosterEntryKey); assert.equal(preview.preview.review.canSubmit, true); assert.equal(f.capture(), before);
});

test('shell refuses viewer, stale job, running job, other view, unsupported platform and invalid event fields', t => {
  const f = fixture(t), item = f.read().items[0], snapshot = readMasterRoster(f.db), detail = f.detail(item);
  for (const options of [{ role: 'viewer' }, { role: 'readonly' }, { currentJob: null }, { currentJob: { id: SECOND, status: 'completed' } },
    { currentJob: { id: JOB, status: 'running' } }, { viewName: 'overview' }]) {
    const bridge = eventBridge({ snapshot, ...options }); bridge.dispatch(detail); assert.equal(bridge.opened.length, 0); assert.equal(bridge.navigated.length, 0);
  }
  for (const changed of [{ jobId: SECOND }, { entryKey: null }, { entryKey: '' }, { entryKey: 'x'.repeat(501) }, { platform: 'kuaishou' },
    { platform: 'not-a-platform' }, { submittedId: 123 }, { submittedId: '' }, { submittedId: 'x'.repeat(181) }]) {
    const bridge = eventBridge({ snapshot }); bridge.dispatch({ ...detail, ...changed }); assert.equal(bridge.opened.length, 0); assert.equal(bridge.navigated.length, 0);
  }
});

test('event forwarding preserves identity strings and does not resolve by equal name or numeric coercion', t => {
  const f = fixture(t), item = f.read().items[0], snapshot = readMasterRoster(f.db), before = f.capture();
  for (const changed of [{ submittedId: '123' }, { entryKey: '同名作者' }, { platform: 'bilibili' }]) {
    const bridge = eventBridge({ snapshot }); bridge.dispatch({ ...f.detail(item), ...changed }); assert.equal(bridge.opened.length, 0);
  }
  assert.equal(f.capture(), before);
});

test('backend does not issue editable capabilities for duplicate identity rows, conflicts, live-only records or already paused accounts', t => {
  for (const options of [{ duplicate: true }, { ids: ['000123', 'different'] }, { errors: ['作品作者与原提交 ID 不一致'] },
    { ids: ['different'] }, { registered: true }]) {
    const f = fixture(t, options), before = f.capture(), result = f.read(); validateImportMonitoring(result, JOB);
    assert.equal(result.items[0].rosterEntryKey, null, JSON.stringify(options)); assert.equal(f.capture(), before);
  }
});

test('backend suppresses capability when a newer source task replaces the requested original projection', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO author_resolution_jobs SELECT ?,file_name,sheet_name,status,?,?,request_json,result_json FROM author_resolution_jobs WHERE id=?')
    .run(SECOND, '2026-10-09T13:00:00Z', '2026-10-09T13:01:00Z', JOB);
  const before = f.capture(), result = f.read(); assert.equal(result.sourceAvailable, false); assert.equal(result.items[0].status, 'unknown');
  assert.equal(result.items[0].rosterEntryKey, null); assert.equal(f.capture(), before);
});

test('unsupported submitted-identity shapes do not invent a capability or a known identity denominator', t => {
  const f = fixture(t, { platform: 'kuaishou' }), before = f.capture(), result = f.read();
  assert.equal(result.counts.submittedIdentities, 0); assert.equal(result.items.length, 0); assert.equal(f.capture(), before);
});

test('real persisted attempt projection validates in the frontend without changing account status or exposing upstream text', t => {
  const f = fixture(t), input = prepareImportAuthorisedDetail(f.job, { sourceRow: 2 });
  f.db.exec('CREATE TABLE activity_log(id INTEGER PRIMARY KEY,actor_name TEXT,action TEXT,resource_type TEXT,resource_id TEXT,created_at TEXT,details_json TEXT)');
  const startedAt = '2026-10-09T17:00:00.000Z', finishedAt = '2026-10-09T17:00:04.000Z';
  recordImportAuthorisedAttempt(f.db, f.job, { sourceRow: 2, startedAt, finishedAt, recordedAt: '2026-10-09T17:01:00.000Z', result: {
    ...input, status: 'unavailable', errorCode: 'identity_mismatch', requestStartedAt: startedAt, requestFinishedAt: finishedAt,
    diagnostic: { version: 1, stage: 'public_identity', reason: 'submitted_id_mismatch' }, rawError: 'SENSITIVE_SHELL_PEER_TOKEN',
  } });
  const before = f.capture(), changes = f.db.prepare('SELECT total_changes() n').get().n, result = f.read();
  validateImportMonitoring(result, JOB); assert.equal(result.items[0].status, 'pending'); assert.equal(result.items[0].targetId, null);
  assert.equal(result.items[0].resolutionAttempt.origin, 'authorised-work'); assert.equal(result.items[0].resolutionAttempt.sourceRow, 2);
  assert.equal(result.items[0].resolutionAttempt.finishedAt, finishedAt); assert.match(result.items[0].resolutionAttempt.reason, /公开抖音号与本行填写不一致/);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE_SHELL_PEER_TOKEN|rawError/); assert.equal(f.capture(), before);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('queued, running and awaiting-verification supplements do not receive a dead new-supplement button capability', async t => {
  for (const status of ['queued', 'running', 'completed']) {
    const f = fixture(t), prepared = await prepareMasterRosterSupplement(f.db, { workbookSha256: SHA, entryKey: f.snapshot.items[0].key, evidence: WORK });
    const request = { rows: prepared.rows, fileName: prepared.fileName, sheetName: prepared.sheetName,
      boardCatalog: prepared.boardCatalog, masterRosterSupplement: prepared.masterRosterSupplement };
    f.db.prepare('INSERT INTO author_resolution_jobs VALUES(?,?,?,?,?,?,?,?)').run(SECOND, prepared.fileName, prepared.sheetName, status,
      '2026-10-09T13:00:00Z', status === 'completed' ? '2026-10-09T13:01:00Z' : null,
      JSON.stringify(request), JSON.stringify(status === 'completed' ? { queuedEvidenceRequestCount: 1 } : {}));
    const current = readMasterRoster(f.db); assert.equal(current.items[0].supplement?.status, status === 'completed' ? 'awaiting-verification' : status);
    const before = f.capture(), result = f.read(); assert.equal(result.items[0].status, 'pending');
    assert.equal(result.items[0].rosterEntryKey, null, status); assert.equal(f.capture(), before);
  }
});
