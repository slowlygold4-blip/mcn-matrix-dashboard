# 继续寻找采集方式：固定源码核验与当前官方接口

本轮使用 agent-reach 的 GitHub CLI，固定 8 个仓库提交，下载 32 份相关文件，定向审查 skill、实际请求入口、分页与会话实现。包含已有项目新版复核，不把 8 个仓库称为 8 条独立可用通道。完整第三方源码仅放临时目录，不运行或安装；项目只保留公开链接、版本和文件摘要。

## 1. 当前最有价值的新官方路径

[查询特定视频的视频数据](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-video-data/video-data) 的当前文档明确给出：

- `POST https://open.douyin.com/api/apps/v1/video/query/`。
- 小程序企业开发者申请 `ma.video.bind`，作者通过 `tt.showDouyinOpenAuth` 授权。
- 请求头传授权令牌，查询参数传该授权对应的 `open_id`，请求体传 `item_ids`。
- 返回视频基础信息、发布时间，以及 `statistics.play_count/digg_count/comment_count/share_count` 等字段。
- 仅查询令牌对应用户上传的公开视频。私密视频会返回 `create_time=0` 的记录。

这与本项目以前的 `/video/list/`、`data.external.user` 路线不同，不能互换 scope 或用普通抖音号充当 `open_id`。官方社区里有开发者[反馈旧接口调用已下线](https://developer.open-douyin.com/forum/question/post/6a9ab2de2c8e05501d04dc30)；这是他人反馈，不足以判定所有应用的旧权限均已下线。保留已有隔离工具，但不再把旧 SDK 存在当作当前准入证明。

另外核实：

| 官方能力 | 能提供什么 | 接入前提/限制 |
|---|---|---|
| [获取作者视频列表](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/reach-marketing/mount/self_mount/get-user-video-list) | 文档列出 `/aweme/v1/video/self/get_user_video_list/`，`ma.self_mount_video.item_list` | 需作者绑定及能力授权、client_token；完整页面抓取超时，仅获取到搜索缓存中的参数/错误码，未据此实现未知返回结构 |
| [经营授权视频基础数据](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-recent-video-data/get-base-bc) | `total_play/total_like/total_comment/total_share` | `ma.item.data_bc`，经营关系授权；仅 30 天内创建的视频，首次授权次日有完整数据，后续约次日 10 点刷新，不能承诺实时 |
| [经营授权视频播放数据](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-recent-video-data/get-play-bc) | 按日 `date/play`，可查询 7/15 天 | 仅令牌对应作者的作品，30 天作品范围；不是全矩阵无限历史回补 |
| [拍抖音任务变更推送](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/share/douyin_task/task-change-webhook) | 任务关联作品 ID、公开成功/失败及时间变化 | `apps.douyin.task` 权限与该任务参与关系；不能冒称所有作者新作品通知，也不提供每日互动计数 |

[企业机构号的现行说明](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/operation/business-account/bizaccount)与旧品牌号/合作号说明并不完全相同。不能用旧文章中的绑定额度承诺几千位异主体作者均可直接接入，更不能为监控擅自转移账号主体或创建新账号。实际应用资格、账号关系、授权与用途应分别核验。

## 2. GitHub 与 skill 的底层实现

| 固定源码 | 实际发现 | 处理 |
|---|---|---|
| [ltppp/douyin-ingest](https://github.com/ltppp/douyin-ingest/blob/4c8e6542f4670235e889c13f043c359d66626f59/project/api.py) | HTTP 分页有重复游标、页数上限、作品总量交叉检查；但其 [capture.py](https://github.com/ltppp/douyin-ingest/blob/4c8e6542f4670235e889c13f043c359d66626f59/project/capture.py) 通过 Playwright 捕获会话与接口 | 借鉴完成度证明；不安装该 skill 的浏览器登录/捕获链路，也不启用转录模型 |
| [wanzicong/MediaCrawler_Dy](https://github.com/wanzicong/MediaCrawler_Dy/blob/592f8d6a0351950aa913e2cffdec9f8632ec8ccb/modules/douyin-client/src/crawler/douyin_client/http/client.py) | 客户端将会话注入和 HTTP 分离，不直接导入浏览器；默认会话来源仍涉及浏览器/CDP | 可参考传输/会话/错误分层；HTTP 服务外观不证明独立上游或本机403已解决，没有执行 |
| [LIghtJUNction/douyin](https://github.com/LIghtJUNction/douyin/blob/c70a41e6a8007c09c9d955548f7ab63f25b26df1/src/crawler.rs) | Rust CLI 同时有 Cookie Web 与 OAuth OpenAPI；账号作品仍请求 `/aweme/v1/web/aweme/post/`。检查游标不前进，但列表和分页字段缺失仍可能变成空结束 | 并非更换语言就有新权限；不照搬缺失字段当结束或通用重试策略 |
| [why20261/douyin-data-research](https://github.com/why20261/douyin-data-research/blob/1b14b2a27604081c1fa9e053b381e99560cadb6f/SKILL.md) | 必须 `GUAIKEI_API_TOKEN`；[实际请求](https://github.com/why20261/douyin-data-research/blob/1b14b2a27604081c1fa9e053b381e99560cadb6f/src/api/post.js) 为第三方异步任务，不是本地自足爬虫 | 可参考任务创建/查询分离；免费范围、覆盖、数据权利未核实，未开户、请求或发送名单 |
| [redfox-community 的作品 skill](https://github.com/redfox-data/redfox-community/blob/d2e24f02340a440a73a96aa6ad6a65f681fba89f/skills/douyin-works-crawler/SKILL.md) | `REDFOX_API_KEY`、积分接口；实现对中文昵称明确拒绝，与文案“名称或ID”不完全一致 | 属第三方数据供给，不是免 Key 方案。未付费、开户或发送作者列表 |
| [43college/social-media-scout](https://github.com/43college/43-agent-skills/blob/385773aecd59e38e1d82e8237e122baec1b685a7/social-media-scout/scripts/tikhub_client.py) | MCP 和 REST 两个地址最终都依赖 TikHub API Key | 不是两条独立采集源；未配置密钥或调用服务，尚未验证费用和成功率 |
| [Super-Bull/douyin-to-feishu](https://github.com/Super-Bull/douyin-to-feishu/blob/917dd6ba1319493e8b80240b63ff52f7c8ee25d0/douyin-to-feishu/references/douyin-collect.md) | 通过 computer-use 浏览器逐条导航、读取作品页面，再写飞书 | 不符合用户关闭抖音浏览器采集的要求；未安装或执行 |
| [Evil0ctal 当前新版](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/src/dtk/platforms/douyin/endpoints.py) | 新版按能力注册、明确账号作品分页的登录前提；维护者注释记载游客后续页只返回 status_code=0，判为拒绝。部分搜索/话题作品能力[明确未注册](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/src/dtk/platforms/douyin/adapter.py) | 参考逐能力验证和拒绝分类；这些是上游观察，非本项目实测，不接入身份轮换或浏览器RPC，不把宣传中的全部功能当可用 |

## 3. 本轮已经写入项目的验证入口

直接扩展现有 `lib/douyin-open-api-probe.mjs` 与 `scripts/probe-douyin-open-api.mjs`，不再增加另一套采集进程：

```sh
# 只检查当前进程环境，不请求抖音
node scripts/probe-douyin-open-api.mjs --miniapp

# 对已有授权与已核验应用内作品ID，显式运行一次
node scripts/probe-douyin-open-api.mjs --miniapp --run --account-key KEY
```

仅从进程环境读 `DOUYIN_OPEN_ACCESS_TOKEN`、`DOUYIN_OPEN_ID`、`DOUYIN_OPEN_SCOPES` 及 JSON 数组 `DOUYIN_OPEN_ITEM_IDS`。不要在聊天、源码、提交或日志里填写真实密钥。无参数只输出是否存在/格式有效，不输出令牌、open_id、作品ID。不加载任何浏览器或模型。

隔离运行限制为单次请求、最多 5 个作品，这是本地验证预算，不是官方配额说明。固定官方域名与路径，不跟随重定向；403/429不重试。校验三层错误码，不打印可能含敏感参数的上游描述。保留数字官方错误码，缺失播放留 null，真实0保留0，不用点赞乘100。返回的作品ID必须属于请求集合且不重复；缺失作品单列，不补成零数据。`create_time=0` 的非公开占位记录不提供指标。应用内 item_id 保持不透明，绝不当公开 aweme_id。

结果保持 `identityBindingVerified=false`、`productionAdmitted=false`、`allAuthorWorksCollected=false`。单次已知作品查询不是作者全量列表，匹配请求ID也不等于已经证明本库作者/公开作品的对应关系。

## 4. 实测与尚未解决的事实

- 当前进程 readiness：没有 access token、open_id、ma.video.bind 或作品ID配置；0平台请求、0数据库写入、0模型调用。这不代表用户没有开发者账号，仅说明这条运行环境尚未配好。
- 新入口及现有官方列表/每日入口 35 项测试通过；浏览器禁用和共享拒绝退避 7 项通过。均为合成响应/本地回归，不是42个账号的线上成功率。
- 没有改变现有采集调度、启用浏览器、重启服务、新增模型调用或更改原始数据。主服务在本轮检查时 HTTP200/ready/runtimeAI=false。
- 新官方路线还需要真实获批应用、作者授权、应用内作品ID与本库身份映射，才能完成一个账号的真实验证；现有询问仍待回复，不重复索取密钥。
- 当前全作品403、全部作者身份关联、完整每日发布覆盖仍未解决。研究与隔离代码完成不等于生产采集修复，不修改覆盖率或把缺失数据填零。

证据见 `docs/audits/2026-10-30-browserless-methods-round4/`：公开源码SHA/文件哈希、readiness、`test-results.json`。原始测试日志保留在本地，不加入Git；私有目录35+7项与公开副本42项是同一批用例的复验，不是84项独立测试。接下来仍优先真正不同的上游/授权能力和已有原表自动同步，不反复安装相同Web接口的不同包装。
