# Mock 验收与后续开发

## 1. 目的和边界

本阶段目标是在不触发真实支付、链上转账或生产 `new-api` 写入的前提下，走通 Telegram 用户可见的完整流程。Mock 证明 Bot 的交互、状态迁移、请求合同和防重复处理；它不证明商户、链上节点、资产归集或生产部署已就绪。

所有本地验收使用独立 SQLite 数据库、本机 Mock Bridge 和 Telegram 私聊。Mock 的收款地址、checkout URL、订单号和到账状态均为虚构数据，严禁用于转账。

## 2. 当前 Mock 合同

`npm run mock:bridge` 启动本机 Mock Bridge。Bridge 路由校验与生产 Contract 相同的 HMAC 请求签名、五分钟时钟窗口和单次 nonce；默认 `MOCK_BRIDGE_SECRET` 为测试值，联调时必须显式设为 Bot 的 `NEW_API_INTEGRATION_SECRET`。它提供下列隔离行为：

| 用户流程 | Mock 行为 | 关键验收 |
| --- | --- | --- |
| 欢迎、绑定与账户 | 返回 Pro 用户组、当前余额、历史已用额度与请求数 | 欢迎页区分未绑定/已绑定；账户显示与网页币种一致；不展示密钥 |
| 用量与订阅 | 24h、7 天、30 天返回不同用量；返回 active 与 expired 订阅 | 时间范围切换、额度格式、订阅状态和到期时间可见 |
| 公告与通知设置 | 返回明确的 Mock 公告；Bot SQLite 持久化通知偏好 | 公告不含敏感数据；阈值、暂停和恢复状态可回读 |
| 中英语言 | 默认遵从 Telegram 语言；选择后持久保存 | 重新发送 `/start` 后保持选择 |
| 可用模型 | 返回按账户视角分页的模型与端点类型 | 不返回渠道、API Key 或后台全量配置 |
| API 接入与 Key | 返回 Base URL、授权模型分组和掩码 Key；可创建、启停、删除 | Bot 不返回完整 Key，重复确认只得到同一条 Key 元数据 |
| 模型广场 | Telegram 链接至 `https://supertoken.cc/pricing` | 价格细节以网页模型广场为准 |
| 支付宝/微信 | 创建 Mock checkout URL 和二维码 | 重复回调不重复建单；状态可刷新 |
| 稳定币 | USDT/USDC + BSC、Ethereum、Base、Solana 可选组合 | 只展示收款地址，不发送二维码；地址、币种、网络和确认数在同一订单中锁定 |
| 链上状态 | 第一次查询 `processing`，第二次查询 `success` | Bot 能显示确认中、到账和过期/失败分支 |

Mock 将四条网络都展示为支持 USDT 与 USDC，用于验收完整选择流程；BSC、Ethereum 和 Base 使用 `0x...` EVM 格式模拟地址，Solana 使用 Base58 格式模拟地址。真实阶段必须以托管/监听服务实际支持的代币合约为准，不能根据链名称或 Mock 选项假定某个代币可入账。

## 3. 模型与定价设计

已核对官网公开 `GET /api/pricing`：它返回模型倍率、固定价格、端点类型、缓存倍率和部分图片/视频的动态计费信息。

不能仅根据模型名报出“真实价格”，原因是实际结算还受输入/输出 token、缓存、图像/视频参数、用户分组倍率和计费表达式影响。设计分层如下：

1. Bridge 模式的 Bot 模型列表只展示当前账户可用模型和端点类型；该接口没有返回按账户计算的价格，不能自行推导成用户报价。
2. 原生 `admin` 模式的公开目录可展示静态模型的公开最低标准价：输入/输出按 `model_ratio × 2 × 最低公开分组倍率` 计算，按请求模型按 `model_price × 最低公开分组倍率` 计算；展示货币遵从公开状态配置，额度显示为 tokens 时仍显示法币。动态/分级计费只提示前往 `https://supertoken.cc/pricing` 查看完整规则。
3. 所有公开价格必须标明“不是账号报价”。实际可用模型、模型组价格和最终结算仍以已登录网页和 `new-api` 扣费记录为准。
4. 估算器必须收集模型、端点、输入/输出 token 或媒体参数，并明确显示“估算，不是结算承诺”。
5. 唯一的最终结算来源是 `new-api` 的实际扣费逻辑和用量日志。

`new-api` 新增的 `POST /api/integrations/telegram/v1/models` 只按已验证 Telegram 身份解析用户，并使用该用户分组已启用的模型；分页最多 12 项，避免将管理后台的全局模型表暴露给 Bot。

## 4. 真实集成前硬门槛

以下事项全部完成前，服务端 `TELEGRAM_TOPUP_ENABLED` 与 Bot 的 `TELEGRAM_TOPUP_MODE=live` 都必须保持关闭，且不在生产菜单标记链上充值为可用：

1. 易支付沙箱：支付宝与微信分别完成创建、支付通知、重复通知、退款/超时和到账核对。
2. 链上测试网：每条网络和每个币种组合完成地址分配、正确转账、错误网络、错误代币、重复交易、确认不足、链重组和归集演练。
3. 地址安全：地址不可复用或具备可靠 memo/交易匹配策略；不从用户消息接受地址、金额或 tx hash 作为入账依据。
4. 账本一致性：入账必须由 `new-api` 单一事务完成，并有幂等交易键、审计记录和人工补单流程。
5. 生产运行：HTTPS webhook、Webhook secret 校验、持久化数据库、告警、备份恢复和 Bot Token 轮换完成。

## 5. 开发任务列表

| 顺序 | 任务 | 完成定义 | 验证 |
| --- | --- | --- | --- |
| 1 | 完成全量中英词条 | 菜单、账户、用量、通知、客服、支付状态和 Worker 推送均不混用语言 | 词条 contract + Telegram 中英文回归 |
| 2 | 模型详情与价格摘要 | Bridge 返回按用户分组过滤的安全 DTO；Bot 可分页、查看详情并跳转网页 | Go Bridge contract + Bot callback contract |
| 3 | 模型估算器 | 参数化估算，仅支持已定义的 token/固定价模型；动态计费回退网页 | 数据矩阵、边界值、与网页计算器交叉核对 |
| 4 | Mock Bridge E2E | 本机 Mock 验证请求签名、幂等、错误分支和所有支付状态 | Node integration + Telegram 私聊截图 |
| 5 | 易支付沙箱 | Alipay、WeChat 每条支付链路实际回调入账 | 服务商沙箱正反向用例 |
| 6 | 稳定币测试网服务 | BSC、Ethereum、Base、Solana 的地址、监听、确认和入账 worker | 每链每币种测试网矩阵 |
| 7 | 生产 webhook 与运维 | 公开 HTTPS、secret、健康检查、告警、备份、Token 轮换 | staging 演练与恢复演练 |

任务 5-7 是真实资金和生产边界，必须单独审批，不能因 Mock 通过而自动开始。

## 6. 最新 Mock 验收记录（2026-08-09）

| 验证 | 隔离输入与范围 | 结果 | 证据 SHA |
| --- | --- | --- | --- |
| Node 合同测试 | 本仓库 `npm test`；无生产数据库或支付凭证 | 7 个文件、34 项测试通过 | `d7a7dfa04b6242b70a215555e9f9e8a6e7e553f5` |
| 类型与构建 | 本仓库 `npm run typecheck`、`npm run build` | 通过 | `d7a7dfa04b6242b70a215555e9f9e8a6e7e553f5` |
| Bridge 充值控制器 | `/Users/bill/mygit/new-api` 中 `go test ./controller -run TelegramTopUp -count=1` | 通过 | `d7a7dfa04b6242b70a215555e9f9e8a6e7e553f5` |
| Mock HTTP 与 SQLite | `127.0.0.1:19192` Mock Bridge；`/private/tmp/supertoken-tg-mock-current/bot.sqlite` | 账户、用量、订阅、公告、模型和充值 DTO 均返回隔离 Mock 数据 | `d7a7dfa04b6242b70a215555e9f9e8a6e7e553f5` |
| Telegram 私聊验收 | 历史测试会话；只读/Mock 操作 | 旧验收曾把 `$250.00 quota - $87.50 used_quota` 错算成 `$162.50` 余额，该结论已废止；正确语义是当前余额 `$250.00`、历史已用 `$87.50`。当前版本需在目标 Bot 上重新完成账户、用量、订阅、模型、中英文、微信 Mock 与 Base USDT Mock 回归 | `d7a7dfa04b6242b70a215555e9f9e8a6e7e553f5`（仅历史证据） |

Telegram 私聊还验证了客服未配置时返回“客服入口尚未配置”，不会伪造工单成功；订阅零余额显示为 `$0.00`。这些结果只证明本机 Mock 的用户界面和请求链路，**不**证明真实微信/支付宝收款、真实 USDT/USDC 监听与入账、生产 webhook 或客服群转发已经可用。
