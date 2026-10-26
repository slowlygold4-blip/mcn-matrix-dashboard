import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImportAuthorisedDetail } from '../lib/import-authorised-detail.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';
import { normalizeAuthorisedDetailInput } from '../lib/douyin-authorised-detail.mjs';

const VIDEO = '7686424948055891786';
const OTHER = '7694337592909444442';
const SEC = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx';
const OTHER_SEC = 'MS4wLjABBBBBabcdefghijklmnopqrstuvwx';
const row = () => ({ sourceRow: 682, platform: 'douyin', name: '一头小水水OvO', douyinId: '80336194274',
  videoId: VIDEO, videoLink: `https://www.douyin.com/video/${VIDEO}`, videoHyperlink: '', contentId: '',
  locator: '', shareUrl: '', bilibiliId: '', xiaohongshuId: '', status: 'resolvable', identityConflict: '', rejectedLink: '' });
const job = (value = row()) => ({ id: 'c9895a58-14ef-4f1f-8c88-428fb3ce8d6f', status: 'completed', request: { rows: [value] } });
const prepare = value => prepareImportAuthorisedDetail(job(value), { sourceRow: 682 });
function rejects(value) { assert.throws(() => prepare(value), { code: 'IMPORT_DETAIL_INVALID_INPUT' }); }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('第 682 行形状可纯准备单项 provider 输入，沿用该原行证据 key', () => {
  const original = freeze(job()), before = JSON.stringify(original);
  const result = prepareImportAuthorisedDetail(original, { sourceRow: 682 });
  assert.deepEqual(result, { key: buildAuthorEvidenceRequests([row()])[0].key, videoId: VIDEO, submittedId: '80336194274' });
  assert.deepEqual(normalizeAuthorisedDetailInput({ items: [result] }), result);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.locator, undefined);
  assert.equal(result.enabled, undefined);
  assert.equal(result.status, undefined, '准备请求不得声称已经接入或已经核验');
});

test('拒绝未完成 job、非 rows 结构和缺失/重复源行，不从任务结果猜来源', () => {
  for (const status of ['queued', 'running', 'failed', 'cancelled', 'interrupted', '', undefined]) {
    const value = job(); value.status = status;
    assert.throws(() => prepareImportAuthorisedDetail(value, { sourceRow: 682 }));
  }
  for (const rows of [undefined, {}, [], [row(), row()], [{ ...row(), sourceRow: '682' }], [row(), { ...row(), sourceRow: '682' }]]) {
    const value = job(); value.request.rows = rows;
    assert.throws(() => prepareImportAuthorisedDetail(value, { sourceRow: 682 }));
  }
  assert.throws(() => prepareImportAuthorisedDetail(null, { sourceRow: 682 }));
  const emptyRequest = job(); emptyRequest.request = null;
  assert.throws(() => prepareImportAuthorisedDetail(emptyRequest, { sourceRow: 682 }));
});

test('严格整数行号、拒绝客户端另传作品/账号/链接，任何字段不能覆盖原行', () => {
  for (const sourceRow of ['682', 682.1, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, null, undefined]) {
    assert.throws(() => prepareImportAuthorisedDetail(job(), { sourceRow }));
  }
  for (const name of ['videoId', 'submittedId', 'douyinId', 'url', 'locator', 'expectedSecUid', 'items']) {
    assert.throws(() => prepareImportAuthorisedDetail(job(), { sourceRow: 682, [name]: 'client-value' }));
  }
  assert.throws(() => prepareImportAuthorisedDetail(job()));
  assert.throws(() => prepareImportAuthorisedDetail(job(), null));
});

test('必须明确抖音平台和合法文本提交 ID，昵称/uid/数字不能替代', () => {
  for (const platform of ['bilibili', 'xiaohongshu', '', undefined, '抖音']) rejects({ ...row(), platform });
  for (const douyinId of [80336194274, '', '0', '@@foo', '中文昵称', '?!', '...', 'a b', 'evil\nID', {}, ['id'], 'a'.repeat(101)]) {
    rejects({ ...row(), douyinId });
  }
  for (const field of ['bilibiliId', 'xiaohongshuId']) rejects({ ...row(), [field]: 'other-platform-id' });
  const normalized = prepare({ ...row(), douyinId: ' @Ａccount.001 ' });
  assert.equal(normalized.submittedId, 'account.001');
  assert.equal(normalized.key, buildAuthorEvidenceRequests([{ ...row(), douyinId: ' @Ａccount.001 ' }])[0].key);
});

test('作品 ID 必须为精确字符串，拒绝不安全数值、多个值和冲突声明', () => {
  for (const videoId of [Number(VIDEO), 123456789012345, '', null, undefined, [VIDEO], `${VIDEO},${OTHER}`, '7.686424948055892e18', '0000000000000000000']) {
    rejects({ ...row(), videoId });
  }
  for (const field of ['contentId', 'videoIds', 'shareUrls']) {
    rejects({ ...row(), [field]: field === 'contentId' ? OTHER : [OTHER] });
  }
  rejects({ ...row(), contentId: Number(VIDEO) });
  for (const field of ['identityConflict', 'rejectedLink']) rejects({ ...row(), [field]: '已有拒绝证据' });
  for (const status of ['identity_conflict', 'rejected', 'skipped']) rejects({ ...row(), status });
});

test('canonical sec_uid 仅作为额外一致性约束，不采信 URL query uid 或其他字段', () => {
  const constrained = { ...row(), locator: SEC };
  assert.deepEqual(prepare(constrained), { key: buildAuthorEvidenceRequests([constrained])[0].key,
    videoId: VIDEO, submittedId: '80336194274', expectedSecUid: SEC });
  for (const locator of [`https://www.douyin.com/user/${SEC}`, '123456789', 'https://v.douyin.com/abc/', `${SEC} `, 123]) rejects({ ...row(), locator });
  rejects({ ...row(), locator: SEC, accountLocator: OTHER_SEC });
  rejects({ ...row(), locator: SEC, secUid: OTHER_SEC });
  const query = prepare({ ...row(), videoLink: `${row().videoLink}?uid=111&sec_uid=${OTHER_SEC}&did=222` });
  assert.equal(query.expectedSecUid, undefined);
});

test('同条官方直链可证明同一个作品，不允许用单 probe 代替短链或其他作品', () => {
  for (const field of ['shareUrl', 'videoHyperlink', 'videoLink']) {
    assert.equal(prepare({ ...row(), [field]: `https://www.iesdouyin.com/share/video/${VIDEO}/` }).videoId, VIDEO);
    rejects({ ...row(), [field]: 'https://v.douyin.com/UnknownToken/' });
    rejects({ ...row(), [field]: `https://www.douyin.com/video/${OTHER}` });
    rejects({ ...row(), [field]: `${row().videoLink} https://www.douyin.com/video/${OTHER}` });
    rejects({ ...row(), [field]: `${row().videoLink}?modal_id=${OTHER}` });
    rejects({ ...row(), [field]: `${row().videoLink}?aweme_id=${VIDEO}&aweme_id=${OTHER}` });
  }
  assert.equal(prepare({ ...row(), contentId: VIDEO }).videoId, VIDEO);
  assert.equal(prepare({ ...row(), videoLink: `复制打开 ${row().videoLink} 观看作品` }).videoId, VIDEO);
});

test('额外证据 URL 限精确官方 HTTPS 作品路径，拒绝凭据/端口/嵌套伪装', () => {
  for (const videoLink of [
    `http://www.douyin.com/video/${VIDEO}`, `https://www.douyin.com.evil.test/video/${VIDEO}`,
    `https://evil.test/https://www.douyin.com/video/${VIDEO}`, `https://user@www.douyin.com/video/${VIDEO}`,
    `https://www.douyin.com:443/video/${VIDEO}`, `https://www.douyin.com:8443/video/${VIDEO}`,
    `https://%77ww.douyin.com/video/${VIDEO}`, `https://www.douyin.com\\video/${VIDEO}`,
    `https://www.douyin.com/user/${SEC}?modal_id=${VIDEO}`, '没有可确认的作品链接',
  ]) rejects({ ...row(), videoLink });
});

test('定位选择只作用于原行，不收集其他作者，不修改 frozen job', () => {
  const second = { ...row(), sourceRow: 683, douyinId: 'other-author', videoId: OTHER, videoLink: `https://www.douyin.com/video/${OTHER}` };
  const original = freeze({ ...job(), request: { rows: [second, row()] } });
  const before = JSON.stringify(original);
  assert.equal(prepareImportAuthorisedDetail(original, { sourceRow: 682 }).videoId, VIDEO);
  assert.equal(prepareImportAuthorisedDetail(original, { sourceRow: 683 }).submittedId, 'other-author');
  assert.equal(JSON.stringify(original), before);
});

test('新识别官方直链不能偷偷补写旧 job 的空 videoId', () => {
  const original = freeze(job({ ...row(), sourceRow: 3974, douyinId: '26422792982', videoId: '',
    videoLink: `https://www.iesdouyin.com/share/video/${OTHER}/`, status: 'needs_locator' }));
  const before = JSON.stringify(original);
  assert.throws(() => prepareImportAuthorisedDetail(original, { sourceRow: 3974 }));
  assert.equal(JSON.stringify(original), before);
});
