# 无本机抖音浏览器采集：第六轮定向核验

本轮使用 agent-reach 的 GitHub CLI 与官方文档检索，固定6个仓库的提交，读取22份相关文件。仅核验涉及采集的入口、依赖、字段和费用条件，不声称完成全仓库安全审计。没有安装或执行第三方代码，没有调用转写/大模型，没有打开抖音浏览器。固定版本与文件SHA见 [source-manifest.json](audits/2026-10-30-browserless-methods-round6/source-manifest.json)，原始临时源码只存 `/tmp/mcn-methods-round6`。

## 真正核实到的路线

| 来源 | 源码结论 | 对当前项目的决定 |
|---|---|---|
| [yzfly/douyin-mcp-server](https://github.com/yzfly/douyin-mcp-server/blob/b0bb8b1fbe4f514bf28099b1471928ebb3716ad2/douyin-video/scripts/douyin_downloader.py) | 单分享链接通过 `iesdouyin.com/share/video` HTML 的 `_ROUTER_DATA` 取媒体、标题和作品ID。转写另用硅基流动/百炼，不能混为免费的统计采集。 | 其公开HTML路线与前轮已检验入口同类，不能枚举全作者历史，未重复发相同无效平台请求，未接入模型或下载视频。 |
| [pazwusimple-netizen/douyin-mcp](https://github.com/pazwusimple-netizen/douyin-mcp/blob/ab9eb3b36cd47e9091e520f9a5faabf72f1f16e4/src/client.py) | 有HTTP客户端，但作品列表仍是 `/aweme/v1/web/aweme/post/`，默认走本地签名；另有Playwright搜索降级。 | HTTP包装不是独立新数据源，也不能证明已解决现有403。不执行其签名/登录/浏览器/代理链路。 |
| [liaogx/douyin-mcp](https://github.com/liaogx/douyin-mcp/blob/61668adda5a719afa09396513801cbeca65fffb1/douyin/web.go) | REST/MCP外层仍持有 `rod.Page`，通过真实网页处理登录、搜索和详情。 | 不符合本机抖音浏览器禁用要求，未安装或运行。 |
| [TikHub官方插件/skill](https://github.com/TikHub/tikhub-plugin/blob/755a540afa53dbc31993cb7567376db0ea0fca4f/skills/douyin/SKILL.md) | App-V3提供用户资料、作品分页、单作品等HTTP接口；onboarding明确需注册API key、按端点计费，分页也计费。 | 作为有条件的远程商业方案保留，而不是免费方案。不购买、不注册、不发送内部名单或凭据、不擅自批量调用。 |
| [dynamiclu/Mcp-ChatBI](https://github.com/dynamiclu/Mcp-ChatBI/blob/41a46898ddb076178d7ce41b032e47a903876a04/server/douyin_open_api_server.py) | 文件开头明确注明demo、tool返回固定数据；视频播放等数字写死。另有LLM会话编排。 | 排除作为真实采集实现，不将搜索引擎里的“播放曲线能力”当成已可用接口，不导入演示数据。 |
| [RSSHub](https://github.com/DIYgod/RSSHub/blob/9dae4709c8fc2bbd4a0012e2412de609eb0c6872/lib/routes/douyin/user.ts) | 作者和话题路由实际调用Playwright/XHR；[新榜路由](https://github.com/DIYgod/RSSHub/blob/9dae4709c8fc2bbd4a0012e2412de609eb0c6872/lib/routes/newrank/douyin.ts)虽为HTTP但需NEWRANK_COOKIE，源码描述免费每日20次查询，输出标题/链接/日期，不是完整指标。 | 不把RSS标签误认为已解决采集；不使用他人实例承接内部账号，不运行浏览器或绕过额度。新榜额度为项目文档描述，未登录核验当前商业方案。 |

## 官方单作品按日播放数据：已实现隔离入口

[官方获取视频播放数据](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/video-data/get-play-data/)明确：

- `GET /data/external/item/play/`，`data.external.item`权限及对应作者授权。
- 参数 `open_id`、官方不透明 `item_id`、`date_type`（7或15天）；只有近30天创建的作品能返回数据，首次授权次日才产生数据。检索索引列出了参数；直接正文当前参数表显示“暂无数据”，响应样例仍明确 `result_list[{date,play}]`，参数契约需在真实获批应用试验时再次核对。
- 这是带日期的播放观测，不把它当作者全部作品、话题总量、累计播放或无限历史回补。公开作品ID和官方item_id必须另有可靠映射。

在原有 `lib/douyin-official-daily-probe.mjs` 和CLI上增加 `--video-plays`，没有新增服务、定时器、生产采集路径或数据库表：

```sh
# 默认仅检测配置，0平台请求，不输出密钥
node scripts/probe-douyin-official-daily.mjs --video-plays

# 已有获批应用/作者授权和作品映射后，显式测试单作品、单请求
node scripts/probe-douyin-official-daily.mjs --video-plays --run --account-key KEY
```

从进程环境读取 `DOUYIN_OPEN_ACCESS_TOKEN`、`DOUYIN_OPEN_ID`、`DOUYIN_OPEN_SCOPES`、`DOUYIN_OPEN_ITEM_ID`。不在命令行、聊天、源码或报告写密钥。不自动申请权限或获取token。

校验：严格官方HTTPS域名、拒绝重定向、20秒超时、64KiB响应上限、日期/精确整数/重复日期、7或15天窗口、不透明ID只编码一次、主错误和子错误检查。403/429等失败立即结束，无重试或身份切换。缺项/缺日保留缺失，真实0保留0。输出不回显token/open_id/item_id；不写库，不调用模型，不宣称身份映射已验证。未放行的响应不进入控制台。

同时修复共享每日解析器遗漏 `extra.sub_error_code` 的问题，避免主错误码为0、子错误非0时误报成功。

## Webhook不等于全账号发文监控

官方[事件列表](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/webhooks/event-list)的 `create_video` 描述是用户通过开发者应用分享视频（携带分享id），并不是任何账号任何渠道发文都会触发。不能靠接收这一事件冒充4927位作者全量作品监控。本轮未注册回调或新增对外服务。

## 测试和当前真实覆盖

- 5个新增测试组，全部相关探针共59项通过。包含合成响应/本地CLI，不是59个作者采集成功。
- 真实本机配置检查：token、open_id、item scope和官方item_id均未配置；因此新入口实际0平台请求、0写库、0模型调用，未进行授权成功后的实采验收。
- 2026-10-30T00:16:31.323Z服务检查：ready，runtimeAI=false。24小时主页4072/4081，话题4/4；作品完整0，受限44，作品问题4058，其中transport-cooldown3977、blocked81。这些维度不相互替代；4/4不证明话题全部历史每天双指标均完整。
- 当前全作品采集问题仍未解决。本轮完成了公开候选核验、一个有明确授权前提的播放曲线隔离工具和错误判定修复；没有把文档存在、单元测试通过或主页成功作为全量采集成功。

后续优先：核验已有开放平台应用/作者授权与作品映射，条件具备后做一个真实作者/作品的有限试验；继续寻找不依赖本机浏览器的公开或已授权服务端渠道。同时保留并持续处理既有来源表和主页采样，不重复启动全量任务，不把授权缺口包装为已修复。
