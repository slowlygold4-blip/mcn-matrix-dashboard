# 无浏览器采集路线第二轮核验 · 2026-10-30

本轮继续查 GitHub 实现与 skill，固定提交审查9个新仓库、28份文件。没有安装这些第三方项目或 skill，没有运行第三方代码，没有向供应商提供业务数据和登录态；采集运行不调用模型。前一轮8个仓库的结论见 [第一轮报告](COLLECTION_METHODS_BROWSERLESS_20261030.md)。

## 实际找到什么

| 路线 | 源码核验 | 处理与下一项证据 |
|---|---|---|
| [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader/blob/e327b9549d284a8b1613566f949fe2dbb8a6c2a1/src/interface/account.py) | HTTP作品翻页、账号信息接口。`Account.check_response` 在空列表或缺字段时设 `finished=True`；提前结束会写警告，但没有这里所需的逐页完整性契约。`requester.py` 使用 curl_cffi，不能仅凭“纯HTTP”推断可稳定访问。 | 保留只读候选；进入生产前要补缺列表、重复游标、目标作者绑定、每页限额与完整性证明。未验证本地实际成功率。 |
| [douyin-downloader](https://github.com/jiji262/douyin-downloader/blob/ed863617aa52353821aca8fdebcfad4e916ebff5/README.md) | README明确：CLI受平台验证限制，作品列表使用可选Playwright回退也不保证成功。其作品策略区分截断与置顶排除，值得借鉴覆盖审查。 | 不使用浏览器回退，不作为当前限制的修复。只借鉴“原始条数/置顶/截断原因分别呈现”，不静默少算。 |
| [creatorhub](https://github.com/3441293738/creatorhub/blob/13598884a6fcb3ccb661b6bbb7dea7c9b13fc478/app/platforms/douyin/client.py) | 有HTTP客户端、精确抖音号匹配和游标接口；仍使用Cookie、签名及网络指纹组件。`fetch_video_list` 对空响应转换成 `items=[]/has_more=False`，`fetch_all_new_videos` 碰到已知作品就结束。 | 不直接接全量入口：空响应不能证明作品为空；置顶或乱序可能使“遇旧即停”遗漏新作。未来只评估单页解析，已有凭证的合法使用另验。 |
| [sigcli的抖音skill](https://github.com/sigcli/sigcli/blob/9ba8b35415bfee4fca67927a5b62d9e2ef676e81/skills/douyin/SKILL.md) | 是Cookie提供器；`sig login`打开可见浏览器。验证的是通知接口登录状态，不是作品分页权限。 | 当前不采用，不导出Cookie。不能把会话有效当成作品可采。 |
| [growth-lab抖音skill](https://github.com/tsingyuai/growth-lab/blob/2d0807c5831c69eac4267702f539957a621e7689/collectors/media-crawler-douyin/SKILL.md) | MediaCrawler工作流包装，不是另一套采集传输。要求保留原始证据，遇登录/风控停止。 | 采用证据与停止规则；不重新安装一个同依赖包装来冒充新路线。 |
| [红狐作品采集skill](https://github.com/redfox-data/redfox-community/blob/d2e24f02340a440a73a96aa6ad6a65f681fba89f/skills/douyin-works-crawler/SKILL.md) | 唯一数据源为红狐API，要求Key、注册和按调用积分计费；并非免费的开源采集器。 | 未注册、购买、调用。记录为有条件的供应商路线，当前授权范围不采用。 |
| [SandBase抖音研究skill](https://github.com/sandbaseai/sandbase-skills/blob/cbab58188611e626ccaf54ac346b437d12ea4729/research/douyin-research/SKILL.md) | 通过发现/检查/执行供应商端点获取数据，要求先核对价格及具体schema；skill本身不公开无凭证的采集能力。 | 未调用。不能把“支持话题/达人研究”的描述当作可免费自动全量监控的证明。 |
| [douyin-cli](https://github.com/tamnd/douyin-cli/blob/b70c8d7e3f650023aada02013aa75850f67f0222/douyin/api.go) | Go的HTTP/CLI/MCP同一实现，README与代码说明签名API可能返回空正文或验证页。`Posts`缺列表或has_more默认零会结束，没有函数内重复游标防护或ID去重。 | 保留单页候选，不采用全量循环，也不按维护者“任何IP”的热榜说明推断账号接口可用。没有安装/运行。 |
| [yt-dlp抖音提取器](https://github.com/yt-dlp/yt-dlp/blob/34ea29166e37d6f16849217982d0429aafc463e8/yt_dlp/extractor/tiktok.py) | `DouyinIE._real_extract`直接请求 `/aweme/v1/web/aweme/detail/`，缺详情就报需要新Cookie；这个类是单作品详情，不是作者作品枚举器。 | 独立单次HTTP试验见下；没有执行其验证TODO、Cookie生成或下载媒体。 |

这些是具体可核查的实现；没有把外部SKILL.md里的指令当作本项目指令，没有盲装依赖。

## 本轮真实试验

对正式库内一条已有作品，只读尝试yt-dlp实现使用的**无签名详情路径**。使用明确标识的普通HTTP请求；不加载抖音网页、不启动浏览器、不带Cookie、不改出口、不生成验证参数。

结果：**1次请求，HTTP403，0条可用观测，0次数据库写入，0次模型调用**。遇403即结束，未重试、未触发数千账号扫描。这个结果只证明当前单样本与当前环境未取得详情，不证明所有HTTP方案都不可用，也不冒充整个yt-dlp客户端的实测。

官方API只执行本机零请求配置检查：当前进程没有access_token、open_id、video.list声明。该检查没有扫描其他登录态目录，也不等同于用户没有开发者账号。

## 与每日增长直接相关的官方路线

[用户互动数据能力](https://developer.open-douyin.com/capacity-center-page/capacity-detail/7180284622729658424)明确列出每天新增粉丝、发片、播放、点赞等指标；需合格开发者申请、应用获批与账号授权，首次授权次日才有完整数据。文档还限制用途，不能用于对外售卖的数据服务或平台统计分析。是否允许当前内部矩阵管理场景，需要以实际申请及审核为准，不能自行承诺获批。

它比“读取当前累计值后硬推每天增量”更匹配长期每日监控，但**目前没有完成授权接入**。普通抖音号、sec_uid与应用open_id不能互换。当前文档的具体接口页此次只返回导航壳，没有据此猜测字段开发另一个未经验证的采集器。

## 下一项接入验收

1. 保留当前可工作的主页HTTP采集与原表同步，不因换库丢失已存数据；每个来源进入同一作者/作品模型。
2. 候选采集器先证明一个账号单页真实返回、精确身份匹配、指标含义与采样时间，再验证分页、重复游标、空响应、置顶/乱序和停止原因。没有这些证据不得上线全量入口。
3. 无浏览器HTTP候选与官方授权方案继续分别评估；第三方供应商属于需要新商业授权的路线，不能代用户购买。
4. 不把本轮研究称采集已修复：完整作品、话题双指标与部分身份关联仍有缺口。也不把测试数、进程在线或主页覆盖率当作品成功率。

本轮已发布的作品数据融合与时间语义修复另见 [数据证据审查](UNIFIED_WORK_EVIDENCE_REVIEW_20261030.md)；公开数据台v119真实浏览器加载通过，但这与采集能力分开验收。
