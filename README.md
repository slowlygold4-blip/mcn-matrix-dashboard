# MCN 矩阵数据台

**最新源码整理：2026-10-30（北京时间）。包含后台与公开前端源码，部署核验见开发记录。**

[打开线上工作台](https://mcn-matrix-observatory.slowlygold4.chatgpt.site) · [开发交接说明](docs/DEVELOPER_HANDOFF.md)

本仓库包含当前本地采集服务完整应用源码，以及线上工作台前端源码。源码仓库不是运行中的数据服务；他人打开仓库不会取得管理权限。

## 目录

- 根目录 `server.mjs`、`lib/`、`scripts/`：本地服务、采集、去重、导入、每日快照与发布脚本。
- `public/`：本地管理界面。
- `frontend/`：当前线上 React / Vinext 工作台，包括每日发片、全作者名册与交互更新。
- `test/`、`frontend/test/`：后端与前端测试。
- `docs/`：公开开发说明。

业务资料、原表、审查日志及数据库的历史快照（2026-10-26，不等于当前实时数据）保存在[私有完整归档仓库](https://github.com/slowlygold4-blip/mcn-matrix-dashboard-archive/releases/tag/snapshot-20261026)。登录态、密钥、会话与邀请码不上传。请向所有者申请归档访问权限，不要把业务数据提交到本公开仓库。

## 启动本地服务

需要 Node.js **24+**（使用 `node:sqlite`）和 Python 3。默认停用抖音浏览器采集；HTTP 采集与来源表同步不需要打开抖音网页。前端浏览器测试另需本机 Chrome，仅用于模拟数据或本控制台验收。 当前无浏览器采集的[最新源码核验与单作品播放曲线验证](docs/COLLECTION_METHODS_BROWSERLESS_ROUND6_20261030.md)已整理；`node scripts/probe-douyin-open-api.mjs --author-list`检查绑定作者近期作品列表所需配置，`--miniapp`检查作品指标查询配置，均默认不发平台请求。需要真实获批应用及作者授权后才能显式运行该隔离接口。

```sh
npm ci
npm start
```

打开 http://127.0.0.1:4188/ 。首次启动为空库；数据恢复见交接说明。不要让测试副本和原生产服务同时对同一数据库运行采集。

## 启动线上前端开发副本

```sh
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

打开 http://127.0.0.1:5173/。干净源码自动使用独立只读模式，通过 `.env.local` 中的 `MCN_READONLY_ORIGIN` 读取现有公开数据；未配置时明确报数据源未配置，不填示例数字。无需 Sites 登录态、D1/R2 凭据或本机业务数据。请求不转发 Cookie/Authorization，采集、上传和发布写入均拒绝。

`npm run build && npm start` 可验证独立生产构建。已有完整 Sites 脚手架的工作副本仍使用保留的托管配置；配置不完整会明确报错。源码不会自动取得生产管理权限。 若当前网络已配置 `HTTPS_PROXY` 等环境变量，Node 24 可用 `NODE_OPTIONS=--use-env-proxy npm run dev` 显式采用该配置；不需要代理的网络直接运行即可。网络可达性仍取决于现有公开数据源。

```sh
# 默认不启动浏览器、不读取业务表格、不请求抖音
npm test
npm run typecheck
# 先 build；用本机合成上游核验 dev/start、数据校验与拒绝写入
npm run test:runtime
# 必须由资料持有人明确指定私有来源导出目录；无目录会失败
npm run test:published -- --directory /absolute/private-export/public
```

普通回归使用可重复的合成数据；来源导出验收单独检查全部文件的字节/SHA、修订、条数、去重与派生统计。它不等于平台数据完整采集或播放量真实性核验。[独立运行与验证记录](docs/PORTABLE_DEVELOPER_HANDOFF_20261030.md)。

来源读取和发布性能优化及核验结果见[性能审查记录](docs/SOURCE_PROJECTION_COST_20261030.md)。

## 验证与合作

```sh
node --check server.mjs
node --test test/collection-progress.test.mjs
cd frontend
node --test test/observatory-field.test.mjs test/matrix-scope.test.mjs test/replica-navigation.test.mjs
```

根目录的 `npm test` 是完整后端测试，部分用例需要额外环境。前端日常开发使用 `cd frontend && npm test`。确需浏览器交互验收时，在根目录和 frontend 安装依赖后显式执行：

```sh
cd frontend
npm run test:browser
```

浏览器验收需本机 Chrome，部分历史用例还需要指定验收资料；它不属于默认普通回归，本轮未运行。`MCN_TEST_CHROME` 可指定 Chrome 路径；`MCN_MAIN_ROOT` 默认自动定位仓库根目录，手工覆盖时保留末尾 `/`。不要同时启动多套浏览器验收。

本次验证：[每日发片体验](docs/DAILY_PUBLICATION_UX_20261029.md)、[HTTP 采集方案审查](docs/HTTP_COLLECTION_REVIEW_20261029.md)。欢迎通过 Issue / Pull Request 提交改进。

## 数据与采集边界

运行时采集是本地脚本，不调用语言模型。平台访问失败、作品分页不完整和作者关联缺口仍需处理；不应把单次成功或主页成功当作全部作品采集成功。缺测保留为空；估算播放与实际播放不可混用。保留来源、采样时间与去重证据。

本项目为 UNLICENSED；第三方组件许可证见 THIRD_PARTY_NOTICES.md 和各 vendor 目录。

存储治理与恢复：[STORAGE.md](docs/STORAGE.md)。

发布链修复与验收边界见 [PUBLICATION_ACTIVATION_20261029.md](docs/PUBLICATION_ACTIVATION_20261029.md)。

增量存储、迁移与实际验收边界见 [INCREMENTAL_REPLICA_STORAGE_20261030.md](docs/INCREMENTAL_REPLICA_STORAGE_20261030.md)。

作品话题分类修复、每日发片分类筛选与发布等待期间的开销优化见 [WORK_CLASSIFICATION_AND_PUBLISHING_20261030.md](docs/WORK_CLASSIFICATION_AND_PUBLISHING_20261030.md)。无浏览器采集路径研究与官方 HTTP 隔离测试工具见 [COLLECTION_METHODS_REVIEW_20261030.md](docs/COLLECTION_METHODS_REVIEW_20261030.md)。

覆盖口径、发布器空闲内存生命周期及长期查询上限审查见 [COVERAGE_QUALITY_AND_PUBLISHER_LIFETIME_20261030.md](docs/COVERAGE_QUALITY_AND_PUBLISHER_LIFETIME_20261030.md)。

日期历史长期读取已改造并部署v124；[当轮记录](docs/STREAMED_DATE_HISTORY_20261030.md)保留当时的验证与缺口。公开源码的17项数据依赖失败与构建脚手架缺口已在后续[独立运行修复](docs/PORTABLE_DEVELOPER_HANDOFF_20261030.md)处理，不代表完整平台采集已解决。

官方单作品按日播放隔离验证：`node scripts/probe-douyin-official-daily.mjs --video-plays` 默认仅检查配置、0平台请求。需对应作者授权、`data.external.item` 权限和可靠官方作品ID映射；仅支持近30天创建作品，不能用作无限历史回补。真实授权验收前未接生产调度。
