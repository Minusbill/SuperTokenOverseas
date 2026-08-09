# `new-api` 接口核对

## 1. 核对基线

本设计核对的是你们本地 fork `/Users/bill/mygit/new-api`，当前 commit：

```text
0ab02020603d22e5613bc4cf46bfab06f8567769
2026-08-01T23:19:01+08:00
```

该仓库工作树干净，远程是 `git@github.com:Minusbill/new-api.git`。它与官方主线同源，但比 2026-08-08 主线落后约 10 个提交；上线前应固定实际部署 commit，并在 staging 做契约测试。

## 2. 已确认能力

| 能力 | 官方路由 | 鉴权 | 设计结论 |
| --- | --- | --- | --- |
| 系统状态和额度展示配置 | `GET /api/status` | 公开 | MVP 可直接使用 |
| Telegram 登录/绑定 | `/api/oauth/telegram/login`、`/api/oauth/telegram/bind/*` | Telegram 签名 + 网页会话 | 能建立 `new-api` 账号的 `telegram_id`，但不会给外部 Bot 用户授权 |
| 按用户 ID 查看用户 | `GET /api/user/:id` | Admin PAT | 可用于 MVP 绑定核验和账户摘要 |
| 管理员用量统计 | `GET /api/log/stat?username=...` | Admin PAT | 可做账户用量摘要 |
| 管理员日志列表 | `GET /api/log/?username=...` | Admin PAT | 可做分页明细，但必须最小化返回和缓存 |
| 管理员查看用户订阅 | `GET /api/subscription/admin/users/:id/subscriptions` | Admin PAT | 可展示订阅 |
| 用户兑换码充值 | `POST /api/user/topup` | 当前用户会话/PAT | Admin PAT 不能替目标用户兑换 |
| 用户令牌管理 | `/api/token/*` | 当前用户会话/PAT | Admin PAT 调用时操作的是管理员自己的令牌，不是目标用户令牌 |
| 用户自助资料/日志 | `/api/user/self`、`/api/log/self` | 当前用户会话/PAT | 外部 Bot 不能仅凭 Telegram ID 调用 |

## 3. 你们 fork 中值得复用的设计

### Telegram 身份与 AuthFlow

- `model/external_identity_claim.go` 用双唯一索引保证一个 Telegram 身份只能归属一个用户，适合 Bridge 按 `telegram_id` 解析目标用户。
- `model/auth_flow.go` 只保存随机 flow token 的 HMAC 摘要，流程有用途、过期时间、用户/会话绑定，并在事务中原子消费；Bot 的一次性绑定链接和 reveal ticket 应沿用这个思路。
- `controller/telegram.go` 对 Telegram widget 的签名、过期时间和 assertion replay 做了明确校验；Node 侧不要把“收到 Telegram Update”误当成 new-api 会话。

### 配额通知与 Webhook

- `service/quota.go` 已在扣费结算后判断用户和订阅额度阈值。
- `service/webhook.go` 已有 HMAC-SHA256 body 签名、SSRF 防护和可选 Worker 出站路径，可作为 Bridge 事件推送的实现参考。
- 现有 Webhook 是用户个人通知配置，并且一个用户只有一个通知类型，不能直接当成全站 Telegram Bot 事件总线；正式方案应新增带事件 ID、投递重试和幂等的系统集成 outbox。

### 领域与安全边界

- 额度扣减、兑换和订阅结算均位于 model/service 层，Bridge 应调用这些业务函数，不能通过 Node 直写表或拼装后台 HTTP 请求绕过事务。
- `service/authz` 已对部分管理员资源做细粒度权限控制，但用户、日志等路由仍有按 AdminAuth 直接放行的路径，不能假设普通 Admin PAT 已经是“只读 PAT”。
- `new-api` 最新主线增加了用户级关键接口限流和兑换码额度精度修复。当前 Bot 不包含写操作，这些变更由 `new-api` 自身的网页流程负责。

### 不应照搬的地方

- 支付 Webhook 处理代码中存在把签名、请求体写入日志的调试式日志模式；Bot 和 Bridge 禁止记录密钥、兑换码或完整支付体。
- 现有个人通知 Webhook 的配置由用户自行提供 URL，Bot 集成不能接受任意 URL 作为内部回调，否则会扩大 SSRF 和数据外泄面。

## 4. 关键事实与推论

### 已确认事实

- `new-api` 用户表包含带索引的 `telegram_id` 字段，且 `FillUserByTelegramId` 已存在。
- Telegram 绑定流程要求有效网页登录会话，回调签名使用配置的 Telegram Bot Token 校验。
- 管理面板 API 当前接受短期 JWT 或用户 PAT；PAT 使用 `Authorization`，旧 `New-Api-User` 请求头已退出鉴权。
- 普通用户令牌接口从鉴权上下文读取当前用户 ID，没有供管理员传目标用户 ID 的参数。
- 用户搜索只搜索用户 ID、用户名、邮箱和显示名，不按 `telegram_id` 搜索。
- 用户列表 API 会省略密码和 access token，但管理员凭据仍然具有较大数据读取范围。
- `new-api` 采用 AGPL-3.0 许可证。

## 3.1 已实现的 Telegram Bridge

本地 fork 当前已增加以下只读路由，代码位于 `middleware/telegram-integration.go`、`controller/telegram_integration.go` 和 `service/telegram_integration.go`：

```text
POST /api/integrations/telegram/account/summary
POST /api/integrations/telegram/account/usage
POST /api/integrations/telegram/account/subscriptions
```

所有路由都使用 `TelegramIntegrationAuth` 中间件。Node 发送的请求体只包含 Telegram 数字 ID（以及用量查询的时间范围），服务端通过 `FillUserByTelegramId` 解析目标用户，不接受 Node 传入的可替换 `new_api_user_id`。

请求签名使用 `TELEGRAM_INTEGRATION_SECRET`，Node 侧配置名为 `NEW_API_INTEGRATION_SECRET`。签名原文为：

```text
METHOD + "\\n" + PATH + "\\n" + SHA256(raw_body) + "\\n" + TIMESTAMP + "\\n" + NONCE
```

签名放在 `X-Integration-Signature`（十六进制 HMAC-SHA256）中，同时发送 `X-Integration-Timestamp` 和 `X-Integration-Nonce`。服务端接受前后 300 秒内的时间戳，并把 nonce 写入 `auth_flows` 做持久化重放保护。共享密钥必须只通过 Secret Manager 或部署环境注入，不能提交到 Git。

成功响应沿用 `{"success":true,"message":"","data":...}`；业务失败可能是 HTTP 200 且 `success:false`，Node 客户端会先检查 envelope 再校验 DTO。账户摘要和用量返回最小字段；订阅目前返回 `SubscriptionSummary` 包装对象，Node 会解包 `subscription` 字段。

上线前必须在 staging 使用实际部署 commit 做契约测试，并确认反向代理不会改写请求路径或请求体。Bridge 仍建议限制在内网或 mTLS 网络；HMAC 不是替代网络隔离的理由。

### 合理推测

- 同一个 Telegram Bot 可以同时用于 `new-api` 的 Telegram 登录组件和本 Node Bot，因为登录流程只使用 Bot Token 验签；但这会让同一密钥存在于两个服务中，需要统一轮换。
- 既然这是你们自己的 fork，新增只读 Bridge 比让 Node 长期持有 Admin PAT 更合理；UID 手工绑定只保留为临时联调路径。
- 账户余额和订阅只读查询足以验证首版用户价值；Bot 不托管用户 PAT，也不规划交易或支付写操作。

### 暂时无法验证

- 用户实际部署的 `new-api` 版本、二开内容和反向代理行为。
- 用户是否已经开启 Telegram OAuth、订阅、支付合规开关和用量日志。
- 管理员 PAT 是否可被网络和账号权限限制在真正的只读范围；官方路由中的不少 Admin 接口主要按角色判断，不能假设已经细分到最小权限。
- 预计用户规模、通知频率和可接受的轮询负载。

## 5. 为什么不能直接“Telegram ID 代登录”

Telegram Update 能证明消息来自某个 Telegram 账号，但它不能自动证明 Bot 有权获得该账号在 `new-api` 中的面板会话。`new-api` 的 Telegram 登录接口为浏览器创建登录会话，不会向外部 Bot 签发 scoped token。

所以以下推导是错误的：

```text
Telegram 消息里有 user.id
=> new-api 用户表里有 telegram_id
=> Node Bot 可以调用所有该用户的 self API
```

前两项可以建立身份映射，但第三项缺少授权凭据。MVP 只能让受控集成客户端读取目标用户的有限资料；交易、支付和令牌写操作始终留在 `new-api` 网页流程。

## 6. 兼容性要求

- 将 `new-api` commit/version 写入部署配置或运行元数据。
- 每次升级先在 staging 执行契约测试，再升级生产。
- 解析响应时同时检查 HTTP 状态、JSON `success` 和必要字段。
- 对 `quota`、`used_quota` 等整数值禁止使用浮点数累计；显示时使用 decimal 算法。
- 所有时间戳明确按秒处理，进入 JS 后转换为受控的 Date/Temporal 表达。
- 只从允许列表接收并展示字段，不能把原始管理员响应序列化到日志或缓存。

## 6. 来源

- [`new-api` 本地 fork](</Users/bill/mygit/new-api>)
- [`new-api` 官方仓库最新核对基线](https://github.com/QuantumNous/new-api/tree/823e26304a396854ace30b52b98ec497c2dd9c36)
- [API 路由定义](https://github.com/QuantumNous/new-api/blob/823e26304a396854ace30b52b98ec497c2dd9c36/router/api-router.go)
- [面板鉴权说明](https://github.com/QuantumNous/new-api/blob/823e26304a396854ace30b52b98ec497c2dd9c36/docs/authentication.md)
- [Telegram 登录与绑定实现](https://github.com/QuantumNous/new-api/blob/823e26304a396854ace30b52b98ec497c2dd9c36/controller/telegram.go)
- [用户模型与搜索实现](https://github.com/QuantumNous/new-api/blob/823e26304a396854ace30b52b98ec497c2dd9c36/model/user.go)
- [Telegram Bot API Webhook](https://core.telegram.org/bots/api#setwebhook)
