# 主页数据采样：免签请求与严格成功判定

日常粉丝和主页总获赞继续从已工作的公开 HTTP 主页接口采集。此次修复只涉及主页，不把它解释成逐作品采集已恢复。

旧代码在任何主页失败后都改用签名请求，既增加请求，也可能掩盖最初的403、429或业务拒绝。现在主页只走原有免签请求；失败保留失败，不改签名、Cookie、浏览器或请求身份重试。成功响应的字段、真实零值和 `guest-ttwid-unsigned-profile` 来源名称保持原样。

采样需同时满足：原官方 HTTPS 主页接口返回；明确整数 `status_code: 0`；没有明确登录或验证标志；非注销账号严格回显请求的 canonical sec_uid。缺状态、布尔/字符串状态、异常重定向、HTML校验页或缺失身份均不能提供新的账号指标。注销状态继续沿原生命周期流程保留，不写成零粉丝。HTTP401/403/429及部分响应后的传输失败保留明确拒绝类别，错误正文不写入诊断。

历史签名来源名称仍由原验证器兼容读取。此次不改写旧快照、来源指纹、身份回执和作者关联；新请求停止签名回退，不等于否认此前已经核验的旧证据。

## 本次单作品 HTTP 调查

使用 agent-reach 的 GitHub CLI 检查了固定版本的以下源码，未安装或执行第三方采集器：

- [free-video-downloader](https://github.com/liyupi/free-video-downloader/blob/6783636e03e91b0beb82683d955beb475d7e66cc/backend/douyin.py)：公开页解析之外还含脚本挑战求解和 Cookie 重放；其播放字段还会退回点赞值。不能直接采用为实际播放或免校验采集。
- [douyin-wm-downloader](https://github.com/gdSHAY/douyin-wm-downloader/blob/a47a6bd66f1f76f312f4c81b31c6bb8bd590d2ce/douyin_parser.py)：说明写无需Cookie，实际代码维护会话、预热取得Cookie并在空数据后重试。不能仅依赖README判断可用性。
- [sharextract](https://github.com/wuaishare/sharextract/blob/9934bdd16f2804c3ee956569138f81313d01c8a5/sharextract/extractors/douyin.py)：复核此前公开单作品页面候选，并检查正常重定向，而非到302就判定平台拒绝。

本轮对仓库公开样本做一次有界检查：精选页面302正常重定向到同一作品官方页面，后者200但正文无作品ID、点赞字段、SSR数据或JSON-LD，含脚本Cookie校验代码。因此停止，不执行脚本、不求解挑战、不换身份重试、不下载视频、不入库。共2个HTTP请求，无浏览器、Cookie、签名或模型调用。这不是新的有效作品观测，当前逐作品日采缺口仍在。

已保存响应的独立检查也未发现可回收作品：本轮检查时，当日4736份已存快照内嵌作品数组计数为0。此数字是检查时点的证据，不是永久总量或全量采集证明。
