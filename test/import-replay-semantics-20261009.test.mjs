import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function authorJobReplayPayload(');
const end = source.indexOf('\nfunction enqueueAuthorResolutionJob(', start);
assert.ok(start >= 0 && end > start);
// The HTTP suite exercises the real row sanitizer. Here isolate the semantic
// projection contract from parser/identity logic and live platform requests.
const project = runInNewContext(`(${source.slice(start, end)})`, { sanitizeAuthorJobRow: row => ({ ...row }) });
const row = { sourceRow: 2, name: '作者甲', status: 'ready', reason: '可导入', locator: 'canonical', owner: '', identityConflict: '' };
const base = { rows: [row], boardCatalog: [{ name: '团团' }, { name: '其他' }], defaultBoard: '',
  sourceType: 'lark-sheet', sourceUrl: 'https://example.feishu.cn/sheets/example', sourceSha256: 'a'.repeat(64), sourceRevision: 3,
  sourceReadAt: '2026-10-09T00:00:00Z', sourceExportSha256: 'b'.repeat(64) };
test('old persisted request remains replayable after ready becomes existing and volatile read metadata changes', () => {
  assert.equal(project(base), project({ ...base, rows: [{ ...row, status: 'existing', reason: '已接入' }],
    boardCatalog: [{ name: '其他' }, { name: '团团' }], sourceReadAt: '2026-10-09T00:10:00Z', sourceExportSha256: 'c'.repeat(64) }));
});
for (const [key, value] of [['owner', '新负责人'], ['locator', 'other'], ['sourceRow', 12], ['identityConflict', '不一致'], ['status', 'needs_locator']]) {
  test(`replay refuses changed row ${key}`, () => {
    assert.notEqual(project(base), project({ ...base, rows: [{ ...row, [key]: value }] }));
  });
}
test('replay refuses changed semantic source and independent board directory', () => {
  for (const patch of [{ sourceSha256: 'd'.repeat(64) }, { sourceRevision: 4 }, { sourceUrl: 'https://example.feishu.cn/sheets/other' },
    { boardCatalog: [...base.boardCatalog, { name: '新目录' }] }]) assert.notEqual(project(base), project({ ...base, ...patch }));
});
