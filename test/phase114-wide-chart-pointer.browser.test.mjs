import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const files = Object.fromEntries(['rebuild.html', 'rebuild.js', 'rebuild.css', 'console-model.js']
  .map(name => [name, fs.readFileSync(path.join(root, 'public', name), 'utf8')]));
const points = Array.from({ length: 30 }, (_, index) => ({
  date: `2026-09-${String(index + 1).padStart(2, '0')}`,
  followersDelta: index + 1,
  followersDeltaReliable: true,
  followersDeltaCohortKey: 'wide-pointer-fixture',
}));
const data = { period: 'custom', range: { startDate: points[0].date, endDate: points.at(-1).date },
  enabledCount: 0, accounts: [], boards: [], comparison: null,
  summary: { enabledCount: 0, metrics: { followers: { value: 0, delta: 0, comparableCount: 0 } }, trend: points } };
const html = files['rebuild.html'].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<link\b[^>]*>/gi, '').replace('</head>', `<style>${files['rebuild.css']}</style></head>`);

test('1440px wide chart pointer selects exact dates under first and last 30-day points', { timeout: 15000 }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await page.setContent(html);
  const modelUrl = `data:text/javascript;base64,${Buffer.from(files['console-model.js']).toString('base64')}`;
  const runtime = files['rebuild.js'].replace("'./console-model.js'", JSON.stringify(modelUrl)).replace(/void init\(\);\s*$/, '');
  await page.addScriptTag({ type: 'module', content: runtime + `\nwindow.subject={state,enhanceShell,setupDates,renderTrend,busy,bind};` });
  await page.waitForFunction(() => window.subject);
  await page.evaluate(value => {
    subject.enhanceShell();
    Object.assign(subject.state, { view: 'overview', metric: 'followers', period: 'custom', start: value.range.startDate,
      end: value.range.endDate, compare: false, data: value });
    subject.setupDates(); subject.busy(false); subject.bind(); subject.renderTrend();
  }, data);
  const svg = page.locator('#trendChart svg');
  const size = await svg.boundingBox();
  assert.ok(size.width / size.height > 980 / 235, 'wide SVG viewport must exercise centered viewBox whitespace');
  assert.equal(await page.locator('#trendChart circle').count(), 30);
  for (const [selector, expectedDate, expectedIndex] of [
    ['#trendChart circle:first-of-type', '2026-09-01', '0'],
    ['#trendChart circle:last-of-type', '2026-09-30', '29'],
  ]) {
    const dot = page.locator(selector);
    await dot.scrollIntoViewIfNeeded();
    const rect = await dot.boundingBox();
    assert.ok(rect, `${expectedDate} circle must have a rendered hit target`);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.equal(await page.locator('#overviewChartDate').inputValue(), expectedIndex);
    assert.match(await page.locator('#overviewChartReading').innerText(), new RegExp(expectedDate));
  }
});
