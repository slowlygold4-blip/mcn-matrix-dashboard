import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'recorded-period-'));
  const database = new MonitorDatabase(join(dir, 'test.sqlite'));
  t.after(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  const account = label => {
    const target = database.createTarget({type:'account', label, locator:`MS4wLjABAAAA${label}abcdefghijklmnop`, provider:'public-web'});
    database.db.prepare('UPDATE targets SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', target.id);
    return target;
  };
  const sample = (target, date, values, time = '02:00:00', quality = 'validated') => database.db.prepare(`INSERT INTO snapshots
    (target_id,captured_at,followers,total_likes,total_posts,quality_status,account_status,works_coverage,source_checksum)
    VALUES(?,?,?,?,?,?,'available','unavailable',?)`).run(target.id, `${date}T${time}Z`, ...values, quality, `source-${target.id}-${date}-${time}`);
  const read = (options = {}) => getProductInsights(database, {period:'custom',startDate:'2026-09-23',endDate:'2026-09-29',
    reference:new Date('2026-09-28T16:01:00Z'),timeZone:'Asia/Shanghai',...options});
  return {database,account,sample,read};
}

test('Beijing midnight preserves a separate common recorded period without inventing today', t => {
  const {account,sample,read} = fixture(t); const a = account('a');
  sample(a,'2026-09-22',[100,1000,10]); sample(a,'2026-09-28',[120,1500,11]);
  const result = read();
  assert.equal(result.summary.metrics.followers.delta,null);
  assert.equal(result.summary.trend.at(-1).followers,null);
  const win = result.recordedWindow;
  assert.equal(win.baselineDate,'2026-09-22'); assert.equal(win.endDate,'2026-09-28');
  assert.equal(win.range.startDate,'2026-09-23');
  assert.equal(win.metrics.followers.delta,20); assert.equal(win.metrics.likes.delta,500);
  assert.equal(win.metrics.estimatedPlays.delta,50000); assert.equal(win.metrics.posts.delta,1);
  assert.equal(win.accounts[0].metrics.likes.baselineAt,'2026-09-22T02:00:00.000Z');
});

test('missing month-start baseline uses explicit observed dates, not full-month growth', t => {
  const {account,sample,read} = fixture(t); const a = account('a');
  sample(a,'2026-09-12',[20,100,2]); sample(a,'2026-09-28',[15,80,1]);
  const result = read({startDate:'2026-09-01'});
  assert.equal(result.summary.metrics.likes.delta,null);
  assert.equal(result.recordedWindow.baselineDate,'2026-09-12');
  assert.equal(result.recordedWindow.metrics.likes.delta,-20);
  assert.equal(result.recordedWindow.metrics.estimatedPlays.delta,-2000);
  assert.equal(result.recordedWindow.metrics.posts.delta,-1);
});

test('different author windows are not added together', t => {
  const {account,sample,read} = fixture(t); const a = account('a'), b = account('b');
  sample(a,'2026-09-23',[10,100,1]); sample(a,'2026-09-28',[20,200,2]);
  sample(b,'2026-09-24',[30,300,3]); sample(b,'2026-09-27',[40,400,4]);
  assert.equal(read().recordedWindow,null);
});

test('one day cannot manufacture a multi-day recorded change', t => {
  const {account,sample,read} = fixture(t); const a = account('a');
  sample(a,'2026-09-28',[10,100,1]); sample(a,'2026-09-28',[20,200,2],'03:00:00');
  assert.equal(read().recordedWindow,null);
});

test('complete strict period stays strict and zero is a real observed change', t => {
  const {account,sample,read} = fixture(t); const a = account('a');
  sample(a,'2026-09-22',[0,0,0]); sample(a,'2026-09-28',[0,0,0]);
  const result = read({endDate:'2026-09-28'});
  assert.equal(result.recordedWindow,null);
  assert.equal(result.summary.metrics.followers.delta,0);
  assert.equal(result.summary.metrics.followers.percent,null);
});

test('day and comparison keep strict endpoints', t => {
  const {account,sample,read} = fixture(t); const a = account('a');
  sample(a,'2026-09-22',[100,100,1]); sample(a,'2026-09-28',[120,200,2]);
  assert.equal(read({period:'day',startDate:'2026-09-29'}).recordedWindow,null);
  const result = read({comparisonStartDate:'2026-09-01',comparisonEndDate:'2026-09-07'});
  assert.equal(result.recordedWindow,null); assert.equal(result.summary.metrics.likes.delta,null);
});

test('latest valid sample per metric is used, rejected and future samples excluded', t => {
  const {account,sample,read} = fixture(t); const a = account('a');
  sample(a,'2026-09-22',[100,1000,10]); sample(a,'2026-09-28',[110,1100,11]);
  sample(a,'2026-09-28',[120,null,12],'03:00:00');
  sample(a,'2026-09-28',[999,9999,99],'04:00:00','rejected');
  sample(a,'2026-09-29',[999,9999,99]);
  const win = read().recordedWindow;
  assert.equal(win.metrics.followers.delta,20); assert.equal(win.metrics.likes.delta,100);
  assert.equal(win.accounts[0].metrics.likes.comparisonCurrentAt,'2026-09-28T02:00:00.000Z');
});

test('90 percent paired coverage is explicit, absent author stays null', t => {
  const {account,sample,read} = fixture(t);
  for (let i=0;i<10;i++) {
    const a = account(`a${i}`); sample(a,'2026-09-28',[20,200,2]);
    if(i<9) sample(a,'2026-09-22',[10,100,1]);
  }
  const win = read().recordedWindow;
  assert.equal(win.comparableCount,9); assert.equal(win.enabledCount,10);
  assert.equal(win.metrics.followers.delta,90); assert.equal(win.metrics.followers.coveragePercent,90);
  assert.equal(win.accounts.at(-1).metrics.followers.delta,null);
});
