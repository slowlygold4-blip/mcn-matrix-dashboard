#!/usr/bin/env node
/** Offline Linux deployment metadata check. Never imports the application,
 * opens SQLite, reads credentials, starts a process, or makes a request. */
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILES = ["package-lock.json", "scripts/douyin_public_collector.py",
  "vendor/f2/abogus.py", "vendor/f2/__init__.py",
  "vendor/gmssl/sm3.py", "vendor/gmssl/func.py", "vendor/gmssl/__init__.py"];
const PACKAGES = ["@e965/xlsx", "exceljs", "playwright-core"];
const REMAINING_ACCEPTANCE = [
  "由监督器落实单实例与先停后启；本检查不扫描进程、不提供跨进程锁，也不能证明没有第二实例。",
  "确认持久磁盘/挂载生命周期、空间、SQLite WAL 锁与一致性备份恢复；权限检查未写探针文件。",
  "在目标 Linux 上另行验证二进制版本、Node SQLite/worker、Chrome 系统库和沙箱及正常关停；存在/可执行不代表运行成功。",
  "经用户授权落实主机、域名、TLS、受信反代与访问控制，再验匿名拒绝、角色权限、CSRF 和外网登录；不是部署成功。",
  "由服务用户正常完成飞书及可选抖音专用授权；只验文件元数据不能证明会话有效，不复制个人 Cookie。",
  "验同机 poller 的首次恢复、24 小时检查与北京时间 02/10/18 时段回执；离线检查未请求任何来源。",
  "完成异地备份与隔离恢复演练；本机备份不能代替异地容灾。",
];

function defaultDependencies(projectDir) {
  const require = createRequire(join(projectDir, "package.json"));
  return { platform: process.platform, nodeVersion: process.versions.node, uid: process.getuid?.(), homeDirectory: homedir(),
    stat: statSync, lstat: lstatSync, realpath: realpathSync, access: accessSync, resolveModule: name => require.resolve(name) };
}

function executable(command, pathValue, deps) {
  if (!command || typeof command !== "string" || command.includes("\0")) return false;
  // A relative configured binary or PATH entry depends on cwd and is unsafe for
  // a service. Do not search the filesystem, invoke a shell, or run --version.
  const candidates = isAbsolute(command) ? [command] : command.includes("/") ? []
    : String(pathValue || "").split(":").filter(isAbsolute).map(dir => join(dir, command));
  return candidates.some(path => {
    try { if (!deps.stat(path).isFile()) return false; deps.access(path, constants.X_OK); return true; }
    catch { return false; }
  });
}

function isVolatile(path) {
  return ["/tmp", "/var/tmp", "/run", "/dev/shm"].some(root => path === root || path.startsWith(`${root}/`));
}

function privateSession(path, deps) {
  if (!isAbsolute(path)) return false;
  try {
    const stat = deps.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== deps.uid || (stat.mode & 0o077) !== 0) return false;
    deps.access(path, constants.R_OK);
    return true;
  } catch { return false; }
}

/** All filesystem and module lookups are injectable. env is consulted only for
 * named, non-secret deployment settings; no .env/state contents are read. */
export function inspectDeployment(options = {}, injected = {}) {
  const projectDir = options.projectDir || PROJECT_DIR;
  const deps = { ...defaultDependencies(projectDir), ...injected };
  const env = options.env || process.env;
  const dataDir = options.dataDir ?? env.DATA_DIR ?? join(projectDir, "data");
  const checks = [];
  const add = (id, passed, success, failure) => checks.push({ id, status: passed ? "pass" : "fail", message: passed ? success : failure });
  add("platform", deps.platform === "linux", "Linux 平台。", "该预检面向 Linux；macOS launchd 安装器不是 Linux 部署方案。");
  const version = /^(?:v)?(\d+)\.\d+\.\d+(?:\+[\w.-]+)?$/.exec(String(deps.nodeVersion));
  add("node", Boolean(version && Number(version[1]) >= 24), "当前 Node 版本满足 >=24；未启动 SQLite/worker。", "当前 Node 必须为 24 或更高正式兼容版本。");
  add("service-user", Number.isInteger(deps.uid) && deps.uid > 0, "当前为非 root 服务用户。", "请以最终非 root 服务用户检查，权限结论不能由 root 代替。");

  let realData = null;
  let directoryReady = false;
  if (typeof dataDir === "string" && isAbsolute(dataDir) && resolve(dataDir) !== "/") {
    try {
      realData = deps.realpath(dataDir);
      const stat = deps.stat(dataDir);
      directoryReady = stat.isDirectory() && stat.uid === deps.uid && (stat.mode & 0o022) === 0;
      if (directoryReady) deps.access(dataDir, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch { directoryReady = false; }
  }
  add("data-directory", directoryReady, "DATA_DIR 已存在、归当前用户且权限允许读写/遍历；未实际写入。", "DATA_DIR 须为已存在的绝对目录，归服务用户、不可被组/其他用户写入，并具备读写/遍历权限。");
  add("data-persistence", Boolean(directoryReady && realData && !isVolatile(realData) && options.persistentData === true),
    "已声明使用持久卷，且真实路径不在已知临时目录；挂载持久性仍需人工验证。", "须确认 --persistent-data；临时目录或未就绪目录不能作持久卷，容器层/挂载生命周期需人工核对。");
  add("single-instance", options.instances === 1, "部署计划声明 1 个主服务；这是声明，不是运行进程计数或全局锁。", "须显式声明 --instances 1；禁止多副本及新旧实例重叠调度。");

  const pathValue = env.PATH || "";
  for (const [id, command, label] of [["python", env.PYTHON_BIN || "/usr/bin/python3", "Python3（PYTHON_BIN，默认 /usr/bin/python3）"],
    ["curl", "curl", "PATH 中的 curl"], ["sqlite-cli", "/usr/bin/sqlite3", "固定 /usr/bin/sqlite3"], ["procps", "/bin/ps", "固定 /bin/ps（Linux 通常由 procps 提供）"]]) {
    add(id, executable(command, pathValue, deps), `${label} 存在且可执行；未启动或验证版本。`, `${label} 不存在、不是文件或不可执行；本工具不安装依赖。`);
  }
  const larkCandidates = env.LARK_CLI_BIN ? [env.LARK_CLI_BIN] : [join(deps.homeDirectory, ".local", "bin", "lark-cli"), "lark-cli", "/usr/local/bin/lark-cli", "/usr/bin/lark-cli"];
  add("lark-cli", larkCandidates.some(command => executable(command, pathValue, deps)), "来源 poller 的 lark-cli 存在且可执行；未读取或验证授权。", "来源 poller 缺少可执行 lark-cli；显式设置 LARK_CLI_BIN 并另行完成服务用户授权。");

  const missingFiles = SOURCE_FILES.filter(file => {
    try { const path = join(projectDir, file); if (!deps.stat(path).isFile()) return true; deps.access(path, constants.R_OK); return false; }
    catch { return true; }
  });
  add("source-files", !missingFiles.length, "锁文件、匿名采集脚本及受审 vendor 文件存在且可读；未执行。", `缺失/不可读：${missingFiles.join("、")}；请完整交付已审代码，不下载陌生替代实现。`);
  const missingPackages = PACKAGES.filter(name => { try { return !deps.resolveModule(name); } catch { return true; } });
  add("node-packages", !missingPackages.length, "三个现有 Node 依赖可解析；未导入或验证包版本/完整性。", `依赖不可解析：${missingPackages.join("、")}；目标机应在授权后按锁文件安装，预检不会自动安装。`);

  const host = env.HOST || "0.0.0.0";
  const port = Number(env.PORT || 4188);
  const validPort = Number.isInteger(port) && port > 0 && port <= 65535;
  add("listen-address", ["127.0.0.1", "::1"].includes(host) && validPort, "服务计划仅绑定 loopback；未检测端口占用或启动监听。", "此 Linux 公网部署基线要求 HOST=127.0.0.1 或 ::1 及合法 PORT；不能直接暴露业务端口。");
  let localPoller = false;
  try {
    const url = new URL(env.SOURCE_POLL_BASE_URL || "http://127.0.0.1:4188");
    const expectedHost = host === "::1" ? "[::1]" : host;
    localPoller = ["127.0.0.1", "::1"].includes(host) && validPort && url.protocol === "http:"
      && url.hostname === expectedHost && Number(url.port || 80) === port && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  } catch { /* Do not echo URLs: malformed input can contain credentials. */ }
  add("poller-url", localPoller, "来源 poller 使用同端口、同地址族的字面量 loopback HTTP 根地址。", "SOURCE_POLL_BASE_URL 须与服务 loopback 地址及 PORT 一致，无账号、路径、查询或片段；不能改成公网/容器 DNS。");
  add("poller-topology", options.pollerSameHost === true, "已声明 poller 与服务在同网络命名空间；未证明实际拓扑。", "须确认 --poller-same-host：poller 与主服务共享网络命名空间及同一绝对 DATA_DIR。");

  const accountBrowser = ["1", "true", "browser", "browser-fallback"].includes(String(env.DOUYIN_ACCOUNT_BROWSER_FALLBACK || "off").toLowerCase());
  const topicBrowser = ["browser", "browser-first"].includes(env.DOUYIN_TOPIC_RESOLVER_MODE);
  const authorBrowser = env.DOUYIN_AUTHOR_RESOLVER_MODE === "browser-first";
  if (accountBrowser || topicBrowser || authorBrowser) {
    add("browser", executable(env.DOUYIN_CHROME_PATH, pathValue, deps) && isAbsolute(env.DOUYIN_CHROME_PATH || ""),
      "显式 Linux Chrome 路径可执行；未启动、未测试系统库/沙箱。", "已启用浏览器路径，必须设置可执行的绝对 DOUYIN_CHROME_PATH；macOS 默认路径不适用。");
    const topicState = env.DOUYIN_TOPIC_BROWSER_STATE || join(dataDir, "douyin-topic-browser-state.json");
    const accountState = env.DOUYIN_ACCOUNT_BROWSER_STATE || topicState;
    for (const [enabled, id, path] of [[topicBrowser, "topic-session", topicState], [accountBrowser, "account-session", accountState]]) {
      if (!enabled) continue;
      add(id, privateSession(path, deps), "专用授权文件为当前用户私有可读普通文件；仅查元数据，未读内容或验证登录。", "专用授权文件须为绝对路径、非符号链接、归当前用户且仅本人可读（建议 0600）；缺失/权限不符需管理员处理。");
    }
  } else checks.push({ id: "browser", status: "skip", message: "未启用浏览器链路，不要求 Chrome，也不检查任何会话文件。" });

  return { scope: "offline-metadata-only", offlineReady: checks.every(item => item.status !== "fail"), deploymentVerified: false,
    checks, remainingAcceptance: [...REMAINING_ACCEPTANCE] };
}

export function parsePreflightArgs(args) {
  const result = {};
  const flags = { "--json": "json", "--help": "help", "--persistent-data": "persistentData", "--poller-same-host": "pollerSameHost" };
  const values = { "--data-dir": "dataDir", "--instances": "instances" };
  for (let i = 0; i < args.length; i++) {
    const key = Object.hasOwn(flags, args[i]) ? flags[args[i]] : Object.hasOwn(values, args[i]) ? values[args[i]] : null;
    if (!key || Object.hasOwn(result, key)) throw new Error("未知或重复选项；使用 --help 查看允许参数。");
    if (flags[args[i]]) { result[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("选项缺少参数；未执行检查。");
    if (key === "instances") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("实例数必须为非负整数。");
      result[key] = Number(value);
    } else result[key] = value;
  }
  return result;
}

export function formatPreflight(result) {
  return [result.offlineReady ? "离线元数据门槛通过；不是部署成功。" : "离线部署预检未通过；未作任何修改。",
    ...result.checks.map(item => `[${item.status.toUpperCase()}] ${item.id}: ${item.message}`),
    "仍需完成：", ...result.remainingAcceptance.map(text => `- ${text}`)].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parsePreflightArgs(process.argv.slice(2));
    if (options.help) console.log("只读离线预检（不读 .env/凭据内容、不启动二进制、不联网/安装）\nnode scripts/deployment-preflight.mjs [--data-dir /absolute/path] [--instances 1] [--persistent-data] [--poller-same-host] [--json]\n请以最终服务用户运行；环境设置由监督器显式注入。声明并不能证明部署完成，详见 docs/deployment-linux.md。");
    else {
      const result = inspectDeployment(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatPreflight(result));
      process.exitCode = result.offlineReady ? 0 : 1;
    }
  } catch { console.error("预检参数或元数据检查失败；未输出输入或异常原文，请使用 --help。"); process.exitCode = 2; }
}
