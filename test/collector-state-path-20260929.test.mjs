import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBrowserWorks } from "../scripts/douyin_browser_collector.mjs";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const stateName = "douyin-topic-browser-state.json";
const defaultState = resolve(projectDir, "data", stateName);
const envKeys = ["DOUYIN_ACCOUNT_BROWSER_STATE", "DOUYIN_TOPIC_BROWSER_STATE", "DATA_DIR"];
const input = { items: [{ key: "path-only", secUid: "MS4wLjABAAAAabcdefghijklmnopqrstuvwx", limit: 30 }] };

// Exercise collectBrowserWorks -> real readAuthorisedState. Only filesystem
// boundaries are replaced: no credential content, browser or network is read.
async function observePath(t, env, { mode = 0o100644, missing = false } = {}) {
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    if (Object.hasOwn(env, key)) process.env[key] = env[key];
    else delete process.env[key];
  }
  t.after(() => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  const paths = []; let reads = 0, writes = 0, accesses = 0, launches = 0;
  t.mock.method(fs, "stat", async path => {
    paths.push(path);
    if (missing) throw new Error("fixture missing");
    return { mode };
  });
  t.mock.method(fs, "readFile", async () => { reads++; throw new Error("fixture unreadable; no real content accessed"); });
  t.mock.method(fs, "chmod", async () => { writes++; throw new Error("permission repair must not occur"); });
  syncBuiltinESMExports();
  await assert.rejects(collectBrowserWorks(input, { runtime: {
    access: async () => { accesses++; throw new Error("must stop before executable check"); },
    launch: async () => { launches++; throw new Error("must never launch"); },
  } }), missing ? /未配置抖音浏览器会话/ : mode & 0o077 ? /会话文件权限过宽/ : /会话文件不可读取/);
  assert.equal(writes, 0); assert.equal(accesses, 0); assert.equal(launches, 0);
  assert.equal(reads, !missing && !(mode & 0o077) ? 1 : 0);
  assert.equal(paths.length, 1);
  return paths[0];
}

const cases = [
  ["unset uses project data", {}, defaultState],
  ["empty values use project data", { DOUYIN_ACCOUNT_BROWSER_STATE: "", DOUYIN_TOPIC_BROWSER_STATE: "", DATA_DIR: "" }, defaultState],
  ["absolute DATA_DIR", { DATA_DIR: "/fixture/custom-data" }, `/fixture/custom-data/${stateName}`],
  ["relative DATA_DIR resolves from cwd", { DATA_DIR: "fixture/custom-data" }, resolve("fixture/custom-data", stateName)],
  ["dot DATA_DIR", { DATA_DIR: "." }, resolve(stateName)],
  ["DATA_DIR with spaces is preserved", { DATA_DIR: "fixture/custom data" }, resolve("fixture/custom data", stateName)],
  ["absolute account override wins", { DOUYIN_ACCOUNT_BROWSER_STATE: "/fixture/account.json", DOUYIN_TOPIC_BROWSER_STATE: "/fixture/topic.json", DATA_DIR: "/fixture/data" }, "/fixture/account.json"],
  ["relative account override wins", { DOUYIN_ACCOUNT_BROWSER_STATE: "fixture/account.json", DOUYIN_TOPIC_BROWSER_STATE: "/fixture/topic.json", DATA_DIR: "/fixture/data" }, resolve("fixture/account.json")],
  ["empty account falls to topic", { DOUYIN_ACCOUNT_BROWSER_STATE: "", DOUYIN_TOPIC_BROWSER_STATE: "/fixture/topic.json", DATA_DIR: "/fixture/data" }, "/fixture/topic.json"],
  ["relative topic overrides DATA_DIR", { DOUYIN_TOPIC_BROWSER_STATE: "fixture/topic.json", DATA_DIR: "/fixture/data" }, resolve("fixture/topic.json")],
  ["empty overrides fall to DATA_DIR", { DOUYIN_ACCOUNT_BROWSER_STATE: "", DOUYIN_TOPIC_BROWSER_STATE: "", DATA_DIR: "/fixture/data" }, `/fixture/data/${stateName}`],
];
for (const [name, env, expected] of cases) {
  test(`collector state path: ${name}`, async t => assert.equal(await observePath(t, env), expected));
}

test("collector state path: group and other permission guards reject before content access", async t => {
  for (const mode of [0o100640, 0o100604, 0o100666]) {
    await t.test(`mode ${mode.toString(8)}`, async child => {
      assert.equal(await observePath(child, { DATA_DIR: "/fixture/permissions" }, { mode }), `/fixture/permissions/${stateName}`);
    });
  }
});

test("collector state path: 0600 retains the existing unreadable-state guard", async t => {
  assert.equal(await observePath(t, { DATA_DIR: "/fixture/private" }, { mode: 0o100600 }), `/fixture/private/${stateName}`);
});

test("collector state path: missing configured state never falls back to a different session", async t => {
  assert.equal(await observePath(t, { DOUYIN_ACCOUNT_BROWSER_STATE: "/fixture/missing-account.json", DOUYIN_TOPIC_BROWSER_STATE: "/fixture/topic.json" }, { missing: true }), "/fixture/missing-account.json");
});
