import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createOwnedCollectorExecutor } from '../lib/collector-ownership.mjs';
import { collectAuthorisedDetail } from '../lib/douyin-authorised-detail.mjs';

const collectorUrl = new URL('../scripts/douyin_authorised_detail.mjs', import.meta.url).href;
const detailUrl = new URL('../lib/douyin-authorised-detail.mjs', import.meta.url).href;
const ownershipUrl = new URL('../lib/collector-ownership.mjs', import.meta.url).href;
const payload = { items: [{ key: 'offline-peer-share', submittedId: 'offline_peer', shareUrl: 'https://v.douyin.com/OfflinePeer/' }] };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Exact pre-fix cleanup block, captured by this independent review before the
// 2026-10-09 narrow lifecycle fix. Only isolated loader memory is rewritten.
const legacyCleanup = `  finally {
    const cleanup = async action => {
      try { await bounded(Promise.resolve().then(action), Math.max(1, Math.min(1000, deadline - performance.now(), ownership.remainingExecutionMs()))); }
      catch { clean = false; }
    };
    if (page) await cleanup(() => page.close());
    if (context) await cleanup(() => context.close());
    if (browser) await cleanup(() => browser.close());
    if (server) {
      await cleanup(() => server.close());
      const process = server.process();
      if (process?.exitCode === null && process?.signalCode === null) await cleanup(() => server.kill());
      if (process?.exitCode === null && process?.signalCode === null) clean = false;
      if (registered && clean) await cleanup(() => ownership.send('released', pid));
    }
  }
`;
// Pre-fix CLI control flow; absolute import URLs are the only path adaptation.
const legacyCli = `import { collectAuthorisedDetail } from ${JSON.stringify(detailUrl)};
import { collectorOwnershipClient } from ${JSON.stringify(ownershipUrl)};
let ownership, launched = false;
try {
  if (process.env.DOUYIN_AUTHORISED_DETAIL_ENABLED !== '1') throw Object.assign(new Error(), { code: 'disabled' });
  ownership = collectorOwnershipClient();
  if (!ownership) throw Object.assign(new Error(), { code: 'ownership_required' });
  await ownership.send('hello');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  let input = '', bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16_384) throw Object.assign(new Error(), { code: 'invalid_input' });
    input += chunk;
  }
  let payload;
  try { payload = JSON.parse(input); } catch { throw Object.assign(new Error(), { code: 'invalid_input' }); }
  const trackedOwnership = { remainingExecutionMs: () => ownership.remainingExecutionMs(), send: async (kind, pid) => {
    if (kind === 'register') launched = true;
    return ownership.send(kind, pid);
  } };
  const data = await collectAuthorisedDetail(payload, { enabled: true, runtime: { ownership: trackedOwnership }, signal: controller.signal });
  await ownership.send('complete');
  process.off('SIGTERM', stop);
  process.stdout.write(JSON.stringify({ ok: true, data }));
  if (!launched || data.errorCode === 'cleanup_uncertain') process.exitCode = 1;
} catch (error) {
  try { await ownership?.send('complete'); } catch { }
  const errorCode = ['disabled', 'ownership_required', 'invalid_input'].includes(error?.code) ? error.code : 'collector_error';
  process.stdout.write(JSON.stringify({ ok: false, errorCode }));
  process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }
`;

async function runOffline(t, { close = 'normal', legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'authorised-owned-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'synthetic-state.json'), preload = join(directory, 'offline-loader.mjs');
  await writeFile(state, JSON.stringify({ cookies: [{ name: 'offline-only', value: 'SYNTHETIC_NOT_A_SESSION' }], origins: [] }), { mode: 0o600 });
  // A disposable Node timer process substitutes for a browser process. There
  // is no browser executable, page network, real saved session or platform call.
  const chromiumSource = `import {spawn} from 'node:child_process'; import {once,EventEmitter} from 'node:events';
  const mode=${JSON.stringify(close)};
  const page=new EventEmitter(); page.mainFrame=()=>page.frame;page.frame={url:()=>page.current};page.current='about:blank';page.url=()=>page.current;
  page.goto=async()=>{throw new Error('PRIVATE_PEER_NAVIGATION_FAILURE')};
  page.close=async()=>{if(mode==='throw')throw new Error('PRIVATE_PEER_CLOSE_FAILURE');if(mode==='hang')await new Promise(()=>{});};
  const context={newPage:async()=>page,close:async()=>{}};
  const browser={newContext:async()=>context,close:async()=>{}};
  export const chromium={launchServer:async()=>{
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await once(child,'spawn');
    process.stderr.write('OFFLINE_OWNER='+child.pid+'\\n');
    const close=async()=>{if(mode==='unconfirmed'){child.unref();throw new Error('PRIVATE_PEER_SERVER_CLOSE_FAILURE');}if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');await exited;};
    return {process:()=>child,wsEndpoint:()=> 'ws://127.0.0.1:1/offline',close,kill:close};
  },connect:async()=>browser};`;
  const chromiumUrl = 'data:text/javascript;base64,' + Buffer.from(chromiumSource).toString('base64');
  await writeFile(preload, `import {registerHooks} from 'node:module';
  globalThis.fetch=async()=>{throw new Error('No external network in offline lifecycle fixture')};
  registerHooks({resolve(specifier,context,next){if(specifier==='playwright-core')return {url:${JSON.stringify(chromiumUrl)},shortCircuit:true};return next(specifier,context)},
  load(url,context,next){
    if(${legacy}&&url===${JSON.stringify(collectorUrl)})return {format:'module',source:${JSON.stringify(legacyCli)},shortCircuit:true};
    const loaded=next(url,context);
    if(${legacy}&&url===${JSON.stringify(detailUrl)}){
      const source=Buffer.from(loaded.source).toString(),start=source.indexOf('  finally {\\n    const cleanup = async'),end=source.indexOf('  const finishedAt =',start);
      if(start<0||end<0)throw new Error('Legacy cleanup capture cannot be applied');
      return {...loaded,source:source.slice(0,start)+${JSON.stringify(legacyCleanup)}+source.slice(end)};
    }return loaded;
  }});`);
  const executor = createOwnedCollectorExecutor(); let child, owner = null, stderr = '';
  const result = new Promise(resolve => {
    child = executor.exec(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(collectorUrl)], {
      timeout: 15000, cleanupTimeoutMs: 1000, terminationGraceMs: 50, maxBuffer: 16384,
      env: { ...process.env, DOUYIN_AUTHORISED_DETAIL_ENABLED: '1', DOUYIN_CHROME_PATH: process.execPath,
        DOUYIN_ACCOUNT_BROWSER_STATE: state, NODE_OPTIONS: '' },
    }, (error, stdout, errorOutput) => resolve({ error, stdout, stderr: errorOutput }));
    child.stderr.on('data', chunk => { stderr += chunk; const match = /OFFLINE_OWNER=(\d+)/.exec(stderr); if (match) owner = Number(match[1]); });
    child.stdin.end(JSON.stringify(payload));
  });
  const output = await result;
  assert.ok(owner, 'the fixture-only process group was registered');
  assert.equal(alive(owner), false, 'the fixture owner is actually gone before interpreting the lane result');
  assert.equal(alive(child.pid), false);
  assert.equal(output.stderr, '');
  assert.doesNotMatch(output.stdout, /PRIVATE_PEER|SYNTHETIC_NOT_A_SESSION/);
  return { output, state: executor.state(), diagnostics: executor.diagnostics() };
}

for (const close of ['throw', 'hang']) test(`legacy lifecycle reproduces permanent protocol lock after page.close ${close}, despite dead owned group`, { timeout: 10000 }, async t => {
  const result = await runOffline(t, { close, legacy: true });
  assert.equal(result.output.error?.code, 'BROWSER_PROTOCOL_INVALID');
  assert.equal(result.diagnostics.lastLock.branch, 'protocol-state-invalid');
  assert.equal(result.diagnostics.lastLock.collectorClosed, true);
  assert.equal(result.diagnostics.lastLock.recoveryEligible, false);
  assert.equal(result.state.locked, true);
  t.diagnostic('Reproduced: dead registered fixture group + skipped released + premature complete => protocol-state-invalid, recoveryEligible=false');
});

for (const close of ['normal', 'throw', 'hang']) test(`fixed CLI preserves navigation failure and releases the proven-dead group after page.close ${close}`, { timeout: 10000 }, async t => {
  const result = await runOffline(t, { close });
  assert.equal(result.output.error, null);
  const response = JSON.parse(result.output.stdout);
  assert.equal(response.ok, true); assert.equal(response.data.status, 'unavailable');
  assert.equal(response.data.errorCode, 'navigation_error'); assert.equal(response.data.candidate, undefined);
  assert.deepEqual(result.state, { busy: false, locked: false, reason: null });
  assert.equal(result.diagnostics.lastLock, null);
});

test('fixed CLI never fabricates complete without release; missing release remains fail-closed rather than protocol-invalid', { timeout: 10000 }, async t => {
  const result = await runOffline(t, { close: 'unconfirmed' });
  assert.equal(result.output.error?.code, 'BROWSER_OWNERSHIP_UNKNOWN');
  assert.equal(result.diagnostics.lastLock.branch, 'protocol-completion-unconfirmed');
  assert.equal(result.diagnostics.lastLock.recoveryEligible, false);
  assert.equal(result.state.locked, true);
  assert.equal(result.output.stdout, '', 'unconfirmed cleanup cannot return usable identity evidence');
});

test('release confirmation budget tolerates a 1100ms ACK without accepting a late identity result', async () => {
  const page = new EventEmitter(), calls = [], process = { pid: 12345, exitCode: null, signalCode: null };
  page.mainFrame = () => page; page.url = () => 'about:blank';
  page.goto = async () => { throw new Error('PRIVATE_PEER_NAVIGATION'); }; page.close = async () => {};
  const server = { process: () => process, wsEndpoint: () => 'ws://127.0.0.1:1/offline', close: async () => { process.exitCode = 0; } };
  const result = await collectAuthorisedDetail(payload, { enabled: true, runtime: {
    readState: async () => ({ cookies: [], origins: [] }), access: async () => {},
    ownership: { remainingExecutionMs: () => 45000, send: async kind => {
      calls.push(kind); if (kind === 'released') await new Promise(resolve => setTimeout(resolve, 1100));
    } },
    chromium: { launchServer: async () => server, connect: async () => ({ close: async () => {},
      newContext: async () => ({ close: async () => {}, newPage: async () => page }) }) },
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.errorCode, 'navigation_error');
  assert.equal(result.candidate, undefined); assert.equal(calls.filter(kind => kind === 'released').length, 1);
});
