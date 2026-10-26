import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { accessSync } from "node:fs";
import { createOwnedCollectorExecutor, sameRegisteredBrowserIdentity, safeOwnershipFailure } from "../lib/collector-ownership.mjs";

const helper = new URL("../lib/collector-ownership.mjs", import.meta.url).href;
const collector = new URL("../scripts/douyin_browser_collector.mjs", import.meta.url).href;
const provider = new URL("../lib/providers/public-web.mjs", import.meta.url).href;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let chromeAvailable = false; try { accessSync(chrome); chromeAvailable = true; } catch {}
const options = { timeout: 2500, cleanupTimeoutMs: 900, terminationGraceMs: 80, maxBuffer: 8192 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const base = `import {spawn}from'node:child_process';import{once}from'node:events';import{collectorOwnershipClient}from${JSON.stringify(helper)};const ipc=collectorOwnershipClient();await ipc.send('hello');`;
const ownChild = `await ipc.send('launch');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});await ipc.send('register',c.pid);console.log(JSON.stringify({ids:[c.pid]}));`;
function run(executor, source, extra = {}) {
  let child;
  const result = new Promise(resolve => { child = executor.exec(process.execPath, ["--input-type=module", "-e", source], { ...options, ...extra }, (error, stdout, stderr) => resolve({ error, stdout, stderr })); });
  return { child, result };
}
function ready(child, ms = 2000) {
  return new Promise((resolve, reject) => {
    let text = ""; const timer = setTimeout(() => reject(new Error("fixture readiness timeout")), ms);
    child.stdout.on("data", chunk => { text += chunk; if (text.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(text.split("\n")[0])); } });
  });
}
function cleanup(ids) { for (const pid of ids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} } }

test("ownership: normal success requires registered group release and completion before callback", async () => {
  const executor = createOwnedCollectorExecutor();
  const source = base + ownChild + `process.kill(-c.pid,'SIGKILL');await once(c,'exit');await ipc.send('released',c.pid);await ipc.send('complete');process.disconnect();`;
  const { child, result } = run(executor, source); const ids = [child.pid, ...(await ready(child)).ids];
  try { assert.equal((await result).error, null); assert.deepEqual(ids.filter(alive), []); assert.deepEqual(executor.state(), { busy: false, locked: false, reason: null }); }
  finally { cleanup(ids); }
});

for (const mode of ["abort", "timeout"]) test(`ownership: ${mode} cleans registered noncooperative private group before returning`, async () => {
  const executor = createOwnedCollectorExecutor(), controller = new AbortController();
  const { child, result } = run(executor, base + `process.on('SIGTERM',()=>{});` + ownChild + `await new Promise(()=>{});`, { signal: controller.signal });
  const ids = [child.pid, ...(await ready(child)).ids];
  try {
    if (mode === "abort") controller.abort(); const output = await result;
    assert.equal(output.error.code, mode === "abort" ? "ABORT_ERR" : "BROWSER_COLLECTOR_TIMEOUT");
    assert.deepEqual(ids.filter(alive), []); assert.equal(executor.state().locked, false);
  } finally { cleanup(ids); }
});

test("ownership: previous early-parent-exit counterexample is rejected and locks next browser spawn", async () => {
  const executor = createOwnedCollectorExecutor();
  const source = `import{spawn}from'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(JSON.stringify({ids:[c.pid]})+String.fromCharCode(10),()=>process.exit(0));`;
  const first = run(executor, source); const ids = (await ready(first.child)).ids;
  try {
    assert.equal((await first.result).error.code, "BROWSER_OWNERSHIP_UNKNOWN");
    assert.equal(executor.state().locked, true); assert.equal(alive(ids[0]), true, "unknown ownership is not permission to kill");
    const next = run(executor, "throw new Error('must not spawn')");
    assert.equal(next.child, null); assert.equal((await next.result).error.code, "BROWSER_LANE_LOCKED");
  } finally { cleanup(ids); }
});

test("ownership: unrelated private process cannot be registered or killed", async () => {
  const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const executor = createOwnedCollectorExecutor();
  try {
    const output = await run(executor, base + `await ipc.send('launch');await ipc.send('register',${external.pid});`).result;
    assert.equal(output.error.code, "BROWSER_PROTOCOL_INVALID"); assert.equal(alive(external.pid), true); assert.equal(executor.state().locked, true);
  } finally { cleanup([external.pid]); }
});

test("ownership: no-launch error handshake does not lock the browser lane", async () => {
  const executor = createOwnedCollectorExecutor();
  const output = await run(executor, base + `await ipc.send('complete');process.exitCode=1;process.disconnect();`).result;
  assert.equal(output.error.code, "BROWSER_COLLECTOR_EXIT"); assert.equal(executor.state().locked, false);
});

test("ownership: launch without registration and fake nonce cannot be called clean", async () => {
  for (const suffix of [`await ipc.send('launch');process.exit(0);`, `process.send({channel:'mcn-browser-ownership-v1',nonce:'wrong',request:1,kind:'hello'});`]) {
    const executor = createOwnedCollectorExecutor(); const result = await run(executor, base + suffix).result;
    assert.ok(result.error.code.startsWith("BROWSER_")); assert.equal(executor.state().locked, true);
  }
});

test("ownership: duplicate or out-of-order protocol requests and repeated complete fail closed", async () => {
  for (const suffix of [
    `process.send({channel:'mcn-browser-ownership-v1',nonce:process.env.MCN_BROWSER_OWNERSHIP_NONCE,request:1,kind:'launch'});`,
    `process.send({channel:'mcn-browser-ownership-v1',nonce:process.env.MCN_BROWSER_OWNERSHIP_NONCE,request:7,kind:'launch'});`,
    `await ipc.send('complete');await ipc.send('complete');`
  ]) {
    const executor = createOwnedCollectorExecutor(), output = await run(executor, base + suffix).result;
    assert.equal(output.error.code, "BROWSER_PROTOCOL_INVALID"); assert.equal(executor.state().locked, true);
  }
});

test("ownership: dead registered leader with live group members cannot be released or guessed safe", async () => {
  const executor = createOwnedCollectorExecutor();
  const descendant = `const{spawn}=require('node:child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000);`;
  const source = base + `await ipc.send('launch');const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','pipe','ignore']});const grand=await new Promise(r=>c.stdout.once('data',d=>r(Number(String(d).trim()))));await ipc.send('register',c.pid);console.log(JSON.stringify({ids:[c.pid,grand]}));c.kill('SIGKILL');await once(c,'exit');await ipc.send('released',c.pid);`;
  const invocation = run(executor, source); const ids = [invocation.child.pid, ...(await ready(invocation.child)).ids];
  try {
    const output = await invocation.result;
    assert.ok(output.error); assert.equal(executor.state().locked, true);
    assert.equal(alive(ids.at(-1)), true, "no negative-group kill without a live matching leader");
    assert.equal(run(executor, "").child, null);
  } finally { cleanup(ids); }
});

test("ownership: reused PID, changed PGID and absent identity reject destructive ownership proof", () => {
  const original = { pid: 12345, parent: 54321, group: 12345, started: "Mon Sep 28 01:00:00 2026" };
  assert.equal(sameRegisteredBrowserIdentity({ ...original }, original), true);
  for (const current of [null, { absent: true }, { ...original, pid: 22 }, { ...original, group: 9 }, { ...original, started: "Mon Sep 28 01:00:01 2026" }])
    assert.equal(sameRegisteredBrowserIdentity(current, original), false);
  assert.equal(safeOwnershipFailure({ code: "BROWSER_OUTPUT_LIMIT", message: "PRIVATE_SECRET" }).message.includes("PRIVATE_SECRET"), false);
  assert.equal(safeOwnershipFailure({ code: "BROWSER_PRIVATE_SECRET" }), null);
});

test("ownership: synchronous spawn failure and pre-abort release resources without locking", async () => {
  const executor = createOwnedCollectorExecutor();
  const failed = await new Promise(resolve => executor.exec(null, [], options, error => resolve(error)));
  assert.equal(failed.code, "BROWSER_SPAWN_FAILED"); assert.equal(executor.state().busy, false); assert.equal(executor.state().locked, false);
  const controller = new AbortController(); controller.abort();
  const invocation = run(executor, "throw new Error('must not spawn')", { signal: controller.signal });
  assert.equal(invocation.child, null); assert.equal((await invocation.result).error.name, "AbortError");
  assert.equal(executor.state().busy, false);
});

test("ownership: busy lane prevents concurrent launch and abort releases a proven-clean lane", async () => {
  const executor = createOwnedCollectorExecutor(), controller = new AbortController();
  const first = run(executor, base + ownChild + `await new Promise(()=>{});`, { signal: controller.signal });
  const ids = [first.child.pid, ...(await ready(first.child)).ids];
  try {
    const second = run(executor, "throw new Error('must not spawn')"); assert.equal(second.child, null);
    assert.equal((await second.result).error.code, "BROWSER_LANE_BUSY"); controller.abort(); await first.result;
    assert.equal(executor.state().busy, false); assert.equal(executor.state().locked, false); assert.deepEqual(ids.filter(alive), []);
  } finally { cleanup(ids); }
});

test("ownership: cleanup uncertainty stays locked across two new default Provider instances", async () => {
  const source = `import{ownedCollectorExecutor}from${JSON.stringify(helper)};import{PublicWebProvider}from${JSON.stringify(provider)};
  await new Promise(resolve=>ownedCollectorExecutor.exec(process.execPath,['-e','process.exit(0)'],{timeout:1000,cleanupTimeoutMs:300,terminationGraceMs:20},()=>resolve()));
  const codes=[];for(let i=0;i<2;i++){try{await new PublicWebProvider().runBrowserWorks({key:'offline',secUid:'fixture'});}catch(e){codes.push(e.code);}}
  console.log(JSON.stringify({codes,state:ownedCollectorExecutor.state()}));`;
  const output = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 5000 }));
  assert.deepEqual(output.codes, ["BROWSER_LANE_LOCKED", "BROWSER_LANE_LOCKED"]);
  assert.deepEqual(output.state, { busy: false, locked: true, reason: "BROWSER_OWNERSHIP_UNKNOWN" });
});

test("ownership: output overflow cleans ownership and does not expose stdout or stderr", async () => {
  const executor = createOwnedCollectorExecutor();
  const invocation = run(executor, base + ownChild + `process.stdout.write('PRIVATE_TOKEN'.repeat(1000));process.stderr.write('COOKIE_SECRET');await new Promise(()=>{});`, { maxBuffer: 1024 });
  const ids = [invocation.child.pid, ...(await ready(invocation.child)).ids];
  try {
    const output = await invocation.result;
    assert.equal(output.error.code, "BROWSER_OUTPUT_LIMIT"); assert.equal(output.stdout, ""); assert.equal(output.stderr, "");
    assert.equal(output.error.message.includes("PRIVATE_TOKEN"), false); assert.equal(executor.state().locked, false);
    assert.deepEqual(ids.filter(alive), []);
  } finally { cleanup(ids); }
});

for (const mode of ["normal", "abort", "stubborn"]) test(`ownership: real offline launchServer ${mode}, no saved session or platform traffic`, { timeout: 15_000, skip: !chromeAvailable ? "this host has no local Chrome; no lifecycle guarantee claimed" : false }, async () => {
  const executor = createOwnedCollectorExecutor(), controller = new AbortController();
  const source = base + `import{chromium}from'playwright-core';import{collectBrowserWorks}from${JSON.stringify(collector)};
  const launchServer=async opts=>chromium.launchServer({...opts,proxy:{server:'http://127.0.0.1:9'},args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']});
  const connect=async(endpoint,opts)=>{const b=await chromium.connect(endpoint,opts);const make=b.newContext.bind(b);b.newContext=async opts=>{const ctx=await make({...opts,offline:true,serviceWorkers:'block'});await ctx.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html>offline fixture'}));${mode !== "normal" ? `console.log(JSON.stringify({ids:[]}));${mode === "stubborn" ? "process.removeAllListeners('SIGTERM');process.on('SIGTERM',()=>{});" : ""}await new Promise(()=>{});` : ""}return ctx;};return b;};
  const data=await collectBrowserWorks({items:[{key:'offline',secUid:'MS4wLjABAAAAlifecycleOfflineFixture'}]},{executablePath:${JSON.stringify(chrome)},runtime:{ownership:ipc,readState:()=>({cookies:[],origins:[]}),launchServer,connect},collectOptions:{timeoutMs:80}});await ipc.send('complete');console.log(JSON.stringify({ok:true,data}));process.disconnect();`;
  // Include the child's shared cleanup reservation and real Chrome startup;
  // this fixture ceiling is still far below the unchanged provider 45s cap.
  const invocation = run(executor, source, { signal: controller.signal, timeout: 15_000, cleanupTimeoutMs: 2500, terminationGraceMs: 250 });
  let ids = [invocation.child.pid];
  if (mode !== "normal") {
    await ready(invocation.child, 6000);
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    for (let n = 0; n < 10; n++) for (const [pid, parent] of rows) if (ids.includes(parent) && !ids.includes(pid)) ids.push(pid);
    assert.ok(ids.length > 1); controller.abort();
  }
  try {
    const output = await invocation.result;
    assert.equal(output.error?.code ?? null, mode === "normal" ? null : "ABORT_ERR");
    if (mode === "normal") assert.equal(JSON.parse(output.stdout).data.items[0].worksCoverage, "unavailable");
    assert.equal(executor.state().locked, false); assert.deepEqual(ids.filter(alive), []);
  } finally { cleanup(ids); }
});
