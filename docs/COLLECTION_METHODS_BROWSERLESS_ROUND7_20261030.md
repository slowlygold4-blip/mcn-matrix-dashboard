# 无本机抖音浏览器采集：第七轮候选审查

本轮按用户要求继续查找其他采集方法和 skill。使用 agent-reach 的 GitHub CLI 路由与官方文档检索，固定 7 个新仓库的提交，下载并定向阅读 24 份相关文件；这是采集路径、依赖及边界审查，不是完整安全审计。没有安装或执行第三方采集代码，也没有打开抖音网页、导出登录态、创建账号、购买或调用第三方数据服务。本轮不修改生产采集器、数据库和调度，不声称提高了实际采集成功率。

证据见 [固定版本与文件校验](audits/2026-10-30-browserless-methods-round7/source-manifest.json)。临时上游源码仅保存在 /tmp/mcn-browserless-round7，公开清单不含内部账号或凭据。

## 1. 新找到的实现，追到实际传输层

| 项目 | 实际实现与限制 | 当前决定 |
|---|---|---|
| [LIghtJUNction/douyin](https://github.com/LIghtJUNction/douyin/blob/c70a41e6a8007c09c9d955548f7ab63f25b26df1/src/crawler.rs) | Rust HTTP CLI：账号作品、话题、搜索、评论等；Web链路仍需 Cookie 和本地签名。OAuth/OpenAPI 是另一条授权链，不能互换。分页只检测相邻游标不推进；缺列表且缺 has_more 会按结束处理，每页最多重试3次，没有该循环中的ID去重或跨多页循环游标集合。 | 保留单页 HTTP 候选；不直接接全量循环、不执行签名或凭据处理。作者全量、真实播放与线上成功率均未证明。AGPL-3.0，不拷贝进现有闭源业务模块。 |
| [DouyinDataReview](https://github.com/ZhangYukwiver/DouyinDataReview/blob/ba852eccb648d9ce345860230a29ac89b50256d6/collector/creatorCenter.mjs) | 创作者中心支持按账号保存凭据后直接HTTP请求，不是每次都要开浏览器；但仍依赖账号登录材料。另有抖音指数作者趋势接口，源码声称约90日序列，本轮未实采验证。直连底层另含签名和凭据SDK处理；不能因为入口叫direct就视作开放API。 | 保留“已有合法凭据、无需持续网页操作”的架构参考。不上线其签名/凭据导出逻辑，不读取本机浏览器。指数数据的作者收录、口径、权限和时间范围未验证，不能覆盖到全部作者。 |
| [douyin-data-research skill](https://github.com/why20261/douyin-data-research/blob/1b14b2a27604081c1fa9e053b381e99560cadb6f/SKILL.md) | Node内置HTTPS，作品接口实际向 www.guaikei.com 创建任务后查询结果；必须 GUAIKEI_API_TOKEN。limit最大10000是请求参数，不是全量完整性证明。创建最多3次、查询最多20次重试；缺任务数据返回空数组。 | 这是独立的远程供应商路线，记录为候选；注册、费用、数据使用范围和实际返回字段未核实。未开通、未调用、未外发作者名单。不能照搬空数组=采完。 |
| [douyin-to-feishu skill](https://github.com/Super-Bull/douyin-to-feishu/blob/917dd6ba1319493e8b80240b63ff52f7c8ee25d0/douyin-to-feishu/SKILL.md) | computer-use浏览器逐作品读取，默认10条；后续含AI总结/标签、默认另建飞书表。不是无人值守的零模型采集器。 | 不接入本项目：违反用户不用本机抖音网页、运行不调用模型、数据统一入现有库的约束。只读其代码和说明。 |
| [short-video-data-pipeline](https://github.com/david0513web3/short-video-data-pipeline/blob/50c7e30bb528e8f3d77d977e15883db6e7b6741c/step-1-douyin-scraper/README.md) | 说明链路为Playwright/Chromium登录自己的创作者后台，产出history.jsonl；采集核心在另一个依赖仓库。本轮该依赖仓库GitHub读取失败，未验证核心实现。 | 不能把流程README当作可运行的全量采集器，不安装cron或浏览器。 |
| [zJay26/douyin-skills](https://github.com/zJay26/douyin-skills/blob/09e9ccb6c484c59d69e11dbb4bc975c47e5510e5/SKILL.md) | 本机Chrome/CDP操作，公开命令主要是搜索、详情、互动和发布；文档明确不承诺用户主页批量抓取。还会启动自己的更新检查。 | 不安装或运行；不是新的无浏览器数据源，也不新增其后台更新任务。 |
| [douyin-creator-analytics](https://github.com/wei04459-blip/douyin-creator-analytics/blob/52bf645c4b888334eda3395a8cca91e6b09a35a9/src/douyin_creator_analytics/creator_api.py) | Python模块看似API客户端，实际通过AppleScript控制当前Chrome页执行fetch；可读自己创作者后台私有指标，转写另用Whisper。 | 不接入本机浏览器，不用它证明数千作者可采。未执行安装或转写。 |

对前两个项目还查看了公开Issues列表，查询成功但列表为空；没有把“没有issue”解释成稳定性或测试证明。

## 2. 官方经营授权路线：补齐容易漏掉的条件

本轮核查了[视频基础数据（经营授权）](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-recent-video-data/get-base-bc)：
- GET /api/apps/v1/item_bc/get_base/，ma.item.data_bc，bus_act凭证。
- 必须是实际绑定的经营账号和对应作者的open_id/item_id，不能拿公开抖音号代替。
- 返回 total_play、total_like、total_comment、total_share 等真实观测；作品年龄限30天，首次授权次日才产生全部数据，后续约次日10点刷新。
- 这是已知作品指标查询，不负责发现全部作者的新作品，也不能直接回补9.12以来所有历史。

另有[经营能力当前状态查询](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/interface-request-credential/business-token/query-business)：POST /oauth/business_scopes/，可查实际关系；contract_authorize / contract_unauthorize Webhook可用于感知关系变化。**授权状态事件不等于发文或播放指标推送**。

关键规模限制：
- [普通抖音号](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/operation/business-account/standard-account)：个人主体小程序仅本人1个、其他普通账号最多3个，不能作为几千作者的普适方案。
- [企业机构账号](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/operation/business-account/bizaccount)：要求主体认证/对公验证，创建还需至少1个在线小程序；可创建数以账号中心为准，不支持手动申请提额。不能因用户经营MCN就断言其全部合作作者已是这种账号或已获该能力。
- [实时视频查询](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-video-data/video-data)是此前已研究的ma.video.bind用户授权能力；本轮只补核，不算新实现或新实采成功。

本轮未核验实际企业应用/经营关系，未新建注册或生成token；没有用文档示例中的凭证请求平台。

## 3. 可实施路线与准入验收

优先继续验证服务端HTTP与正式授权接口；第三方异步数据API单列为需核实条件的候选。云服务器只能改变执行位置，不能自动解决凭据、权限、数据缺失或限流，不能仅迁移IP就宣称修复。

每个候选接入前必须留下同一作者的有界真实回执：
1. 精确证明作者ID/主页/平台用户身份，不按昵称自动合并。
2. 先1个作者/1页，再检查下一页和终止证据；缺列表/缺游标/重复循环不算完成。
3. 403、429、登录/验证拒绝立即记录并停止，不重复重试或切换身份。
4. 逐作品保留ID、发布日期、指标观测时间、来源；缺值为null，0仅保留真实0。
5. 真实播放、估算和不可用分开；作品发布日期不能当指标观测日期。
6. 测试重复数据去重、跨日追加、删帖后作品存量净变化与实际发文条数分离。
7. 用现有统一入库与去重链路，不能再建一个独立业务板块，也不能把一页成功算作全作者全作品成功。
8. 采集、合并、发布运行时不调用任何LLM；研究开发对话仍会消耗模型额度，不能声称整个过程零token。

本轮可交付的是新候选和具体接口条件的可复查审查记录；**没有获得新的真实作品样本，现有全作品采集问题仍未解决**。既有已登记表格继续作为真实数据源保留，来源更新与每日采样不应互相替代。后续工作不以“又找到一个skill”为完成标准，而以真实作者/分页/日期/指标回执通过上述验收为准。
