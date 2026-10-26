import test from 'node:test';
import assert from 'node:assert/strict';
import { targetPlatform } from '../lib/target-platform.mjs';

test('scheduler and provider use the same explicit platform', () => {
  assert.equal(targetPlatform({ metadata: { platform: 'bilibili' }, locator: 'https://www.douyin.com/user/x' }), 'bilibili');
  assert.equal(targetPlatform({ metadata: { platform: 'kuaishou' }, locator: 'MS4wLjABAAAAexample' }), 'kuaishou');
});

test('locator inference checks host boundaries and supports short domains', () => {
  assert.equal(targetPlatform({ locator: 'https://space.bilibili.com/123' }), 'bilibili');
  assert.equal(targetPlatform({ locator: 'https://b23.tv/abc' }), 'bilibili');
  assert.equal(targetPlatform({ locator: 'https://www.xiaohongshu.com/user/profile/abc' }), 'xiaohongshu');
  assert.equal(targetPlatform({ locator: 'https://xhslink.com/abc' }), 'xiaohongshu');
  assert.equal(targetPlatform({ locator: 'https://www.kuaishou.com/profile/123' }), 'kuaishou');
  assert.equal(targetPlatform({ locator: 'https://bilibili.com.evil.test/user' }), 'unknown');
  assert.equal(targetPlatform({ locator: 'MS4wLjABAAAAexample' }), 'douyin');
});
