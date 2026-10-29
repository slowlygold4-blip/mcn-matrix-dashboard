# 无浏览器采集的第二轮实现核查

本轮继续使用 agent-reach 的 GitHub CLI 路线读取源代码，并核对抖音官方文档。以下是对指定版本的审查，未将仓库宣传当作本项目实测成功率。没有安装这些项目的依赖、启动抖音浏览器、购买 API、调用模型采集或上传登录态。

## 新核查的实现与 skill

| 来源与固定版本 | 代码或依赖事实 | 对本项目的结论 |
| --- | --- | --- |
| [cv-cat/DouYin_Spider](https://github.com/cv-cat/DouYin_Spider/blob/d151f9c2980abc304c1ae4918c2272675cd9e4c2/dy_apis/douyin_api.py) | 用户资料与作品使用 HTTP GET，作品仍为 `/aweme/v1/web/aweme/post/`；依赖 Cookie。全量方法按 `max_cursor/has_more` 翻页，但未对不前进游标提供独立退出证明；部分请求关闭 TLS 验证 | 可研究会话与逐接口参数；不是独立于现有被拒接口的新数据源。不整套安装，不复制关闭 TLS 校验或认证挑战逻辑 |
| [amibaren/douyin-DL-skills](https://github.com/amibaren/douyin-DL-skills/blob/7ae3b47eed16a9a4fd88378cd985d8bf9619be89/skills/douyin_downloader/SKILL.md) | 核心复用 F2；Cookie 自动刷新依赖 Playwright；主要目标是下载文件 | 任务恢复思路可参考；下载成功不能证明每日计数齐全。浏览器刷新、被拒后的其他通道切换不接入 |
| [yunsur/douyin-mcp-skills](https://github.com/yunsur/douyin-mcp-skills/blob/5f19f34c635f15064ce670a3ef43695b0fe6fbbc/skills/douyin-user/SKILL.md) | skill 描述 `get_user_posts/get_user_all_posts` 等工具；说明本身没有提供独立于底层服务的采集能力 | 不能仅安装提示词就宣称解决采集；需继续审查实际服务、身份和翻页实现 |
| [OpenSenseNova 搜索脚本](https://github.com/OpenSenseNova/SenseNova-Skills/blob/0ee34f37b969011d527eba348d1bec220fd1a7dd/skills/sn-search-social-cn/scripts/douyin_search.py) | 普通 HTTP 搜索、需要 Cookie；源码注明稳定性较低；单次结果上限20，缺失统计默认0 | 可参考响应业务码检查；不适合作为作者全量作品/精确每日指标的唯一来源，不采用缺失补0 |
| [sigcli 的 Douyin skill](https://github.com/sigcli/sigcli/blob/9ba8b35415bfee4fca67927a5b62d9e2ef676e81/skills/douyin/SKILL.md) | 提供 Cookie 登录管理，明确可见浏览器扫码，后续配合 DouYin_Spider | 身份管理工具，非无浏览器、免授权的数据接口。本轮不运行其登录/自动刷新命令 |
| [字节官方 Go SDK 仓库](https://github.com/bytedance/douyin-openapi-sdk-go/tree/a50593c5ccdc31ab5b7cb2153947dfad612bbed9) | 官方 SDK 仓库入口 | 不能把 SDK 当成权限；以当前官方接口文档为准，未安装 SDK 或创建应用 |
| [DouyinDataReview](https://github.com/ZhangYukwiver/DouyinDataReview/tree/6acf55eeb6789f9500b0723c1efcadd9318df8fc) | 本人登录会话读取、个人备份与创作者中心数据 | 与几千位作者免逐个授权的矩阵采集不同，不能用个人会话冒称全部作者授权 |
| [douyin_one_spider](https://github.com/mashukui/douyin_one_spider/blob/dce7e2bbcd2c84f66716ce76de92bd63c1b3731a/README.md) | README 说明系统浏览器读取及收费开通 | 不符合当前无浏览器、无新增付费约束 |
| [gggso/douyin_crawler](https://github.com/gggso/douyin_crawler/blob/96688c2a9cff6721026b0322ba50355b8981041c/README.md) | 标称云端分布式，文档注明 token 为购买时分配，并按请求点数计费 | 不符合无付费 Key；未调用服务 |
| [GoldArowana/douyin-crawler](https://github.com/GoldArowana/douyin-crawler/blob/5926211e4fb42ef907104e36ec92e252a8b69809/README.md) | 手机挂代理、访问个人空间，由 mitmdump 捕获数据 | 需要手机访问与流量拦截，不是当前可直接运行的无浏览器 HTTP 监控；未配置代理/设备 |
| [skill-douyin-rss-alert](https://github.com/JasonCai2024/skill-douyin-rss-alert/blob/bec588fb3d656a26396638e08c9f444b9eafdf23/README.md) | ASR 和投研简报流程，含付费模型代理 | 不符合采集不调用模型的要求；没有安装 |

另发现 `Xiahanjiu/douyin-rss`，但 README 读取失败，未将它归为已审查可用方案。上述源码临时文件放在 `/tmp`，没有加入生产依赖。

## 官方 HTTP 能力

[查询授权账号视频列表](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/account-video-list) 提供 `GET /video/list/`、分页及视频统计，需要 `video.list` 权限和用户授权。它不是仅凭抖音 ID 即可读取全部账号的匿名接口。

[用户互动数据能力](https://developer.open-douyin.com/capacity-center-page/capacity-detail/7180284622729658424) 包含授权账号的粉丝等数据，并明确使用场景约束及首次授权后数据产生时间。接入前需核对实际应用资格、scope、各作者授权和允许用途。没有应用授权时不发送占位 token，也不以更换接口方式绕过拒绝。

## 已验证的现有路径和本轮修复

- 继续运行已有 HTTP 主页与话题通道、飞书来源同步；不重新启用抖音浏览器。
- 已观察到真实后台快照中的作品 `deferred` 和下一次可请求时间，说明此前微批次共享退避已在运行中生效；这证明请求节奏控制生效，不代表作品数据已采到。
- 用既有飞书用户授权读通六个原始链接的对象/结构，抽查13个工作表；另全量读取一份357条作者登记表。没有把抽样当全量作品读取，也没有把名单读取当身份核验。
- 修复 `readBitable` 将缺失 `has_more` 当成结束，以及将缺失/null/布尔修订号转成数字的问题。只有明确布尔分页标志和有效修订号才继续提交；显式0修订号仍有效，短页 `has_more=true` 必须继续读取。
- 新回归在旧代码下14项中12项失败、2项通过；修复后相关五文件66项全通过。测试没有访问抖音、调用模型或写生产库。

## 仍需完成的能力

1. 完整作品页和最新计数的有效 HTTP 入口仍未验证通过，不能报告全量采集成功。
2. 原表是业务数据来源，须按作品 ID/明确作者 ID 进入统一去重与观测体系。当前原始排名/统计表的持续增量适配仍有缺口；元数据版本检查不能冒充指标已更新。
3. 不凭昵称、页面排序或截图猜 `sec_uid`；已有 ID/来源证据复用应保持冲突、权限和采样日期检查。
4. 新实现先验证身份归属、真实字段、日期与分页，再扩大范围；无效响应、限流、权限拒绝保持为失败或缺测，绝不变为空作品或0播放。


## 第三轮新增实现核查与已落地通道

仍使用 agent-reach 的 GitHub CLI，读取以下固定提交的实现，未安装或执行它们的采集程序：

- [geoqiao/short-video-skills 的 video-data skill](https://github.com/geoqiao/short-video-skills/blob/df7deb8c443340bc1412595cf1691ee6ec5ada1c/skills/video-data/SKILL.md)：文档及 `collectors/douyin.js` 明确依赖已登录Chrome/Playwright，访问当前创作者后台。作品列表最多5页，详细分析最多12条，不能直接证明几千账号的完整覆盖；本项目不启用这条浏览器路径。
- [lucky-Luor/bilibili-douyin-notes](https://github.com/lucky-Luor/bilibili-douyin-notes/blob/a9b9cae97d5c5e80aaba14d4cd6a9e0aabea749d/scripts/douyin_fetch.py)：脚本主要下载单作品视频，包含本地伪造的风控字段和签名逻辑；宣传的免登录不构成全矩阵统计成功证据。没有采用或执行这些逻辑，也没有下载媒体。
- [Xiahanjiu/douyin-rss](https://github.com/Xiahanjiu/douyin-rss/blob/864a6af1fb677134b3bfa744b8856ef5ad786744/app/crawler/douyin.py)：本轮读通实际代码。其HTTP客户端转调已有TikTokDownloader服务，并非独立上游数据源；默认无日期时回填当前时间，不适合直接用于精确日发布统计。可参考订阅增量组织，但未当作解决403的新接口。

同时，已验证的飞书用户授权成为真正的数据接入路径：四份原始工作簿经云端整本读取、前后版本检查、逐表范围检查、备份校验后事务入主库；原件和行版本均保留。现有每日来源worker已自动复查，无模型调用、不打开抖音网页、不新增定时器。数据进入统一经营读模型，重复作品不累计，未证明的指标日期不回填。

这解决的是原始来源自动接入断点，**没有**解决抖音作品接口403。当前真实覆盖、失败和版本证据分别记录，不把原表读取成功算作新的平台作品采集成功。
