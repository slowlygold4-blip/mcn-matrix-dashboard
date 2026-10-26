import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, chmod, access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MonitorDatabase } from "../lib/database.mjs";

test("HTTP server SIGTERM settles an in-flight collection and receipt before closing SQLite", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-shutdown-checkpoint-"));
  const path = join(directory, "douyin-monitor.sqlite");
  const database = new MonitorDatabase(path);
  database.createTarget({ type: "account", provider: "public-web", label: "offline", locator: "MS4wLjABofflineShutdown" });
  database.close();
  const marker = join(directory, "inflight.marker");
  const fakePython = join(directory, "fake-python.mjs");
  await writeFile(fakePython, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const operation = process.argv[process.argv.indexOf('--operation') + 1];
if (operation === 'selftest') {
  process.stdout.write(JSON.stringify({ok:true,data:{profileEndpoint:true}}));
} else {
  writeFileSync(${JSON.stringify(marker)}, operation);
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
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  let inflight = false;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { await access(marker); inflight = true; break; } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(inflight, true, logs);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, true);
  child.kill("SIGTERM");
  const exit = await exited;
  assert.equal(exit.code, 0, logs);
  const reopened = new DatabaseSync(path, { readOnly: true });
  try {
    const run = reopened.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();
    assert.equal(run.status, "interrupted", logs);
    assert.equal(run.error_count, 0); assert.equal(run.processed_count, 0);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM audits").get().n, 0);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM snapshots").get().n, 0);
    const receipt = JSON.parse(await readFile(join(directory, "ingestion-reviews", `run-${run.id}.json`), "utf8"));
    assert.equal(receipt.runStatus, "interrupted"); assert.equal(receipt.snapshotCount, 0);
    assert.equal(receipt.unattemptedCount, 1);
    assert.doesNotMatch(logs, /database is not open|database.*closed/i);
  } finally { reopened.close(); }
});
