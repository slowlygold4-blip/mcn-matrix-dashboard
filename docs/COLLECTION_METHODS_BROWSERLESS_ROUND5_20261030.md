# 无本机抖音浏览器采集：第五轮源码核验

本轮新增核验6个此前报告未收录的仓库，固定提交、读取24份不同相关文件；只定向检查采集入口、字段和依赖，并非全面安全审计。没有安装或运行第三方代码。使用 agent-reach 的 GitHub CLI 与官方文档搜索；源码临时副本在 `/tmp`，项目仅保存来源版本与文件哈希。

## 这次最有用的官方发现

[获取作者视频列表](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/reach-marketing/mount/self_mount/get-user-video-list) 的参数和返回结构本轮获取到完整搜索索引正文，直接打开文档仍超时；结合第三方C# SDK的固定源码核对调用路径，不将SDK当作权限有效的证据。

- `POST https://open.douyin.com/aweme/v1/video/self/get_user_video_list/`，权限为 `ma.self_mount_video.item_list`。
- 使用企业小程序的 `client_token`；仍要求作者授权绑定“查询作者视频列表”。
- JSON请求里的 `aweme_id` **是作者抖音号**，不是视频ID，也不是 `sec_uid/open_id`。这为已有抖音号的名册提供不同于逐人open_id查询的接入方式。
- 返回 `data.user_publish_item_list`、`has_more`、`max_cursor`；每条含 `create_time/item_id/video_link`。文档规定count不超过100，翻页cursor须为近30天内毫秒时间戳，首页可传0。
- 返回的是作品发现信息，没有该响应中的粉丝/点赞/播放统计。不能把列表查询成功当作完整指标采集，更不能承诺无限历史回补。

可形成的接入链路是：已有抖音号 → 获授权作者近期作品列表 → 用明确映射后的作品ID查询相应授权指标 → 按作品ID和观测时间并入现有数据。列表权限、指标权限及公开作品ID映射需分别验证，不混用token。

## 新仓库和skill的实际结论

| 固定来源 | 底层能力与限制 | 本次处理 |
|---|---|---|
| [ShareXtract](https://github.com/wuaishare/sharextract/blob/9934bdd16f2804c3ee956569138f81313d01c8a5/sharextract/extractors/douyin.py) | 匿名HTTP读取 `jingxuan.douyin.com/m/video/<ID>` 的SSR/JSON-LD；能提取标题、日期及可选作者/计数，属于单作品元数据，不枚举作者全部作品。JSON-LD降级直接使用 `userInteractionCount`，需要另核验interactionType，不能照搬为播放量。 | 新的公开页面候选；用仓库公开样本做1次无Cookie、无浏览器、无签名请求，返回302，未跟随；没有取得数据。没有换UA或反复尝试，没有入生产。 |
| [creator-platform-data](https://github.com/orangexie05/creator-platform-data/blob/27e21185d911812ffba987d69a35a26e83c38be4/scripts/douyin/collect_snapshot.py) | 独立skill提供按天创作者中心作品指标导出；实现启动Playwright持久化浏览器，在页面内fetch本人后台接口。 | 可参考导出字段，但不符合当前禁用抖音浏览器采集要求，不安装、执行或获取登录态。 |
| [social-media-copilot](https://github.com/iszhouhua/social-media-copilot/blob/bcbb586aefcb0f5aad9821b40722712ddc36693c/README.md) | 项目说明server版通过socket.io将API请求转发给浏览器插件；审查main分支抖音请求/作品处理源码。HTTP入口并不消除浏览器依赖。 | 未把其Docker/API宣传当作独立无浏览器方案；未执行。未审查server分支的完整实现。 |
| [C# OpenAPI SDK](https://github.com/zhangliang2008/douyin-openapi-sdk-csharp/blob/df22552aa46573b3c74d3465335b060c7fcdb8c0/src/DouyinOpenApi/Apis/DouyinClient.Aweme.cs) | 请求中有上述作者列表POST及旧每日fans/item接口。第三方SDK提供调用封装，不授予应用权限。 | 补充路径交叉核验；只借鉴公开接口契约，未安装SDK或声称当前应用已获批。 |
| [SenseNova中文社交搜索skill](https://github.com/OpenSenseNova/SenseNova-Skills/blob/95db9cf340f0efad2945c3b79f4fc7d7a5d474fd/skills/sn-search-social-cn/scripts/douyin_search.py) | 带Cookie请求抖音Web综合搜索，最多20条；缺失play_count等字段默认0。不是作者完整作品列表。 | 可研究搜索能力，不能直接并入统计或用于宣称完整覆盖；未执行。 |
| [douyin-knowledge-skill](https://github.com/yytyyt125/douyin-knowledge-skill/blob/57dbce56700c4cc6c64835a54ee984e795d6dc75/src/douyin_kb/collector/monitor.py) | skill有单分享链接/收藏/作者知识库工作流；列表监控实现监听浏览器JSON响应，按endpoint+cursor记录翻页和作品ID去重。 | 借鉴去重和进度证据，不安装其浏览器链路、本地转录模型或可选LLM。 |

另外找到火山引擎的[矩阵管家更新说明](https://docs.volcengine.com/docs/MatrixButler/FAQs-6?lang=zh)，但其[计费规则](https://docs.volcengine.com/docs/MatrixButler/MatrixManagerProductServiceOnlineBillingandSettlementRules?lang=zh)明确为预付费SaaS；未购买、注册或上传名单，也不把它包装成免费接口。

## 已落地到现有工具

扩展 `lib/douyin-open-api-probe.mjs` 与原CLI，没有新增采集进程、定时任务或浏览器入口：

```sh
# 仅检查环境配置，零网络请求，不打印密钥或作者抖音号
node scripts/probe-douyin-open-api.mjs --author-list

# 已有获批授权时，显式试验一个作者的一页，最多10条
node scripts/probe-douyin-open-api.mjs --author-list --run --account-key KEY
```

进程环境使用 `DOUYIN_CLIENT_TOKEN`、`DOUYIN_AUTHOR_HANDLE`、`DOUYIN_CLIENT_SCOPES`。不要把密钥写进命令参数、聊天、源码或日志。不自动生成token，不启动登录流程。

模块层最多3页，仅用于有界试验；CLI默认1页。校验缺列表、缺has_more、重复/倒退异常游标、异常域名作品链接、重复作品的日期冲突和超大响应。403/429及业务拒绝停止，不重试或切换身份。大整数item_id不强转字符串；公开作品ID只从严格校验的视频链接读取，避免JSON数字精度丢失。

发布时间无时区的响应按北京时间解析，这是当前隔离试验的显式解释，正式接入前需用作者已知作品核对；无效、未来或缺失日期保留null。列表不含的互动指标全部为null，不伪造播放数据。`recentWindowPaginationExhausted`只描述本次近期窗口，`allAuthorWorksCollected/identityBindingVerified/productionAdmitted`始终为false。

## 验证与真实缺口

- 新增7组测试，与现有官方/分享页入口共54组通过；是合成响应与本地契约回归，不是54个线上作者采集成功。
- 当前环境readiness：client_token、作者抖音号、scope均未配置；官方入口0次网络请求、0写库、0模型调用。未因缺token向平台发送无授权请求。
- 另一次公开样本HTTP试验返回302，未读取作品数据；结果单独记录，不算采集成功。
- 主服务健康检查200/ready/runtimeAI=false。本轮未重启服务、改变调度、修改用户数据或上线未验证采集渠道。代码改动前已备份。
- 全作品403、未关联作者及持续每日数据完整性仍未解决。本轮获得了更具体的作者列表接入契约与可复用验证工具；真实作者授权和实际返回字段核验仍是后续准入条件。

固定源码清单、样本请求结果、测试记录见 `docs/audits/2026-10-30-browserless-methods-round5/`。不以找到skill或测试通过替代实际采集覆盖。
