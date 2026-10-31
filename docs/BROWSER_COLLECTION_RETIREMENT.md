# 本机抖音浏览器采集已停用

用户选择不再通过本机抖音网页采集。此前部署开关只保护后台 Provider；独立脚本和连接命令没有同等保护。现在以下入口统一返回非零退出码及 `DOUYIN_BROWSER_RETIRED`，在读取标准输入、登录态或启动浏览器之前结束。旧环境变量和上传参数不能重新启用这些命令。

- `scripts/douyin_browser_resolver.mjs`
- `scripts/douyin_browser_collector.mjs`
- `scripts/douyin_topic_browser_resolver.mjs`
- `scripts/douyin_authorised_detail.mjs`
- `scripts/douyin_public_id_search.mjs`
- `scripts/douyin_work_author_candidate.mjs`
- `scripts/connect-douyin-topics.mjs` / `npm run connect:douyin-topics`

删除了作者浏览器解析、话题浏览器搜索和登录引导中的实际页面执行逻辑。作品采集及身份核验库不再导入或隐式启动真实 Playwright；只保留显式注入的离线测试操作。注入接口用于程序测试，不是远程输入可用的授权机制；不得向其中注入真实浏览器来恢复已停用的功能。

旧父进程若已将命令放进私有所有权通道，拒绝入口只确认 `hello/complete`，不声明启动、注册或释放过浏览器。这样可在拒绝之后释放本次队列通道；真实协议异常仍由监督器保持锁定。监督器保持原有行为：非零退出时不返回子进程输出。

历史 URL/话题/作品响应解析、分页、身份回执和来源指纹校验继续保留。旧身份协议的进程清理回归改用 `test/fixtures/retired-authorised-detail-cli.mjs` 的离线夹具，并由测试加载器注入模拟浏览器。生产 Provider 不引用该夹具。没有删除登录态文件、原件、用户修改或历史观测。

现有公开/已授权 HTTP Provider、来源表同步、统一去重入库、日计算与公开发布继续各自运行。这些运行时操作不调用模型。无浏览器接口仍需真实权限；停用旧命令不等于缺失的逐作品日采已经补齐。

日常验收以 [四项监控标准](DAILY_MONITORING_ACCEPTANCE.md) 为准：粉丝、单作品点赞、主页总获赞、按作品实际日期去重的每天发布情况，各有独立覆盖与缺测状态。

验证包括：7 条真实 CLI 子进程在故意保持 stdin 打开、启用旧环境变量时仍立即拒绝；测试加载器阻断任何真实 Playwright 启动；库默认路径在读取会话前拒绝；原纯解析、模拟生命周期和既存身份回执继续回归。模拟结果不能当成平台采集回执。
