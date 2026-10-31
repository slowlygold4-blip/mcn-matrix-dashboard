# 日常指标审查命令与公开数据回读

`npm run audit:product-state` 是只读的本地脚本，不触发采集、浏览器或模型。使用项目要求的 Node 24 运行；退出码 0 只表示列出的结构不变量通过，不代表四项日常监控全部完成。

本轮补齐其命令输出中的 `dailyProfiles` 和 `dailyWorkLikes`，分别查看粉丝、主页总获赞、逐作品点赞的当天观测及相邻日可比数。缺少相应存储结构时输出 `null`，不能当成已成功检查的零。每日实际发布情况仍按统一作品索引的精确作品 ID、明确发布日期及列表覆盖核验，不能从作品库存净差代替。

修复了两项实际误报：

- 来源数量分别报告当前登记、历史清单、合并库存和仅历史清单条数；复用现有来源检查器，不把历史收据数量称为当前登记数量，也不隐式删除历史来源。缺少登记目录时报告未知和错误，不显示成功的零。
- 最近七天记录按实际 UTC 时间比较上下界，再转北京时间分日。旧代码会把带时区偏移的过期记录和未来记录计入；现在未来记录仍列为数据不变量问题，但不进入统计。

新增三项回归先复现失败，再修复通过。源目录和正式目录各 36 项相关测试通过，临时数据库逐字节保持不变；真实只读审查另外核对了当前来源数量和独立日采覆盖。没有重启服务或改写业务数据。

V18 数据代际已由原发布器成功激活并完成匿名网络回读：核对 11 个分区的字节数与 SHA，新增原表的 8 个直接作品 ID 均在统一作品分区中，明确发布日期及切片分类保留。日期台账和账号投影也通过核对。此结果证明原始数据已合并并公开，不能证明当天逐作品点赞采集已恢复。

继续核对的 GitHub 实现：

- [yt-dlp 的 DouyinIE](https://github.com/yt-dlp/yt-dlp/blob/b77c9304e1c4220cca450c583491904daf8455af/yt_dlp/extractor/tiktok.py) 仍调用网页详情接口，无详情时要求新会话；没有提供已经验证可用的无会话替代入口。
- [douyin-hunter](https://github.com/TeamWiseFlow/xiaobei/blob/47aea0be00db5f86e27615224e45e558d737d9ee/crews/main/skills/douyin-hunter/scripts/douyin_hunter.py) 经共享 [HTTP 客户端](https://github.com/TeamWiseFlow/xiaobei/blob/47aea0be00db5f86e27615224e45e558d737d9ee/crews/main/skills/_shared/douyin_utils/http.py) 依赖 API 会话及 relay_sign，不是独立的免授权入口。
- [hujinhao123/douyin-api](https://github.com/hujinhao123/douyin-api/blob/c4b3e5de8fa13feea28aae0545f70dfed1f3fec2/README.md) 明确依赖真实浏览器签名、二维码登录和会话，并说明不适合大规模采集。

只读审查了上述代码，未安装执行、导出会话或采用签名绕过。官方逐作品授权入口仍需真实有效授权；没有把搜索结果、方法名称、历史数据恢复或绿色测试当作全量采样成功。
