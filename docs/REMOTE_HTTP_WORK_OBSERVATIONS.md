# HTTP 作品回执接入

采集与入库不调用模型。`lib/remote-work-observation.mjs` 接受已由操作者核验的 HTTP 回执，将作品与点赞追加到现有 `posts/post_metrics`，来源证明放在 `account_events`；不新增展示板块，也不修改账号分类、主页统计或旧指标历史。

当前是单账号样本接入能力，**没有启用全量远程采集**。白名单仅包含本轮实际测试的公开演示站。上游演示服务明确不保证可用性，不能配置为日常生产依赖：[项目使用说明](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/README.md)。自行部署或使用其他供应商仍需单独审查授权、资源、来源和稳定性；本实现不购买服务、不导出本机登录态。

## 契约与校验

- 回执：`{targetId, receipt:{source,httpStatus,requestStartedAt,requestFinishedAt,meta,data}}`，`meta.endpoint` 必须为 `douyin.author_posts`，`cached=false`；不接受失败正文或无时间证据的缓存。
- `data.items` 使用 DTK 的 `content_id/created_at/fetched_at/author/stats`。归一化现在优先识别明确的 `content_id`，避免生成临时 ID 或借用普通行号造成重复作品。
- 作者必须与当前有效主页证明中的 canonical `sec_uid` 精确相同。[上游解析器](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/src/dtk/platforms/douyin/parser.py)将 `author.uid` 设置为 `sec_uid`，两种命名空间不能误比；若返回数值 UID 则必须匹配本地证明。不能按昵称匹配。
- 点赞必须为非负安全整数，真 0 保留，缺失不伪造。公开作品页的播放字段不在本通道中认证，写入观察为 `null`。
- 每条指标时间使用真实 `fetched_at`；发布日期独立取 `created_at`，缺失为 null。微秒时钟转为同一毫秒，不以入库时刻改写采样日。
- 单页最多 100 条，重复 ID 的冲突整页拒绝；事务内重新检查账号状态、主页证明和历史作者归属。回执幂等，重放不会增加指标；同回执不同事实拒绝。
- 仅保留必要作品字段，不保存媒体下载地址、Cookie、Authorization、任意原文错误或第三方账号凭据。

## 安全执行

首先核对操作者捕获的 HTTP 回执来源；这个命令的校验不能代替真实 HTTP 来源审查，也不是供不可信客户端上传数据的公共 API。

```sh
# 默认只读预检，数据库文件必须已存在
node scripts/admit-remote-work-page.mjs --receipt /absolute/receipt.json --database /absolute/monitor.sqlite

# 明确提交已核验的样本；生产写入前应先验证既有一致性备份
node scripts/admit-remote-work-page.mjs --receipt /absolute/receipt.json --database /absolute/monitor.sqlite --commit
```

不要把凭据放在命令参数或回执中。命令本身没有网络请求、定时器、浏览器或模型调用。

## 覆盖与每日发片

列表响应的 `has_more=false` 只作为原始分页证据留存。本阶段统一记为 `limited`，不生成“每日发布 0”，也不将主页作品存量差当发片量。确认每日发布数量还需要完整分页、作者范围、同日观察及库存差异的审查；分页结束不代表这些条件全部满足。

新指标可进入已有按作品 ID 的日对比。昨天缺测仍显示缺基线，不能以旧发布日期或今天入库的时间补造昨日点赞。测试包含跨北京时间午夜、真 0、去重、缺值、身份错误、暂停、缓存、冲突事务及凭据排除，均不代表全部作者线上成功。
