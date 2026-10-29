# 不依赖本机抖音浏览器的采集方法核验 · 2026-10-30

这次新核验 8 个 GitHub 仓库、31 份固定提交版本文件，包含 skill 本身及其实际依赖服务。没有安装或执行这些第三方代码，没有新增采集定时任务。已有表格同步、账号采集与本轮隔离探针均不调用模型。

## 本轮找到的路线

| 路线与代码证据 | 实际能力与限制 | 本轮处理 |
|---|---|---|
| [yunsur/douyin-mcp-skills](https://github.com/yunsur/douyin-mcp-skills/blob/5f19f34c635f15064ce670a3ef43695b0fe6fbbc/skills/douyin-user/SKILL.md) + [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp/blob/7e90d139007f141cb7389aa509d8e6e67f7b5840/douyin/api_user.go) | skill 提供账号资料与作品翻页工具；实际 Go 服务使用 HTTP、Cookie 与客户端签名，并非免费的官方无授权接口。skill 的全量功能说明不等于真实全量覆盖。 | 保留为单页隔离评估候选；源码的全量函数遇到缺少 aweme_list 会直接返回已有结果，且没有循环游标检测或作品去重。客户端还有 TLS 模拟及验证重试。不能直接照搬全量函数；未安装、未运行、未提供登录态。 |
| [Johnserf-Seed/f2](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/f2/apps/douyin/crawler.py) | Python HTTP 采集、作品翻页与字段处理可研究；其请求构造仍依赖客户端签名和 Cookie。纯 HTTP 不等于不会限流。 | 阅读实际请求链；未将一个未经实测的库替换进正式采集。 |
| [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/src/dtk/platforms/douyin/endpoints.py) | 端点表明确区分作者作品首屏和后续页的登录要求，代码注释也记载后续页可能返回没有作品列表的空成功结构。它同时含身份池等机制。 | 采用“首屏成功与全量分页成功必须分开”的验收原则；不采用身份池、代理轮换等行为。 |
| [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler/blob/68d9ef1c1da22eab75940dfd7cec259907006538/media_platform/douyin/client.py) | 当前客户端含 Playwright 参数及特殊验证头；该版本说明头部用于应对验证网关，不能直接视作你要求的无浏览器稳定采集方案。 | 不执行这条验证处理，不开启浏览器。 |
| [mashukui/douyin_one_spider](https://github.com/mashukui/douyin_one_spider/blob/dce7e2bbcd2c84f66716ce76de92bd63c1b3731a/src/douyin_user_post.py) | 公开源码中 get_user_post 标注“专有代码已移除”；GUI 和功能宣传不能证明公开代码具备可接入的核心采集器。 | 排除作为直接可用实现，避免无效安装。 |
| [ldsoy/douyin-video-parser](https://github.com/ldsoy/douyin-video-parser/blob/2ebcb268d706a392de77301855aba9306d04cc84/src/parser.ts)、[ucmao/media-parser](https://github.com/ucmao/media-parser/blob/d425c1f7ae2ef295fc58d3aa8f2bfad361686ea5/src/parsers/douyin_parser.py) | 分享页 HTML 可能携带作品 JSON，适合对已知作品 ID 做补充观测；不能枚举某作者的全部新作品，也不能保证分享页播放字段就是后台真实播放。 | 独立重写了有界、无浏览器的只读探针，完成真实请求与合成测试；结果如下。 |

## 新写工具及真实试验

文件：`lib/douyin-share-metadata-probe.mjs`、`scripts/probe-douyin-share-metadata.mjs`、`test/douyin-share-metadata-probe.test.mjs`。

```sh
# 只检查工具，不发网络请求
node scripts/probe-douyin-share-metadata.mjs
# 显式只读试验一条已知公开作品；不会触发全量采集
node scripts/probe-douyin-share-metadata.mjs --run --content-id PUBLIC_VIDEO_ID
```

固定移动端 HTML 格式请求并标识探针；不启动浏览器，不读取/生成 Cookie，不生成签名，不请求媒体。每次总超时 20 秒、正文上限 2 MB，最多 3 个经逐跳校验的同作品官方域名跳转。403/429/登录或外部跳转停止，不做身份切换或重试。JSON 仅解析，不执行页面 JavaScript；按字符串作品 ID 精确匹配，支持额外作者 sec_uid 一致性验证。统计缺失保持 null，原始播放字段只保留为未验证证据，不当真实播放入库。

真实试验涉及两个已有作品 ID，其中一条在当前库有近期平台记录。首次普通格式遇到跳转；加入受控规范跳转后普通格式只拿到空页面。固定移动格式可找到 JSON 容器，但没有作品记录。最近一次证据为：HTTP 200、32,512 字节、1 次请求、1 个匹配路由、0 条作品。**不是网络报错，也不是成功采到空作品列表；该样本没有形成任何新统计观测。** 未开启全量试扫，未将该探针接到生产调度。

合成回归共 24 项通过（新探针 12 项、已有官方视频探针 12 项），覆盖精确身份、缺失/零值、原始播放不冒充真实播放、异常结构、正文限制、超时/取消、拒绝跳转、分页试验及错误脱敏。这些测试不证明平台采集成功，更不证明所有作者作品已覆盖。

## 继续推进的官方数据路线

- [用户互动数据能力](https://developer.open-douyin.com/capacity-center-page/capacity-detail/7180284622729658424)：明确提供授权账号的每日粉丝、发片、播放、点赞等数据，与长期增长监控更直接相关。需要企业等合格开发者申请及账号授权，首次授权后次日才产生完整数据；不能把旧版“视频列表接口”当作这些每日指标的替代。
- [经营授权的近30天视频数据](https://partner.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/basic-abilities/video-id-convert/user-recent-video-data/get-share-bc)：企业机构号绑定能力与经营关系授权后可查询对应账号，存在视频年龄和更新时间限制。它不是查询任意抖音号的公共接口。
- 已有的 `scripts/probe-douyin-open-api.mjs` 保留独立授权试验入口；没有真实获批权限及授权数据时，不伪造成功样本。不能将普通抖音 ID、公开 sec_uid 和应用 open_id 混用。

现有原表、公示表、作品登记及带时间观测继续作为正式数据来源，使用既有同步/去重链路；不能因为平台接口受限而忽略它们，也不能把后来观测的累计值伪造成过去每天的变化。

## 结论与下一项验收

尚未找到并实证“匿名、免费、无浏览器、可以稳定全量覆盖数千作者”的路线。这里列出实际候选和失败点，不宣称不存在其他方法，也不将换库或换 skill 名称算修复。继续核验 Go HTTP 服务时只评估明确授权的单页数据，不执行其验证重试；全量入口必须先补齐错误响应、循环游标、去重和总请求上限。官方每日指标路线需独立核实获批能力与作者授权。各自必须取得匹配作品/账号的真实样本，证明分页、采样时间与字段，再进入统一入库和生产调度。

更换本地浏览器为 HTTP 能降低渲染开销；同一网络出口仍可被平台限流。MCP 也可以由普通脚本调用，运行采集本身不需要 LLM，但不会自动授予平台数据权限。
