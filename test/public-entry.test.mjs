import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePublicEntry, readPublicEntry, tunnelLogEvent, writePublicEntry } from '../lib/public-entry.mjs';

test('public entry accepts only a fresh root Quick Tunnel URL', () => {
  const now = Date.parse('2026-09-21T10:00:00Z');
  const good = { status: 'running', url: 'https://demo.trycloudflare.com/', updatedAt: '2026-09-21T09:59:30Z' };
  assert.equal(normalizePublicEntry(good, now)?.url, 'https://demo.trycloudflare.com');
  assert.equal(normalizePublicEntry({ ...good, url: 'https://demo.trycloudflare.com/app' }, now), null);
  assert.equal(normalizePublicEntry({ ...good, url: 'https://demo.example.com' }, now), null);
  assert.equal(normalizePublicEntry({ ...good, updatedAt: '2026-09-21T09:57:00Z' }, now), null);
});

test('public entry writes atomically and ignores stale or stopped state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-entry-'));
  writePublicEntry(dir, { status: 'stopped', url: null, updatedAt: new Date().toISOString() });
  assert.equal(readPublicEntry(dir), null);
  writePublicEntry(dir, { status: 'running', url: 'https://demo.trycloudflare.com', updatedAt: new Date().toISOString() });
  assert.match(readFileSync(join(dir, 'public-entry.json'), 'utf8'), /demo\.trycloudflare\.com/);
  assert.equal(readPublicEntry(dir)?.status, 'running');
});

test('tunnel log readiness is separate from the URL announcement', () => {
  assert.deepEqual(tunnelLogEvent('Your quick Tunnel has been created: https://demo.trycloudflare.com'), { url: 'https://demo.trycloudflare.com', connected: false });
  assert.equal(tunnelLogEvent('INF Registered tunnel connection connIndex=0').connected, true);
});
