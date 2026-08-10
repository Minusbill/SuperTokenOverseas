# 系统架构

## 1. 已确认实现

当前是一个 Node.js + TypeScript 模块化单体：同一进程在 Long Polling 或 Webhook 模式下运行 Bot、通知定时任务和 Telegram Update 队列 Worker。Webhook 先写入本地持久队列并响应，Worker 再串行处理 Update。没有 Redis、BullMQ、Drizzle ORM 或独立 Worker 进程；这些不应被文档写成已经存在的能力。

| 领域 | 当前选择 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js 22 + TypeScript | 严格类型与 ESM |
| Telegram | grammY | 命令、回调与 Update 处理 |
| HTTP | Fastify | Webhook、`/healthz`、`/readyz` |
| 外部契约 | Zod | 校验 `new-api` 最小 DTO |
| Bot 存储 | SQLite（前期）或 PostgreSQL | Bot 自有运营数据，不与 `new-api` 共库 |
| 日志 | Pino | 不输出密钥或 `new-api` 原始响应 |
| 测试 | Vitest | 单元与 SQLite Repository 合同测试 |

SQLite 使用 Node 22 内建的 `node:sqlite`。该 Node API 目前仍有 experimental 标记，这是已确认的运行时风险；因此 SQLite 仅限单实例前期部署，并须固定 Node 22 小版本。需要多副本或独立 Worker 时切换 PostgreSQL。

## 2. 数据所有权

```text
                         authenticated web session
+-----------------+  ------------------------------>  +----------------------+
| Telegram user   |                                   | new-api console      |
+--------+--------+                                   +----------+-----------+
         | Telegram update                                       |
         v                                                       | stores Telegram ID
+-----------------+   webhook or polling   +-----------------+  v
| Telegram Bot API|  --------------------> | SuperToken Bot  |-----> [new-api database]
+-----------------+                       +--+-----------+--+
                                                |           \
                         Bot-only data          |            \ HMAC + timestamp + nonce
                                                v             v
                                      +----------------+  +----------------------+
                                      | Bot SQLite or  |  | new-api Telegram     |
                                      | PostgreSQL     |  | Bridge v1            |
                                      +----------------+  +----------+-----------+
                                                |                        |
                                                v                        v
                                      [notifications, updates,       [account, quota,
                                       support routing, audit]        keys, orders]

[Epay provider] -- signed payment callback --> [new-api payment handler] --> [new-api database]

Notes:
- The Bot never receives user passwords, PATs, full API keys, payment credentials, or ledger data.
- Telegram top-up is disabled by default. On-chain USDT/USDC is mock-only and has no production path.
```

| 数据类别 | 权威系统 | Bot 的边界 |
| --- | --- | --- |
| 账户、额度、用量、订阅 | `new-api` | 实时读取最小摘要，不缓存或累计 |
| 请求明细、消费日志 | `new-api` | 不读取为持久化数据，不保存 |
| 订单、支付、充值、退款 | `new-api` | `admin` 模式仅跳转网页；仅已验收的 Bridge 才能发起 scoped 订单并展示状态/checkout，不保存 |
| API Key、PAT、密码、兑换码 | `new-api` | 不接收、不保存、不转发 |
| Telegram 身份与绑定 | Bot | 保存数字 ID 与一对一绑定映射 |
| 通知偏好、去重键、Update 去重 | Bot | 保存运营所需最小状态 |
| 客服 | Telegram 会话/运营群 | Bot 仅保存回复路由映射，不保存正文副本 |
| Bot 审计 | Bot | 仅记录动作、目标和白名单运营计数 |

Node 只通过 HTTP 调用 `new-api`。默认 `admin` 模式以网页 Telegram 绑定加手动用户 ID 复核后读取账户，不调用用户 Key 或支付路由；该模式的 Admin PAT 是高权限部署密钥。Bridge 模式由 `new-api` 根据 Telegram ID 解析用户，Node 不传入可替换的用户 ID，也不直连 `new-api` 数据库。查询、Key 状态切换、受限 Key 创建和订单意图是唯一允许的 scoped 动作；完整 Key、余额账本和支付回调始终留在 `new-api`。

## 3. 绑定与查询流程

```text
Telegram user          SuperToken Bot      new-api console + Bridge       Bot DB
     |                       |                     |                        |
     | web session bind -------------------------> |                        |
     |                       |                     | store Telegram ID      |
     | /bind                 |                     |                   |
     | --------------------> | account/summary     |                   |
     |                       | -- HMAC ----------> |                   |
     |                       | <--- minimum DTO -- |                   |
     |                       | save verified link --------------------> |
     | <--- bind confirmed - |                     |                   |
     |                       |                     |                   |
     | /account or /usage    |                     |                   |
     | --------------------> | read summary/usage  |                   |
     |                       | -- HMAC ----------> |                   |
     |                       | <--- current DTO -- |                   |
     | <--- formatted reply- |                     |                   |

The Bot stores only the verified link and operational idempotency state. It does not cache balances or usage.
```

账户、用量与订阅数据只在一次请求处理期间存在于内存中。通知任务也是每轮重新从 `new-api` 读取状态；数据库只保存“这个通知是否已经发过”的幂等键，不保存余额或消费数值。

## 4. Bot 数据模型

| 表 | 最小字段 | 用途 |
| --- | --- | --- |
| `telegram_users` | `telegram_user_id`、`chat_id`、`locale` | Telegram 私聊路由 |
| `account_bindings` | `telegram_user_id`、`new_api_user_id`、校验时间 | 一对一身份映射 |
| `notification_preferences` | 阈值、暂停状态 | 用户通知选择 |
| `notification_events` | 幂等键、事件类型 | 防止重复通知 |
| `support_tickets` | 工单号、用户 chat ID、运营消息 ID、状态 | 客服回复路由，不含正文 |
| `telegram_update_queue` | Update ID、临时 payload、处理状态 | Webhook 持久化、短时重试与崩溃恢复；完成/失败后清空 payload |
| `broadcasts` | 管理员、公告快照、状态、总数与结果计数 | 广播草稿、确认、暂停、恢复、取消与状态展示 |
| `broadcast_deliveries` | 广播 ID、收件人 chat ID、投递状态、重试与租约 | 持久化收件人快照和后台限速投递；不保存消息接收方以外的用户内容 |
| `processed_updates` | Telegram `update_id` | Update 幂等 |
| `audit_logs` | 动作、目标、阈值/广播计数 | Bot 操作审计，不含外部响应 |

`telegram_update_queue` 的原始 payload 在完成或最终失败后立即清空。`processed_updates`、队列状态、通知事件、关闭工单与审计日志尚未实现保留期清理，这是前期 SQLite 部署前必须补齐的运维项；不能以“数据量小”当作无限增长的理由。

广播确认只把任务放入 Bot 自有数据库，后台 Worker 才调用 Telegram 发送接口。已完成的收件任务不会再次被领取；但 Telegram API 不支持投递幂等键，因此进程在 Telegram 接收消息和 Bot 数据库写入完成之间崩溃时，租约恢复可能重发一次。这是明确接受的至少一次语义，管理员状态页只能展示已确认成功、最终失败和未完成数，不能承诺严格一次。

## 5. 安全边界

- Bridge v1 已额外提供受 HMAC 保护的账户、模型、API Key 和充值接口。Key 创建使用服务端选定的模型分组与幂等键，响应只能包含掩码 Key；充值使用服务端金额计算、幂等键和跨用户隔离。外部服务商验收范围见 `docs/05-telegram-epay-topup-plan.md`。
- HMAC 覆盖 method、path、body hash、timestamp 与 nonce；`new-api` 持久化 nonce 防重放。
- 账号查询限定 Telegram 私聊，绑定以 Telegram 数字 ID 复核。
- 管理员功能使用数字 ID 白名单，不依赖可变更的 `@username`。
- 日志和审计不写入 Bot Token、PAT、API Key、支付参数、客服正文或完整 `new-api` 响应。
- `/support` 只做转发与回复路由；用户应被提示不要提交密钥或支付凭证。

## 6. 部署演进

前期单实例：一个 Bot 容器 + 一个挂载的 SQLite 数据卷。该模式不允许横向扩容，也不应同时运行多个通知进程。

扩容条件：需要多副本 Webhook、独立通知 Worker、跨机器存储或更强备份恢复时，将 `DATABASE_URL` 切到 PostgreSQL，并补充分布式任务锁/队列。迁移前必须演练 SQLite 备份恢复与数据导入，不能直接让两个进程共享同一个 SQLite 文件。

## 7. 关键配置

```text
NODE_ENV
BOT_MODE
PUBLIC_BASE_URL
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
NEW_API_INTEGRATION_MODE
NEW_API_BASE_URL
NEW_API_PORTAL_URL
NEW_API_PRICING_URL
NEW_API_DOCS_URL
NEW_API_TOPUP_URL
NEW_API_INTEGRATION_SECRET
DATABASE_URL
BOT_ADMIN_TELEGRAM_IDS
SUPPORT_CHAT_ID
NOTIFICATION_INTERVAL_MS
NOTIFICATION_DEFAULT_LOW_QUOTA_THRESHOLD
BROADCAST_DELAY_MS
LOG_LEVEL
```

日志只能记录配置是否存在，不能输出实际密钥值。
