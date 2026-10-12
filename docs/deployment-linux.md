# Linux 单实例部署：离线预检与待验收清单

本文件是可执行的准备清单，**不是已经购买主机、部署上线或验证采集成功的证明**。新增预检不安装软件，不读 `.env`、Cookie、专用会话内容，不打开数据库，不导入 `server.mjs`，不启动任何二进制或网络请求。目标主机、域名、费用和授权方式仍需用户明确提供/授权。

## 1. 先确定实际运行形态

最低形态是：一个完整 Node.js 主服务、一个同机来源 poller、一个可持久保存 SQLite 和文件回执的数据目录。两个进程须共享网络命名空间和同一绝对 `DATA_DIR`。不要配置多副本、集群模式或新旧进程同时运行的滚动更新；调度器没有全局 leader 锁。关闭前端浏览器不是停服务，关机/睡眠则不能持续运行。

本项目使用 Node SQLite、worker、Python/curl 子进程和常驻计时器，不是静态站点。只发布前端、短时函数或不提供完整运行能力的环境，不能算完整部署。既有 `scripts/service.mjs` 仅用于 macOS launchd，不能在 Linux 上当作安装器执行。本轮不创建 Docker 空壳或自动写入服务单元。

## 2. 目标主机先由管理员准备

以下动作需要在获准的目标主机执行；预检不会代办，也没有在本轮执行：

| 项目 | 必需条件 |
|---|---|
| 服务身份 | 专用非 root 用户；以该用户执行预检与服务。root 下的权限可用不代表服务用户可用。 |
| Node | 完整 Node.js 24+，可用 `node:sqlite`、`worker_threads`、`child_process`；不能只有兼容 stub。 |
| 已审代码与依赖 | 完整交付代码、`package-lock.json`、`vendor/`；获准后按锁文件安装现有依赖。不要替换为陌生爬虫包。 |
| 系统命令 | `PYTHON_BIN`（默认 `/usr/bin/python3`）、PATH 中的 `curl`、**固定 `/usr/bin/sqlite3`**、**固定 `/bin/ps`**（常由 procps 提供）。仅在其他位置装 sqlite3/ps 不能满足当前实现。 |
| 飞书来源 | 服务用户可执行的 `lark-cli`，建议显式 `LARK_CLI_BIN`；正常用户授权另验，预检不查看安全存储。 |
| 持久目录 | 事先建立绝对路径，例如 `/var/lib/douyin-monitor`，归服务用户，建议 0700，不允许组/其他用户写入。确保足够空间、SQLite WAL/SHM 和文件回执可持久保存。 |
| 可选浏览器 | 仅启用授权话题、账号作品 fallback 或显式浏览器诊断时需要 Linux Chrome。设置绝对 `DOUYIN_CHROME_PATH`；`playwright-core` 不自带 Chrome。另验系统库和沙箱，不能以禁用保护替代正常运行。 |
| 专用会话 | 启用账号/话题浏览器链路时，由用户正常授权创建专用 state。归服务用户，仅本人可读（建议 0600）、非符号链接，所在目录亦应受控。不得从个人浏览器复制凭据、上传到代码仓库或静态网站。 |

不能在服务运行时只复制 `.sqlite` 主文件并视为一致性备份。使用已有在线备份与清单校验，恢复到新的隔离路径；来源 registry/manifest、导入和入库审查回执等数据库外文件也须分类保全。授权资料单独处理，不把整个 `data` 打包公开。

## 3. 执行离线预检

先把目标配置显式注入环境，再以最终服务用户运行。以下地址/路径仅是目标配置示例，不表示目标主机已存在；命令不会启动服务：

```sh
HOST=127.0.0.1 PORT=4188 \
DATA_DIR=/var/lib/douyin-monitor \
PYTHON_BIN=/usr/bin/python3 \
LARK_CLI_BIN=/usr/local/bin/lark-cli \
SOURCE_POLL_BASE_URL=http://127.0.0.1:4188 \
node scripts/deployment-preflight.mjs \
  --instances 1 --persistent-data --poller-same-host
```

加 `--json` 获取机器可读报告；`--data-dir /absolute/path` 只覆盖预检路径，**不会替服务配置 `DATA_DIR`**。`--help` 不执行检查。工具只读取明确列出的环境字段，不自动加载 `.env.example` 或 `.env`。

三个声明参数不能由工具代为确认：

- `--instances 1`：管理员确认监督器只计划一个主实例；工具不扫描进程，不证明已有实例数量，也不是锁。
- `--persistent-data`：管理员确认数据目录所在卷的生命周期；工具只拒绝已知临时路径并核对权限，不会写探针，不能识别所有临时容器层或证明断电持久性。
- `--poller-same-host`：管理员确认两个进程共享网络命名空间及同一绝对数据目录；只把 URL 写成 loopback 不能证明该拓扑。

默认不填这些声明会明确失败，不偷偷假设成立。poller URL 必须为与服务同端口/同地址族的字面量 loopback HTTP 根地址，不接受公网地址、容器 DNS、用户名/密码、路径、query 或 hash。本部署基线要求服务只绑定 loopback；默认 `HOST=0.0.0.0` 不符合这项公网隔离基线。端口更改时两个进程都必须同步。

浏览器开关沿用业务当前含义：`DOUYIN_TOPIC_RESOLVER_MODE=browser|browser-first`；`DOUYIN_ACCOUNT_BROWSER_FALLBACK=1|true|browser|browser-fallback`；诊断性的 `DOUYIN_AUTHOR_RESOLVER_MODE=browser-first`。没有开关时不要求 Chrome，也不检查会话文件。账号 state 优先 `DOUYIN_ACCOUNT_BROWSER_STATE`，否则复用 `DOUYIN_TOPIC_BROWSER_STATE`，最后使用 `DATA_DIR/douyin-topic-browser-state.json`。授权文件只查元数据和读权限，绝不解析或验证 Cookie。

退出码：`0` = 离线元数据与声明门槛通过；`1` = 检查发现缺口；`2` = 参数/检查异常。JSON 的 `deploymentVerified` **始终为 false**。二进制的存在/可执行检查不证明正确版本、CPU 架构、运行依赖或网络可用；包可解析也不等于版本/完整性已验证。不要把退出码 0 当部署、登录或平台采集成功。

## 4. 授权后才进行真正运行验收

监督器可选目标 Linux 已有的 systemd 等机制，但必须落实以下契约；本轮没有安装或启动这些服务：

1. 主服务使用确定的 Node 24+ 绝对路径、代码 WorkingDirectory 和 `node server.mjs`；`User` 为专用用户，环境显式注入。来源进程单独监督 `node scripts/source-poller.mjs --loop`，使用相同用户、数据路径和本地端口。不要使用 `node --watch`、多 worker 或多个调度实例。
2. 配置失败退避和正常 SIGTERM 关停；设置足够的停止时间让在途任务交接，核对旧进程退出后才启动新版本。不使用并行蓝绿/滚动部署来争抢同一数据库和调度计划。
3. 先在隔离恢复目录验备份清单、SHA、SQLite 完整性、业务行数及原始证据；启动/重启后验证 ready、worker、备份、队列恢复和调度状态。`/healthz` 仅代表 HTTP 进程存活，不能代替 `/api/system-audit` 的真实状态。
4. 飞书 CLI 与可选抖音专用会话由用户正常授权；登录/验证码不得绕过。真实采样另获批准后执行，并分别验主页、话题双指标、作品范围；迁移不等于解决平台限制，不能伪造漏采历史。
5. 跨正常时段核对北京时间 02:00/10:00/18:00 回执；来源默认 24 小时检查。轮询请求须走直连 loopback 的本地授权与 CSRF 合同，不能擅自把内部身份改成公网匿名管理员。
6. 给业务端口加网络隔离。固定域名、DNS、TLS、反向代理信任与管理员引导尚须明确设计/验收；仅设置合法 HTTPS `PUBLIC_BASE_URL` 只代表 configured/unverified，不建立公网入口。普通代理不能随意把 Host 改成 localhost 并丢掉代理标记，也不能盲目信任访客伪造的 forwarded 头。当前 Cloudflare 合同不能当作通用 Nginx 配置。
7. 实际外网核对匿名拒绝、成员登录、viewer 写入拒绝、CSRF/Origin、Secure Cookie 和伪造头；通过受控服务器本机访问完成管理员引导。不得把 4188 直接公开。
8. 获准后配置独立异地备份与恢复演练。本机同卷的自动备份不能抵御整盘丢失；备份存储、保留期、费用和授权由用户确认。

## 5. 本轮离线验收

执行 `node --test test/deployment-preflight.test.mjs`。测试注入 Linux/文件元数据覆盖缺依赖、权限、临时目录、单实例声明、loopback、可选浏览器及敏感输入不回显；另用隔离临时目录运行真实 CLI，验证不创建额外文件、不加载 `.env`。所有临时夹由测试收尾，不连接 4188、不读取生产数据或凭据。

本轮专用 15 项测试通过，与既有 runtime-audit/source-poller-status 合并为 30 项通过；语法检查通过。Node 预发布版拒绝、正式版附带 build 元数据接受。这里验证的是离线检查工具及隔离 CLI，不是 Linux 二进制实际运行或云端部署。

当前仍未完成：目标 Linux 实机验收、服务监督部署、固定域名与 TLS、授权重建、真实来源可用性和异地恢复。需要用户提供目标主机/域名及相关操作授权，不能从离线单测推导这些步骤已完成。
