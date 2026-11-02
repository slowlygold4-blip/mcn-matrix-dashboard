# 远端公开作品能力测试

这是一项一次性、手动触发的项目集成测试，不是全量采集器，也不是新定时任务。它验证标准远端浏览器是否能正常读到公开作品和作者第一页作品统计；失败应保留失败，不能以CI运行成功冒充取得数据。

## 为什么单独验证远端

此前实测的HTTP服务确实返回过数据，但其[抖音访客会话实现](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/src/dtk/identity/minting/client.py)仍依赖远端浏览器。它的[部署文档](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/documents/en/01-quickstart.md)也列出了浏览器容器的额外资源开销。不能把一个HTTP入口宣传成整条链路无浏览器，更不能未经审查把整套容器装在用户电脑上。

本测试使用[GitHub公开仓库的标准免费运行器](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)，按[Playwright官方CI方式](https://playwright.dev/docs/ci)仅在远端安装固定版本Chromium。用户电脑不安装、不启动抖音浏览器。标准运行器免费不意味着它已经适合长期海量采集；本轮不将Actions配置为生产采样调度。

## 固定范围

- 只有`workflow_dispatch`，单作业、并发上限1、最多6分钟、只读仓库权限；官方Actions固定提交，Playwright固定1.64.1。
- 只有仓库上游公开样本作品7660369906369629476；作者只能从该公开作品响应读取，不能输入内部名单、私有账号资料或生产凭据。
- 只监听正常网页请求和已知公开HTML数据，不执行手写签名、私有API重放、隐身/指纹补丁、代理轮换或验证码处理。不登录，遇到拒绝或访问门禁停止。
- 仅观察作者第一页，成功也保留`completeAuthor=false`；缺点赞/日期、错误作者、HTTP200业务拒绝都不能报为成功。
- 产物只含有界公开指标、时间与状态，保留1天；不输出Cookie、请求头、签名URL、HTML、媒体下载地址、浏览器登录态或内部资料。
- 脚本在macOS或自托管环境主动拒绝启动；本地单元测试只校验纯数据函数，不加载Playwright或启动浏览器。

## 执行与验收

```sh
gh workflow run remote-public-work-smoke.yml --repo slowlygold4-blip/mcn-matrix-dashboard --ref main
# 取得本次runId后只轮询该run，不因观察超时而重启任务
gh run view RUN_ID --repo slowlygold4-blip/mcn-matrix-dashboard
```

结果以`public-work-capability`产物中的`mcn-public-smoke.json`为准。只有真实详情和绑定作者列表均取得指标，状态才为`verified-public-list`；普通网页打开、包安装完成、部分HTTP200或进程退出都不能代替该证据。它不写入业务数据库、不调用模型、不改变本机采集服务，也不能证明四千多账号的成功率。
