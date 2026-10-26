import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { readNavigationState, writeNavigationState } from '../public/console-model.js';

const root = new URL('../', import.meta.url);
const rebuildHtml = readFileSync(new URL('public/rebuild.html', root), 'utf8');
const rebuildCss = readFileSync(new URL('public/rebuild.css', root), 'utf8');
const rebuildJs = readFileSync(new URL('public/rebuild.js', root), 'utf8');
const consoleModel = readFileSync(new URL('public/console-model.js', root), 'utf8');
const consoleWorkflow = readFileSync(new URL('public/console-workflow.js', root), 'utf8');
const isolatedHtml = rebuildHtml
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, '')
  .replace('</head>', `<style>${rebuildCss}</style></head>`);

function injectedController() {
  const source = rebuildJs
    .replace(/from\s+['"]\.\/console-model\.js[^'"]*['"]/, "from '/console-model.js'")
    .replace(/void init\(\);\s*$/, '');
  return `${source}\nwindow.jupiterSubject={state,enhanceShell,setupDates,bind,setView,setAccountMode,renderCatalog,setAppliedContext(value){appliedContext={...value};}};`;
}

test('account mode is a bounded navigation value and preserves the operating query/page', () => {
  const parsed = readNavigationState('http://matrix.test/?accountMode=roster&q=%E5%9B%A2%E5%9B%A2&page=7&period=week#accounts');
  assert.equal(parsed.accountMode, 'roster');
  assert.equal(parsed.query, '团团');
  assert.equal(parsed.page, 7);

  const invalid = readNavigationState('http://matrix.test/?accountMode=unexpected&q=author&page=4#accounts');
  assert.equal(invalid.accountMode, 'operating');
  assert.equal(invalid.query, 'author');
  assert.equal(invalid.page, 4);

  const rosterUrl = writeNavigationState('http://matrix.test/?unrelated=keep#accounts', {
    ...parsed, accountMode: 'roster', period: 'week', platform: 'all', enabled: 'active',
    collectionFilter: 'all', sort: 'followers.delta', direction: 'desc', compare: false,
  });
  assert.equal(rosterUrl.searchParams.get('accountMode'), 'roster');
  assert.equal(rosterUrl.searchParams.get('q'), '团团');
  assert.equal(rosterUrl.searchParams.get('page'), '7');
  assert.equal(rosterUrl.searchParams.get('unrelated'), 'keep');

  const operatingUrl = writeNavigationState(rosterUrl, { ...parsed, accountMode: 'operating' });
  assert.equal(operatingUrl.searchParams.has('accountMode'), false);
  assert.equal(operatingUrl.searchParams.get('q'), '团团');
  assert.equal(operatingUrl.searchParams.get('page'), '7');
});

test('Jupiter account modes and applied scope are semantic in the saved shell', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--disable-background-networking'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(isolatedHtml);

    const switcher = page.locator('#accountModeSwitch');
    assert.equal(await switcher.getAttribute('role'), 'tablist');
    assert.match(await switcher.getAttribute('aria-label'), /账号|名单/);
    const operating = switcher.locator('[data-account-mode="operating"]');
    const roster = switcher.locator('[data-account-mode="roster"]');
    assert.equal(await operating.getAttribute('role'), 'tab');
    assert.equal(await roster.getAttribute('role'), 'tab');
    assert.equal(await operating.getAttribute('aria-controls'), 'operatingAccountsPanel');
    assert.equal(await roster.getAttribute('aria-controls'), 'rosterAccountsPanel');

    const operatingPanel = page.locator('#operatingAccountsPanel');
    const rosterPanel = page.locator('#rosterAccountsPanel');
    assert.equal(await operatingPanel.getAttribute('role'), 'tabpanel');
    assert.equal(await rosterPanel.getAttribute('role'), 'tabpanel');
    assert.equal(await operatingPanel.locator('#accountSearch').count(), 1);
    assert.equal(await operatingPanel.locator('#masterRosterHost').count(), 0);
    assert.equal(await rosterPanel.locator('#masterRosterHost').count(), 1);
    assert.equal(await rosterPanel.locator('#accountSearch').count(), 0);

    const scope = page.locator('#appliedScopeBar');
    assert.match(await scope.getAttribute('aria-label'), /范围/);
    assert.equal(await scope.locator('#scopeSummary').count(), 1);
    const adjust = page.locator('#adjustScopeButton');
    assert.equal(await adjust.getAttribute('aria-controls'), 'filterDetails');
    assert.equal(await adjust.getAttribute('aria-expanded'), 'false');
  } finally {
    await browser.close();
    assert.equal(browser.isConnected(), false);
  }
});

test('actual isolated controller keeps both account workspaces intact and opens scope adjustment from the applied bar', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--disable-background-networking'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(3000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://fixture.invalid') return route.abort('blockedbyclient');
      if (url.pathname === '/console-model.js') return route.fulfill({ contentType: 'text/javascript', body: consoleModel });
      if (url.pathname === '/console-workflow.js') return route.fulfill({ contentType: 'text/javascript', body: consoleWorkflow });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: isolatedHtml });
      return route.abort('blockedbyclient');
    });
    await page.goto('http://fixture.invalid/?accountMode=roster&q=%E7%BB%8F%E8%90%A5%E6%90%9C%E7%B4%A2&page=3&board=board-a&theme=tuantuan&classification=slice&period=week#accounts');
    await page.addScriptTag({ type: 'module', content: injectedController() });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => Boolean(window.jupiterSubject)), true, pageErrors.join('\n') || 'controller did not expose the isolated subject');
    await page.evaluate(() => {
      const subject = window.jupiterSubject;
      subject.enhanceShell();
      subject.setupDates();
      Object.assign(subject.state, {
        view: 'accounts', accountMode: 'roster', board: 'board-a', theme: 'tuantuan', classification: 'slice',
        period: 'week', start: '2026-10-03', end: '2026-10-09', query: '经营搜索', page: 3,
        data: {
          period: 'week', range: { startDate: '2026-10-03', endDate: '2026-10-09', end: '2026-10-09T15:00:00.000Z', partialEndDay: true },
          boards: [{ key: 'board-a', name: '团团矩阵' }],
          themeSummary: { items: [{ key: 'tuantuan', label: '团团', count: 12 }] },
          classificationSummary: { items: [{ key: 'slice', label: '切片', count: 9 }] },
          classificationSources: [], summary: { enabledCount: 12, metrics: {} }, accounts: [],
        },
      });
      subject.setAppliedContext({
        board: 'board-a', theme: 'tuantuan', classification: 'slice', period: 'week',
        start: '2026-10-03', end: '2026-10-09', compare: false, compareStart: '', compareEnd: '',
      });
      subject.renderCatalog();
      subject.setView('accounts', { renderData: false });
      subject.bind();
      subject.setAccountMode('roster', { focus: false });
      const host = document.querySelector('#masterRosterHost');
      host.innerHTML = '<label>完整名册搜索<input id="isolatedRosterSearch" type="search" value="来源名册搜索"></label><span id="isolatedRosterPage">第 5 页</span>';
    });

    const operatingTab = page.locator('[data-account-mode="operating"]');
    const rosterTab = page.locator('[data-account-mode="roster"]');
    const operatingPanel = page.locator('#operatingAccountsPanel');
    const rosterPanel = page.locator('#rosterAccountsPanel');
    assert.equal(await operatingPanel.getAttribute('hidden'), '');
    assert.equal(await rosterPanel.getAttribute('hidden'), null);
    assert.equal(await operatingTab.getAttribute('aria-selected'), 'false');
    assert.equal(await rosterTab.getAttribute('aria-selected'), 'true');
    assert.equal(await operatingTab.getAttribute('tabindex'), '-1');
    assert.equal(await rosterTab.getAttribute('tabindex'), '0');
    assert.equal(await page.locator('#accountSearch').isVisible(), false);
    assert.equal(await page.locator('#isolatedRosterSearch').isVisible(), true);

    await operatingTab.click();
    assert.equal(await operatingPanel.getAttribute('hidden'), null);
    assert.equal(await rosterPanel.getAttribute('hidden'), '');
    assert.equal(await page.locator('#accountSearch').isVisible(), true);
    assert.equal(await page.locator('#isolatedRosterSearch').isVisible(), false);
    assert.equal(await page.locator('#accountSearch').inputValue(), '经营搜索');
    assert.equal(await page.evaluate(() => window.jupiterSubject.state.page), 3);
    assert.equal(await page.locator('#isolatedRosterSearch').inputValue(), '来源名册搜索');
    assert.equal(await page.locator('#isolatedRosterPage').innerText(), '第 5 页');
    assert.equal(new URL(page.url()).searchParams.has('accountMode'), false);
    assert.equal(new URL(page.url()).searchParams.get('q'), '经营搜索');
    assert.equal(new URL(page.url()).searchParams.get('page'), '3');

    await operatingTab.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await rosterTab.getAttribute('aria-selected'), 'true');
    assert.equal(await rosterTab.evaluate(element => element === document.activeElement), true);
    assert.equal(new URL(page.url()).searchParams.get('accountMode'), 'roster');
    assert.equal(new URL(page.url()).searchParams.get('q'), '经营搜索');
    assert.equal(new URL(page.url()).searchParams.get('page'), '3');

    const expectedScope = {
      board: /矩阵.*团团矩阵|团团矩阵/,
      theme: /主题.*团团|团团/,
      classification: /分类.*切片|切片/,
      period: /周期.*近 7 天|近 7 天/,
    };
    for (const [key, pattern] of Object.entries(expectedScope)) {
      assert.match(await page.locator(`[data-scope-key="${key}"]`).innerText(), pattern);
    }
    const details = page.locator('#filterDetails');
    assert.equal(await details.getAttribute('open'), null);
    await page.locator('#adjustScopeButton').click();
    assert.notEqual(await details.getAttribute('open'), null);
    assert.equal(await page.locator('#adjustScopeButton').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.querySelector('#filterDetails').contains(document.activeElement)), true);
    assert.equal(await page.evaluate(() => document.activeElement.matches('button,input,select,textarea,summary,[tabindex]')), true);
  } finally {
    await browser.close();
    assert.equal(browser.isConnected(), false);
  }
});
