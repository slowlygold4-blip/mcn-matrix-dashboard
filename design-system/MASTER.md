# Design System: 抖音监控工作台

## Color Palette

| Token | Value | usage |
|---|---|---|
| --primary | #566342 | 苔藓主色，导航与主要状态 |
| --secondary | #879278 | 鼠尾草绿，次要图形 |
| --bg-main | #E7DDC9 | 砂岩主背景 |
| --bg-card | #F4EDDF | 燕麦容器背景 |
| --text-main | #2E3228 | 标题与主要文字 |
| --text-muted | #6D7064 | 辅助信息 |
| --accent | #C5633D | 陶土橙，主要行动与异常 |
| --danger | #9E3F32 | 错误与失败 |
| --success | #3F6B4B | 已校验与健康状态 |
| --line | #C9BFA9 | 分隔线与边框 |

## Typography

- **Headings**: Bricolage Grotesque, PingFang SC, sans-serif (600–700)
- **Body**: PingFang SC, Noto Sans CJK SC, sans-serif (400–600)
- **Scale**: H1 clamp(2rem, 4vw, 4.4rem); H2 clamp(1.3rem, 2vw, 2rem); body 0.95rem

## Spacing & Layout

- **Container**: 1600px
- **Radius**: 6px / 14px / 26px / 999px
- **Spacing unit**: 5px base with deliberate 7px, 13px, 22px, 34px, 55px rhythm
- **Dashboard grid**: 5fr / 7fr asymmetric composition

## Effects

- **Shadow**: 0 18px 60px rgba(61, 53, 39, 0.09)
- **Transitions**: 240ms cubic-bezier(0.22, 1, 0.36, 1)
- **Texture**: low-opacity inline SVG grain over sand background

## Anti-Patterns

- 不使用假指标、演示账号或占位趋势。
- 不使用霓虹色、纯白背景、商业蓝与对称三栏卡片。
- 不让所有区域都悬浮或都有阴影。
- 不加载远程字体、图表库或运行时 AI 服务。
- 不把采集失败显示成“0”，必须显示缺失原因与审查状态。
