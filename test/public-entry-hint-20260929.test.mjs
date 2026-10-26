import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sharing from '../public/access-sharing.js';

test('public DNS names with fc/fd/fe80 prefixes are not mistaken for private IPv6', () => {
  for (const host of ['fc-mcn.example.com', 'fd-data.example.com', 'fe80-studio.example.com']) {
    assert.equal(sharing.isPrivateHostname(host), false);
    assert.equal(sharing.preferredShareOrigin({ publicBaseUrl: `https://${host}`, currentOrigin: 'http://localhost:4188' }), `https://${host}`);
  }
  for (const host of ['fc00::1', 'fd12::3', 'fe80::1', '::1']) assert.equal(sharing.isPrivateHostname(host), true);
});

test('configured public URL remains explicitly unverified in the share hint', () => {
  const hint = sharing.shareEntryHint({ origin: 'https://mcn.example.com', publicEntry: { url: 'https://mcn.example.com', source: 'configuration', status: 'configured', verificationStatus: 'unverified' } });
  assert.match(hint, /已配置/);
  assert.match(hint, /尚未验证/);
  assert.doesNotMatch(hint, /可直接打开|任何网络/);
});

test('temporary tunnel hint does not promise permanent or all-network access', () => {
  const hint = sharing.shareEntryHint({ origin: 'https://demo.trycloudflare.com', publicEntry: { url: 'https://demo.trycloudflare.com', status: 'running' } });
  assert.match(hint, /临时/);
  assert.match(hint, /本机/);
  assert.match(hint, /目标网络/);
});

test('stale temporary tunnel origin is not reused without a fresh matching heartbeat', () => {
  const currentOrigin = 'https://expired.trycloudflare.com';
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, publicBaseUrl: currentOrigin, now: 200_000 }), null);
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, publicBaseUrl: currentOrigin,
    publicEntry: { url: currentOrigin, status: 'running', updatedAt: new Date(100_000).toISOString() }, now: 200_000 }), null,
  'a heartbeat older than the server freshness window is rejected');
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, publicBaseUrl: currentOrigin,
    publicEntry: { url: currentOrigin, status: 'running', updatedAt: new Date(150_000).toISOString() }, now: 200_000 }), currentOrigin,
  'only a fresh, matching running entry permits a temporary tunnel link');
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, publicBaseUrl: currentOrigin,
    publicEntry: { url: 'https://new.trycloudflare.com', status: 'running', updatedAt: new Date(199_000).toISOString() }, now: 200_000 }), null,
  'a different current heartbeat cannot validate an older page URL');
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, publicBaseUrl: currentOrigin,
    publicEntry: { url: currentOrigin, status: 'stopped', updatedAt: new Date(199_000).toISOString() }, now: 200_000 }), null,
  'a non-running entry cannot validate a temporary tunnel');
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, publicBaseUrl: currentOrigin,
    publicEntry: { url: currentOrigin, status: 'running', updatedAt: new Date(231_000).toISOString() }, now: 200_000 }), null,
  'a heartbeat too far in the future is rejected');
  assert.equal(sharing.preferredShareOrigin({ currentOrigin, lanUrls: ['http://192.168.1.8:4188'], now: 200_000 }), 'http://192.168.1.8:4188');
});

test('observed current HTTPS page is not a guarantee for another network', () => {
  const hint = sharing.shareEntryHint({ origin: 'https://other.example.com', publicEntry: { url: 'https://mcn.example.com', status: 'configured' } });
  assert.match(hint, /当前页面/);
  assert.match(hint, /目标网络/);
  assert.doesNotMatch(hint, /已配置|可直接打开/);
});

test('LAN and missing entry hints retain their limitations', () => {
  assert.match(sharing.shareEntryHint({ origin: 'http://192.168.1.2:4188' }), /同一网络/);
  assert.match(sharing.shareEntryHint({ origin: null }), /没有可分享/);
});

test('management footer distinguishes loopback, LAN, verified scheme, and plain HTTP without promising reachability', () => {
  assert.equal(sharing.managementOriginLabel('http://127.0.0.1:4188'), '本机后台');
  assert.equal(sharing.managementOriginLabel('http://192.168.1.2:4188'), '局域网后台（仅同网）');
  assert.equal(sharing.managementOriginLabel('https://mcn.example.com'), 'HTTPS 入口（可达性待验证）');
  assert.equal(sharing.managementOriginLabel('http://mcn.example.com:4188'), 'HTTP 非安全入口');
  assert.equal(sharing.managementOriginLabel('file:///tmp/index.html'), '入口待确认');
});

test('setup guide does not prescribe an obsolete private LAN address', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /10\.10\.3\.100/);
  assert.match(readme, /以面板实时显示的地址为准/);
  assert.match(readme, /不是公网链接/);
});

test('API passes sanitized public-entry provenance through without changing authentication', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf('pathname === "/api/access"'), server.indexOf('pathname === "/api/access/invites"'));
  assert.match(route, /requireRole\(request, "admin"\)/);
  assert.match(route, /publicBaseUrl: publicEntry\?\.url \|\| null/);
  assert.match(route, /publicEntry,/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /shareEntryHint\(/);
  assert.match(app, /publicEntry: accessData\.publicEntry/);
  assert.match(app, /publicEntry: state\.access\?\.publicEntry/);
  assert.match(app, /publicEntry: latestAccess\.publicEntry/);
  assert.match(app, /let latestAccess = await api\("\/api\/access"\)/);
  assert.match(app, /managementOriginLabel\(currentOrigin\)/);
  assert.doesNotMatch(app, /远程成员可直接打开/);
});
