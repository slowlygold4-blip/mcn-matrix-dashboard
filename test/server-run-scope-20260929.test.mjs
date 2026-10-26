import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("HTTP collection scope: scheduled account A cannot impersonate manual B or topic collection", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-http-scope-"));
  const databasePath = join(directory, "douyin-monitor.sqlite");
  const database = new MonitorDatabase(databasePath);
  // listTargets orders newest first: establish A as the scheduled in-flight row.
  const targetB = database.createTarget({ type: "account", provider: "public-web", label: "offline-B", locator: "MS4wLjABofflineScopeBBBB" });
  await pause(3);
  const targetA = database.createTarget({ type: "account", provider: "public-web", label: "offline-A", locator: "MS4wLjABofflineScopeAAAA" });
  const topic = database.createTarget({ type: "hashtag", provider: "public-web", label: "offline-topic", locator: "offline-topic", enabled: false });
  database.close();
  const marker = join(directory, "inflight.json");
  const fakePython = join(directory, "fake-python.mjs");
  await writeFile(fakePython, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const operation = process.argv[process.argv.indexOf('--operation') + 1];
if (operation === 'selftest') {
  process.stdout.write(JSON.stringify({ok:true,data:{profileEndpoint:true}}));
} else {
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({operation,locator:process.argv[process.argv.indexOf('--locator')+1]}));
  setInterval(() => {}, 1000);
}
`);
  await chmod(fakePython, 0o700);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", DATA_DIR: directory, HOST: "127.0.0.1", PORT: String(port),
      PYTHON_BIN: fakePython, DOUYIN_ACCOUNT_BROWSER_FALLBACK: "false", DOUYIN_TOPIC_RESOLVER_MODE: "public" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
    await exited; clearTimeout(force);
    await rm(directory, { recursive: true, force: true });
  });
  let inflight;
  for (let attempt = 0; attempt < 250; attempt++) {
    try { inflight = JSON.parse(await readFile(marker, "utf8")); break; } catch {}
    if (child.exitCode !== null) break;
    await pause(20);
  }
  assert.equal(inflight?.operation, "account", logs);
  assert.equal(inflight?.locator, targetA.locator, "the automatic run must actually be hanging on A");
  const origin = `http://127.0.0.1:${port}`;
  const sessionResponse = await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(2000) });
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true); assert.equal(session.localOwner, true);
  const cookie = sessionResponse.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  assert.ok(cookie); assert.ok(session.csrfToken);
  const headers = { cookie, origin, "content-type": "application/json", "x-csrf-token": session.csrfToken };
  // Make topic scope nonempty only after A is in flight. This is a legitimate
  // isolated owner edit, not a fake collector result or a direct DB mutation.
  const enabledTopic = await fetch(`${origin}/api/targets/${topic.id}`, { method: "PATCH", headers,
    body: JSON.stringify({ enabled: true }), signal: AbortSignal.timeout(2000) });
  assert.equal(enabledTopic.status, 200); await enabledTopic.json();
  const cases = [
    { name: "manual B conflicts with scheduled A", path: "/api/sync", body: { targetId: targetB.id }, status: 409, code: "COLLECTION_SCOPE_CONFLICT" },
    { name: "manual topics conflicts with scheduled accounts", path: "/api/topics/sync", body: {}, status: 409, code: "COLLECTION_SCOPE_CONFLICT" },
    ...[null, [], "bad", {}, { scope: "all" }, { targetId: targetB.id, scope: "all" },
      { targetId: targetB.id, force: true }, { targetId: true }, { targetId: false }, { targetId: 0 },
      { targetId: -1 }, { targetId: 1.5 }, { targetId: "1x" }, { targetId: [] }, { targetId: {} },
      { targetId: Number.MAX_SAFE_INTEGER + 1 }].map(body => ({ name: `invalid account body ${JSON.stringify(body)}`,
      path: "/api/sync", body, status: 400 })),
    ...[null, [], "bad", { scope: "all" }, { targetId: targetB.id }, { force: true }].map(body => ({
      name: `invalid topic body ${JSON.stringify(body)}`, path: "/api/topics/sync", body, status: 400 })),
  ];
  const results = await Promise.all(cases.map(async entry => {
    try {
      const response = await fetch(`${origin}${entry.path}`, { method: "POST", headers,
        body: JSON.stringify(entry.body), signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      return { status: response.status, code: body.code, runId: body.runId };
    } catch { return { status: "no-response-within-budget" }; }
  }));
  // Abort only the test-owned process; its original run must settle as interrupted.
  child.kill("SIGTERM");
  const exit = await exited;
  assert.equal(exit.code, 0, logs);
  for (let index = 0; index < cases.length; index++) {
    await t.test(cases[index].name, () => {
      assert.equal(results[index].status, cases[index].status);
      if (cases[index].code) assert.equal(results[index].code, cases[index].code);
      assert.equal(results[index].runId, undefined, "a rejected request must not receive another scope's run");
    });
  }
  await t.test("conflicts and invalid bodies create neither false-success activity nor extra runs", () => {
    const saved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const runs = saved.prepare("SELECT trigger_type,status,processed_count FROM runs ORDER BY id").all();
      assert.equal(runs.length, 1); assert.equal(runs[0].trigger_type, "scheduled");
      assert.equal(runs[0].status, "interrupted"); assert.equal(runs[0].processed_count, 0);
      assert.equal(saved.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('sync.run','topics.sync')").get().n, 0);
      assert.equal(saved.prepare("SELECT COUNT(*) AS n FROM audits").get().n, 0);
      assert.equal(saved.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n, 0);
    } finally { saved.close(); }
  });
});
