# MCN 矩阵工作台

**最新源码整理：2026-10-26。公开前端对应线上 v104。**

[打开线上工作台](https://mcn-matrix-observatory.slowlygold4.chatgpt.site) · [开发交接说明](docs/DEVELOPER_HANDOFF.md)

本仓库包含当前本地采集服务完整应用源码，以及线上工作台前端源码。源码仓库不是运行中的数据服务；他人打开仓库不会取得管理权限。

## 目录

- 根目录 `server.mjs`、`lib/`、`scripts/`：本地服务、采集、去重、导入、每日快照与发布脚本。
- `public/`：本地管理界面。
- `frontend/`：当前线上 React / Vinext 工作台，包括 v104 视觉与交互改动。
- `test/`、`frontend/test/`：后端与前端测试。
- `docs/`：公开开发说明。

完整业务资料、原表、审查日志及数据库快照另外保存在所有者的私有完整归档仓库。登录态、密钥、会话与邀请码不上传。请向所有者申请归档访问权限，不要把业务数据提交到本公开仓库。

## 启动本地服务

需要 Node.js **24+**（使用 `node:sqlite`）、Python 3，以及采集脚本需要的浏览器环境。

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

全量后端测试为 `npm test`，建议串行执行，避免启动大量浏览器导致电脑卡顿。欢迎通过 Issue / Pull Request 提交改进。

## 数据与采集边界

运行时采集是本地脚本，不调用语言模型。平台访问失败、作品分页不完整和作者关联缺口仍需处理；不应把单次成功或主页成功当作全部作品采集成功。缺测保留为空；估算播放与实际播放不可混用。保留来源、采样时间与去重证据。

本项目为 UNLICENSED；第三方组件许可证见 THIRD_PARTY_NOTICES.md 和各 vendor 目录。
