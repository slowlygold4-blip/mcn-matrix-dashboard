import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const helper = new URL(process.env.MCN_OWNERSHIP_TEST_MODULE || '../lib/collector-ownership.mjs', import.meta.url).href;
const { createOwnedCollectorExecutor } = await import(helper);
const options = { timeout: 6000, cleanupTimeoutMs: 450, terminationGraceMs: 35, maxBuffer: 8192 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const base = `import{spawn}from'node:child_process';import{once}from'node:events';import{collectorOwnershipClient}from${JSON.stringify(helper)};const ipc=collectorOwnershipClient();await ipc.send('hello');`;
function run(executor, source, extra = {}) {
  let child;
  const result = new Promise(resolve => { child = executor.exec(process.execPath, ['--input-type=module', '-e', source], { ...options, ...extra },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })); });
  return { child, result };
}
function ready(child) {
  return new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('offline fixture readiness timeout')), 2500);
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); } });
  });
}
async function gone(pid, maximum = 4500) {
  const deadline = Date.now() + maximum;
  while (alive(pid) && Date.now() < deadline) await sleep(25);
  assert.equal(alive(pid), false, 'fixture-owned process must actually exit');
}
function cleanup(ids) { for (const pid of ids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
function delayedDescendant(delayMs) {
  const grandchild = `process.on('SIGUSR1',()=>setTimeout(()=>process.exit(0),${delayMs}));console.log(process.pid);setInterval(()=>{},1000);`;
  const owner = `const{spawn}=require('node:child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});g.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  return base + `await ipc.send('launch');const c=spawn(process.execPath,['-e',${JSON.stringify(owner)}],{detached:true,stdio:['ignore','pipe','ignore']});const grand=await new Promise(r=>c.stdout.once('data',d=>r(Number(String(d).trim()))));await ipc.send('register',c.pid);console.log(JSON.stringify({ids:[c.pid,grand]}));c.kill('SIGKILL');await once(c,'exit');process.kill(grand,'SIGUSR1');try{await ipc.send('released',c.pid);await ipc.send('complete');}catch{try{await ipc.send('complete');}catch{}process.exitCode=1;}finally{if(process.connected)process.disconnect();}`;
}

test('lane recovery: waits for a registered group tail after its leader exits, then succeeds', async () => {
  const executor = createOwnedCollectorExecutor();
  const invocation = run(executor, delayedDescendant(225));
  const ids = [invocation.child.pid, ...(await ready(invocation.child)).ids];
  try {
    const result = await invocation.result;
    assert.equal(result.error, null);
    assert.deepEqual(ids.filter(alive), []);
    assert.deepEqual(executor.state(), { busy: false, locked: false, reason: null });
  } finally { cleanup(ids); }
});

test('lane recovery: remains locked while registered tail lives and recovers only after group disappearance', async () => {
  const executor = createOwnedCollectorExecutor();
  const invocation = run(executor, delayedDescendant(2600));
  const ids = [invocation.child.pid, ...(await ready(invocation.child)).ids];
  try {
    const result = await invocation.result;
    assert.equal(result.error.code, 'BROWSER_CLEANUP_UNCERTAIN');
    assert.equal(alive(ids.at(-1)), true, 'tail is not killed after leader identity has disappeared');
    assert.equal(executor.state().locked, true);
    const refused = run(executor, "throw new Error('must not spawn while old group lives')");
    assert.equal(refused.child, null); assert.equal((await refused.result).error.code, 'BROWSER_LANE_LOCKED');
    await gone(ids.at(-1));
    const next = run(executor, base + `await ipc.send('complete');process.exitCode=1;process.disconnect();`);
    assert.ok(next.child, 'a proven-clean old group permits new work');
    assert.equal((await next.result).error.code, 'BROWSER_COLLECTOR_EXIT');
    assert.equal(executor.state().locked, false);
    const proof = executor.diagnostics();
    assert.equal(proof.lastRecovery.reason, 'registered-group-confirmed-absent');
    assert.equal(proof.lastRecovery.collectorClosed, true);
    assert.equal(proof.lastRecovery.registeredGroupId, ids[1]);
    assert.ok(proof.lastLock.branch.includes('group'));
    proof.lastRecovery.collectorClosed = false;
    assert.equal(executor.diagnostics().lastRecovery.collectorClosed, true, 'diagnostic copies cannot mutate recovery evidence');
    const bad = await run(executor, base + `await ipc.send('complete');await ipc.send('complete');`).result;
    assert.equal(bad.error.code, 'BROWSER_PROTOCOL_INVALID');
    const blockedAgain = run(executor, "throw new Error('stale recovery proof cannot release a new protocol lock')");
    assert.equal(blockedAgain.child, null); assert.equal((await blockedAgain.result).error.code, 'BROWSER_LANE_LOCKED');
    assert.equal(executor.diagnostics().lastLock.recoveryEligible, false);
  } finally { cleanup(ids); }
});

test('lane recovery: group-release waiting never extends the unchanged parent execution deadline', async () => {
  const executor = createOwnedCollectorExecutor(), started = Date.now();
  const invocation = run(executor, delayedDescendant(1500), { timeout: 650, cleanupTimeoutMs: 200, terminationGraceMs: 20 });
  const ids = [invocation.child.pid, ...(await ready(invocation.child)).ids];
  try {
    const result = await invocation.result;
    assert.equal(result.error.code, 'BROWSER_CLEANUP_UNCERTAIN');
    assert.ok(Date.now() - started < 1000, 'release waits share, not extend, the parent budget');
    assert.equal(executor.state().locked, true);
    assert.equal(alive(ids.at(-1)), true);
  } finally { cleanup(ids); }
});

test('lane recovery: a fake release PID cannot borrow a registered owner cleanup proof', async () => {
  const executor = createOwnedCollectorExecutor();
  const invocation = run(executor, base + `await ipc.send('launch');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await ipc.send('register',c.pid);console.log(JSON.stringify({ids:[c.pid]}));await ipc.send('released',c.pid+100000000);`);
  const ids = [invocation.child.pid, ...(await ready(invocation.child)).ids];
  try {
    assert.equal((await invocation.result).error.code, 'BROWSER_PROTOCOL_INVALID');
    assert.deepEqual(ids.filter(alive), []);
    const refused = run(executor, "throw new Error('fake release must remain locked')");
    assert.equal(refused.child, null); assert.equal((await refused.result).error.code, 'BROWSER_LANE_LOCKED');
    assert.equal(executor.diagnostics().lastLock.recoveryEligible, false);
    assert.equal(executor.diagnostics().lastRecovery, null);
  } finally { cleanup(ids); }
});

test('lane recovery: unknown launch ownership never self-unlocks even when fixture child exits', async () => {
  const executor = createOwnedCollectorExecutor();
  const output = await run(executor, base + `await ipc.send('launch');process.exit(0);`).result;
  assert.equal(output.error.code, 'BROWSER_OWNERSHIP_UNKNOWN');
  const refused = run(executor, "throw new Error('unknown ownership must stay locked')");
  assert.equal(refused.child, null); assert.equal((await refused.result).error.code, 'BROWSER_LANE_LOCKED');
  assert.equal(executor.diagnostics().lastRecovery, null);
  assert.equal(executor.diagnostics().lastLock.branch, 'launch-without-registered-owner');
});

test('lane recovery: unrelated PID registration remains a protocol lock and is never killed', async () => {
  const external = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const executor = createOwnedCollectorExecutor();
  try {
    const output = await run(executor, base + `await ipc.send('launch');await ipc.send('register',${external.pid});`).result;
    assert.equal(output.error.code, 'BROWSER_PROTOCOL_INVALID');
    assert.equal(alive(external.pid), true);
    cleanup([external.pid]); await gone(external.pid);
    const refused = run(executor, "throw new Error('invalid registration must stay locked')");
    assert.equal(refused.child, null); assert.equal((await refused.result).error.code, 'BROWSER_LANE_LOCKED');
    assert.equal(executor.diagnostics().lastRecovery, null);
    assert.equal(executor.diagnostics().lastLock.branch, 'register-identity-mismatch');
  } finally { cleanup([external.pid]); }
});
