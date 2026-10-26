import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfiguredPublicEntry, normalizePublicEntry, readPublicEntry, writePublicEntry, tunnelLogEvent } from '../lib/public-entry.mjs';

const now = Date.parse('2026-09-29T02:00:00Z');
const tunnel = { status: 'running', url: 'https://fixture.trycloudflare.com', updatedAt: '2026-09-29T01:59:30Z' };
const configured = { url: 'https://monitor.example.com', status: 'configured', source: 'configuration',
  verificationStatus: 'unverified', verifiedAt: null, updatedAt: null };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcn-fixed-entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writePublicEntry(dir, tunnel);
  return dir;
}

test('explicit HTTPS DNS origin is configured but never represented as verified or running', () => {
  for (const value of ['https://monitor.example.com', 'https://monitor.example.com/', 'HTTPS://MONITOR.EXAMPLE.COM/', '  https://monitor.example.com  ']) {
    assert.deepEqual(normalizeConfiguredPublicEntry(value), configured);
  }
  assert.equal(normalizeConfiguredPublicEntry('https://xn--bcher-kva.example.com')?.status, 'configured');
});

const invalid = [null, undefined, true, 1, {}, ['https://monitor.example.com'], '',
  'http://monitor.example.com', '//monitor.example.com', 'https://user@monitor.example.com',
  'https://user:password@monitor.example.com', 'https://monitor.example.com:443', 'https://monitor.example.com:444',
  'https://monitor.example.com/path', 'https://monitor.example.com/?', 'https://monitor.example.com/#',
  'https://monitor.example.com?x=1', 'https://monitor.example.com#fragment',
  'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://0x7f000001',
  'https://8.8.8.8', 'https://[::1]', 'https://[2001:4860:4860::8888]', 'https://localhost',
  'https://app.localhost', 'https://app.local', 'https://app.internal', 'https://app.test',
  'https://app.invalid', 'https://app.home.arpa', 'https://app.lan', 'https://app.onion',
  'https://monitor', 'https://monitor.example.com.', 'https://-bad.example.com',
  'https://bad-.example.com', 'https://bad..example.com', 'https://under_score.example.com',
  `https://${'a'.repeat(64)}.example.com`, `https://${Array(5).fill('a'.repeat(60)).join('.')}.com`,
  'https://监控.example.com', 'https://monitor%2eexample.com', 'https://monitor.example.com\\@evil.com',
  'https://monitor. example.com', 'https://monitor.example.com\n', 'https://monitor.example.com\t',
  'https://monitor.example.com\u0000', 'https://monitor.example.com\u007f'];
for (const [index, value] of invalid.entries()) test(`configured origin rejects unsafe or malformed input ${index}`, () => {
  assert.equal(normalizeConfiguredPublicEntry(value), null);
});

test('configuration wins without reading a tunnel path or modifying the stored heartbeat', t => {
  assert.deepEqual(readPublicEntry(Symbol('must not touch filesystem'), { publicBaseUrl: configured.url }), configured);
  const dir = fixture(t), before = readFileSync(join(dir, 'public-entry.json'), 'utf8');
  assert.deepEqual(readPublicEntry(dir, { publicBaseUrl: configured.url, now }), configured);
  assert.equal(readFileSync(join(dir, 'public-entry.json'), 'utf8'), before);
});

test('nonempty invalid configuration fails closed rather than falling back to a fresh tunnel', t => {
  const dir = fixture(t);
  for (const value of invalid.filter(value => value !== undefined && value !== null && value !== '')) {
    assert.equal(readPublicEntry(dir, { publicBaseUrl: value, now }), null);
  }
});

test('absent or blank explicit configuration retains the original tunnel object and TTL guards', t => {
  const dir = fixture(t);
  for (const value of [undefined, null, '', '   ']) {
    assert.deepEqual(readPublicEntry(dir, { publicBaseUrl: value, now }), normalizePublicEntry(tunnel, now));
    assert.equal(readPublicEntry(dir, { publicBaseUrl: value, now: now + 90_000 }), null);
  }
  assert.equal(normalizePublicEntry({ ...tunnel, status: 'configured' }, now), null);
  assert.equal(normalizePublicEntry({ ...tunnel, status: 'stopped' }, now), null);
  assert.equal(normalizePublicEntry({ ...tunnel, updatedAt: new Date(now + 31_000).toISOString() }, now), null);
  assert.equal(normalizePublicEntry({ ...tunnel, url: configured.url }, now), null);
  assert.deepEqual(tunnelLogEvent('https://fixture.trycloudflare.com'), { url: tunnel.url, connected: false });
});

test('environment is read only at the entry point and options allow isolated deterministic tests', t => {
  const original = process.env.PUBLIC_BASE_URL;
  t.after(() => { if (original === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = original; });
  const dir = fixture(t);
  process.env.PUBLIC_BASE_URL = configured.url;
  assert.deepEqual(readPublicEntry(dir, { now }), configured);
  assert.deepEqual(readPublicEntry(dir, { publicBaseUrl: undefined, now }), normalizePublicEntry(tunnel, now));
  process.env.PUBLIC_BASE_URL = 'http://invalid.example.com';
  assert.equal(readPublicEntry(dir, { now }), null);
  process.env.PUBLIC_BASE_URL = '';
  assert.deepEqual(readPublicEntry(dir, { now }), normalizePublicEntry(tunnel, now));
});

test('legacy temporary URL in environment never resurrects an expired Quick Tunnel', t => {
  const dir = fixture(t);
  for (const value of ['https://old.trycloudflare.com', 'https://fixture.trycloudflare.com/']) {
    assert.equal(normalizeConfiguredPublicEntry(value), null);
    assert.deepEqual(readPublicEntry(dir, { publicBaseUrl: value, now }), normalizePublicEntry(tunnel, now));
    assert.equal(readPublicEntry(dir, { publicBaseUrl: value, now: now + 90_000 }), null);
  }
  for (const value of ['https://old.trycloudflare.com/path', 'https://old.trycloudflare.com:443', 'https://old.trycloudflare.com\n',
    'https://-.trycloudflare.com', 'https://-bad.trycloudflare.com', 'https://bad-.trycloudflare.com', `https://${'a'.repeat(64)}.trycloudflare.com`]) {
    assert.equal(readPublicEntry(dir, { publicBaseUrl: value, now }), null);
  }
  writePublicEntry(dir, { ...tunnel, status: 'stopped' });
  assert.equal(readPublicEntry(dir, { publicBaseUrl: 'https://old.trycloudflare.com', now }), null);
});
