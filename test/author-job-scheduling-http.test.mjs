import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DIRECT_A = "MS4wLjABAAAAauthorJobRaceDirectA1234567890";
const DIRECT_B = "MS4wLjABAAAAauthorJobRaceDirectB1234567890";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function request(origin, path, { method = "GET", cookie, csrf, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json().catch(() => null) };
}

async function startServer({ port, dataDir, fakeChrome, fakePython, delayState, publicCalls, resolverState = null, fetchPreload = null, authorResolverMode = null }) {
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "test",
      DOUYIN_CHROME_PATH: fakeChrome,
      PYTHON_BIN: fakePython,
      FAKE_BROWSER_DELAY_STATE: delayState,
      FAKE_PUBLIC_CALLS: publicCalls,
      ...(authorResolverMode ? { DOUYIN_AUTHOR_RESOLVER_MODE: authorResolverMode } : {}),
      ...(resolverState ? { FAKE_RESOLVER_STATE: resolverState } : {}),
      ...(fetchPreload ? { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(fetchPreload).href}`.trim() } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return { child, origin, logs: () => logs }; } catch {}
    if (child.exitCode !== null) assert.fail(`server exited during startup: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`server did not start: ${logs}`);
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill("SIGTERM");
  await new Promise((resolve) => instance.child.once("exit", resolve));
}

async function localSession(instance) {
  const response = await request(instance.origin, "/api/auth/session");
  assert.equal(response.response.status, 200);
  assert.equal(response.payload.user.role, "admin");
  return { cookie: cookieFrom(response.response), csrf: response.payload.csrfToken };
}

async function submit(instance, session, body) {
  const response = await request(instance.origin, "/api/author-spreadsheet/auto-monitor", {
    method: "POST",
    cookie: session.cookie,
    csrf: session.csrf,
    body,
  });
  assert.equal(response.response.status, 202, JSON.stringify(response.payload));
  return response.payload;
}

async function readJob(instance, session, id) {
  const response = await request(instance.origin, `/api/author-spreadsheet/jobs/${id}`, { cookie: session.cookie });
  assert.equal(response.response.status, 200);
  return response.payload;
}

async function waitForJob(instance, session, id, acceptedStatuses, attempts = 200) {
  let job = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    job = await readJob(instance, session, id);
    if (acceptedStatuses.includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`job ${id} did not reach ${acceptedStatuses.join("/")}; last=${JSON.stringify(job)}; logs=${instance.logs()}`);
}

async function waitForFirstQueueRetry(instance, session, douyinId, attempts = 200) {
  let item = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await request(instance.origin, "/api/author-resolution-queue?status=all", { cookie: session.cookie });
    assert.equal(result.response.status, 200);
    item = result.payload.items.find((entry) => entry.douyinId === douyinId);
    if (item?.status === "retry") {
      assert.equal(item.attempts, 1, "each unresolved author must retry exactly once before its future backoff");
      assert.ok(Date.parse(item.nextAttemptAt) > Date.now(), "the automatic retry must enter a future backoff");
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`author ${douyinId} did not finish its first queued retry; last=${JSON.stringify(item)}; logs=${instance.logs()}`);
}

function evidenceJob(fileName, douyinId, videoId) {
  return {
    fileName,
    sheetName: "名单",
    rows: [{ sourceRow: 2, name: fileName.replace(/\.xlsx$/, ""), douyinId, videoId, status: "resolvable" }],
  };
}

function directJob(fileName, label, locator) {
  return {
    fileName,
    sheetName: "名单",
    rows: [{ sourceRow: 2, name: label, platform: "douyin", locator, status: "ready" }],
  };
}

test("author job scheduling survives active workers, timer replacement, burst submissions and graceful restart", { timeout: 25_000 }, async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-author-job-race-"));
  const dataDir = join(tempDir, "data");
  const fakeChrome = join(tempDir, "fake-chrome.mjs");
  const fakePython = join(tempDir, "fake-public-resolver.mjs");
  const delayState = join(tempDir, "browser-delay.txt");
  const publicCalls = join(tempDir, "public-calls.jsonl");
  const restartEntered = `${publicCalls}.restart-entered`;
  const restartRelease = `${publicCalls}.restart-release`;
  await writeFile(fakeChrome, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const delay = Number(readFileSync(process.env.FAKE_BROWSER_DELAY_STATE, "utf8")) || 10;
setTimeout(() => process.exit(1), delay);
`);
  await writeFile(fakePython, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const payload = JSON.parse(source || "{}");
if (!Array.isArray(payload.items)) {
  console.log(JSON.stringify({ ok: false, error: "隔离测试不采集账号数据" }));
  process.exit(0);
}
// Hold the real signed-only transport, not the unused browser fixture. The
// marker proves the old attempt is waiting before its external-call log.
if (payload.items.some((item) => item.douyinId === "race-restart")) {
  const release = process.env.FAKE_PUBLIC_CALLS + ".restart-release";
  if (!existsSync(release)) {
    writeFileSync(process.env.FAKE_PUBLIC_CALLS + ".restart-entered", "entered");
    while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
appendFileSync(process.env.FAKE_PUBLIC_CALLS, JSON.stringify(payload.items || []) + "\\n");
console.log(JSON.stringify({ ok: true, data: { items: (payload.items || []).map((item) => ({
  key: item.key, candidates: [], errors: [{ error: "隔离测试临时公开读取失败" }]
})) } }));
`);
  await chmod(fakeChrome, 0o755);
  await chmod(fakePython, 0o755);
  await writeFile(delayState, "700");

  const port = await freePort();
  let instance = await startServer({ port, dataDir, fakeChrome, fakePython, delayState, publicCalls, authorResolverMode: "signed-only" });
  t.after(async () => {
    await stopServer(instance);
    await new Promise((resolve) => setTimeout(resolve, 800));
    await rm(tempDir, { recursive: true, force: true });
  });
  let session = await localSession(instance);

  await new Promise((resolve) => setTimeout(resolve, 400));
  const slow = await submit(instance, session, evidenceJob("慢任务.xlsx", "race-slow", "7679000000000000001"));
  const running = await waitForJob(instance, session, slow.id, ["running"]);
  assert.equal(running.phase, "resolving", "a submission must replace the existing 30-second idle timer");

  const directA = await submit(instance, session, directJob("连续A.xlsx", "连续任务A", DIRECT_A));
  const directB = await submit(instance, session, directJob("连续B.xlsx", "连续任务B", DIRECT_B));
  const completed = await Promise.all([
    waitForJob(instance, session, slow.id, ["completed", "failed"]),
    waitForJob(instance, session, directA.id, ["completed", "failed"]),
    waitForJob(instance, session, directB.id, ["completed", "failed"]),
  ]);
  assert.ok(completed.every((job) => job.status === "completed"), completed.map((job) => job.error).join("; "));
  assert.deepEqual(completed.map((job) => job.result.createdCount), [0, 1, 1]);
  const afterBurst = await request(instance.origin, "/api/bootstrap", { cookie: session.cookie });
  assert.deepEqual(afterBurst.payload.targets.map((target) => target.label).sort(), ["连续任务A", "连续任务B"]);
  const burstQueue = await request(instance.origin, "/api/author-resolution-queue?status=all", { cookie: session.cookie });
  assert.equal(burstQueue.payload.summary.total, 1);

  // Failed immediate evidence resolution deliberately schedules a queue retry.
  // Await that state instead of assuming the next phase beats its 1-second timer.
  await waitForFirstQueueRetry(instance, session, "race-slow");

  await writeFile(delayState, "1200");
  const restart = await submit(instance, session, evidenceJob("重启任务.xlsx", "race-restart", "7679000000000000002"));
  await waitForJob(instance, session, restart.id, ["running"]);
  let reachedBarrier = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { reachedBarrier = (await readFile(restartEntered, "utf8")) === "entered"; } catch {}
    if (reachedBarrier) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(reachedBarrier, true, "the old signed resolver must enter its controlled barrier before SIGTERM");
  const beforeShutdownCalls = (await readFile(publicCalls, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(beforeShutdownCalls.map((items) => items[0].douyinId), ["race-slow", "race-slow"], "the held restart attempt must not call the upstream resolver before shutdown");
  const blockingSocket = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "POST /api/author-spreadsheet/auto-monitor HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        `Origin: ${instance.origin}`,
        `Cookie: ${session.cookie}`,
        `X-CSRF-Token: ${session.csrf}`,
        "Content-Type: application/json",
        "Content-Length: 1000",
        "Connection: keep-alive",
        "",
        "{",
      ].join("\r\n"));
      resolve(socket);
    });
  });
  instance.child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  assert.equal(instance.child.exitCode, null, "the incomplete authenticated request must keep graceful shutdown open for the lease-race assertion");

  const readOnly = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  const handedOff = readOnly.prepare("SELECT status,phase,lease_owner,lease_until,version FROM author_resolution_jobs WHERE id=?").get(restart.id);
  readOnly.close();
  assert.equal(handedOff.status, "queued");
  assert.equal(handedOff.phase, "queued");
  assert.equal(handedOff.lease_owner, null);
  assert.equal(handedOff.lease_until, null);
  assert.equal(handedOff.version, 1);
  blockingSocket.destroy();
  await new Promise((resolve) => instance.child.once("exit", resolve));

  await writeFile(delayState, "10");
  await writeFile(restartRelease, "release");
  instance = await startServer({ port, dataDir, fakeChrome, fakePython, delayState, publicCalls, authorResolverMode: "signed-only" });
  session = await localSession(instance);
  const resumed = await waitForJob(instance, session, restart.id, ["completed", "failed"]);
  assert.equal(resumed.status, "completed", resumed.error || instance.logs());
  assert.equal(resumed.result.createdCount, 0);
  assert.equal(resumed.result.queuedAuthors, 1);
  await waitForFirstQueueRetry(instance, session, "race-restart");

  const finalBootstrap = await request(instance.origin, "/api/bootstrap", { cookie: session.cookie });
  assert.equal(finalBootstrap.payload.targets.length, 2, "recovery must not duplicate previously committed targets");
  const finalQueue = await request(instance.origin, "/api/author-resolution-queue?status=all", { cookie: session.cookie });
  assert.equal(finalQueue.payload.summary.total, 2);

  const finalReadOnly = new DatabaseSync(join(dataDir, "douyin-monitor.sqlite"), { readOnly: true });
  const jobCounts = finalReadOnly.prepare("SELECT status,COUNT(*) AS count FROM author_resolution_jobs GROUP BY status").all();
  const restartRow = finalReadOnly.prepare("SELECT status,version FROM author_resolution_jobs WHERE id=?").get(restart.id);
  const completionActivities = finalReadOnly.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='authors.auto-monitor.complete'").get().count;
  finalReadOnly.close();
  assert.deepEqual(jobCounts.map((row) => ({ ...row })), [{ status: "completed", count: 4 }]);
  assert.deepEqual({ ...restartRow }, { status: "completed", version: 2 });
  assert.equal(completionActivities, 4, "each accepted job must publish completion exactly once");

  const resolverCalls = (await readFile(publicCalls, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(resolverCalls.length, 4, JSON.stringify(resolverCalls));
  assert.ok(resolverCalls.every((items) => items.length === 1), "each immediate or queued resolution has exactly one expected author");
  assert.deepEqual(resolverCalls.map((items) => items[0].douyinId), ["race-slow", "race-slow", "race-restart", "race-restart"]);
});

test("account plus work ownership mismatch never writes a target, including after queued retry", { timeout: 15_000 }, async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "douyin-monitor-owner-gate-"));
  const dataDir = join(tempDir, "data");
  const fakeChrome = join(tempDir, "fake-chrome.mjs");
  const fakePython = join(tempDir, "fake-owner-resolver.mjs");
  const delayState = join(tempDir, "browser-delay.txt");
  const publicCalls = join(tempDir, "public-calls.jsonl");
  const resolverState = join(tempDir, "resolver-state.json");
  const fetchPreload = join(tempDir, "fake-bilibili-fetch.mjs");
  const bilibiliState = join(tempDir, "bilibili-state.txt");
  const submittedImmediate = "MS4wLjABAAAAownerGateImmediate1234567890";
  const submittedQueued = "MS4wLjABAAAAownerGateQueued123456789012345";
  const otherOwner = "MS4wLjABAAAAownerGateOther1234567890123456";
  await writeFile(fakeChrome, "#!/usr/bin/env node\nprocess.exit(1);\n");
  await writeFile(fakePython, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const payload = JSON.parse(source || "{}");
const statePath = process.env.FAKE_RESOLVER_STATE;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const items = (payload.items || []).map((item) => {
  const count = Number(state[item.key] || 0);
  state[item.key] = count + 1;
  const queued = String(item.key).includes("ownerGateQueued");
  if (queued && count === 0) return { key: item.key, candidates: [], errors: [{ error: "隔离测试临时公开读取失败" }] };
  return { key: item.key, candidates: [{
    videoId: item.videoIds?.[0], secUid: ${JSON.stringify(otherOwner)}, nickname: "其他发布者", uniqueId: "other-owner"
  }], errors: [] };
});
writeFileSync(statePath, JSON.stringify(state));
console.log(JSON.stringify({ ok: true, data: { items } }));
`);
  await chmod(fakeChrome, 0o755);
  await chmod(fakePython, 0o755);
  await writeFile(delayState, "0");
  await writeFile(resolverState, "{}");
  await writeFile(bilibiliState, "0");
  await writeFile(fetchPreload, `
import { readFileSync, writeFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "api.bilibili.com" || url.pathname !== "/x/web-interface/view") return originalFetch(input, init);
  const statePath = ${JSON.stringify(bilibiliState)};
  const count = Number(readFileSync(statePath, "utf8")) || 0;
  writeFileSync(statePath, String(count + 1));
  if (count === 0) throw new Error("隔离测试 B站公开接口临时失败");
  const bvid = url.searchParams.get("bvid");
  return new Response(JSON.stringify({ code: 0, data: { bvid, owner: { mid: 222222, name: "其他B站发布者" } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`);
  const port = await freePort();
  const instance = await startServer({ port, dataDir, fakeChrome, fakePython, delayState, publicCalls, resolverState, fetchPreload });
  t.after(async () => {
    await stopServer(instance);
    await rm(tempDir, { recursive: true, force: true });
  });
  const session = await localSession(instance);

  const immediate = await submit(instance, session, {
    fileName: "即时不一致.xlsx",
    sheetName: "作者名单",
    rows: [{ sourceRow: 2, platform: "douyin", locator: submittedImmediate, videoId: "7679000000000000011", status: "resolvable" }],
  });
  const immediateDone = await waitForJob(instance, session, immediate.id, ["completed", "failed"]);
  assert.equal(immediateDone.status, "completed", immediateDone.error || instance.logs());
  assert.equal(immediateDone.result.createdCount, 0);
  assert.equal(immediateDone.result.queuedAuthors, 0);
  assert.match(immediateDone.result.skipped[0].reason, /不一致.*拒绝/);
  assert.equal(immediateDone.result.skipped[0].status, "unresolved");
  assert.equal(immediateDone.result.skipped[0].locator, submittedImmediate);
  assert.equal(immediateDone.result.skipped[0].videoId, "7679000000000000011");

  const queued = await submit(instance, session, {
    fileName: "后台不一致.xlsx",
    sheetName: "作者名单",
    rows: [{ sourceRow: 3, platform: "douyin", locator: submittedQueued, videoId: "7679000000000000022", status: "resolvable" }],
  });
  const queuedDone = await waitForJob(instance, session, queued.id, ["completed", "failed"]);
  assert.equal(queuedDone.status, "completed", queuedDone.error || instance.logs());
  assert.equal(queuedDone.result.createdCount, 0);
  assert.equal(queuedDone.result.queuedAuthors, 1);

  let queue = null;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    queue = await request(instance.origin, "/api/author-resolution-queue?status=all", { cookie: session.cookie });
    const item = queue.payload.items.find((entry) => entry.accountLocator === submittedQueued);
    if (item?.status === "rejected") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const queuedItem = queue.payload.items.find((entry) => entry.accountLocator === submittedQueued);
  assert.equal(queuedItem.status, "rejected");
  assert.match(queuedItem.lastError, /不一致.*拒绝/);

  const bilibili = await submit(instance, session, {
    fileName: "B站后台不一致.xlsx",
    sheetName: "作者名单",
    rows: [{ sourceRow: 4, platform: "bilibili", locator: "111111", bilibiliId: "111111", videoId: "BV1xx411c7mD", status: "resolvable" }],
  });
  const bilibiliDone = await waitForJob(instance, session, bilibili.id, ["completed", "failed"]);
  assert.equal(bilibiliDone.status, "completed", bilibiliDone.error || instance.logs());
  assert.equal(bilibiliDone.result.createdCount, 0);
  assert.equal(bilibiliDone.result.queuedAuthors, 1);
  for (let attempt = 0; attempt < 250; attempt += 1) {
    queue = await request(instance.origin, "/api/author-resolution-queue?status=all", { cookie: session.cookie });
    const item = queue.payload.items.find((entry) => entry.accountLocator === "111111");
    if (item?.status === "rejected") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const bilibiliItem = queue.payload.items.find((entry) => entry.accountLocator === "111111");
  assert.equal(bilibiliItem.status, "rejected");
  assert.match(bilibiliItem.lastError, /不一致.*拒绝/);

  const conflict = await submit(instance, session, {
    fileName: "身份冲突.xlsx",
    sheetName: "作者名单",
    rows: [{
      sourceRow: 5,
      platform: "douyin",
      name: "冲突作者",
      locator: submittedImmediate,
      douyinId: "submitted-id",
      contentId: "7679000000000000033",
      videoId: "7679000000000000033",
      videoLink: "https://www.douyin.com/video/7679000000000000044",
      shareUrl: "https://www.douyin.com/video/7679000000000000044",
      board: "杨齐家切片矩阵",
      organization: "冲突机构",
      status: "identity_conflict",
      identityConflict: "sec_uid 与主页中的 sec_uid 不一致",
      reason: "身份冲突：sec_uid 与主页中的 sec_uid 不一致；已阻止该行进入自动核验和监控，请核对后重传",
    }],
  });
  const conflictDone = await waitForJob(instance, session, conflict.id, ["completed", "failed"]);
  assert.equal(conflictDone.status, "completed", conflictDone.error || instance.logs());
  assert.equal(conflictDone.result.createdCount, 0);
  assert.equal(conflictDone.result.queuedAuthors, 0);
  assert.deepEqual({
    status: conflictDone.result.skipped[0].status,
    platform: conflictDone.result.skipped[0].platform,
    locator: conflictDone.result.skipped[0].locator,
    contentId: conflictDone.result.skipped[0].contentId,
    videoId: conflictDone.result.skipped[0].videoId,
    board: conflictDone.result.skipped[0].board,
  }, {
    status: "identity_conflict",
    platform: "douyin",
    locator: submittedImmediate,
    contentId: "7679000000000000033",
    videoId: "7679000000000000033",
    board: "杨齐家切片矩阵",
  });
  assert.match(conflictDone.result.skipped[0].reason, /身份冲突/);
  const bootstrap = await request(instance.origin, "/api/bootstrap", { cookie: session.cookie });
  assert.equal(bootstrap.payload.targets.length, 0, "即时与后台 owner 不一致都不得产生监控目标");
});
