# 作者和作品数据入库：普通本机程序，不调用 AI

## 原始作品表通用适配：已完成只读对账，自动入库仍待接通

原始作品表、公示详情不能使用只接受标准化总表的导入命令。现在可直接运行通用作品适配器，对整本 XLSX 读取字段、保留物理行号、区分抖音号/UID、按作品 ID 与现有总库对账：

```sh
node --max-old-space-size=512 scripts/reconcile-work-source-workbook.mjs \
  --input /absolute/path/original-source.xlsx \
  --database /absolute/path/data/douyin-monitor.sqlite \
  --output-directory /absolute/path/new-review-directory
```

此命令**不写业务数据库、不请求平台、不调用模型**，输出目录必须尚不存在；私有证据使用0600权限。`work-facts.jsonl.gz` 保存逐行事实，`work-reconciliation.jsonl.gz` 保存逐作品对照，`reconciliation.json` 保存读取范围、异常和数量。原件与已有证据不覆盖。

同一作品的多条来源记录不会相加计数；各来源累计值不一致时列出候选值，不取差当作每日增长。工作簿更新时间、作品发布日期和指标采样日是不同字段。没有明确指标日期就保持未知；“万/w/亿”保留其显示精度信息，不假称逐个精确计数。含糊的“42.4”或“七万”等字段保留原文和问题，不能自行补单位。

短链接优先复用现有总表`10_收集原始记录`、`13_公示奖项明细`中明确的“作品链接＋视频ID”配对，且作品ID必须已在去重总表中。每次关联带原导入、工作表、行号和行哈希；同链接多ID、显式ID冲突不自动选择。这个过程只关联作品引用，不等于确认作者身份或新采样成功。

Feishu导出的A1范围错误、空前缀富文本、复制分享文案、`modal_id`链接使用既有兼容/官方链接读取逻辑。本轮真实资料中29条超出安全数字精度的作者ID被标出但不四舍五入；其独立、准确的作品ID和计数继续保留。标题/昵称不充当账号归属证据。

2026-10-29本机既存原件的实际对账：话题作品27,526行、17,868个不同视频ID全部在去重总表；三份公示逐作品704/149/17行完整读取，803条短链接记录通过旧来源配对得到作品ID，另有2处配对冲突、4条未关联短链接。新增作品数0不代表没有采集缺口，只说明这些历史原件已经在总库。原件为已存历史版本，不把本次读盘时间冒充今天平台数据。

**尚未完成：**把新版本事实事务入库并保存版本头、让主读模型/公开导出共用该头、接入已有每日来源同步。当前命令是可重复运行的完整对账适配器，不能宣称执行后公开仪表盘已自动更新。

以下流程只使用 Node.js、ExcelJS 和 SQLite，无模型 API、无推理 token。对话中的开发与人工审查属于另一项工作；这些命令运行本身无需 Codex 或其他模型。当前运行要求 Node.js 24（使用 `node:sqlite`）。

## 1. 原件 → 独立暂存库与一致性审查

输入是现有标准化作者总表 XLSX，包含 `01_总览`、`05_赛道总览`、`08_作者总表`、`09_去重作品`、`16_账号别名合并`、`18_口径说明`、`19_播放叠加查重` 等既有字段结构。不能直接把任意原始登记表当作这种总表。保留原始 XLSX，不覆盖旧版本。

在项目根目录运行（路径、修订号和修改时间替换为真实值）：

```sh
node scripts/import-creator-library.mjs \
  /absolute/path/creator-source.xlsx \
  data/creator-library-next.sqlite \
  data/douyin-monitor.sqlite \
  真实修订号 \
  2026-10-22T13:09:53Z
```

该步骤计算原文件 SHA-256，审查作品 ID 去重、作者/作品数量、赛道与累计值对账、缺测数量，并保存 `metadata.audit`、完整来源行和明确账号 ID 关联。它仅创建暂存库，对监控主库使用只读连接。标准化总表已声明的数量和最新数据应一致；审查失败先修正来源，不能把预期数量改成硬编码常量绕过审查。

## 2. 只读预演

```sh
node scripts/integrate-creator-library.mjs \
  --source data/creator-library-next.sqlite \
  --target data/douyin-monitor.sqlite \
  --dry-run
```

预演只读打开现有目标库，不创建空目标、不建表、不写业务数据。它验证原 XLSX 哈希、审查数量、每张表行数及原行号、唯一作品 ID、来源作者主 ID/别名、当前目标的公开 ID 与已核验身份；输出 `would-import` 或 `unchanged` 和本批数量。暂存库来自多少作者、多少作品就按实际审查结果核对，已移除 4,481/18,179/34,150 的固定数量限制。

若原件丢失、SHA 不符、来源版本信息不完整、目标不存在、身份变化或现有同哈希记录不完整，则拒绝继续，不猜测归属。

## 3. 已验证备份后事务入库

先保留并验证最近的一致性主库备份；备份的文件名应唯一，避免覆盖旧备份。生产维护中使用项目既有 SQLite 备份流程，不直接复制正在写入的 SQLite 主文件。预演通过后执行同一命令并去掉 `--dry-run`：

```sh
node scripts/integrate-creator-library.mjs \
  --source data/creator-library-next.sqlite \
  --target data/douyin-monitor.sqlite
```

所有新版本、来源行、严格账号/作品关联和兼容视图在同一事务提交，失败全部回滚；旧版本保留，相同原件哈希重复执行返回 `unchanged`。兼容原有无参数调用，仍读取 `data/creator-library.sqlite` 并写 `data/douyin-monitor.sqlite`，所以生产试运行必须明确带 `--dry-run`。

入库保存的是表格来源事实。作品发布日期可用于作品批次统计；表格累计点赞/播放可与已有平台采样对照，但不会改写粉丝快照、伪造每日增长或将来源更新时间充当逐作品采样时间。影子采集文件另有身份、分页和时间证据审查，不能直接当作本流程的 XLSX 暂存库。

## 验证命令

```sh
node --test test/integrate-creator-library.test.mjs
node scripts/integrate-creator-library.mjs --dry-run
```

测试仅创建系统临时目录内的小型 SQLite 数据库；覆盖动态增量、只读预演、来源漂移、身份漂移、重复 ID、幂等及事务回滚。不要为了测试执行生产导入或启动全量浏览器采集。
