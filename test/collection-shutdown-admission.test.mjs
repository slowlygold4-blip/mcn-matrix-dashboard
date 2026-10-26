import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function beginHeldPost({ port, path, body, cookie, csrfToken }) {
  let resolveResponse, rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const request = httpRequest({
    host: "127.0.0.1", port, path, method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Cookie: cookie,
      Origin: `http://127.0.0.1:${port}`,
      "X-CSRF-Token": csrfToken,
    },
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  request.once("error", rejectResponse);
  request.flushHeaders();
  return { request, response };
}

test("late account and topic sync bodies arriving after SIGTERM drain cannot enqueue runs", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "collection-shutdown-admission-"));
  const databasePath = join(directory, "douyin-monitor.sqlite");
  const database = new MonitorDatabase(databasePath);
  database.setSettings({ scheduleTime: "23:59" });
  const target = database.createTarget({ type: "account", provider: "manual", label: "延迟请求测试", locator: "manual://late-body" });
  database.createTarget({ type: "hashtag", provider: "manual", label: "#延迟话题请求测试", locator: "#延迟话题请求测试" });
  database.close();

  const port = await reservePort();
  let logs = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "test", DATA_DIR: directory, HOST: "127.0.0.1", PORT: String(port),
      DOUYIN_ACCOUNT_BROWSER_FALLBACK: "false", DOUYIN_TOPIC_RESOLVER_MODE: "public" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });

  let authResponse;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/session`);
      if (response.status === 200) { authResponse = response; break; }
    } catch {}
    if (child.exitCode !== null) break;
    await delay(20);
  }
  assert.ok(authResponse, logs);
  const owner = await authResponse.json();
  const cookie = authResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const heldSync = beginHeldPost({ port, path: "/api/sync", body: JSON.stringify({ targetId: target.id }), cookie, csrfToken: owner.csrfToken });
  const heldTopics = beginHeldPost({ port, path: "/api/topics/sync", body: "{}", cookie, csrfToken: owner.csrfToken });
  await delay(80); // allow both requests to authenticate and block in readJson()
  child.kill("SIGTERM");
  await delay(100); // let drain complete before the delayed request body is released
  heldSync.request.end(JSON.stringify({ targetId: target.id }));
  heldTopics.request.end("{}");

  const results = await Promise.all([heldSync.response, heldTopics.response]);
  for (const result of results) {
    assert.equal(result.status, 503, result.body);
    assert.equal(JSON.parse(result.body).code, "SERVER_SHUTTING_DOWN");
  }
  const exit = await exited;
  assert.equal(exit.code, 0, logs);

  const reopened = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0,
      "the late account and topic requests must be rejected without creating even a manual run");
  } finally { reopened.close(); }
});
