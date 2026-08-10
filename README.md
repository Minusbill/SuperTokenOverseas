# SuperTokenOverseas

面向 `new-api` 中转站用户和运营人员的 Telegram 服务机器人。

当前仓库已完成可运行的用户服务 MVP：账号绑定、账户摘要、今日/7 天/30 天用量、订阅查询、公告、低余额/到期通知、客服工单和受保护的管理员广播。首版目标不是在 Telegram 内转发大模型对话。

## 设计结论

- 首版采用 Node.js + TypeScript 的模块化单体，生产环境使用 Telegram Webhook。
- 不保存用户密码、`new-api` 用户 PAT 或模型 API Key。
- `admin` 是不修改原生 `new-api` 的默认模式：用户先在网页绑定 Telegram，再执行 `/bind <用户ID>`；Bot 只做账户、用量、订阅和公告读取。
- `bridge` 是可选的现有集成模式：目标实例已经实现 Telegram Bridge 时，Bot 才能按 Telegram ID 解析用户并显示受限的 Key/收银台功能。Node 不保存用户 PAT。
- `new-api` 是余额、用量、订阅、支付和令牌的唯一数据源；Bot 通过 scoped Bridge 读取最小展示 DTO，绝不直连其数据库。
- Bot 不保存 `new-api` 的消费明细、订单、支付流水、额度账本、API Key、密码、PAT 或兑换码。
- Telegram 充值已完成本地 Mock 与 focused contract：易支付订单展示 checkout URL/二维码；链上 USDT/USDC 订单只展示锁定的网络、币种和收款地址。`TELEGRAM_TOPUP_MODE` 在生产默认 `disabled`，本地 Mock 必须设为 `mock`，仅在后端支付能力完成独立验收后才能显式设为 `live`。订单、回调与入账全部由 `new-api` 处理；服务商沙箱与生产验收尚未完成。

## 文档

- [产品需求](docs/01-requirements.md)
- [系统架构](docs/02-architecture.md)
- [变更记录](CHANGELOG.md)
- [开发计划](docs/03-development-plan.md)
- [new-api 接口核对](docs/04-new-api-integration.md)
- [Telegram 易支付充值计划](docs/05-telegram-epay-topup-plan.md)
- [Mock 验收与后续开发](docs/06-mock-acceptance-and-delivery-plan.md)

## 当前实现

- `npm install && npm run build`：构建 TypeScript。
- `npm test`：运行单元测试。
- `cp .env.example .env` 后配置 `TELEGRAM_BOT_TOKEN`、`NEW_API_*`。前期默认 `DATABASE_URL=sqlite:./data/supertoken_bot.sqlite`；未配置时仅用于一次性内存开发。
- Bridge 充值联调设置 `TELEGRAM_TOPUP_MODE=mock`；生产环境在支付服务验收前保持 `disabled`。
- `BOT_MODE=polling npm run dev`：本地 Long Polling。
- `BOT_MODE=webhook npm start`：生产 Webhook；必须配置 `PUBLIC_BASE_URL` 和 HTTPS 反向代理。
- Webhook 会在数据库持久化 Telegram Update 后立即响应；进程内 Worker 再串行处理，失败每 5 秒重试，最多五次。完成或最终失败后会清空原始 Update payload。
- 管理员广播先持久化收件人快照，再由后台 Worker 限速投递，可暂停、恢复、取消并查询状态。由于 Telegram 发送接口没有幂等键，在“Telegram 已接收、数据库尚未确认”这一崩溃窗口内，租约恢复后可能重发一次；该路径是至少一次投递，不是严格一次。
- `/bind`、客服和管理员命令带有进程内固定窗口限流；该限流只约束单个 Bot 实例，多实例部署必须在入口网关或共享存储增加全局限流。

SQLite 只支持单 Bot 实例和本地持久卷，适合前期小规模部署。要部署多个副本、独立 Worker 或共享存储时，切换到 PostgreSQL。通知、工单映射和广播只使用 Bot 自有运营数据，不缓存 `new-api` 交易数据。

通知命令：`/settings`、`/notify <额度|off|pause|resume>`。客服命令：`/support <问题>`。管理员命令：`/admin`、`/broadcast <内容>`，管理员 ID 必须配置在 `BOT_ADMIN_TELEGRAM_IDS`。

在原生 `admin` 模式下，API Key 管理、充值、退款、补单和额度调整始终在 `new-api` 网页完成；Bot 会给出门户链接而不会尝试越权调用用户接口。`bridge` 模式中的 Key/充值界面仅能在该实例已完成对应服务端适配和验收后启用。链上稳定币仍只有 Mock，不能用于真实收款。

## 本地真实 Bridge 联调

本项目已在隔离 Docker `new-api` 实例上完成一次本地 Bridge 联调。该环境只适合开发验证，不能连接生产数据库、商户或链上地址。

| 项目 | 已验证范围 |
| --- | --- |
| `new-api` | Docker 容器使用独立 SQLite 卷启动；`GET /api/status` 正常 |
| 身份与鉴权 | `new-api` 的 OAuth Bind 路由建立测试 Telegram 身份；无效 HMAC 返回 `401`，有效 HMAC 由服务端按已绑定身份解析账户 |
| Bot 到 Bridge | 真实 `NewApiClient` 与 Bot 命令处理器完成账户、7 天用量、订阅、模型、API 接入和返回菜单联调 |
| API Key | 只返回掩码元数据；创建、停用、启用和删除均由 scoped Bridge 执行 |
| 支付关闭 | 后端 `payment_methods: null` 会被 Bot 规范化为空列表并提示“充值暂未开放”，不会创建订单 |

推荐的本地环境变量如下；Bridge 两侧的共享密钥必须通过本机私有环境文件或 Secret Manager 注入，不能提交到仓库：

```dotenv
# Bot
BOT_MODE=polling
NEW_API_INTEGRATION_MODE=bridge
NEW_API_BASE_URL=http://127.0.0.1:3002
NEW_API_INTEGRATION_SECRET=<same-private-secret>
DATABASE_URL=sqlite:./data/supertoken_bot.sqlite
TELEGRAM_TOPUP_MODE=disabled

# Docker new-api
TELEGRAM_INTEGRATION_SECRET=<same-private-secret>
TELEGRAM_TOPUP_ENABLED=false
```

本地完整用户流需要先在 `new-api` 网页绑定 Telegram，再用同一 Telegram 数字 ID 向 Bot 发送 `/bind`。本机可以用 Long Polling；生产使用 Webhook 和公网 HTTPS。之前在聊天中暴露过的 Bot Token 不得继续使用，必须先在 BotFather 轮换。

以下项目尚未完成，不能由上述本地联调外推：

- 使用新 Token 的真实 Telegram Long Polling/Webhook、Telegram OAuth widget 和人工私聊回归。
- 易支付沙箱订单、验签回调、额度原子入账、失败补偿与退款边界。
- BSC、Ethereum、Base、Solana 上 USDT/USDC 的测试网地址分配、监听、确认、重组和归集。
- 有真实渠道与模型数据时的账户可见模型、模型广场价格展示和分页回归。
- 进程/容器重启后的 SQLite 恢复、备份恢复、Telegram `429`、`new-api` 超时及多实例 PostgreSQL 场景。

## 开发前待确认

以下问题不会阻碍设计，但会改变最终范围和工期：

1. 机器人只服务普通用户，还是也承担运营后台和故障告警？
2. 是否允许对 `new-api` 做少量 Go 代码扩展？
3. 客服群、管理员白名单与数据保留期分别是什么？
4. 预计绑定用户数、日活和每日消息量是多少？
5. 部署环境是否已有 HTTPS 域名和可持久化本地磁盘？
6. 首版语言是中文、英文，还是自动中英双语？
