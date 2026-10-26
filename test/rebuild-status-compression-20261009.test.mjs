import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';

const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
const html = readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, hidden: ['notice', 'importPreview'].includes(id), textContent: '', innerHTML: '', value: '',
      disabled: false, open: false, attrs: {}, files: [],
      setAttribute(key, value) { this.attrs[key] = value; },
    });
    return nodes.get(id);
  };
  const context = {
    ...model, fmt: model.formatNumber, URL, URLSearchParams, Intl, Date,
    location: new URL('http://fixture.test/?period=week#overview'),
    document: { getElementById: node }, window: {},
    readMonitoring: async () => ({}), blocked: '',
    fetch: () => { throw new Error('Visibility updates must not request data'); },
    setTimeout: () => { throw new Error('Visibility updates must not schedule collection or reads'); },
  };
  runInNewContext(`${source}
    loadMonitoringStatus = options => readMonitoring(options);
    renderScopeSubtitle = () => {};
    saveLocation = () => {};
    syncDataBlockedReason = () => blocked;
    this.subject = { state, busy, renderLiveStatus, loadImportWorkspace,
      setTopicFailure(value) { topicReadFailed = value; } };
  `, context);
  context.subject.state.session = { authenticated: true, user: { role: 'viewer' } };
  context.subject.state.data = { saved: true };
  return { ...context.subject, node,
    setMonitor(fn) { context.readMonitoring = fn; },
    setBlocked(reason) { context.blocked = reason; } };
}

test('ordinary saved-snapshot success collapses immediately while compact connection status remains', () => {
  const f = fixture();
  f.busy(true);
  assert.equal(f.node('loadFeedback').hidden, false);
  assert.match(f.node('loadFeedback').innerHTML, /保留上次成功快照/);
  f.busy(false);
  assert.equal(f.node('loadFeedback').hidden, true);
  assert.equal(f.node('loadFeedback').attrs['data-read-state'], 'success');
  assert.equal(f.node('connectionStatus').textContent, '快照已读取');
  assert.equal(f.node('connectionStatus').hidden, false);
  assert.match(f.node('loadFeedback').innerHTML, /保存的快照/);
  assert.equal(f.state.data.saved, true);
});

test('loading, warning, partial and error all reappear after a hidden success', () => {
  for (const mode of ['loading', 'warning', 'partial', 'error']) {
    const f = fixture();
    f.busy(false);
    if (mode === 'warning') f.node('notice').hidden = false;
    if (mode === 'partial') { f.state.view = 'topics'; f.setTopicFailure(true); }
    f.busy(mode === 'loading', mode === 'error' ? 'error' : 'success');
    assert.equal(f.node('loadFeedback').hidden, false, mode);
    assert.equal(f.node('loadFeedback').attrs['data-read-state'], mode);
    assert.equal(f.node('loadFeedback').attrs['data-state'], mode === 'partial' ? 'warning' : mode);
    assert.equal(f.node('connectionStatus').attrs['data-state'], mode === 'partial' ? 'warning' : mode);
    assert.equal(f.state.data.saved, true);
  }
});

test('quiet live outcomes remain on the top indicator without masking a snapshot error', () => {
  const f = fixture();
  f.busy(false, 'error');
  for (const kind of ['ready', 'checked', 'updated']) {
    f.renderLiveStatus({ kind, pending: false });
    assert.equal(f.node('liveSyncStatus').hidden, true, kind);
    assert.equal(f.node('connectionStatus').attrs['data-live-state'], kind);
    assert.equal(f.node('connectionStatus').attrs.title, f.node('liveSyncMessage').textContent);
    assert.equal(f.node('connectionStatus').attrs['aria-description'], f.node('liveSyncMessage').textContent);
    assert.equal(f.node('connectionStatus').textContent, '快照读取失败');
    assert.equal(f.node('connectionStatus').attrs['data-state'], 'error');
    assert.equal(f.node('loadFeedback').hidden, false);
  }
});

test('checking, pending, offline and errors stay visible and preserve pending-action guards', () => {
  const f = fixture();
  for (const kind of ['checking', 'pending', 'offline', 'error']) {
    f.renderLiveStatus({ kind: 'checked', pending: false });
    f.renderLiveStatus({ kind, pending: kind === 'pending', status: 403 });
    assert.equal(f.node('liveSyncStatus').hidden, false, kind);
    assert.equal(f.node('liveSyncStatus').attrs['data-state'], kind);
    assert.equal(f.node('applyLiveUpdate').hidden, kind !== 'pending');
  }
  assert.match(f.node('liveSyncMessage').textContent, /登录或访问权限需检查/);
  f.setBlocked('保留未应用草稿');
  f.renderLiveStatus({ kind: 'pending', pending: true });
  assert.equal(f.node('applyLiveUpdate').disabled, true);
  assert.equal(f.node('applyLiveUpdate').textContent, '稍后自动应用');
  f.setBlocked('');
  f.renderLiveStatus({ kind: 'pending', pending: true });
  assert.equal(f.node('applyLiveUpdate').disabled, false);
  assert.equal(f.node('applyLiveUpdate').textContent, '应用更新');
});

test('a pending action or unknown future live state is never silently hidden', () => {
  const f = fixture();
  f.renderLiveStatus({ kind: 'ready', pending: true });
  assert.equal(f.node('liveSyncStatus').hidden, false);
  assert.equal(f.node('applyLiveUpdate').hidden, false);
  f.renderLiveStatus({ kind: 'future-warning', pending: false });
  assert.equal(f.node('liveSyncStatus').hidden, false);
});

test('import status errors reappear after dashboard success; successful retry collapses', async () => {
  const f = fixture(), gate = deferred();
  f.busy(false);
  f.state.view = 'import';
  f.node('pasteAuthorsText').value = '保留未提交名单';
  f.setMonitor(() => gate.promise);
  const read = f.loadImportWorkspace();
  assert.equal(f.node('loadFeedback').hidden, false);
  assert.equal(f.node('loadFeedback').attrs['data-read-state'], 'loading');
  gate.reject(new Error('<临时不可用>'));
  await read;
  assert.equal(f.node('loadFeedback').hidden, false);
  assert.equal(f.node('loadFeedback').attrs['data-read-state'], 'error');
  assert.match(f.node('loadFeedback').innerHTML, /&lt;临时不可用&gt;/);
  f.setMonitor(async () => ({}));
  await f.loadImportWorkspace();
  assert.equal(f.node('loadFeedback').hidden, true);
  assert.equal(f.node('loadFeedback').attrs['data-read-state'], 'success');
  assert.equal(f.node('connectionStatus').textContent, '导入状态已核对');
  assert.equal(f.node('pasteAuthorsText').value, '保留未提交名单');
});

test('one diagnostic disclosure retains the full collection truth; redundant standalone hint is hidden', () => {
  const details = html.match(/<details\b[^>]*id="operationsDetails"[\s\S]*?<\/details>/)?.[0];
  assert.ok(details);
  assert.equal((html.match(/id="operationsDetails"/g) || []).length, 1);
  assert.match(details, /刷新快照 = 发起全局采集 \+ 更新数据；采集需本机开机联网，失败和缺测不补零。/);
  assert.match(details, /不代表全部历史作品已采齐/);
  assert.match(details, /公开只读镜像仅展示已发布快照，不在云端执行采集/);
  const hint = html.match(/<p\b[^>]*id="runtimeCollectionHint"[^>]*>/)?.[0];
  assert.match(hint, /\bhidden\b/);
  assert.match(html.match(/<div\b[^>]*id="liveSyncStatus"[^>]*>/)?.[0], /\bhidden\b/);
  assert.doesNotMatch(html.match(/<div\b[^>]*id="loadFeedback"[^>]*>/)?.[0], /\bhidden\b/);
  assert.match(html, /rebuild\.js\?v=20261010-jupiter-workspace-2/);
});
