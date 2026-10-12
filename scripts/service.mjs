import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validatedIdentityProxyUrl } from "../lib/identity-proxy.mjs";
import { readServiceTransitionGate } from "../lib/service-transition-gate.mjs";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const label = "com.codex.douyin-monitor-workbench";
const agentPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const sourceLabel = `${label}.source-poller`;
const sourceAgentPath = join(homedir(), "Library", "LaunchAgents", `${sourceLabel}.plist`);
const tunnelLabel = `${label}.public-tunnel`;
const tunnelAgentPath = join(homedir(), "Library", "LaunchAgents", `${tunnelLabel}.plist`);
const dataDir = join(projectDir, "data");
const nodePath = process.execPath;
const launchServerPath = join(projectDir, "scripts", "launch-server.sh");
const uid = process.getuid();
const domain = `gui/${uid}`;

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plist() {
  // Use a fresh runtime log path. The historical service.log may carry an
  // inherited macOS ACL from an earlier launch agent and launchd refuses to
  // open that descriptor before spawning the process.
  const logPath = join(dataDir, "service-runtime.log");
  const previous = existsSync(agentPath)
    ? /<key>DOUYIN_IDENTITY_PROXY_URL<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(agentPath, "utf8"))?.[1]
    : null;
  const previousPublicBase = existsSync(agentPath)
    ? /<key>PUBLIC_BASE_URL<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(agentPath, "utf8"))?.[1]
    : null;
  const identityProxy = validatedIdentityProxyUrl(process.env.DOUYIN_IDENTITY_PROXY_URL ?? previous);
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL ?? previousPublicBase ?? "").trim().replace(/\/$/, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(nodePath)}</string><string>${xmlEscape(join(projectDir, "server.mjs"))}</string></array>
  <!-- launchd can be denied TCC access to ~/Documents as cwd. Code paths are
       resolved from import.meta.url; mutable state is anchored with DATA_DIR. -->
  <key>WorkingDirectory</key><string>/</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>EnvironmentVariables</key>
  <dict><key>HOST</key><string>0.0.0.0</string><key>PORT</key><string>4188</string><key>TZ</key><string>Asia/Shanghai</string><key>HOME</key><string>${xmlEscape(homedir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${xmlEscape(join(homedir(), ".local", "bin"))}</string><key>DATA_DIR</key><string>${xmlEscape(dataDir)}</string><key>DOUYIN_TOPIC_RESOLVER_MODE</key><string>browser-first</string><key>DOUYIN_ACCOUNT_BROWSER_FALLBACK</key><string>1</string><key>TRUST_PROXY</key><string>cloudflare</string>${identityProxy ? `<key>DOUYIN_IDENTITY_PROXY_URL</key><string>${xmlEscape(identityProxy)}</string>` : ""}${publicBaseUrl ? `<key>PUBLIC_BASE_URL</key><string>${xmlEscape(publicBaseUrl)}</string>` : ""}</dict>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function sourcePlist() {
  const logPath = join(dataDir, "source-poller.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${sourceLabel}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(nodePath)}</string><string>${xmlEscape(join(projectDir, "scripts", "source-poller.mjs"))}</string><string>--loop</string></array>
  <key>WorkingDirectory</key><string>/</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict><key>SOURCE_POLL_BASE_URL</key><string>http://127.0.0.1:4188</string><key>SOURCE_POLL_INTERVAL_MS</key><string>86400000</string><key>TZ</key><string>Asia/Shanghai</string><key>HOME</key><string>${xmlEscape(homedir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${xmlEscape(join(homedir(), ".local", "bin"))}</string><key>LARK_CLI_BIN</key><string>${xmlEscape(join(homedir(), ".local", "bin", "lark-cli"))}</string><key>DATA_DIR</key><string>${xmlEscape(dataDir)}</string></dict>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function tunnelPlist() {
  const logPath = join(dataDir, "public-tunnel.log");
  // The desktop runtime may reach the public internet through the user's
  // local proxy. launchd does not inherit the interactive shell environment,
  // so preserve only the standard proxy variables when installing the tunnel
  // agent; without them the tunnel can register but its hostname probe fails
  // with a misleading DNS error.
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
  const proxyXml = proxyKeys
    .filter((key) => process.env[key])
    .map((key) => `<key>${key}</key><string>${xmlEscape(process.env[key])}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${tunnelLabel}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(nodePath)}</string><string>${xmlEscape(join(projectDir, "scripts", "public-tunnel.mjs"))}</string></array>
  <key>WorkingDirectory</key><string>/</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>EnvironmentVariables</key>
  <dict><key>DATA_DIR</key><string>${xmlEscape(dataDir)}</string><key>CLOUDFLARED_BIN</key><string>${xmlEscape(join(homedir(), ".local", "bin", "cloudflared"))}</string><key>HOME</key><string>${xmlEscape(homedir())}</string><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${xmlEscape(join(homedir(), ".local", "bin"))}</string>${proxyXml}</dict>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, { ignoreError = false } = {}) {
  try { return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { if (ignoreError) return ""; throw new Error(error.stderr?.trim() || error.message); }
}

function install() {
  if (existsSync(agentPath) || existsSync(sourceAgentPath) || existsSync(tunnelAgentPath)) {
    const databasePath = join(dataDir, "douyin-monitor.sqlite");
    if (!existsSync(databasePath)) throw new Error("现有服务的数据文件不可读取，拒绝盲目重装；请先核对数据路径");
    const db = new DatabaseSync(databasePath, { readOnly: true });
    let gate;
    try { gate = readServiceTransitionGate(db); }
    finally { db.close(); }
    if (!gate.safe) throw new Error(`已有任务运行中，拒绝重装服务：运行采集 ${gate.runningRuns}、作者导入 ${gate.runningAuthorJobs}、作者核验租约 ${gate.activeAuthorLeases}`);
    if (existsSync(join(dataDir, "source-poll", ".poll.lock"))) {
      throw new Error("飞书来源检查正在执行或锁状态待核对，拒绝重装服务");
    }
  }
  mkdirSync(dirname(agentPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const configuration = plist();
  if (existsSync(agentPath)) runLaunchctl(["bootout", domain, agentPath], { ignoreError: true });
  if (existsSync(sourceAgentPath)) runLaunchctl(["bootout", domain, sourceAgentPath], { ignoreError: true });
  if (existsSync(tunnelAgentPath)) runLaunchctl(["bootout", domain, tunnelAgentPath], { ignoreError: true });
  writeFileSync(agentPath, configuration, { encoding: "utf8", mode: 0o600 });
  writeFileSync(sourceAgentPath, sourcePlist(), { encoding: "utf8", mode: 0o600 });
  writeFileSync(tunnelAgentPath, tunnelPlist(), { encoding: "utf8", mode: 0o600 });
  chmodSync(agentPath, 0o600);
  chmodSync(sourceAgentPath, 0o600);
  chmodSync(tunnelAgentPath, 0o600);
  runLaunchctl(["bootstrap", domain, agentPath]);
  runLaunchctl(["bootstrap", domain, sourceAgentPath]);
  runLaunchctl(["bootstrap", domain, tunnelAgentPath]);
  runLaunchctl(["enable", `${domain}/${label}`], { ignoreError: true });
  runLaunchctl(["enable", `${domain}/${sourceLabel}`], { ignoreError: true });
  runLaunchctl(["enable", `${domain}/${tunnelLabel}`], { ignoreError: true });
  runLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  // RunAtLoad starts the poller as part of bootstrap. Do not synchronously
  // kill/kick an existing poller here: it may be waiting on a slow public
  // source and launchctl would block this installer until that request ends.
  console.log(`已安装并启动：${label}`);
  console.log(`已安装并启动：${sourceLabel}（每日检查已导入飞书来源）`);
  console.log(`已安装并启动：${tunnelLabel}（公网入口自动重连；Quick Tunnel 地址可能变化）`);
  console.log("工作台地址：http://127.0.0.1:4188");
  console.log(`服务配置：${agentPath}`);
  console.log(`来源轮询配置：${sourceAgentPath}`);
}

function uninstall() {
  if (!existsSync(agentPath)) {
    console.log("服务尚未安装。");
    return;
  }
  runLaunchctl(["bootout", domain, agentPath], { ignoreError: true });
  if (existsSync(sourceAgentPath)) runLaunchctl(["bootout", domain, sourceAgentPath], { ignoreError: true });
  if (existsSync(tunnelAgentPath)) runLaunchctl(["bootout", domain, tunnelAgentPath], { ignoreError: true });
  console.log(`服务已停止。配置文件保留在 ${agentPath}；来源轮询配置保留在 ${sourceAgentPath}，公网入口配置保留在 ${tunnelAgentPath}，便于恢复。`);
}

function status() {
  const statuses = [[label, agentPath], [sourceLabel, sourceAgentPath], [tunnelLabel, tunnelAgentPath]].map(([serviceLabel, path]) => {
    const output = runLaunchctl(["print", `${domain}/${serviceLabel}`], { ignoreError: true });
    const state = output ? (/state = ([^\n]+)/.exec(output)?.[1]?.trim() || "unknown") : "未运行";
    const pid = output ? (/pid = (\d+)/.exec(output)?.[1] || "—") : "—";
    return { serviceLabel, path, output, state, pid };
  });
  for (const status of statuses) {
    console.log(`${status.serviceLabel}：${status.state}，PID：${status.pid}`);
    if (existsSync(status.path)) console.log(`配置文件：${status.path}（${readFileSync(status.path, "utf8").includes(projectDir) ? "路径有效" : "路径需更新"}）`);
  }
  if (statuses.some((status) => !status.output)) process.exitCode = 1;
}

const command = process.argv[2] || "status";
if (process.platform !== "darwin") throw new Error("后台服务安装脚本当前仅支持 macOS launchd");
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else throw new Error(`未知命令：${command}`);
