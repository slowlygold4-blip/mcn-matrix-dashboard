# 无本机浏览器采集通道复核（2026-11-04，北京时间）

本轮通过 agent-reach 的 GitHub CLI 后端阅读公开 README、代码目录和问题记录。没有安装或执行第三方代码，没有向新服务发送内部账号标识、Cookie 或全名单。搜索结果与项目宣称均不等于本系统已恢复采集。

| 公开项目 | 本轮可验证的结论 | 采用情况 |
| --- | --- | --- |
| [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | 提供自托管 HTTP API；需要实际部署和运行环境验证。现有演示服务的单账号成功不能证明全名单稳定吞吐。 | 保留已审核回执接入，未将演示站设为全量生产源 |
| [F2](https://github.com/Johnserf-Seed/f2) | 文档包含 Cookie 配置；[403 问题记录](https://github.com/Johnserf-Seed/f2/issues/443)仍有未关闭报告。不能承诺换库就解决拒绝。 | 未安装、未导出登录态 |
| [douyin-downloader](https://github.com/jiji262/douyin-downloader) | README 明确说明当前请求校验可能阻止 CLI 下载，反复更新 Cookie 或重试不能修复该问题，并提出浏览器回退。 | 不使用本机浏览器回退 |
| [DouyinCrawler](https://github.com/RyanLiying/DouyinCrawler) | 配置路径要求 Chrome/Chromium CDP、首次登录。 | 不符合当前采集约束，未采用 |
| [douyin-crawler-guaikei](https://github.com/why20261/douyin-crawler-guaikei) | 需要额外 API TOKEN 和服务开通，链接将发送给第三方。 | 没有凭据、未注册或付费、未外发名单 |
| [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader) | 已查阅 README 和请求/提取代码目录。 | 未执行；没有宣称其可替代现有日采 |

## 由真实运行发现的产品问题

“作品覆盖有限”可能来自已登记作品的详情更新，而非新投稿列表。原“列表有限观察”“最后有效列表观察”等文案把这两类证据混在一起，可能误导管理者认为系统已发现最新投稿。改为通用作品采样表述；仅保留完整分页和库存核验成立时的“列表完整核验”。

该呈现修复不改变覆盖算法、原始回执、采样时间、指标或失败原因，也不构成逐作品日采或每日发布数量已完整恢复的证明。日增长仍须相邻北京日真实基线，缺测不补零。
