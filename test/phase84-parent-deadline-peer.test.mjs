// Real private IPC + real detached child group + actual collector/executor.
// Time alone is accelerated 5x, equally in parent and child; no platform,
// saved state, browser installation, database, or service is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ownershipUrl = new URL(process.env.PHASE84_OWNERSHIP_MODULE || '../lib/collector-ownership.mjs', import.meta.url).href;
const collectorUrl = new URL(process.env.PHASE84_COLLECTOR_MODULE || '../scripts/douyin_browser_collector.mjs', import.meta.url).href;
const { createOwnedCollectorExecutor } = await import(ownershipUrl);
const sourceHashes = Object.fromEntries([ownershipUrl, collectorUrl].map(url => [url,
  createHash('sha256').update(readFileSync(new URL(url))).digest('hex')]));
const SCALE = 5;
const realNow = Date.now.bind(Date);
const realTimeout = globalThis.setTimeout;
const realHrtime = process.hrtime.bigint;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const records = [];

function acceleratedClock(origin, monotonicOrigin) {
  Date.now = () => origin + (realNow() - origin) * SCALE;
  globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, Math.max(0, Number(ms) || 0) / SCALE, ...args);
  process.hrtime.bigint = () => monotonicOrigin + (realHrtime() - monotonicOrigin) * BigInt(SCALE);
  return () => { Date.now = realNow; globalThis.setTimeout = realTimeout; process.hrtime.bigint = realHrtime; };
}

function fixtureSource({ setupMs = 3_000, beforeHelloMs = 0, cleanupHang = false, payload = {} }, origin, monotonicOrigin) {
  return `
    import {spawn} from 'node:child_process';
    import {once,EventEmitter} from 'node:events';
    import {collectorOwnershipClient} from ${JSON.stringify(ownershipUrl)};
    import {collectBrowserWorks} from ${JSON.stringify(collectorUrl)};
    const originalNow=Date.now.bind(Date),originalTimeout=globalThis.setTimeout,origin=${origin},scale=${SCALE};
    Date.now=()=>origin+(originalNow()-origin)*scale;
    globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,Math.max(0,Number(ms)||0)/scale,...args);
    const originalHrtime=process.hrtime.bigint,monotonicOrigin=BigInt(${JSON.stringify(String(monotonicOrigin))});
    process.hrtime.bigint=()=>monotonicOrigin+(originalHrtime()-monotonicOrigin)*BigInt(scale);
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const mark=(event,fields={})=>console.error(JSON.stringify({phase84:true,event,at:Date.now()-origin,...fields}));
    if(${beforeHelloMs})await sleep(${beforeHelloMs});
    const ipc=collectorOwnershipClient();
    const hello=await ipc.send('hello');mark('hello',{hello:hello??null});
    let owner;
    const terminate=async()=>{if(owner&&owner.exitCode===null&&owner.signalCode===null){const ended=once(owner,'exit');process.kill(-owner.pid,'SIGKILL');await ended;}mark('owner-reaped');};
    const closeStep=async name=>{mark(name+'-start');if(${cleanupHang}&&name!=='page-close')await new Promise(()=>{});else await sleep(100);mark(name+'-end');};
    class Page extends EventEmitter {
      constructor(){super();this.address='about:blank';this.frame={url:()=>this.address};}
      url(){return this.address;}
      mainFrame(){return this.frame;}
      request(url,navigation=false){return{url:()=>url,isNavigationRequest:()=>navigation,method:()=> 'GET',frame:()=>this.frame,resourceType:()=>navigation?'document':'fetch',redirectedFrom:()=>null};}
      async goto(url,options){
        mark('collect-start',{navigationTimeoutMs:options.timeout,trustedRemainingMs:ipc.remainingExecutionMs?.()??null});
        const doc=this.request(url,true);this.emit('request',doc);this.address=url;
        this.emit('response',{request:()=>doc,url:doc.url,status:()=>200});this.emit('framenavigated',this.frame);
        this.bodyTimer=setTimeout(()=>{const request=this.request('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAAphase84DeadlineFixture&max_cursor=0');
          this.emit('request',request);this.emit('response',{request:()=>request,url:request.url,status:()=>200,json:async()=>{mark('body-pending');await new Promise(()=>{});}});},20_000);
      }
      async close(){clearTimeout(this.bodyTimer);await closeStep('page-close');}
      async evaluate(){return null;}
    }
    const page=new Page();
    try{
      const result=await collectBrowserWorks({items:[{key:'phase84-offline',secUid:'MS4wLjABAAAAphase84DeadlineFixture',limit:1}],...${JSON.stringify(payload)}},{
        executablePath:process.execPath,collectOptions:{timeoutMs:45_000},runtime:{ownership:ipc,
          readState:async()=>{mark('setup-start');await sleep(${setupMs});mark('setup-end');return {cookies:[],origins:[]};},
          access:async()=>{},
          launchServer:async()=>{owner=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});mark('owner-spawn',{pid:owner.pid});return{
            process:()=>owner,wsEndpoint:()=> 'ws://127.0.0.1:0/phase84-offline',
            close:async()=>{await closeStep('server-close');await terminate();},kill:terminate};},
          connect:async()=>({newContext:async()=>({newPage:async()=>page,close:async()=>closeStep('context-close')}),close:async()=>closeStep('browser-close')})
        }});
      mark('collect-return',{elapsedMs:result.items[0]?.failureDiagnostics?.elapsedMs??null,stopReason:result.items[0]?.failureDiagnostics?.stopReason??null});
      await ipc.send('complete');mark('complete');
      process.stdout.write(JSON.stringify({ok:true,data:result}));
    }catch(error){mark('caught',{code:error.code??null});try{await ipc.send('complete');}catch{}process.stdout.write(JSON.stringify({ok:false,code:error.code??null}));process.exitCode=1;}
    finally{if(process.connected)process.disconnect();}
  `;
}

async function runOwned(config = {}) {
  const origin = realNow(), monotonicOrigin = realHrtime(), restore = acceleratedClock(origin, monotonicOrigin);
  const executor = createOwnedCollectorExecutor();
  const events = []; let child, buffer = '';
  const deadline = origin + 45_000;
  let callbackAt;
  try {
    const output = await new Promise(resolve => {
      child = executor.exec(process.execPath, ['--input-type=module', '-e', fixtureSource(config, origin, monotonicOrigin)],
        { timeout: 45_000, cleanupTimeoutMs: 3_000, terminationGraceMs: 350, maxBuffer: 100_000 },
        (error, stdout, stderr) => { callbackAt = Date.now() - origin; resolve({ error, stdout, stderr }); });
      child.stderr.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) { try { const event = JSON.parse(line); if (event.phase84) events.push(event); } catch {} }
      });
      child.stdin.end('{}');
    });
    const ids = [child.pid, ...events.filter(e => e.event === 'owner-spawn').map(e => e.pid)];
    const record = { mode: config.name, timeScale: SCALE, parentTimeoutMs: 45_000, parentCleanupReserveMs: 3_000,
      accountTimeoutMs: 45_000, origin, deadline, callbackAt, realElapsedMs: realNow() - origin,
      callbackError: output.error?.code ?? null, callbackOutputBytes: Buffer.byteLength(output.stdout),
      state: executor.state(), events, remainingOwnedProcesses: ids.filter(alive) };
    records.push(record);
    return { output, record };
  } finally {
    restore();
    // Only PIDs created by this fixture are cleanup targets; never scan/kill
    // arbitrary processes or use a negative group without actual ownership.
    for (const pid of [child?.pid, ...events.filter(e => e.event === 'owner-spawn').map(e => e.pid)].filter(Boolean))
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}

test.after(() => {
  if (process.env.PHASE84_DEADLINE_EVIDENCE) writeFileSync(process.env.PHASE84_DEADLINE_EVIDENCE,
    JSON.stringify({ recordedAt: new Date().toISOString(), realSubprocess: true, actualExecutor: ownershipUrl,
      actualCollector: collectorUrl, sourceHashes, noPlatformRequests: true, noSavedState: true, records }, null, 2) + '\n');
});

const red = process.env.PHASE84_PARENT_DEADLINE_EXPECT === 'red';
test(`phase84: actual-owned subprocess ${red ? 'RED characterization: parent cuts off child diagnostics' : 'returns diagnostics and releases owner before parent deadline'}`, { timeout: 20_000 }, async () => {
  const { output, record } = await runOwned({ name: 'parent-cutoff', setupMs: 3_000 });
  assert.deepEqual(record.remainingOwnedProcesses, []);
  assert.deepEqual(record.state, { busy: false, locked: false, reason: null });
  assert.ok(record.callbackAt < 45_000 + 1_500, 'the unchanged parent 45s ceiling remains bounded');
  if (red) {
    assert.equal(output.error?.code, 'BROWSER_COLLECTOR_TIMEOUT');
    assert.equal(output.stdout, '');
    assert.ok(record.events.some(e => e.event === 'collect-start'));
    assert.ok(!record.events.some(e => e.event === 'collect-return'));
    assert.ok(record.callbackAt >= 42_000);
  } else {
    assert.equal(output.error?.code ?? null, null, 'child must return structured diagnostics before parent kill');
    const body = JSON.parse(output.stdout);
    assert.equal(body.ok, true); assert.equal(body.data.items[0].status, 'unavailable');
    assert.equal(body.data.items[0].posts.length, 0);
    assert.ok(record.events.some(e => e.event === 'owner-reaped'));
    assert.ok(record.events.some(e => e.event === 'complete'));
    assert.ok(record.events.find(e => e.event === 'collect-return').at < 42_000);
  }
});

for (const config of [
  { name: 'payload-cannot-extend', setupMs: 3_000, payload: { parentDeadlineAt: 9e15, workDeadlineAt: 9e15,
    batchTimeoutMs: 850_000, timeoutMs: 850_000, collectOptions: { timeoutMs: 850_000, batchTimeoutMs: 850_000 },
    runtime: { ownership: { deadlineAt: 9e15 } } } },
  { name: 'setup-consumes-budget', setupMs: 9_000 },
  { name: 'startup-before-hello-consumes-budget', setupMs: 3_000, beforeHelloMs: 6_000 },
  { name: 'serial-cleanup-reserve', setupMs: 3_000, cleanupHang: true },
]) test(`phase84: ${config.name} under actual parent45s ceiling`, { timeout: 20_000, skip: red }, async () => {
  const { output, record } = await runOwned(config);
  assert.equal(output.error?.code ?? null, null, 'trusted remaining deadline must include setup and serial cleanup');
  assert.deepEqual(record.remainingOwnedProcesses, []);
  assert.deepEqual(record.state, { busy: false, locked: false, reason: null });
  assert.ok(record.callbackAt < 45_000 + 1_500);
  const body = JSON.parse(output.stdout); assert.equal(body.ok, true);
  assert.equal(body.data.items[0].status, 'unavailable'); assert.equal(body.data.items[0].posts.length, 0);
  const accountStart = record.events.find(e => e.event === 'collect-start');
  const returned = record.events.find(e => e.event === 'collect-return');
  assert.ok(accountStart && returned);
  assert.ok(accountStart.trustedRemainingMs > 0 && accountStart.trustedRemainingMs <= 42_000 - accountStart.at + 500,
    'trusted remaining time must consume elapsed setup');
  assert.ok(returned.elapsedMs <= 42_000 - accountStart.at - 2_000,
    'account work must retain a positive child cleanup reserve');
  assert.ok(returned.at < 42_000, 'collection, serial cleanup and released ACK all finish before parent cutoff');
  if (config.cleanupHang) {
    for (const step of ['context-close', 'browser-close', 'server-close'])
      assert.ok(record.events.some(e => e.event === step + '-start'));
    assert.ok(record.events.some(e => e.event === 'owner-reaped'));
  }
});

// Controlled parent ACKs, actual child client, real private IPC. These tests
// intentionally emulate invalid protocol inputs; they do not emulate the
// validator or substitute a copied implementation of the production client.
async function clientProbe({ name = 'ack-guard', reply, afterHello = '', awaitLate = false }) {
  const nonce = 'phase84-private-client-fixture';
  const source = `import{collectorOwnershipClient}from${JSON.stringify(ownershipUrl)};
    const ipc=collectorOwnershipClient();const output={frozen:Object.isFrozen(ipc)};
    try{await ipc.send('hello');output.accepted=true;output.firstRemaining=ipc.remainingExecutionMs();${afterHello}}
    catch(error){output.accepted=false;output.error=error.code??null;}
    ${awaitLate ? 'await new Promise(r=>setTimeout(r,700));' : ''}
    try{output.finalRemaining=ipc.remainingExecutionMs();}catch{output.finalRemaining=null;}
    console.log(JSON.stringify(output));if(process.connected)process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source],
    { env: { MCN_BROWSER_OWNERSHIP_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = ''; const timers = [];
  const send = (request, fields, delay = 0) => {
    const action = () => { if (child.connected) child.send({ channel: 'mcn-browser-ownership-v1', nonce,
      request, kind: 'ack', ok: true, ...fields }, () => {}); };
    if (delay) timers.push(realTimeout(action, delay)); else action();
  };
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => reply(message, send));
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
      timers.push(realTimeout(() => { child.kill('SIGKILL'); reject(new Error('client probe exceeded 4s real bound')); }, 4_000));
    });
    assert.equal(code, 0, `client probe failed: ${stderr.slice(0, 300)}`);
    const outcome = JSON.parse(stdout);
    records.push({ mode: name, realIpcClient: true, outcome });
    return outcome;
  } finally { for (const timer of timers) clearTimeout(timer); if (alive(child.pid)) child.kill('SIGKILL'); }
}

const nsAhead = milliseconds => String(realHrtime() + BigInt(milliseconds) * 1_000_000n);

test('phase84: trusted hello ACK deadline is immutable; replay and later ACK cannot enlarge it', { skip: red }, async () => {
  const out = await clientProbe({
    name: 'immutable-replay-wrong-nonce',
    reply: (message, send) => {
      if (message.kind === 'hello') {
        send(message.request, { nonce: 'wrong-nonce', executionDeadlineNs: nsAhead(900_000) });
        send(message.request, { executionDeadlineNs: nsAhead(5_000) }, 20);
      } else {
        send(1, { executionDeadlineNs: nsAhead(900_000) }); // replayed hello
        send(message.request, { executionDeadlineNs: nsAhead(900_000) }, 20);
      }
    },
    afterHello: `await ipc.send('launch');output.afterLaunch=ipc.remainingExecutionMs();
      try{ipc.remainingExecutionMs=()=>900_000;}catch{}output.afterMutation=ipc.remainingExecutionMs();`,
  });
  assert.equal(out.accepted, true); assert.equal(out.frozen, true);
  assert.ok(out.firstRemaining > 4_000 && out.firstRemaining <= 5_000);
  assert.ok(out.afterLaunch > 0 && out.afterLaunch <= out.firstRemaining);
  assert.ok(out.afterMutation <= out.afterLaunch && out.finalRemaining <= out.afterLaunch);
});

for (const [name, deadline] of [['missing', undefined], ['nan', 'NaN'], ['negative', '-1'],
  ['fractional', '1.5'], ['wrong-type', 123], ['empty', ''], ['expired', '1'], ['too-long', '9'.repeat(21)]])
  test(`phase84: malformed or expired hello deadline rejects ${name}`, { skip: red }, async () => {
    const out = await clientProbe({ name: `malformed-${name}`, reply: (message, send) => send(message.request,
      deadline === undefined ? {} : { executionDeadlineNs: deadline }) });
    assert.equal(out.accepted, false);
    assert.ok(!(out.finalRemaining > 0), 'invalid ACK cannot install a positive trusted work budget');
  });

test('phase84: malformed truthy ACK success flag cannot install a trusted budget', { skip: red }, async () => {
  const out = await clientProbe({ name: 'malformed-ack-ok',
    reply: (message, send) => send(message.request, { ok: 'yes', executionDeadlineNs: nsAhead(5_000) }) });
  assert.equal(out.accepted, false); assert.ok(!(out.finalRemaining > 0));
});

test('phase84: unreasonable private hello deadline cannot enlarge existing maximum', { skip: red }, async () => {
  const out = await clientProbe({ name: 'unreasonable-deadline',
    reply: (message, send) => send(message.request, { executionDeadlineNs: nsAhead(900_000) }) });
  assert.equal(out.accepted, false); assert.ok(!(out.finalRemaining > 0));
});

test('phase84: hello ACK arriving after request timeout cannot resurrect trusted budget', { timeout: 5_000, skip: red }, async () => {
  const out = await clientProbe({ name: 'late-ack', awaitLate: true,
    reply: (message, send) => send(message.request, { executionDeadlineNs: nsAhead(900_000) }, 1_650) });
  assert.equal(out.accepted, false); assert.equal(out.error, 'BROWSER_PROTOCOL_TIMEOUT');
  assert.ok(!(out.finalRemaining > 0));
});
