import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDeployment, parsePreflightArgs, formatPreflight } from "../scripts/deployment-preflight.mjs";

function fixture() {
  const files = new Map();
  const calls = [];
  const meta = (kind, mode = 0o700, uid = 1000) => ({ mode, uid,
    isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link" });
  files.set("/srv/mcn/data", meta("dir"));
  for (const path of ["/usr/bin/python3", "/usr/bin/curl", "/usr/bin/sqlite3", "/bin/ps", "/usr/bin/lark-cli", "/usr/bin/chrome"]) files.set(path, meta("file", 0o755, 0));
  for (const path of ["package-lock.json", "scripts/douyin_public_collector.py", "vendor/evil0ctal/xbogus.py", "vendor/f2/abogus.py", "vendor/f2/__init__.py", "vendor/gmssl/sm3.py", "vendor/gmssl/func.py", "vendor/gmssl/__init__.py"]) files.set(`/srv/mcn/${path}`, meta("file", 0o644));
  const deps = {
    platform: "linux", nodeVersion: "24.16.0", uid: 1000, homeDirectory: "/home/mcn",
    stat(path) { calls.push(["stat", path]); if (!files.has(path)) throw new Error("missing SECRET"); return files.get(path); },
    lstat(path) { calls.push(["lstat", path]); if (!files.has(path)) throw new Error("missing SECRET"); return files.get(path); },
    realpath(path) { calls.push(["realpath", path]); return path; },
    access(path, mode) { calls.push(["access", path, mode]); if (!files.has(path)) throw new Error("no SECRET"); },
    resolveModule(name) { calls.push(["module", name]); return `/srv/mcn/node_modules/${name}/index.js`; },
  };
  const options = { projectDir: "/srv/mcn", dataDir: "/srv/mcn/data", instances: 1, persistentData: true, pollerSameHost: true,
    env: { HOST: "127.0.0.1", PORT: "4188", PATH: "/usr/bin:/bin", LARK_CLI_BIN: "/usr/bin/lark-cli" } };
  return { deps, options, files, calls, meta, run(extra = {}) { return inspectDeployment({ ...options, ...extra }, deps); } };
}
const check = (result, id) => result.checks.find(item => item.id === id);

test("complete offline metadata fixture never claims deployment or runtime verification", () => {
  const f = fixture(); const result = f.run();
  assert.equal(result.offlineReady, true);
  assert.equal(result.deploymentVerified, false);
  assert.equal(result.scope, "offline-metadata-only");
  assert.ok(result.remainingAcceptance.some(text => text.includes("授权")));
  assert.ok(result.remainingAcceptance.some(text => text.includes("单实例")));
  assert.match(formatPreflight(result), /不是部署成功/);
  assert.ok(f.calls.every(([kind]) => ["stat", "lstat", "realpath", "access", "module"].includes(kind)));
  assert.ok(!f.calls.some(([, path]) => /\.env|state\.json|cookie/.test(path)));
});

test("Linux and Node 24+ are required, and root is rejected", () => {
  for (const [key, value, id] of [["platform", "darwin", "platform"], ["nodeVersion", "22.9.0", "node"], ["nodeVersion", "24.0.0-rc.1", "node"], ["nodeVersion", "garbage", "node"], ["uid", 0, "service-user"]]) {
    const f = fixture(); f.deps[key] = value;
    assert.equal(check(f.run(), id).status, "fail");
  }
  const f = fixture();
  for (const version of ["26.0.0", "24.16.0+build.1"]) { f.deps.nodeVersion = version; assert.equal(check(f.run(), "node").status, "pass"); }
});

test("missing declarations cannot default to deployment readiness", () => {
  const f = fixture(); const result = f.run({ instances: undefined, persistentData: false, pollerSameHost: false });
  for (const id of ["single-instance", "data-persistence", "poller-topology"]) assert.equal(check(result, id).status, "fail");
  for (const instances of [0, 2, -1, "1", 1.5]) assert.equal(check(f.run({ instances }), "single-instance").status, "fail");
});

test("data directory must be absolute, existing, private, and accessible without creating a probe", () => {
  const f = fixture();
  for (const dataDir of ["data", "/missing"]) assert.equal(check(f.run({ dataDir }), "data-directory").status, "fail");
  f.files.set("/srv/mcn/data", f.meta("file")); assert.equal(check(f.run(), "data-directory").status, "fail");
  f.files.set("/srv/mcn/data", f.meta("dir", 0o777)); assert.equal(check(f.run(), "data-directory").status, "fail");
  f.files.set("/srv/mcn/data", f.meta("dir"));
  f.deps.access = (path, mode) => { if (mode & constants.W_OK) throw new Error("readonly SECRET"); };
  const result = f.run(); assert.equal(check(result, "data-directory").status, "fail");
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("real temporary directories cannot be called persistent by assertion or symlink", () => {
  const f = fixture(); f.deps.realpath = () => "/tmp/mcn";
  assert.equal(check(f.run(), "data-persistence").status, "fail");
  f.deps.realpath = () => "/var/tmp/mcn"; assert.equal(check(f.run(), "data-persistence").status, "fail");
  f.deps.realpath = () => "/srv/tmp-named-volume"; assert.equal(check(f.run(), "data-persistence").status, "pass");
});

test("fixed sqlite3 and ps locations must exist even if PATH has alternatives", () => {
  for (const [path, id] of [["/usr/bin/python3", "python"], ["/usr/bin/curl", "curl"], ["/usr/bin/sqlite3", "sqlite-cli"], ["/bin/ps", "procps"], ["/usr/bin/lark-cli", "lark-cli"]]) {
    const f = fixture(); f.files.delete(path); assert.equal(check(f.run(), id).status, "fail");
  }
});

test("executables are inspected, not launched, and relative PATH directories are not trusted", () => {
  const f = fixture(); f.files.set("/usr/bin/python3", f.meta("dir"));
  assert.equal(check(f.run(), "python").status, "fail");
  const env = { ...f.options.env, PYTHON_BIN: "./python3", PATH: ".:relative", LARK_CLI_BIN: "./lark-cli" };
  const result = f.run({ env });
  for (const id of ["python", "curl", "lark-cli"]) assert.equal(check(result, id).status, "fail");
  assert.ok(!f.calls.some(([, path]) => path.startsWith("relative/")));
});

test("lockfile, vendored files and installed package resolution are required", () => {
  const f = fixture(); f.files.delete("/srv/mcn/vendor/gmssl/sm3.py");
  assert.equal(check(f.run(), "source-files").status, "fail");
  assert.match(check(f.run(), "source-files").message, /vendor\/gmssl\/sm3\.py/);
  f.deps.resolveModule = () => { throw new Error("missing SECRET"); };
  const result = f.run(); assert.equal(check(result, "node-packages").status, "fail");
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("poller requires literal loopback HTTP, matching port/family, no credentials, query or path", () => {
  const f = fixture();
  for (const value of ["http://remote:4188", "http://localhost:4188", "https://127.0.0.1:4188", "http://user:SECRET@127.0.0.1:4188", "http://127.0.0.1:4189", "http://127.0.0.1:4188/api", "http://127.0.0.1:4188?token=[REDACTED]", "http://127.0.0.1:4188#SECRET", "http://[::1]:4188"]) {
    const result = f.run({ env: { ...f.options.env, SOURCE_POLL_BASE_URL: value } });
    assert.equal(check(result, "poller-url").status, "fail", value);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
  assert.equal(check(f.run({ env: { ...f.options.env, HOST: "::1", SOURCE_POLL_BASE_URL: "http://[::1]:4188" } }), "poller-url").status, "pass");
  assert.equal(check(f.run({ env: { ...f.options.env, HOST: "0.0.0.0" } }), "listen-address").status, "fail");
});

test("anonymous mode does not inspect sessions or require Chrome", () => {
  const f = fixture(); f.files.delete("/usr/bin/chrome");
  assert.equal(check(f.run(), "browser").status, "skip");
  assert.ok(!f.calls.some(([, path]) => path.includes("state.json")));
});

test("enabled browser requires actual executable and metadata-only private owner session", () => {
  const f = fixture(); const env = { ...f.options.env, DOUYIN_ACCOUNT_BROWSER_FALLBACK: "true", DOUYIN_CHROME_PATH: "/usr/bin/chrome" };
  const path = "/srv/mcn/data/douyin-topic-browser-state.json";
  assert.equal(check(f.run({ env }), "account-session").status, "fail");
  f.files.set(path, f.meta("file", 0o600)); assert.equal(f.run({ env }).offlineReady, true);
  for (const value of [f.meta("file", 0o644), f.meta("file", 0o600, 2000), f.meta("link", 0o600), f.meta("dir", 0o700)]) {
    f.files.set(path, value); assert.equal(check(f.run({ env }), "account-session").status, "fail");
  }
  f.files.set(path, f.meta("file", 0o400)); assert.equal(check(f.run({ env }), "account-session").status, "pass");
  assert.equal(check(f.run({ env: { ...env, DOUYIN_CHROME_PATH: "" } }), "browser").status, "fail");
  assert.equal(check(f.run({ env: { ...env, DOUYIN_ACCOUNT_BROWSER_STATE: "relative.json" } }), "account-session").status, "fail");
});

test("topic and account session overrides are checked independently; author diagnostic also needs Chrome", () => {
  const f = fixture(); f.files.set("/srv/mcn/topic.json", f.meta("file", 0o600));
  const env = { ...f.options.env, DOUYIN_TOPIC_RESOLVER_MODE: "browser-first", DOUYIN_ACCOUNT_BROWSER_FALLBACK: "1", DOUYIN_CHROME_PATH: "/usr/bin/chrome", DOUYIN_TOPIC_BROWSER_STATE: "/srv/mcn/topic.json", DOUYIN_ACCOUNT_BROWSER_STATE: "/srv/mcn/missing.json" };
  assert.equal(check(f.run({ env }), "topic-session").status, "pass");
  assert.equal(check(f.run({ env }), "account-session").status, "fail");
  assert.equal(check(f.run({ env: { ...f.options.env, DOUYIN_AUTHOR_RESOLVER_MODE: "browser-first" } }), "browser").status, "fail");
});

test("CLI accepts only scoped declarations and rejects unknown/duplicate/invalid options without echo", () => {
  assert.deepEqual(parsePreflightArgs(["--data-dir", "/srv/mcn/data", "--instances", "1", "--persistent-data", "--poller-same-host", "--json"]), { dataDir: "/srv/mcn/data", instances: 1, persistentData: true, pollerSameHost: true, json: true });
  for (const args of [["--instances"], ["--instances", "NaN"], ["--instances", "1.5"], ["--execute=SECRET"], ["toString"], ["__proto__"], ["--json", "--json"], ["--data-dir", "--json"]]) {
    assert.throws(() => parsePreflightArgs(args), error => !error.message.includes("SECRET"));
  }
});

test("only named deployment environment fields are read, never enumerated or serialized", () => {
  const f = fixture();
  const allowed = new Set(["DATA_DIR", "PATH", "PYTHON_BIN", "LARK_CLI_BIN", "HOST", "PORT", "SOURCE_POLL_BASE_URL",
    "DOUYIN_ACCOUNT_BROWSER_FALLBACK", "DOUYIN_TOPIC_RESOLVER_MODE", "DOUYIN_AUTHOR_RESOLVER_MODE"]);
  const env = new Proxy(f.options.env, { get(target, key) { assert.ok(allowed.has(key), String(key)); return target[key]; },
    ownKeys() { throw new Error("environment enumeration forbidden"); } });
  assert.equal(f.run({ env }).offlineReady, true);
});

test("real CLI only inspects an isolated directory, ignores .env and never echoes secret-like inputs", () => {
  const temp = mkdtempSync(join(tmpdir(), "mcn-preflight-test-"));
  try {
    writeFileSync(join(temp, ".env"), "DATA_DIR=/SHOULD_NOT_BE_LOADED\nSECRET=FIXTURE_SECRET\n", { mode: 0o600 });
    const before = readdirSync(temp);
    const script = fileURLToPath(new URL("../scripts/deployment-preflight.mjs", import.meta.url));
    const env = { PATH: "/usr/bin:/bin", DATA_DIR: temp, HOST: "127.0.0.1", PORT: "4188",
      PYTHON_BIN: "/missing/python3", LARK_CLI_BIN: "/missing/lark-cli", SECRET: "FIXTURE_SECRET",
      SOURCE_POLL_BASE_URL: "http://user:FIXTURE_SECRET@127.0.0.1:4188" };
    const result = spawnSync(process.execPath, [script, "--json"], { cwd: temp, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.offlineReady, false);
    assert.equal(report.deploymentVerified, false);
    assert.equal(check(report, "poller-url").status, "fail");
    assert.ok(!`${result.stdout}${result.stderr}`.includes("FIXTURE_SECRET"));
    assert.deepEqual(readdirSync(temp), before);
    const invalid = spawnSync(process.execPath, [script, "--FIXTURE_SECRET"], { cwd: temp, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(invalid.status, 2);
    assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes("FIXTURE_SECRET"));
    const help = spawnSync(process.execPath, [script, "--help"], { cwd: temp, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(help.status, 0); assert.match(help.stdout, /不联网/);
    assert.deepEqual(readdirSync(temp), before);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
