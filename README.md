# MCN 矩阵工作台

**最新源码整理：2026-10-29。公开前端对应线上 v112。**

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

需要 Node.js **24+**（使用 `node:sqlite`）和 Python 3。默认停用抖音浏览器采集；HTTP 采集与来源表同步不需要打开抖音网页。前端浏览器测试另需本机 Chrome，仅用于模拟数据或本控制台验收。

```sh
npm ci
npm start
```

打开 http://127.0.0.1:4188/ 。首次启动为空库；数据恢复见交接说明。不要让测试副本和原生产服务同时对同一数据库运行采集。

## 启动线上前端开发副本

```sh
cd frontend
npm ci
npm run dev
```

前端的持久化数据依赖 D1 / R2 配置或已有公开副本接口；只有源码不会自动拥有生产数据库、管理权限或生产部署密钥。`npm run build` 生成部署产物。

## 验证与合作

```sh
node --check server.mjs
node --test test/collection-progress.test.mjs
cd frontend
node --test test/observatory-field.test.mjs test/matrix-scope.test.mjs test/replica-navigation.test.mjs
```

全量后端测试为 `npm test`。前端交互测试在根目录与 `frontend` 都完成 `npm ci` 后，从仓库根目录执行：

```sh
MCN_MAIN_ROOT="$PWD/" node --test --test-concurrency=2 frontend/test/*.test.mjs
```

`MCN_MAIN_ROOT` 指向本仓库根目录并保留末尾 `/`，兼容现有测试的依赖路径拼接；若 Chrome 不在默认 macOS 路径，还需设置 `MCN_TEST_CHROME` 为实际可执行文件路径。电脑资源紧张时改为 `--test-concurrency=1`。这些浏览器用例使用模拟请求，不采集抖音、不调用模型；不要同时启动多套完整浏览器测试。

本次验证：[每日发片体验](docs/DAILY_PUBLICATION_UX_20261029.md)、[HTTP 采集方案审查](docs/HTTP_COLLECTION_REVIEW_20261029.md)。欢迎通过 Issue / Pull Request 提交改进。

## 数据与采集边界

运行时采集是本地脚本，不调用语言模型。平台访问失败、作品分页不完整和作者关联缺口仍需处理；不应把单次成功或主页成功当作全部作品采集成功。缺测保留为空；估算播放与实际播放不可混用。保留来源、采样时间与去重证据。

本项目为 UNLICENSED；第三方组件许可证见 THIRD_PARTY_NOTICES.md 和各 vendor 目录。

存储治理与恢复：[STORAGE.md](docs/STORAGE.md)。
