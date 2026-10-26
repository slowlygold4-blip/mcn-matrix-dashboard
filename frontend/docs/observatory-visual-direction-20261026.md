# 矩阵工作台：空间视觉与交互升级

## 参考核对
用户视频 https://www.douyin.com/video/7667416314029411594 。2026-10-26 通过视频章节与评论交叉核对五站；自动章节转写的 universe / enemies / astonity 不作为正确拼写。

| 网站 | 本轮查看的方向 | 在工作台的落位 |
|---|---|---|
| [MotionSites](https://motionsites.org/prompts/design-world) | 空间主体、细线网格、标题层级；另看 Data Signal / Forecast Center | 标题右侧独立空间插画、紧凑数据层级 |
| [React Bits](https://reactbits.dev/backgrounds/particles) | 粒子三维位置、透明度和鼠标视差 | 原创 72 点投影球体，限 30fps，小面积装饰 |
| [Uiverse](https://uiverse.io/ui/animated-buttons) | 按钮 hover / pressed / focus 状态 | 导航、采集按钮、快速定位的明确反馈 |
| [Anime.js](https://animejs.com/) | 滚动进入、stagger、SVG 动画节奏 | 沿用现有控制器：只播放一次，不隐藏待加载内容 |
| [Aceternity UI](https://ui.aceternity.com/components/3d-card-effect) | 空间卡片；另看 Glowing Effect / Liquid Glass | 卡片轻抬升、玻璃细边、柔和边缘光，正文保持平面 |

GitHub 同时检查 https://github.com/DavidHDev/react-bits 和 https://github.com/juliangarnier/anime 。本轮不安装第三方动画库、不复制付费源代码。MotionSites 部分完整提示词需要登录/订阅，仅查看公开预览；不声称取得完整付费提示词。

## 可复用的项目提示词（原创）

为现有 MCN 矩阵数据后台做空间感视觉升级，保留全部数据契约、筛选、排序、分页、账号详情和公开/管理权限。

采用石墨黑画布、低饱和紫色导航强调、青色增长与粉色下降。顶部是真实采集覆盖和全量采集按钮；其后是工作区标题、全局筛选、增长/趋势/发片/作者的快速定位。作者总人数突出，能计算变化的人数与待关联人数清楚列出。增长指标、真实曲线、贡献榜、作品每日发布图按任务顺序呈现。来源和计算说明可展开，异常不可隐藏成成功。

仅在标题右侧加入轻量三维粒子轨道：装饰不承载统计意义、不挡文字，鼠标只引入轻微视差。卡片 hover 上移 4px，边缘亮度增加；按钮按下回落 1px。入场约 0.8 秒，每节一次，数字直接显示真实值，不滚动编造计数。图表保留断点、键盘访问与精确值，空数据仍为缺测。

不使用滚动劫持、不用全屏视频、不引入多处 WebGL。粒子不超过 80 个、最高 30fps、DPR 不超过 1.5；离开视口或隐藏标签停止。提供动效开关并尊重系统减少动态效果。手机采用单列，表格有自己的横向滚动，页面不得溢出。

## 实现范围
- `observatory-atmosphere.tsx`：投影粒子、动效设置、快速定位。
- `observatory-field.mjs`：纯几何计算与运行条件；不接收业务数据。
- `observatory.css`：全站导航/标题/过滤/作者/指标/表格/话题视觉统一，手机与打印适配。
- `collection-console.tsx`：24h 真实覆盖保留，详细断点归入可展开诊断，问题数始终可见。
- `page.tsx`：修正总览缺少“全部主题”选项，防止下拉显示与真实 scope 不符。

## 边界
此次前端更新不会改变作者或作品原始数据，不触发额外采集，也不把“部分作品”改成“完整”。脚本采集仍独立运行。后端作品接口的遮挡/未发请求缺口仍需后续针对性修复，不能用视觉更新宣称采集已完全解决。
