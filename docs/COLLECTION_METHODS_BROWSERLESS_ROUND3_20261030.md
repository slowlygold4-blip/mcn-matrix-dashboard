# 无浏览器采集方法与 skill 第三轮核验

本轮继续查找替代方案，使用 agent-reach 的 GitHub CLI 路径。核验 8 个固定提交、下载 22 份文件并针对实际入口审查；其中 5 个仓库未列在前四份研究报告，3 个为复核，不能称 8 个全新方案。官方 SDK 是约 7.7 MB 的生成文件，仅审查相关模型和请求函数，未宣称逐行审核整个文件。没有运行第三方代码、安装新 skill、启动抖音浏览器、采购服务或向第三方提供名单/登录态。

## 这次有用的新证据

### 1. 官方每日数据确实有接口，不必从样本视频点赞反推

[字节官方 Go SDK](https://github.com/bytedance/douyin-openapi-sdk-go/blob/a50593c5ccdc31ab5b7cb2153947dfad612bbed9/client/client.go) 的 `UserFans`、`UserLike`、`UserItem` 请求与官方旧版文档相互印证：

| 接口 | 返回字段 | 正确用途与限制 |
|---|---|---|
| `/data/external/user/fans/` | `date`, `new_fans`, `total_fans` | 原样保留官方日字段；未确认语义前，不把 new_fans 擅自命名为“净增粉丝”。累计总粉丝按相邻有效日比较才可另算净变化。 |
| `/data/external/user/like/` | `date`, `new_like` | 保留按天的官方点赞字段，不用视频抽样点赞代替全账号获赞。 |
| `/data/external/user/item/` | `date`, `new_issue`, `new_play`, `total_issue` | 可提供日播放相关字段，但 new_issue 是受删除影响的存量变化，不能当作逐作品去重后的当天发布条数。 |

官方文档：[粉丝](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-fans-count/)、[点赞](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-like-number/)、[作品情况](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-video-status/)。需应用获批 `data.external.user` 并有作者授权，不能把普通抖音号/sec_uid当作 open_id。SDK使用 `date_type` 和 `open_id` 查询参数，令牌放请求头；隔离工具默认请求7天，参数允许7/15/30，但当前没有真实令牌验证这些参数或权限仍对本应用开放。

官方说明首次授权后次日才有完整数据、通常次日12时前刷新，因此这条路线不能承诺实时或任意历史回补。作品情况文档还说明统计基于抖音App发送且审核通过的作品，极速版发送不纳入。不能将该端点等同全部平台作品覆盖。新站部分文档只返回导航壳，本轮追到仍可阅读的官方旧站及字节SDK；不把旧文档存在当作当前应用已获准调用。

另查到[小程序粉丝接口](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/data-open/user-homepage-data/get-user-fans-count)：权限 `ma.user.data`、需作者通过小程序授权，且只返回千粉以上用户；不能静默套用于所有矩阵作者。

### 2. 投稿任务接口有价值，但不能冒充统计接口

[查询视频基础信息](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/posting-task/video-basic-info) 接受授权用户的 `item_ids` 或明文 `video_ids`，可用于已有作品身份核验；仅能查询令牌对应用户作品，不能越过作者授权。示例未提供播放、点赞统计。并且[字段调整公告](https://developer.open-douyin.com/forum/bulletin/post/6736c38048f043667b75f70a)已经下线该能力的 `video_status` 字段，不能照旧SDK示例依赖此字段。

### 3. Skill 的真实依赖已追到实现

| 固定源码 | 核验事实 | 处理 |
|---|---|---|
| [Kuhakucai/douyin-mcp](https://github.com/Kuhakucai/douyin-mcp/blob/53c888a5e1d83ea70978e71432ad8774707d69b7/src/douyin_creator_mcp/browser/session.py) | Playwright持久化浏览器登录创作者中心，非独立HTTP数据源。 | 不接入当前无浏览器采集；可参考隔离会话与状态表达。 |
| [hujinhao123/douyin-api](https://github.com/hujinhao123/douyin-api/blob/c4b3e5de8fa13feea28aae0545f70dfed1f3fec2/docs/known-limits.md) | HTTP服务外观背后默认真实浏览器传输；文档明确普通HTTP仍403。非Windows会话存储也有占位限制。 | 不因“self-hosted API”名称就换入生产，不执行其浏览器/签名路径。 |
| [xxjrq导出skill](https://github.com/xxjrq/douyin-creator-analytics-export-free/blob/720944f34757c5c66bd0fe0a1e4fd6faed1ef394/SKILL.md) | 通过EasyBR/Bridge读取已登录本人后台，非无人值守HTTP采集。其self-test只断言三项本地样例字段，不证明线上有效。 | 可以借鉴报告来源/缺失字段契约；不安装浏览器包装，不把self-test当采集成功率。 |
| [Mithranda/agent-reach-douyin](https://github.com/Mithranda/agent-reach-douyin/blob/19d1f5249dbfebb5426f92252cc2876dc594195a/agent_reach/scripts/douyin_common.py) | requests读取已知作品分享HTML；主要是下载与转录，转录可调用外部模型。不能枚举作者全部新作。 | 已知ID分享页路线此前已有独立探针且无数据，避免重复请求同路径；不接入转录API。 |
| [01Anlan/douyin-api-lite](https://github.com/01Anlan/douyin-api-lite/blob/a79ef688cb22a1f32d646e377f3a6b576245c8e6/README.md) | 树仅README/LICENSE/env示例，需外部二进制和启动卡密，无法审查采集核心。 | 不执行未知二进制或领取卡密；未验证是否免费，不称开源可直接接入。 |
| [zJay26/douyin-skills](https://github.com/zJay26/douyin-skills/blob/09e9ccb6c484c59d69e11dbb4bc975c47e5510e5/SKILL.md) | 复核相同提交，仍为Chrome/CDP工作流。 | 不算新的传输方法。 |
| [xiaoyiv/douyin-skill](https://github.com/xiaoyiv/douyin-skill/blob/760a1c5414a213751e66f6c713717789b361199a/scripts/download.py) | 复核相同提交，nodriver浏览器/XHR提取单作品。 | 不恢复用户已经取消的浏览器采集。 |

## 已落地的代码和验证

- `lib/douyin-official-daily-probe.mjs`：纯HTTP、单作者、至多3个串行请求；固定官方域名；不跟随重定向、不重试拒绝、不调用模型、不读写数据库。
- `scripts/probe-douyin-official-daily.mjs`：无参数只检查进程环境是否具有凭据与scope，不发平台请求。`--run --account-key KEY`才尝试7天三个端点；令牌只从环境读取，不放CLI参数、不打印原始异常。
- `lib/douyin-official-http.mjs`：与已有官方作品列表探针复用有界JSON读取器，不复制另一套无限制传输。
- 严格北京时间历史日期；不接受当天/过旧/重复/非法日期；缺字段留null，数字字符串保留精度，真实0保留0；保留官方错误码但不输出上游可能含凭据的描述。
- 结果是按日官方统计，不写成当天采样的历史累计快照；不把 new_issue 画成“当天发布条数”。身份绑定未验证、未准入生产，不能用假设账号填进后台。

本机真实配置检查：`accessTokenPresent=false`, `openIdPresent=false`, `userDataScopeDeclared=false`；0平台请求、0数据库写入、0模型调用。说明本轮进程没配置这条路线，不说明用户没有开发者账户。已有关于应用授权的询问仍待回复，未重复索取，更不要求在聊天发送密钥。

相关70项测试通过，包括原列表探针、每日探针、分享页探针、浏览器禁用及拒绝退避规则。属于合成响应/本地回归，不是70个线上账号成功。主服务HTTP200/ready/runtimeAI=false；没有新采集进程、定时器、服务重启或浏览器。

## 下一步按证据推进

1. 官方路线：确认已有获批应用和作者授权后，用一个已绑定作者运行该隔离工具，核验返回日字段和身份，再进入同一事实库；未授权作者保留原表/可用公开统计的现有来源。
2. 持续检查不同传输/授权模型，不把CLI、MCP、skill三个包装重复算三条路线。对已知普通HTTP403不做海量重复撞接口。
3. 已登记表格继续自动同步、去重、按作品ID和观测日期合并到同一后台。它们本来就是数据来源，不另立一个表格产品；不能把发布日期/提交日代替指标采样日。
4. 全作品分页、每日实际发布ID统计和话题参与/播放双指标仍需实际补齐。本轮没有宣称已解决全量采集。

证据：`docs/audits/2026-10-30-browserless-methods-round3/` 的固定SHA/文件摘要、SDK定向摘录、readiness和测试日志。完整第三方下载仅在临时研究目录，不复制7.7MB生成文件进项目或公开业务数据。
