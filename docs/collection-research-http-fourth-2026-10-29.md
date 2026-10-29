# 无浏览器采集：第四轮源码与 skill 核查

2026-10-29。通过 agent-reach 的 GitHub CLI 路线继续搜索、固定提交、读取实现和问题记录。本轮核查下面 10 个仓库，包括继续追查此前 skill 对应的实际服务。未安装这些项目、执行其中代码、启动抖音浏览器、购买接口或调用模型采集。

## 实际读到的能力与缺陷

| 固定源码 | 真实能力 / 前提 | 接入判断 |
| --- | --- | --- |
| [erma0/douyin](https://github.com/erma0/douyin/blob/c26d3ac30711c2864d5d5eec8b44e8d8300b5833/README.md) | 当前树只有 README；原实现已移除 | 搜索摘要仍称支持账号/话题，不能据此安装或报告采集可用 |
| [loadchange/amemv-crawler](https://github.com/loadchange/amemv-crawler/tree/3faec40ce5f5556a335df2c2563cb1c59b0f845a) | 分享用户/话题下载方案；该提交实际为 2019-10-02 | 仓库 updatedAt 很新不等于代码刚更新，旧接口不能直接作为当前可靠通道 |
| [ShilongLee/Crawler](https://github.com/ShilongLee/Crawler/blob/e7dea2895483f94499147ce13bf23f3a5864859a/service/douyin/logic/user.py) | Python HTTP 请求主页和作品，依赖 Cookie；作品仍用 `/aweme/v1/web/aweme/post/` | 中途请求失败直接返回已有作品，缺失 `has_more` 默认结束；没有游标停滞上限。不能把这种结果当全量成功 |
| [该实现的 common.py](https://github.com/ShilongLee/Crawler/blob/e7dea2895483f94499147ce13bf23f3a5864859a/service/douyin/logic/common.py) | 请求构造包含随机会话字段，日志打印完整 headers | 不照搬凭据日志或拒绝后的身份处理；维护者也在[维护计划](https://github.com/ShilongLee/Crawler/issues/86)中说明部分平台实现长期未维护 |
| [Yym11345/douyin_skill](https://github.com/Yym11345/douyin_skill/blob/716494967867361d7f812a94ada3ad15a8158ed7/scripts/adapters/douyin.mjs) | 实际有独立 HTTP 适配器，不只有提示词；主页与作品分页 | 与当前同一作品接口；默认最多 50 页，缺失分页标志视为结束，缺失粉丝/互动补 0，缺主页获赞时用样本点赞代替；403被列为可重试。不能直接作为准确全量监控 |
| [xiaoyiv/douyin-skill](https://github.com/xiaoyiv/douyin-skill/blob/760a1c5414a213751e66f6c713717789b361199a/SKILL.md) | 单作品下载/信息提取；nodriver 浏览器登录 | 不符合用户关闭浏览器采集的要求；下载成功也不证明账号每日指标完整 |
| [yunsur/douyin-mcp-skills](https://github.com/yunsur/douyin-mcp-skills/blob/5f19f34c635f15064ce670a3ef43695b0fe6fbbc/skills/setup-douyin-mcp/SKILL.md) | skill 包装实际 Go 服务，需要本地 Cookie | 本轮继续追到下面的 Go 源码，没有把 skill 文案当能力证明 |
| [yunsur/douyin-mcp](https://github.com/yunsur/douyin-mcp/blob/7e90d139007f141cb7389aa509d8e6e67f7b5840/douyin/api_user.go) | Go HTTP 客户端、会话复用、作者与作品接口；不必逐账号开页面 | `GetUserAllWorkInfo` 对缺失列表直接结束、没有游标循环退出证明；部分测试使用 mock HTTP，不能当本项目线上成功率。作品仍为同一 endpoint。会话/传输层另含挑战处理，未执行或接入该部分 |
| [zJay26/douyin-skills](https://github.com/zJay26/douyin-skills/blob/09e9ccb6c484c59d69e11dbb4bc975c47e5510e5/README.zh-CN.md) | 本地 Chrome/CDP 驱动；明确区分合成演示和实际线上验证 | 可参考结果状态和验证边界，但不是无浏览器的新数据来源，不安装 |
| [ErisYoung/douyin_spider](https://github.com/ErisYoung/douyin_spider/blob/0d6c93db9b28da8eb7c7ac9a3d1f71ff3d56d6d8/douyin_spider/models/challenge.py) | 分享话题作品的旧分页实现；该提交实际为 2019-07-03 | 不是当前话题参与人数/播放量双指标的新通道；缺失分页字段不能视为完整结束 |
| [bekoxue/douyin-collector-skill](https://github.com/bekoxue/douyin-collector-skill/blob/0bf7b8bfda386e6e6ce7034c105545fd67089128/SKILL.md) | 名称和功能接近需求，但明确 `COLLECTOR_API_KEY`、按量计费、设备绑定 | 不符合免费、无付费密钥要求；未注册、付费或配置令牌 |

## 对当前工程的实际验证

当前现有分页、浏览器禁用、作品详情停止策略、跨微批次退避、已存主页身份校验使用离线夹具重新验证。没有用这些测试代替新的平台成功采样，也没有为“测试成功率”反复向被拒接口发请求。测试日志在私有本轮审查目录。

额外只读核查原始来源明确的 UID 与已存主页响应：2,408 个来源 UID 中 2,144 个出现唯一目标候选；按明确作品 ID 回溯来源作者后，仅 5 条当前未关联作者行有唯一候选。这是尚未通过全部校验的候选，不是新增作者或已启用监控。没有混淆 UID、抖音号、sec_uid，生产写入为 0。

这轮没有发现已经验证能解决当前作品 403、同时符合全部约束的新通道。该缺口继续保留，不能用“找到仓库”改写为采集成功。

## 后续接入顺序

1. 优先复用原表明确的作品/作者身份与已保存响应；补接前验证原件哈希、身份命名空间、归属、时间与冲突，避免再次向平台请求同一证明。
2. 已验证的原表自动同步继续进入同一数据库和作品经营统计；不是另立查看板块。
3. 对真正独立的新 HTTP 入口，先核对身份、实际指标、分页和访问条件，隔离验证后再扩大；403/429/登录要求保持失败或等待，不能用空数组提高成功率。
4. 独立维护主页统计、完整作品、话题双指标的覆盖；运行脚本不调用模型。继续搜索时复用本报告与固定源码清单，避免反复安装同一底层的不同包装。
