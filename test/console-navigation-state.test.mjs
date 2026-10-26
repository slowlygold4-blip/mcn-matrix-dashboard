import test from 'node:test';
import assert from 'node:assert/strict';
import { readNavigationState, writeNavigationState } from '../public/console-model.js';

test('navigation state round-trips filters, page, collection and comparison dates', () => {
  const source = 'http://127.0.0.1:4188/?board=团团&theme=直播&classification=切片&period=custom&start=2026-09-20&end=2026-09-26&platform=douyin&enabled=all&q=%E4%B8%80%E6%9D%A1%20%E5%B0%8F&page=4&collectionFilter=incomplete-works&sort=likes.delta&direction=asc&compare=1&compareStart=2026-09-01&compareEnd=2026-09-07#accounts';
  const state = readNavigationState(source, { today: '2026-09-26' });
  const url = writeNavigationState(source, state);
  const restored = readNavigationState(url, { today: '2026-09-26' });
  assert.deepEqual(restored, state);
  assert.equal(url.searchParams.get('q'), '一条 小');
  assert.equal(url.hash, '#accounts');
});

test('invalid filters and malformed or future dates safely fall back', () => {
  const state = readNavigationState('http://127.0.0.1/?period=custom&start=2026-99-99&end=2099-01-01&page=-2&platform=secret&enabled=nope&collectionFilter=bad&sort=wat&compare=1&compareStart=2099-01-01&compareEnd=2099-01-02', { today: '2026-09-26' });
  assert.equal(state.period, 'day');
  assert.equal(state.start, '');
  assert.equal(state.end, '');
  assert.equal(state.page, 1);
  assert.equal(state.platform, 'all');
  assert.equal(state.enabled, 'all');
  assert.equal(state.collectionFilter, 'all');
  assert.equal(state.sort, 'followers.delta');
  assert.equal(state.compare, false);
});

test('calendar-invalid dates and overlong custom windows cannot pass startup parsing', () => {
  for (const dates of [['2026-02-30', '2026-03-01'], ['2025-01-01', '2026-09-01']]) {
    const state = readNavigationState(`http://127.0.0.1/?period=custom&start=${dates[0]}&end=${dates[1]}`, { today: '2026-09-26' });
    assert.equal(state.period, 'day');
    assert.equal(state.start, '');
    assert.equal(state.end, '');
  }
});

test('URL writer removes only navigation keys and never adds credentials', () => {
  const url = writeNavigationState('http://127.0.0.1/?token=[REDACTED]&password=[REDACTED]&old=1', { query: 'a&b 中文', page: 2, collectionFilter: 'missing-profile' });
  assert.equal(url.searchParams.get('q'), 'a&b 中文');
  assert.equal(url.searchParams.get('token'), 'secret');
  assert.equal(url.searchParams.get('password'), 'secret');
  assert.equal(url.searchParams.has('session'), false);
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('collectionFilter'), 'missing-profile');
});

test('read after replacement is popstate-safe and does not depend on a browser global', () => {
  const next = writeNavigationState('http://127.0.0.1/#overview', { period: 'week', page: 3, query: '主播' });
  assert.deepEqual(readNavigationState(next), { board: '', theme: 'all', classification: 'all', period: 'week', start: '', end: '', query: '主播', platform: 'all', enabled: 'all', collectionFilter: 'all', sort: 'followers.delta', direction: 'desc', page: 3, accountMode: 'operating', compare: false, compareStart: '', compareEnd: '' });
});
