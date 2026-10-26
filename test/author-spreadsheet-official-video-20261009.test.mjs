import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as XLSX from '@e965/xlsx';
import { extractVideoId, normalizeAccountLocator, parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';
import { buildAuthorEvidenceRequests } from '../lib/author-resolution.mjs';

const VIDEO = '7694337592909444442';
const OTHER = '7686424948055891786';
const ACCOUNT = '26422792982';
const SEC_UID = 'MS4wLjABAAAAabcdefghijklmnopqrstuvwx';
const legacyUrl = `https://www.iesdouyin.com/share/video/${VIDEO}/`;
const csvPreview = (url) => parseAuthorSpreadsheet({
  fileName: '官方作品.csv',
  buffer: Buffer.from(`作者,抖音号,视频链接\n原表作者,${ACCOUNT},${url}`),
});

test('官方 iesdouyin 分享路径保留完整 19 位作品 ID，但不直接认定作者已核验', async () => {
  for (const host of ['iesdouyin.com', 'www.iesdouyin.com', 'WWW.IESDOUYIN.COM']) {
    for (const suffix of ['', '/', '/?region=CN&share_app_id=1128']) {
      assert.equal(extractVideoId(`https://${host}/share/video/${VIDEO}${suffix}`), VIDEO);
    }
  }
  const preview = await csvPreview(legacyUrl);
  const row = preview.rows[0];
  assert.equal(row.videoId, VIDEO);
  assert.equal(row.douyinId, ACCOUNT);
  assert.equal(row.videoLink, legacyUrl);
  assert.equal(row.locator, null);
  assert.equal(row.status, 'resolvable');
  assert.match(row.reason, /严格核验/);
  assert.deepEqual(buildAuthorEvidenceRequests(preview.rows).map((request) => request.videoIds), [[VIDEO]]);
});

test('旧官方作品与 modal 查询兼容，iesdouyin 查询不能代替正式作品路径', () => {
  for (const url of [
    `https://www.douyin.com/video/${VIDEO}`,
    `https://douyin.com/note/${VIDEO}`,
    `https://www.douyin.com/user/${SEC_UID}?modal_id=${VIDEO}`,
  ]) assert.equal(extractVideoId(url), VIDEO);
  for (const path of [`/?aweme_id=${VIDEO}`, `/user/${SEC_UID}?modal_id=${VIDEO}`, `/video/${VIDEO}`, `/share/video/${VIDEO}/extra`]) {
    assert.equal(extractVideoId(`https://www.iesdouyin.com${path}`), null, path);
  }
});

test('官方链接仅限精确 HTTPS 域名，拒绝端口、凭据、域名伪装与 URL 归一化陷阱', async () => {
  const urls = [
    `http://www.iesdouyin.com/share/video/${VIDEO}`,
    `https://www.iesdouyin.com.evil.example/share/video/${VIDEO}`,
    `https://evil-iesdouyin.com/share/video/${VIDEO}`,
    `https://share.iesdouyin.com/share/video/${VIDEO}`,
    `https://user:secret@www.iesdouyin.com/share/video/${VIDEO}`,
    `https://www.iesdouyin.com@evil.example/share/video/${VIDEO}`,
    `https://www.iesdouyin.com:443/share/video/${VIDEO}`,
    `https://www.iesdouyin.com:8443/share/video/${VIDEO}`,
    `https://www.iesdouyin.com./share/video/${VIDEO}`,
    `https://%77ww.iesdouyin.com/share/video/${VIDEO}`,
    `https://www.iesdouyin.com\\share/video/${VIDEO}`,
    `https://evil.example/https://www.iesdouyin.com/share/video/${VIDEO}`,
    `https://www.iesdouyin.com/share/video/${VIDEO}text`,
    'https://www.iesdouyin.com/share/video/7.694337592909444e18/',
    'https://www.iesdouyin.com/share/video/12345/',
  ];
  for (const url of urls) {
    assert.equal(extractVideoId(url), null, url);
    const preview = await csvPreview(url);
    assert.equal(preview.rows[0].videoId, null, url);
    assert.equal(preview.rows[0].status, 'needs_locator', url);
    assert.equal(buildAuthorEvidenceRequests(preview.rows).length, 0, url);
  }
});

test('iesdouyin 的 sec_uid、uid 与设备查询参数不会升级成账号身份', async () => {
  const url = `${legacyUrl}?sec_uid=${SEC_UID}&uid=123456789&did=987654321&iid=987654321`;
  assert.equal(normalizeAccountLocator(url), null);
  assert.equal(extractVideoId(url), VIDEO);
  const preview = await csvPreview(url);
  assert.equal(preview.rows[0].locator, null);
  assert.equal(preview.rows[0].status, 'resolvable');
  assert.equal(preview.rows[0].douyinId, ACCOUNT);
});

test('多个冲突作品 ID 保留原文并禁止自动处理，不静默选择官方分享路径的首条', async () => {
  const urls = [
    `${legacyUrl}?aweme_id=${OTHER}`,
    `${legacyUrl}?item_id=${OTHER}`,
    `${legacyUrl}?modal_id=${VIDEO}&modal_id=${OTHER}`,
    `${legacyUrl} https://www.douyin.com/video/${OTHER}`,
    `${legacyUrl} https://iesdouyin.com/share/video/${OTHER}/`,
  ];
  for (const url of urls) {
    const preview = await csvPreview(url);
    assert.equal(preview.rows[0].status, 'identity_conflict', url);
    assert.match(preview.rows[0].reason, /作品身份不一致/);
    assert.equal(preview.rows[0].videoLink, url);
    assert.equal(buildAuthorEvidenceRequests(preview.rows).length, 0);
  }
  const consistent = await csvPreview(`${legacyUrl}?aweme_id=${VIDEO}&modal_id=${VIDEO}`);
  assert.equal(consistent.rows[0].status, 'resolvable');
});

test('隐藏超链接与可见作品/作品 ID 列冲突同样阻止，不丢原始证据', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('作者');
  sheet.addRow(['作者', '抖音号', '作品ID', '视频链接']);
  sheet.addRow(['作者甲', ACCOUNT, OTHER, legacyUrl]);
  sheet.addRow(['作者乙', ACCOUNT, '', { text: legacyUrl, hyperlink: `https://www.douyin.com/video/${OTHER}` }]);
  const preview = await parseAuthorSpreadsheet({ fileName: '冲突.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  assert.deepEqual(preview.rows.map((row) => row.status), ['identity_conflict', 'identity_conflict']);
  assert.equal(preview.rows[0].contentId, OTHER);
  assert.equal(preview.rows[1].videoHyperlink, `https://www.douyin.com/video/${OTHER}`);
  assert.equal(buildAuthorEvidenceRequests(preview.rows).length, 0);
});

test('JS 不安全数字不会成为精确作品 ID，而文本和完整 URL 不经过浮点数转换', () => {
  assert.equal(extractVideoId(Number(VIDEO)), null);
  assert.equal(extractVideoId(VIDEO), VIDEO);
  assert.equal(extractVideoId('9007199254740993'), '9007199254740993');
  assert.equal(extractVideoId(legacyUrl), VIDEO);
  assert.equal(extractVideoId(123456789012345), '123456789012345');
});

test('XLSX 的不安全数值与公式缓存作品 ID 明确阻止，不猜丢失末位', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('作者');
  sheet.addRow(['作者', '抖音号', '作品ID', '视频链接']);
  sheet.addRow(['数字损坏', ACCOUNT, Number(VIDEO), '']);
  sheet.addRow(['公式缓存损坏', ACCOUNT, { formula: '1+1', result: Number(VIDEO) }, legacyUrl]);
  sheet.addRow(['正确文本', ACCOUNT, VIDEO, legacyUrl]);
  const preview = await parseAuthorSpreadsheet({ fileName: '精度.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  assert.deepEqual(preview.rows.map((row) => row.status), ['identity_conflict', 'identity_conflict', 'resolvable']);
  for (const row of preview.rows.slice(0, 2)) {
    assert.equal(row.videoId, null);
    assert.match(row.reason, /超出安全精度/);
  }
  assert.equal(preview.rows[2].videoId, VIDEO);
  assert.equal(buildAuthorEvidenceRequests(preview.rows).length, 1);
});

test('兼容 XLS 解析也拒绝损失精度的数值作品 ID，文本精确值保留', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['作者', '抖音号', '作品ID'],
    ['数字损坏', ACCOUNT, Number(VIDEO)],
    ['正确文本', ACCOUNT, VIDEO],
  ]), '作者');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' });
  const preview = await parseAuthorSpreadsheet({ fileName: '精度.xls', buffer: Buffer.from(buffer) });
  assert.equal(preview.rows[0].status, 'identity_conflict');
  assert.equal(preview.rows[0].videoId, null);
  assert.equal(preview.rows[1].videoId, VIDEO);
  assert.equal(preview.rows[1].status, 'resolvable');
});
