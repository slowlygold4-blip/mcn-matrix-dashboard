import test from 'node:test';
import assert from 'node:assert/strict';
import { topicSparkline } from '../public/product-dashboard.js';

test('topic sparkline leaves missing observations as gaps instead of zero', () => {
  const html = topicSparkline([
    { participants: 10, sourceVerified: true, qualityStatus: 'validated' },
    { participants: null, sourceVerified: false, qualityStatus: 'unverified' },
    { participants: 30, sourceVerified: true, qualityStatus: 'validated' },
  ], 'participants');
  assert.match(html, /M2\.0/);
  assert.match(html, /M118\.0/);
  assert.doesNotMatch(html, /L60\.0/);
});

test('topic sparkline excludes a numeric but unverified legacy/API observation', () => {
  const html = topicSparkline([
    { participants: 10, sourceVerified: true, qualityStatus: 'validated' },
    { participants: 999999, sourceVerified: false, qualityStatus: 'unverified' },
    { participants: 30, sourceVerified: true, qualityStatus: 'validated' },
  ], 'participants');
  assert.match(html, /M2\.0/);
  assert.match(html, /M118\.0/);
  assert.doesNotMatch(html, /999999/);
  assert.doesNotMatch(html, /L60\.0/);
});
