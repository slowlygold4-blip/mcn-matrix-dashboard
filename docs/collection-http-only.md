# HTTP 与来源同步采集策略

2026-10-29 用户明确停止本机网页/浏览器采集抖音。产品自动通道已关闭，原始资料、登录态文件和历史观测保留，不继续发布浏览器弹窗修复实验。

受管服务设置：

```text
DOUYIN_BROWSER_DISABLED=1
DOUYIN_ACCOUNT_BROWSER_FALLBACK=0
DOUYIN_TOPIC_RESOLVER_MODE=public
DOUYIN_AUTHOR_RESOLVER_MODE=signed-only
```

部署禁用策略优先于单个调用的浏览器 opt-in：账号作品、作者浏览器定位、作品作者线索、授权详情、公开 ID 搜索和话题浏览器批处理均不能启动。独立浏览器作品调度停止；正常 HTTP 主页/作品请求、已核验话题 ID 的 HTTP 详情、表格来源检查与去重入库保留。安装脚本使用相同默认配置，避免重装后自动恢复浏览器方式。

## 请求节奏

持续轮巡不等于无限高速请求。每次请求都应有范围、来源、真实采样时间、超时与退避。HTTP 并不保证免限流；明确拒绝不计为空作品、不补零、不通过反复切换会话制造成功。

单账号微批次会反复创建 provider。此前连续拒绝计数只保存在实例内，可能在达到阈值前清零。现在同一个数据库对象的 provider 共用进程内的 endpoint/transport 策略；已持久化的等待回执仍在每次构造时恢复。三个不同账号的拒绝触发既有等待；同一个账号重复失败不误判为全局故障。作品等待不阻断主页统计和来源入库。独立数据库和显式自定义时钟策略隔离。

这是进程内连续计数与已落盘等待回执的结合，不宣称未到阈值的部分计数在进程重启后也已持久化。

## 已核查公开实现

| 实现 | 核查内容 | 对本项目的含义 |
| --- | --- | --- |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler/blob/68d9ef1c1da22eab75940dfd7cec259907006538/media_platform/douyin/client.py) | 主页与作品分开请求，按 cursor 翻页，逐页回调保存 | 借鉴单账号失败隔离和逐页落地；不能把缺失 has_more 默认成完整结束 |
| [F2](https://github.com/Johnserf-Seed/f2/blob/7dab3e2ffffaa2535834d28fca99dbc2e89fa9d3/f2/apps/douyin/handler.py) | 日期范围、最大数量、游标前进检查；区分游客分页缺失 | 符合增量同步和有界分页；“源码支持”不是本机实测成功率 |
| [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader/blob/473c90ff70c663cfb69310fff2b8d5192f200661/src/interface/template.py) | HTTP 客户端复用、现有会话请求、缺字段与失败处理 | 可评估连接复用及普通已授权 HTTP 会话；仍须逐字段验证来源和权限 |

F2 的 [不完整分页问题](https://github.com/Johnserf-Seed/f2/issues/435) 与 [403 问题](https://github.com/Johnserf-Seed/f2/issues/443) 也已核查。没有把仓库的成功宣传或临时网关占位逻辑当成可靠性承诺，也没有复制其整套依赖或反检测配置。

使用现有已授权会话做过一次隔离的纯 HTTP 作品请求：未启动浏览器、未写生产库、未输出凭据、未使用网关占位头；返回403，停止重试。该路径尚不具备接入条件，不将其报告为成功采集。

## 接下来需要验证的能力

1. 继续筛选官方授权接口、公开 HTTP 实现和可持续的资料来源；先核对字段、权限、登录条件和维护状态，再小样本验证。
2. 以已有作者/作品 ID、日期与最后成功观测为增量索引；同一账号/作品去重，来源表与接口观测融合，保留追溯信息。
3. 优先取得新作品和有效新计数；已知历史尽量复用，避免每天从第一页重复扫完整档案。
4. 有明确授权且实测成功的 HTTP 通道才扩大范围；来源失败与访问拒绝保持可见，不能以假数据或空列表提高成功率。

运行采集、同步、去重与计算不调用模型 API。开发与审查对话仍使用模型额度。

## 验证

`test/douyin-browser-disabled.test.mjs` 覆盖部署策略压过旧 opt-in、直接方法阻断和保留 HTTP 作者定位；`test/public-web-microbatch-backpressure.test.mjs` 覆盖跨实例退避、主页保留、过期恢复与隔离。后者在旧代码下先失败，在修复后通过。均使用合成夹具，不请求平台。
