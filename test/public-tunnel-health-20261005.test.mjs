import test from "node:test";
import assert from "node:assert/strict";
import { gateFailurePolicy, pendingGateEntry, publicGateIsReady } from "../scripts/public-tunnel.mjs";

const tunnelUrl = "https://example.trycloudflare.com";

test("the probe uses direct curl only for the anonymous Quick Tunnel gate", async () => {
  let received;
  const ready = await publicGateIsReady(tunnelUrl, async (...args) => {
    received = args;
    return { stdout: '{"authenticated":false}\n200' };
  });

  assert.equal(ready, true);
  assert.equal(received[0], "/usr/bin/curl");
  assert.deepEqual(received[1].slice(0, 2), ["--noproxy", "*"]);
  assert.deepEqual(received[1].slice(2, 7), ["--fail", "--silent", "--show-error", "--max-time", "10"]);
  assert.equal(received[1].includes("--location"), false);
  const writeOutIndex = received[1].indexOf("--write-out");
  assert.ok(writeOutIndex >= 0);
  assert.equal(received[1][writeOutIndex + 1], "\\n%{http_code}");
  assert.equal(received[1].at(-1), `${tunnelUrl}/api/auth/session`);
  assert.deepEqual(received[2], { timeout: 12_000, maxBuffer: 32_000 });
});

test("only HTTP 200 with an exact unauthenticated JSON response verifies the gate", async () => {
  const output = (body, status) => ({ stdout: `${body}\n${status}` });
  assert.equal(await publicGateIsReady(tunnelUrl, async () => output('{"authenticated":false}', 200)), true);
  assert.equal(await publicGateIsReady(tunnelUrl, async () => output('{"authenticated":false}', 302)), false);
  assert.equal(await publicGateIsReady(tunnelUrl, async () => output('{"authenticated":false}', 401)), false);
  assert.equal(await publicGateIsReady(tunnelUrl, async () => output('{"authenticated":false}', 403)), false);
  assert.equal(await publicGateIsReady(tunnelUrl, async () => output('{"authenticated":true}', 200)), false);
  assert.equal(await publicGateIsReady(tunnelUrl, async () => output("<html>Cloudflare challenge</html>", 403)), false);
  await assert.rejects(publicGateIsReady(tunnelUrl, async () => {
    throw new Error("HTTP 403 or transport failure");
  }), /HTTP 403 or transport failure/);
});

test("missing or malformed curl status output is never considered verified", async () => {
  for (const stdout of [
    '{"authenticated":false}',
    '{"authenticated":false}\n20',
    '{"authenticated":false}200',
    '{"authenticated":false}\n200\nextra',
    '{"authenticated":false}\n200 trailing',
    '{"authenticated":false}\n200extra',
  ]) {
    assert.equal(await publicGateIsReady(tunnelUrl, async () => ({ stdout })), false, JSON.stringify(stdout));
  }
  assert.equal(await publicGateIsReady(tunnelUrl, async () => ({ stdout: null })), false);
});

test("invalid or non-Quick-Tunnel origins are never probed", async () => {
  let called = false;
  const runner = async () => { called = true; return { stdout: '{"authenticated":false}' }; };
  assert.equal(await publicGateIsReady("https://example.com", runner), false);
  assert.equal(await publicGateIsReady("http://example.trycloudflare.com", runner), false);
  assert.equal(await publicGateIsReady("https://user@example.trycloudflare.com", runner), false);
  assert.equal(called, false);
});

test("connector registration remains pending until the anonymous gate is verified", () => {
  assert.deepEqual(pendingGateEntry(), {
    status: "starting",
    error: "隧道已连接，正在验证匿名访问门禁",
  });
});

test("failed gate probes never terminate a registered connector", () => {
  const fakeConnector = { alive: true, terminations: 0 };
  for (let failures = 1; failures <= 30; failures += 1) {
    const policy = gateFailurePolicy({ gateVerified: false, failures });
    if (policy.terminateTunnel) {
      fakeConnector.alive = false;
      fakeConnector.terminations += 1;
    }
    assert.equal(policy.refreshHeartbeat, false);
  }
  assert.equal(fakeConnector.alive, true);
  assert.equal(fakeConnector.terminations, 0);
});

test("previously verified entry is not renewed by failures and ages to reconnecting state", () => {
  const transient = gateFailurePolicy({ gateVerified: true, failures: 11 });
  assert.deepEqual(transient, { status: "running", refreshHeartbeat: false, terminateTunnel: false });
  const expired = gateFailurePolicy({ gateVerified: true, failures: 12 });
  assert.deepEqual(expired, { status: "reconnecting", refreshHeartbeat: false, terminateTunnel: false });
});
