import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tunnelLogEvent, writePublicEntry } from "../lib/public-entry.mjs";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const dataDir = process.env.DATA_DIR || join(projectDir, "data");
const cloudflared = process.env.CLOUDFLARED_BIN || join(homedir(), ".local", "bin", "cloudflared");
let stopping = false;
let child = null;
let cancelBackoff = null;
const execFileAsync = promisify(execFile);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  // launchd owns the log descriptor; writing it again would duplicate output.
  process.stdout.write(line);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); cancelBackoff = null; resolve(); }
    cancelBackoff = done;
  });
}

export async function publicGateIsReady(value, runCurl = execFileAsync) {
  // Probe only a Quick Tunnel host emitted by cloudflared. In this install the
  // inherited curl proxy points at an unavailable loopback port; --noproxy is
  // scoped to this public health request and does not change system settings.
  let origin;
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash
      || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(url.hostname)) return false;
    origin = url.origin;
  } catch {
    return false;
  }
  const { stdout } = await runCurl("/usr/bin/curl", [
    "--noproxy", "*", "--fail", "--silent", "--show-error", "--max-time", "10",
    "--write-out", "\\n%{http_code}", `${origin}/api/auth/session`,
  ], { timeout: 12_000, maxBuffer: 32_000 });
  if (typeof stdout !== "string") return false;
  const statusLine = /(?:^|\r?\n)(\d{3})\r?\n?$/.exec(stdout);
  if (!statusLine || Number(statusLine[1]) !== 200) return false;
  const body = stdout.slice(0, statusLine.index);
  try { return JSON.parse(body)?.authenticated === false; }
  catch { return false; }
}

export function gateFailurePolicy({ gateVerified, failures }) {
  // A failed HTTP gate probe cannot prove the tunnel connector is broken.
  // Let the verified public-entry lease expire; only cloudflared process exit
  // should cause a reconnect.
  return {
    status: gateVerified && failures < 12 ? "running" : "reconnecting",
    refreshHeartbeat: false,
    terminateTunnel: false,
  };
}

export function pendingGateEntry() {
  return { status: "starting", error: "隧道已连接，正在验证匿名访问门禁" };
}

function writeState(status, url = null, extra = {}) {
  writePublicEntry(dataDir, { status, url, updatedAt: new Date().toISOString(), pid: process.pid, ...extra });
}

function startTunnel() {
  return new Promise((resolve) => {
    writeState("starting");
    if (!existsSync(cloudflared)) {
      writeState("error", null, { error: `找不到 cloudflared：${cloudflared}` });
      log(`找不到 cloudflared：${cloudflared}`);
      resolve({ code: 127, url: null });
      return;
    }
    const command = ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4188"];
    child = spawn(cloudflared, command, { env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const processChild = child;
    let url = null, connected = false, registered = false, gateVerified = false, finished = false, checking = false, failures = 0;
    const check = async () => {
      if (checking || finished || stopping || !url || !connected) return;
      checking = true;
      try {
        // Probe only the anonymous authentication gate, without credentials.
        if (!await publicGateIsReady(url)) throw new Error("公网认证入口未就绪");
        if (finished || stopping) return;
        if (!gateVerified) log(`公网入口已通过连通与访问保护检查：${url}`);
        gateVerified = true; failures = 0;
        writeState("running", url);
      } catch (error) {
        if (finished || stopping) return;
        failures += 1;
        log(`公网探测失败（第 ${failures} 次）：${error?.message || "未知错误"}`);
        const policy = gateFailurePolicy({ gateVerified, failures });
        if (policy.status === "running") {
          log("公网探测暂未通过，保留已注册入口但不续期");
        } else if (failures === 1 || failures === 12) {
          writeState("reconnecting", null, { error: "公网检查暂未通过；隧道仍保持运行，入口等待验证" });
        }
      } finally { checking = false; }
    };
    const consume = () => {
      let buffer = "";
      return (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = tunnelLogEvent(line);
        if (event.url && !url) url = event.url;
        if (event.connected) connected = true;
        if (line.trim()) log(`cloudflared ${line.trim()}`);
        if (connected && url && !registered && !finished && !stopping) {
          // Registration proves a connector exists, not that the anonymous
          // authentication gate is reachable. Keep the URL out of the
          // verified entry until the exact gate response is observed.
          registered = true;
          const pending = pendingGateEntry();
          writeState(pending.status, url, { error: pending.error });
          log(`公网隧道已注册，访问保护待验证：${url}`);
        }
        if (event.url || event.connected) void check();
      }
      };
    };
    processChild.stdout.on("data", consume());
    processChild.stderr.on("data", consume());
    const heartbeat = setInterval(check, 15_000);
    const startupTimeout = setTimeout(() => { if (!registered) processChild.kill("SIGTERM"); }, 240_000);
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(startupTimeout);
      child = null;
      writeState(stopping ? "stopped" : "error", null, { error: reason });
      log(reason);
      resolve({ ready: gateVerified, registered });
    };
    processChild.once("error", (error) => finish(`公网入口启动失败：${error.message}`));
    processChild.once("close", (code, signal) => finish(`公网入口已退出：${signal || code || 0}`));
  });
}

async function main() {
  let attempt = 0;
  while (!stopping) {
    const result = await startTunnel();
    if (stopping) break;
    attempt = result.ready ? 1 : attempt + 1;
    const backoff = Math.min(30_000, Math.max(1_000, 2_000 * 2 ** Math.min(attempt - 1, 4)));
    log(`第 ${attempt} 次重连将在 ${Math.round(backoff / 1000)} 秒后进行`);
    await sleep(backoff);
  }
  writeState("stopped", null);
}

function stop() {
  stopping = true;
  cancelBackoff?.();
  if (child) child.kill("SIGTERM");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(dataDir, { recursive: true });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  main().catch((error) => { log(`监督器异常：${error.message}`); process.exitCode = 1; });
}
