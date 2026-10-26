import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as model from '../public/console-model.js';
const { csvCell } = model;

// Exported numeric declines must remain spreadsheet numbers. Formula-injection
// protection still applies to untrusted text, including numeric-looking IDs.
test('team data acceptance: negative numeric metrics remain summable CSV numbers', () => {
  for (const value of [-42, -46, -1, -0.5, -0, 0, 42]) {
    assert.equal(csvCell(value), `"${value}"`, `numeric metric ${value}`);
  }
});

test('team data acceptance: text formula prefixes remain neutralized', () => {
  for (const value of ['=SUM(A1:A2)', '+42', '-42', '@account', '\t=SUM(A1:A2)', '\r=1+1', '\n=1+1', '  -42', '\tname']) {
    assert.equal(csvCell(value), `"'${value}"`);
  }
});

test('team data acceptance: missing metrics remain blank rather than zero', () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(csvCell(value), '""');
});

test('team data acceptance: commas quotes and embedded CR/LF remain within one CSV field', () => {
  assert.equal(csvCell('a,"b"\r\nc'), '"a,""b""\r\nc"');
});

function parseCsv(text) {
  const rows = [], row = []; let value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\r' || char === '\n')) {
      row.push(value); value = '';
      if (char !== ',') { rows.push([...row]); row.length = 0; if (char === '\r' && text[i + 1] === '\n') i++; }
    } else value += char;
  }
  row.push(value); rows.push(row);
  return rows;
}

test('team data acceptance: actual download includes negative and missing metrics as summable values and blanks', async () => {
  const metric = delta => ({ value: 100, delta, comparable: delta !== null, dailyComparable: delta !== null });
  const accounts = [
    { id: 1, label: '\t=HYPERLINK("https://example.invalid")', delta: -42 },
    { id: 2, label: 'normal,"quoted"\r\nname', delta: 50 },
    { id: 3, label: 'missing', delta: null },
  ].map(({ delta, ...account }) => ({ ...account, enabled: true, platform: 'douyin', publicId: '-42',
    metrics: Object.fromEntries(Object.keys(model.METRICS).map(key => [key, metric(delta)])), status: { lastSuccessAt: null } }));
  const data = { period: 'day', range: { startDate: '2026-09-29', endDate: '2026-09-29' }, accounts };
  const downloads = [], filenames = [];
  class BrowserURL extends URL { static createObjectURL(blob) { downloads.push(blob); return 'blob:test'; } static revokeObjectURL() {} }
  const source = readFileSync(new URL('../public/rebuild.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/void init\(\);\s*$/, '');
  const context = { ...model, fmt: model.formatNumber, URL: BrowserURL, URLSearchParams, Intl, Date, AbortController, Blob,
    location: { href: 'http://127.0.0.1:4188/?period=day' }, setTimeout() {},
    document: { createElement: () => ({ click() { filenames.push(this.download); } }) } };
  runInNewContext(`${source}\nthis.subject = {state,downloadCsv};`, context);
  context.subject.state.data = data;
  context.subject.downloadCsv();
  const [headers, ...rows] = parseCsv(await downloads[0].text());
  assert.equal(filenames[0], '矩阵数据_2026-09-29_2026-09-29.csv');
  assert.equal(rows.length, 3);
  for (const name of ['粉丝净变化', '获赞净变化', '估算播放变化(获赞净变化×100)', '作品净变化']) {
    const values = rows.map(row => row[headers.indexOf(name)]);
    assert.deepEqual(values.slice().sort(), ['', '-42', '50']);
    assert.equal(values.filter(value => value !== '').reduce((sum, value) => sum + Number(value), 0), 8);
  }
  assert.ok(rows.every(row => row[headers.indexOf('账号ID')] === "'-42"), 'numeric-looking account IDs stay protected text');
  assert.ok(rows.some(row => row[0] === "'\t=HYPERLINK(\"https://example.invalid\")"));
  assert.ok(rows.some(row => row[0] === 'normal,"quoted"\r\nname'));
});
