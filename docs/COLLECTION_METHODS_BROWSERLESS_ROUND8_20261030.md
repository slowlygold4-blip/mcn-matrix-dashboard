# 无本机抖音浏览器：第八轮采集路线与可执行验证

这轮继续查找替代数据入口，使用 agent-reach 的 GitHub CLI 路由及官方文档检索。固定了四个此前未定向审查项目的提交，取回19份文件并核对相关传输、分页及依赖；不是对这些仓库的完整安全审计。没有安装或执行第三方代码、打开抖音网页、调用模型采集、开通或购买第三方服务。

证据：[源码固定版本清单](audits/2026-10-30-browserless-methods-round8/source-manifest.json)、[当前授权就绪检查](audits/2026-10-30-browserless-methods-round8/readiness.json)、[测试与接入状态](audits/2026-10-30-browserless-methods-round8/release.json)。上游源码临时保存在 `/tmp/mcn-browserless-round8`，不把其中示例作者灌入业务库。

## 新找到的候选，核对实际实现

| 项目 | 核验结果 | 当前处理 |
|---|---|---|
| [JustOneAPI Python SDK](https://github.com/justoneapi-labs/justoneapi-python/blob/a41f56244143590cb6d9e83a57c3ddbded7097c6/justoneapi/generated/resources/douyin.py) | 确有独立服务端HTTP作品列表、用户资料、按ID查作品接口，默认服务是 `api.justoneapi.com`。作品列表V3接受 `secUid/maxCursor`；客户端强制供应商Token。默认业务失败不抛异常，HTTP请求还自动跟随重定向，把Token放在查询参数；不能原样作为生产安全封装。 | 是新的数据供应商候选，不是免费的自足爬虫。已读公开JSON示例确认分页字段和20条作品；这不是本项目的真实采样，也不证明完整历史或实际播放字段可用。未注册、购买、调用或外发内部名单。 |
| [MaxHub 抖音 skill](https://github.com/XieWxx/maxhub-api-skills/blob/79447332cd95579372dc0a95487577cc9fb38f6c/maxhub-douyin/SKILL.md) | 所有查询交给 `www.aconfig.cn`，要求 `MAXHUB_API_KEY`。说明有App作品分页、按UID/short_id取用户、批量作品详情；须核实当前额度、字段、授权范围。recipe对“作品列表空”直接输出“暂无作品”，不适合监控完成度验收。 | 记录为可验证的远程供应商路线；未采用其空列表=作者无作品的结论，未安装、注册、调用。单页、批量详情和全作者历史必须分别验收。 |
| [DouFlow skills](https://github.com/ntierj/douflow-skills/blob/0b1fae7b4147668441738247bcdcfab916acfdca/mcp/README.md) | 仓库仅提供skill及配置说明，MCP服务器在桌面客户端内部，不是可以独立运行的公开采集核心。下载/字幕免费入口受客户端额度限制，博主采集另需启用交互式功能。 | 不把“免费skill”当成无人值守、多账号统计接口。不安装未知桌面依赖或恢复本机浏览器采集。 |
| [dyDownload](https://github.com/Everless321/dyDownload/blob/68654add65c86f1961e15a0a90c9f677a4e03bd4/src/crawler/douyin.ts) | TypeScript HTTP实现仍请求 `/aweme/v1/web/aweme/post/`，带Cookie及本地签名；Token失败会生成替代值，请求函数对全部异常最多尝试3次。 | 不是独立新上游，不执行Token/签名逻辑或对已拒绝接口追加尝试。仅换语言无法证明本部署恢复访问；不并入当前采集器。 |

JustOneAPI公开示例是供应商自己提供的样本，只做离线字段核对，检查摘要见 [public-fixture-check.json](audits/2026-10-30-browserless-methods-round8/public-fixture-check.json)。保留 `has_more/max_cursor` 以防把20条示例当作者全部作品；示例中的播放0也不能直接当作本项目可获取真实播放的证据。

## 本轮新增的官方每日数据入口

此前工具支持旧 `data.external.user` 授权。本轮核对小程序的 `ma.user.data` 路线，已单独实现验证入口，没有假设两者凭据互通：

| 官方文档 | URL路径 | 数据字段 |
|---|---|---|
| [获取用户粉丝数](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/data-open/user-homepage-data/get-user-fans-count) | `/api/apps/v1/user/get_fans/` | `date/new_fans/total_fans` |
| [获取用户点赞数](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/data-open/user-homepage-data/get-user-like-number) | `/api/apps/v1/user/get_like/` | `date/new_like` |
| [获取用户视频情况](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/data-open/user-homepage-data/get-user-video-status) | `/api/apps/v1/user/get_item/` | `date/new_issue/new_play/total_issue` |

具体端点只列近7/15天，不含当天；首次授权需到次日才有全部数据。只返回千粉以上作者，不能用这一条路线覆盖全矩阵。账号需要小程序应用实际获批的 `ma.user.data` 和本人授权；`open_id`是应用范围身份，不能拿抖音号或sec_uid替代。计数保留原字段含义，不把 `new_issue` 擅自当作已去重的当天发布作品ID数量，也不把每日播放改成累计播放。

官方[授权文档](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/authorization/tt-show-douyin-open-auth/)的概述描述近30天，但本工具以具体端点的7/15天约束为准。[能力准入页](https://developer.open-douyin.com/capacity-center-page/capacity-detail/7180284622729658424)要求实际业务场景审核；不默认本项目或MCN全部合作作者已获准使用。

## 已写好并测试的脚本

- `lib/douyin-miniapp-daily-probe.mjs`：适配当前双层 `data.data.result_list` 和顶层 `err_no`，复用已有的日期/整数/缺测校验。
- `scripts/probe-douyin-miniapp-daily.mjs`：默认只查就绪状态，零平台请求；显式 `--run --account-key KEY` 才调用接口。
- `test/douyin-miniapp-daily-probe.test.mjs`：12项新回归；包括HTTP200业务错误、错误授权范围、日期跨北京时间边界、缺值与真0、超大正文及错误脱敏。

```sh
# 默认不访问平台，也不输出凭据
node scripts/probe-douyin-miniapp-daily.mjs

# 仅已有合法凭据与权限、确认作者映射后手动执行一次
# 凭据由进程环境提供，不写进命令行、日志或Git
# DOUYIN_MINIAPP_ACCESS_TOKEN / DOUYIN_MINIAPP_OPEN_ID / DOUYIN_MINIAPP_SCOPES
node scripts/probe-douyin-miniapp-daily.mjs --run --account-key VERIFIED_ACCOUNT_KEY
```

单账号串行最多3个GET，固定官方域名，不跟随重定向，不自动授权/续期，不执行浏览器或签名代码，不调用任何模型。401/403/429、HTTP200内业务拒绝和缺字段立即停止；不拿已成功的前一个指标伪装全部成功。实际样本需完成身份绑定核对后再进入现有统一入库，不另建数据板块。

## 验证结果及仍未解决的部分

六个相关测试文件共71项通过；其中12项为本轮新增。当前执行环境和原launchd配置都没有这套新接口的凭据/权限配置，就绪检查为不可用、零平台请求、零数据库写入、零模型调用。脚本已同步到原后台项目，不改动其采集器、定时器或数据库，不重启服务。

现有原表/历史与正常自动采样继续保留。本轮没有采到新的业务作品数据，不能报告全量采集恢复或成功率提升。全作品拒绝、低粉作者覆盖和未关联身份仍须继续处理。四个候选不会被伪装成四条已经验证成功的数据源；后续依据是同一作者的真实回执、分页终止、指标时间与数据入库结果。
