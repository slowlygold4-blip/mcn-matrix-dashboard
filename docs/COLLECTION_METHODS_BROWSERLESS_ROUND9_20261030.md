# 无本机抖音浏览器：继续检索与官方搜索隔离入口

本轮使用 agent-reach 的 GitHub CLI 路径，固定4个仓库版本、核对27份相关文件，并交叉读取官方接口文档。不安装或执行第三方代码，不开启本机抖音网页，不新建账号或购买服务，不将内部作者名单交给新供应商。这里是定向代码/依赖审查，不是完整安全审计。

## 实际找到什么

| 实现 | 追查到的底层路径 | 可用范围与缺口 |
|---|---|---|
| [BK927/douyin-mcp](https://github.com/BK927/douyin-mcp/blob/8905e38cacc241c0ffed7dbdb2c2fcca199ad084/douyin_mcp/api.py) | 独立官方HTTP适配器；搜索、绑定作者列表、视频详情、每日粉丝和经营视频数据分别使用不同权限。浏览器是另一可选模块。 | 官方视频搜索是本项目此前未实现的发现入口。其本身也注明未提供凭据/实采验收，不能拿mock测试证明本矩阵可采。其分页归一化会默认缺失has_more为false，因此不直接复制。 |
| [SocialDataX MCP](https://github.com/DevinChen2014/douyin-mcp/blob/b2c544f82e84c254993730f7f2ac11cc12b1b2e0/bridge.mjs) | 桥接器经mcp-remote向mcp.socialdatax.com转发；需SOCIALDATAX_API_KEY。README列出按sec_user_id或主页分页取作者作品。 | 是新的远程供应商候选，仓库不含其服务端采集核心。费用、额度、数据使用范围、分页完整性和实际播放字段尚未实测。未注册/调用/外发名单。 |
| [why20261/douyin-research skill](https://github.com/why20261/douyin-research/blob/d3b2bf05e43d2bf2a8d5a9b6bed807dc8a47f601/src/api/post.js) | GUAIKEI_API_TOKEN，向www.guaikei.com创建作品任务再轮询；无data直接返回空数组。 | 与第七轮douyin-data-research仓库是同一供应商路线，不能算新增独立数据源。不能采用空结果=作者没作品。 |
| [lingjw02/douyin-mcp](https://github.com/lingjw02/douyin-mcp/blob/ab90e414ac7ec0e7714425b75d3ef143a7100e94/douyin_client.py) | Playwright读取本人喜欢/收藏列表。 | 既非全部作者作品源，也不满足不用本机抖音浏览器的要求。只审查源码，不运行。 |

固定文件清单：[source-manifest.json](audits/2026-10-30-browserless-methods-round9/source-manifest.json)。旧方案继续可查，未把相同上游换一个skill名字算新能力。

## 官方视频搜索的真实接口条件

[官方文档](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/douyin-search-capability/aweme-dy-video-search)确认：

- GET https://open.douyin.com/dy_open_api/v1/search/video/
- scope为aweme.dy.video_search，使用client_token；还需接入方有效device_id，不能自行杜撰设备身份或导出本机浏览器材料。
- 支持关键词、发布时间0/1/7/180和综合/点赞/最新排序。
- 后续页需cursor及首刷search_id；响应嵌套data.data，video_list包含公开作品ID、链接、发布时间、昵称和点赞数样例。
- 搜索结果不能证明作者归属、作者全部作品或话题参与人数/播放总量；文档没有提供这种完整性承诺。

官方[矩阵账号接入说明](https://open.douyin.com/platform/resource/docs/accession-guide/common-solution/)仍以用户授权为前提。已有抖音号/作品ID有助于定位，但不是访问授权。经营账号、普通OAuth、小程序授权和供应商Key不能互换；本轮没有重复生成token或擅自注册新应用。

## 落地的代码与运行方式

本轮独立实现lib/douyin-official-search-probe.mjs，扩展原CLI的--search模式，不改生产调度、数据库、页面、公开受众或权限：

```sh
# 离线检查，只输出布尔就绪状态，不打印关键词、设备ID或凭据
node scripts/probe-douyin-open-api.mjs --search

# 已有合法获批配置时，显式执行1页、最多10条的只读试验
# DOUYIN_CLIENT_TOKEN / DOUYIN_CLIENT_SCOPES
# DOUYIN_SEARCH_DEVICE_ID / DOUYIN_SEARCH_KEYWORD 通过受保护环境配置
node scripts/probe-douyin-open-api.mjs --search --run
```

固定官方域名、20秒超时、256KiB正文上限、不跟重定向、不自动重试。401/403/429或HTTP200业务拒绝立即结束，仅保留安全错误码；device_id保持精确int64字符串。作品ID须与官方公开链接一致；不将它误称其他接口的加密item_id，不按昵称绑定作者。

未提供的指标为null；真实0点赞保留0。搜索不提供可信播放总量，因此plays=null、plays_source=unavailable。搜索即使耗尽也保留allAuthorWorksCollected=false；identityBindingVerified和productionAdmitted均为false，只有后续真实身份/日期/权限回执通过后才能进入现有统一入库，不另建业务板块。

## 验证及未解决问题

7个相关测试文件81项通过，含本轮10组测试；均为合成HTTP响应/离线CLI回归，不是81个真实作者采集成功。测试覆盖权限隔离、无网络就绪检查、HTTP/业务失败、体积与取消、缺值与真0、ID/日期精度、分页完整性及泄密防护。首轮一项日期期望值手算有误，更正为独立UTC转换值后完整重跑。

当前执行环境的搜索token、scope、device_id未配置，就绪检查为false，实际0平台请求/0数据库写入/0模型调用。新方法已写好但未通过授权实采，**未宣称提高实际作品采集成功率或修复完整作品覆盖**。

接续顺序：在已有正式应用授权具备时先做一个关键词/一页的真实回执；精确核验作品ID、作者身份、发布日期、观测时间后按已有规则合并。并行保留原表同步和现有HTTP采集，不再用源码仓库数量替代真实入库量。远程供应商需要明确的可用Key及使用条件，未核验前不启动批量请求。
