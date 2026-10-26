import assert from "node:assert/strict";
import test from "node:test";
import { identityProxyEnvironment, validatedIdentityProxyUrl } from "../lib/identity-proxy.mjs";
import { PublicWebProvider } from "../lib/providers/public-web.mjs";

const SETTING = "DOUYIN_IDENTITY_PROXY_URL";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

function setFixtureProxy(t, value) {
  const original = process.env[SETTING];
  if (value === undefined) delete process.env[SETTING];
  else process.env[SETTING] = value;
  t.after(() => {
    if (original === undefined) delete process.env[SETTING];
    else process.env[SETTING] = original;
  });
}

function mockProvider() {
  const calls = [];
  const provider = new PublicWebProvider({}, {
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, JSON.stringify({ ok: true, data: { fixture: true } }), "");
    },
  });
  return { calls, provider };
}

test("only canonical local credential-free HTTP proxy URLs and valid ports are accepted", () => {
  for (const absent of [undefined, null, ""]) assert.equal(validatedIdentityProxyUrl(absent), null);
  for (const [input, expected] of [
    ["http://127.0.0.1:16780", "http://127.0.0.1:16780"],
    ["http://localhost:16780/", "http://localhost:16780"],
    ["http://127.0.0.1:1", "http://127.0.0.1:1"],
    ["http://localhost:65535", "http://localhost:65535"],
  ]) assert.equal(validatedIdentityProxyUrl(input), expected);
});

test("invalid proxy settings fail with a generic message that never exposes the supplied value", () => {
  for (const value of [
    "http://name:do-not-print-secret@localhost:16780", "http://localhost:16780?token=[REDACTED]",
    "http://localhost:16780/#do-not-print-secret", "http://localhost:16780/private",
    "https://127.0.0.1:16780", "socks5://127.0.0.1:16780", "http://example.com:16780",
    "http://localhost.example.com:16780", "http://127.1:16780", "http://2130706433:16780",
    "http://0x7f000001:16780", "http://[::1]:16780", "http://localhost:0", "http://localhost:65536",
    "http://localhost:016780", "http://localhost:", "http://localhost", "http://localhost:16780//",
    " http://localhost:16780", "http://localhost:16780\n", " ", 16780, {},
  ]) {
    assert.throws(() => validatedIdentityProxyUrl(value), (error) => {
      assert.equal(error.code, "INVALID_IDENTITY_PROXY_CONFIG");
      assert.equal(error.message.includes("do-not-print-secret"), false);
      assert.equal(error.message.includes("http://"), false);
      return true;
    });
  }
});

test("unconfigured proxy leaves inherited environment behavior unchanged", () => {
  for (const value of [undefined, ""]) {
    const environment = Object.freeze({ [SETTING]: value, HTTP_PROXY: "existing-setting", NO_PROXY: "existing-bypass" });
    assert.equal(identityProxyEnvironment(environment), undefined);
    assert.equal(environment.HTTP_PROXY, "existing-setting");
  }
});

test("configured proxy creates a separate child environment and overrides only proxy routing keys", () => {
  const environment = Object.freeze({ [SETTING]: "http://localhost:16780/", PATH: "/fixture/bin", FIXTURE: "retained",
    HTTP_PROXY: "old-http", https_proxy: "old-https", ALL_PROXY: "old-all", NO_PROXY: "*", no_proxy: "douyin.com" });
  const before = JSON.stringify(environment);
  const globalBefore = { ...process.env };
  const child = identityProxyEnvironment(environment);
  assert.notEqual(child, environment);
  for (const key of PROXY_KEYS) assert.equal(child[key], "http://localhost:16780");
  assert.equal(child.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(child.no_proxy, child.NO_PROXY);
  assert.equal(child.PATH, environment.PATH);
  assert.equal(child.FIXTURE, "retained");
  assert.equal(JSON.stringify(environment), before);
  assert.deepEqual({ ...process.env }, globalBefore);
});

test("provider injects the explicit setting only into identity-work and never global or other operation environments", async (t) => {
  setFixtureProxy(t, "http://127.0.0.1:16780");
  const before = { ...process.env };
  const { provider, calls } = mockProvider();
  for (const operation of ["account", "bilibili-account", "hot", "resolve-authors", "identity-work"]) {
    await provider.run(operation, ["--locator", "fixture"]);
    const call = calls.at(-1);
    assert.equal(call.args[call.args.indexOf("--operation") + 1], operation);
    if (operation === "identity-work") {
      assert.equal(call.options.env.HTTPS_PROXY, "http://127.0.0.1:16780");
      assert.notEqual(call.options.env, process.env);
    } else assert.equal(Object.hasOwn(call.options, "env"), false);
  }
  assert.deepEqual({ ...process.env }, before);
});

test("provider retains ordinary environment inheritance for an unconfigured identity request", async (t) => {
  setFixtureProxy(t, undefined);
  const { provider, calls } = mockProvider();
  await provider.run("identity-work");
  assert.equal(Object.hasOwn(calls[0].options, "env"), false);
});

test("invalid explicit proxy rejects before spawning identity-work, without blocking unrelated collectors", async (t) => {
  setFixtureProxy(t, "http://name:do-not-print-secret@localhost:16780");
  const before = { ...process.env };
  const { provider, calls } = mockProvider();
  await assert.rejects(provider.run("identity-work"), (error) => {
    assert.equal(error.code, "INVALID_IDENTITY_PROXY_CONFIG");
    assert.equal(error.message.includes("do-not-print-secret"), false);
    return true;
  });
  assert.equal(calls.length, 0);
  for (const operation of ["account", "bilibili-account", "hot", "resolve-authors"]) await provider.run(operation);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(Object.hasOwn(call.options, "env"), false);
  assert.deepEqual({ ...process.env }, before);
});
