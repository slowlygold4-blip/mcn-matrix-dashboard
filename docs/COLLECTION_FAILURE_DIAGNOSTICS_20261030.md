# 采集断点、拒绝停止与回归审查 — 2026-10-30

## 实际问题与修复

B站公开采集的JSON读取器将HTTP状态和业务码包进普通文本，列表路径又有两套重复解析。缺少成功码的对象可能被通用读取器当作成功；导航失败只留下unavailable而没有阶段。逐作品详情拒绝后，同一列表仍会继续请求后续详情。历史真实快照可见works_coverage=unavailable但works_error为空，不能据此定位断点。

- 合并到一个有2MiB响应上限、显式整数成功码检查的读取器；保留固定错误类别及数值HTTP/业务码，不保存远端message、请求URL、请求头或异常字符串。未知业务码保留business_error及原数值，不猜测具体原因。
- 列表区分navigation/list阶段。HTTP 401/403/429、业务拒绝及坏结构立即停止该路径，不再去另一作品入口；仅原有网络/5xx允许同入口最多一次重试。
- 详情明确拒绝后停止本批后续详情；此前核验的作品指标和真实0保留，剩余列表资料照常保留但点赞为空。独立记录请求、有效响应、失败、暂缓数量。响应成功数不等于点赞完整数或全量覆盖。
- 账号总获赞仍只来自主页字段，不采用作品点赞加总。逐作品观察时钟保持上一轮逻辑，列表降级数据保留列表读取时间。
- worksError进入既有快照列和账号详情；调度回执不再把通用作品错误码的保存绑在抖音专用传输策略上，其他平台也能进入已有进度诊断。未知类别收敛为固定unknown，不输出任意原文。

## 验证与运行边界

修改前新增3组离线真实Python/Provider回归全部失败，分别复现状态丢失、阶段丢失和3次拒绝请求。修复后增加中途拒绝保留先前成功项场景；13相关文件153测试在源码与正式目录均通过，含真实Python调用、Provider、内存SQLite保存、调度运行与进度读回，及既有北京日时钟、暂停、取消、退避、来源回执回归。测试不访问平台、不启动浏览器、不调用模型。

首次修复回归另发现空HTTPError测试响应关闭异常，以及旧测试替换的JSON函数不接收关键字参数；已保持数值错误并安全关闭、令夹具转发实际读取器，不弱化拒绝和缺失值断言。

正式加载时先核对无运行采集/作者任务/租约，持原来源互斥，主服务89991→92850一次bootstrap成功，health=ready；来源78254、发布器53721不动。启动备份39表可读、32个清单表计数相同，全部4134目标用户字段及原表来源头保留。只在临时硬链接核查，没有额外完整库副本。

这不是抖音全作品采集恢复声明。平台成功率需要自然采集回执确认，测试成功不能代替实采。本轮没有手动追加平台采样、没有新调度，也没有前端改动；Site仍v138。实时证据与私有日志保存在项目data/maintenance-journal和docs/audits目录。

## 继续核查的新方案

使用agent-reach的GitHub CLI路径搜索并固定源码，未安装、执行或向第三方发送登录态。

- [ferren/douyinpy的数据模块](https://github.com/ferren/douyinpy/blob/141e374b546891e547b44a13f6c4a85084c2f242/douyinpy/client/api/datacube.py) 实际继承BaseWeChatAPI、使用api.weixin.qq.com；搜索中的Douyin名称不能证明它能读抖音粉丝/作品。
- [shortvidieoplatform客户端](https://github.com/flenck/shortvidieoplatform/blob/b1ac0908630739b32acdd614b51732d4bb2114ac/douyin_api.py) 的视频列表/数据方法先检查access_token，携带open_id；不是仅凭公共作者ID即可使用的新来源。未验证该非官方客户端声明的所有接口当前可用。
- [ai-aggregator-app的客户端](https://github.com/wknet123/ai-aggregator-app/blob/c3d3834fce9b6d932e420ccae9fc0f2a6302da27/backend/app/integrations/douyin/client.py) 同样依赖OAuth授权，主要实现上传/发布；没有独立的无授权矩阵统计入口。
- [官方Go SDK](https://github.com/bytedance/douyin-openapi-sdk-go/tree/a50593c5ccdc31ab5b7cb2153947dfad612bbed9) 与jiangwei1995/douyin-sdk固定e943d6bc56c31edd8fee3767b35005cbc2f7525b的README是接口封装入口，不能代替应用权限或每位作者授权。
- [官方视频基础数据文档](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/video-data/get-basic-data/)明确data.external.item权限、用户授权、仅对应用户作品、30天创建窗口及次日刷新；不能把该接口承诺成任意作者全部历史的实时通道。既有隔离官方试验代码保留，未用占位token发请求。

以上核查没有得到可在当前授权条件下恢复抖音全部作品的新通道。后续继续复用真实原表与现有身份证据、按四项指标核验，不以重复包装同一接口或缺失补0提高成功率。
