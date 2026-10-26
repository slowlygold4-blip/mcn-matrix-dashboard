import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { validateMasterRoster, filterMasterRoster, safeRosterLink, masterRosterCsv } from '../public/master-roster.js';

const source = fs.readFileSync(new URL('../public/master-roster.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/master-roster.css', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const items = Array.from({ length: 8 }, (_, i) => ({
    key: `person-${i}`, targetId: i < 5 ? i + 1 : null, platform: 'douyin',
    name: i === 5 ? '<img src=x onerror=alert(1)>' : `账号 ${i + 1}`, originalNames: i === 0 ? ['团团原名'] : [],
    accountIds: [i === 0 ? '0012345678901234567890' : String(100 + i)],
    theme: { key: i < 6 ? 'tuantuan' : 'yuqilin', label: i < 6 ? '团团' : '玉麒麟' },
    classifications: [{ key: 'slice', label: '切片' }, ...(i % 2 === 0 ? [{ key: 'ai-remix', label: 'AI二创' }] : []), ...(i === 2 ? [{ key: 'original', label: '原创' }] : [])], monitorStatus: i < 3 ? 'enabled' : i < 5 ? 'paused' : 'pending',
    identityStatus: i < 5 ? '已建号' : '身份待核对', profileLinks: ['https://www.douyin.com/user/fixture'],
    sourceTitles: ['原表来源'], sourceLinks: Array.from({ length: 4 }, (_, n) => `https://example.test/sheet/${i}-share-${n}`),
    reviewReasons: i === 5 ? ['同名账号尚待核对；不表示已采集'] : [],
  }));
  return { snapshotAt: '2026-10-03T11:00:00.000Z', workbook: { fileName: '作者总表.xlsx', sha256: 'a'.repeat(64) },
    summary: { total: 8, registered: 5, enabled: 3, paused: 2, pending: 3 }, items };
}

test('roster requires exact counts, unique keys and pending must not bind to a target', () => {
  assert.equal(validateMasterRoster(fixture()).items.length, 8);
  for (const mutate of [
    v => { v.summary.total = 9; }, v => { v.summary.enabled = 4; },
    v => { v.summary.registered = 4; },
    v => { v.items[5].targetId = 99; }, v => { v.items[0].targetId = null; },
    v => { v.items[1].key = v.items[0].key; }, v => { v.items[5].monitorStatus = 'enabled'; },
    v => { v.snapshotAt = 'not a date'; }, v => { v.workbook.sha256 = 'bad'; },
    v => { v.items[0].sourceLinks = [{}]; }, v => { v.items[0].classifications = [{}]; },
  ]) { const bad = fixture(); mutate(bad); assert.throws(() => validateMasterRoster(bad)); }
});

test('roster shell and entry use the same explicit cache generation', () => {
  const html = fs.readFileSync(new URL('../public/rebuild.html', import.meta.url), 'utf8');
  const entry = fs.readFileSync(new URL('../public/master-roster-entry.js', import.meta.url), 'utf8');
  const shellVersion = html.match(/\/master-roster-entry\.js\?v=([^"']+)/)?.[1];
  const moduleVersion = entry.match(/\.\/master-roster\.js\?v=([^"']+)/)?.[1];
  assert.ok(shellVersion, 'rebuild shell must version the roster entry module');
  assert.ok(moduleVersion, 'roster entry must version the roster implementation');
  assert.equal(shellVersion, moduleVersion);
});

test('search and classification filters are independent and preserve paused records', () => {
  const items = validateMasterRoster(fixture()).items;
  assert.equal(filterMasterRoster(items, { status: 'registered' }).length, 5);
  assert.equal(filterMasterRoster(items, { status: 'paused' }).length, 2);
  assert.equal(filterMasterRoster(items, { status: 'pending', theme: 'tuantuan' }).length, 1);
  assert.equal(filterMasterRoster(items, { query: '团团原名' })[0].key, 'person-0');
  assert.equal(filterMasterRoster(items, { query: '0012345678901234567890' })[0].key, 'person-0');
  assert.equal(filterMasterRoster(items, { query: 'example.test/sheet/3-share-2' })[0].key, 'person-3');
  assert.equal(filterMasterRoster(items, { query: '切片' }).length, 8);
  const ai = filterMasterRoster(items, { classification: 'label:ai-remix' });
  assert.equal(ai.length, 4);
  assert.equal(new Set(ai.map(item => item.key)).size, 4);
  assert.ok(ai.some(item => item.key === 'person-0' && item.classifications.some(label => label.key === 'slice')));
  assert.equal(filterMasterRoster(items, { status: 'enabled', theme: 'tuantuan', classification: 'label:ai-remix' }).length, 2);
  assert.equal(filterMasterRoster([...items, { ...items[0], key: 'uncategorized', classifications: [] }], { classification: '__roster_unclassified__' }).map(item => item.key).join(','), 'uncategorized');
  assert.equal(filterMasterRoster(items, { theme: 'absent' }).length, 0);
});

test('links cannot run script or embed credentials; output does not mutate original input', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'https://user:password@example.com/', 'https://example.com/?access_token=[REDACTED]', 'https://example.com/?Authorization=hidden', '/relative', null]) assert.equal(safeRosterLink(value), null);
  assert.equal(safeRosterLink('https://example.com/path'), 'https://example.com/path');
  const raw = fixture(); raw.items[0].sourceLinks.push('javascript:alert(1)');
  const safe = validateMasterRoster(raw); assert.equal(safe.items[0].sourceLinks.length, 4);
  assert.equal(raw.items[0].sourceLinks.length, 5); assert.equal(raw.items[0].targetId, 1);
});

test('CSV retains account IDs as text and guards formula, quote and newline injection', () => {
  const raw = fixture(); raw.items[0].name = '\t=SUM(1,2)'; raw.items[0].sourceTitles = ['+cmd'];
  raw.items[0].reviewReasons = ['line one\nline "two"'];
  const snapshot = validateMasterRoster(raw), csv = masterRosterCsv(snapshot, [snapshot.items[0]]);
  assert.ok(csv.startsWith('\ufeff')); assert.ok(csv.includes('"\'\t=SUM(1,2)"'));
  assert.ok(csv.includes('"\'0012345678901234567890"')); assert.ok(csv.includes('"\'+cmd"'));
  assert.ok(csv.includes('"line one\nline ""two"""'));
  assert.ok(csv.includes('总表来源大主题（不覆盖经营归属）'));
  assert.ok(!csv.includes('粉丝')); assert.ok(!csv.includes('targetId'));
  for (const value of ['=X', '+X', '-X', '@X', ' \t@X']) {
    const v = fixture(); v.items[0].name = value; assert.ok(masterRosterCsv(validateMasterRoster(v)).includes(`"'${value}"`));
  }
});

test('actual browser: collapsed summary, filters, pagination focus, pending isolation, export, recovery and race guards', { timeout: 45000 }, async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.route('**/*', route => route.abort());
      await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>名册回归</title><style>body{font:14px system-ui;margin:16px;background:#f3f5f8}#host{max-width:1200px;margin:auto}button,input,select{font:inherit}</style><main id="host"></main></html>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ type: 'module', content: source + '\nwindow.mountMasterRoster=mountMasterRoster;' });
      await page.evaluate(async data => {
        window.rosterPayload = data; window.kind = 'ok'; window.requests = []; window.opened = [];
        window.roster = window.mountMasterRoster({ host: document.querySelector('#host'), pageSize: 2,
          fetcher: async (endpoint, options) => {
            window.requests.push({ endpoint, method: options.method, credentials: options.credentials });
            if (window.kind === 'error') throw new Error('credential=must-not-render');
            if (window.kind === 'slow') return await new Promise(resolve => { window.resolveSlow = resolve; });
            return { ok: true, json: async () => structuredClone(window.rosterPayload) };
          }, onOpenAccount: id => window.opened.push(id) });
        await window.roster.ready;
      }, fixture());
      const details = page.locator('.master-roster-disclosure'), summary = details.locator(':scope > summary');
      assert.equal(await details.getAttribute('open'), null);
      assert.match(await summary.innerText(), /总表 8 条 · 已建档资料 5（启用 3 \/ 暂停 2）· 待核对资料 3/);
      assert.match(await page.locator('.master-roster > .master-roster-policy').innerText(), /不覆盖当前经营归属/);
      await summary.focus(); await page.keyboard.press('Enter'); assert.notEqual(await details.getAttribute('open'), null);
      if (process.env.MASTER_ROSTER_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.MASTER_ROSTER_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MASTER_ROSTER_EVIDENCE_DIR, `roster-${width}.png`), fullPage: true });
      }
      const status = page.getByLabel('监控状态', { exact: true }), theme = page.getByLabel('总表来源大主题', { exact: true }), classification = page.getByLabel('总表来源内容分类', { exact: true }), search = page.locator('input');
      assert.equal(await status.locator('option[value="registered"]').innerText(), '已建档资料（含暂停）');
      assert.match(await page.locator('.master-roster-body > .master-roster-policy').innerText(), /不是导入模板，不可直接回导/);
      assert.match(await classification.locator('option[value="label:ai-remix"]').innerText(), /AI二创（4）/);
      await classification.selectOption('label:ai-remix');
      assert.match(await page.locator('.master-roster-filter-count').innerText(), /筛选结果 4 \/ 总表 8/);
      await page.locator('[data-roster-page="next"]').click(); assert.match(await page.locator('.master-roster-pagination').innerText(), /第 2 \/ 2 页/);
      await classification.selectOption('label:slice');
      assert.match(await page.locator('.master-roster-pagination').innerText(), /第 1 \/ 4 页/);
      await classification.selectOption('label:original');
      assert.match(await page.locator('.master-roster-filter-count').innerText(), /筛选结果 1 \/ 总表 8/);
      await page.evaluate(async () => {
        window.originalRosterPayload = structuredClone(window.rosterPayload);
        window.rosterPayload.items[2].classifications = window.rosterPayload.items[2].classifications.filter(label => label.key !== 'original');
        await window.roster.reload();
      });
      assert.equal(await classification.inputValue(), 'label:original');
      assert.equal(await classification.locator('option:checked').innerText(), '此快照无该分类：original');
      assert.match(await page.locator('.master-roster-filter-count').innerText(), /筛选结果 0 \/ 总表 8/);
      await page.evaluate(async () => { window.rosterPayload = window.originalRosterPayload; await window.roster.reload(); });
      assert.equal(await classification.inputValue(), 'label:original');
      assert.match(await classification.locator('option:checked').innerText(), /原创（1）/);
      assert.match(await page.locator('.master-roster-filter-count').innerText(), /筛选结果 1 \/ 总表 8/);
      await classification.selectOption('all');
      await status.selectOption('pending'); assert.equal(await page.locator('tbody tr').count(), 2);
      assert.equal(await page.locator('[data-roster-target]').count(), 0); assert.equal(await page.locator('tbody img').count(), 0);
      assert.match(await page.locator('tbody').innerText(), /<img src=x onerror=alert\(1\)>/);
      assert.match(await page.locator('.master-roster-filter-count').innerText(), /3 \/ 总表 8/);
      assert.equal(await page.locator('tbody tr').first().locator('.master-roster-sources a').count(), 3);
      assert.match(await page.locator('tbody tr').first().locator('.master-roster-sources summary').innerText(), /前 3 \/ 4/);
      await theme.selectOption('tuantuan'); assert.equal(await page.locator('tbody tr').count(), 1);
      await theme.selectOption('all'); await status.selectOption('all'); await search.fill('团团原名');
      assert.equal(await page.locator('tbody tr').count(), 1); assert.equal(await search.evaluate(el => el === document.activeElement), true);
      await page.locator('[data-roster-target]').click(); assert.deepEqual(await page.evaluate(() => window.opened), [1]);
      await search.fill('0012345678901234567890'); assert.equal(await page.locator('tbody tr').count(), 1);
      await search.fill('');
      const next = page.locator('[data-roster-page="next"]'), prev = page.locator('[data-roster-page="prev"]');
      await next.focus(); await page.keyboard.press('Enter'); assert.equal(await next.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Enter'); assert.equal(await next.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Space'); assert.equal(await next.isDisabled(), true); assert.equal(await prev.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
      assert.equal(await prev.isDisabled(), true); assert.equal(await next.evaluate(el => document.activeElement === el), true);
      await status.selectOption('pending');
      await page.evaluate(() => { URL.createObjectURL = blob => { window.csvBlob = blob; return 'blob:fixture'; }; URL.revokeObjectURL = () => {}; });
      await page.getByRole('button', { name: '导出归档名单', exact: true }).click(); const csv = await page.evaluate(() => window.csvBlob.text());
      assert.equal(csv.split('\r\n').length, 4); assert.ok(csv.includes('账号 8')); assert.ok(!csv.includes('账号 1'));
      await page.evaluate(async () => { window.kind = 'error'; await window.roster.reload(); });
      assert.match(await summary.innerText(), /总表 8/); assert.match(await page.locator('.master-roster-read-status').innerText(), /保留/);
      assert.ok(!(await page.locator('.master-roster-read-status').innerText()).includes('credential'));
      await page.evaluate(() => { window.kind = 'slow'; window.slowPromise = window.roster.reload(); });
      await page.evaluate(async () => { window.kind = 'ok'; window.rosterPayload.items[0].name = '最新快照名字'; await window.roster.reload(); });
      await page.evaluate(async old => { window.resolveSlow({ ok: true, json: async () => old }); await window.slowPromise; }, fixture());
      await status.selectOption('all'); await search.fill('最新快照名字'); assert.match(await page.locator('tbody').innerText(), /最新快照名字/);
      await search.fill('absent'); assert.match(await page.locator('tbody').innerText(), /没有符合条件/);
      assert.equal(await prev.isDisabled(), true); assert.equal(await next.isDisabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `viewport ${width} must not overflow`);
      assert.ok((await page.evaluate(() => window.requests)).every(r => r.endpoint === '/api/master-roster' && r.method === 'GET'));
      await page.evaluate(() => { window.kind = 'slow'; window.late = window.roster.reload(); window.roster.destroy(); });
      await page.evaluate(async old => { window.resolveSlow({ ok: true, json: async () => old }); await window.late; }, fixture());
      assert.equal(await page.locator('.master-roster').count(), 0);
      const requestsBefore = await page.evaluate(() => window.requests.length);
      assert.equal(await page.evaluate(() => window.roster.reload()), false);
      assert.equal(await page.evaluate(() => window.requests.length), requestsBefore);
      await page.evaluate(async () => {
        window.invalid = window.mountMasterRoster({ host: document.querySelector('#host'), fetcher: async () => ({ ok: true, json: async () => ({}) }) });
        await window.invalid.ready;
      });
      assert.match(await page.locator('.master-roster-counts').innerText(), /尚未读取/);
      assert.match(await page.locator('.master-roster-read-status').innerText(), /未取得名单，不以 0 代替/);
      await page.evaluate(() => window.invalid.destroy()); await page.close();
    }
  } finally { await browser.close(); }
});
