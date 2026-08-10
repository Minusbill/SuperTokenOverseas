# Changelog

## Unreleased - Telegram Bridge and local acceptance

### User-facing behavior

- Added a Chinese and English Telegram service flow for account summary, usage, subscriptions, available models, API access, announcements, support, notifications, and protected administrator broadcasts.
- Added Bridge-mode API Key management: list masked keys, create a server-authorized profile key, enable or disable a key, and delete a key. Full key material remains visible only in the authenticated new-api web console.
- Added a recharge flow with preset amounts, custom integer amounts, Alipay and WeChat Epay checkout links, QR delivery, status refresh, and explicit disabled-state handling.
- Added mock-only USDT/USDC selection for BSC, Ethereum, Base, and Solana. It is not a production on-chain payment implementation.

### Integration and safety boundaries

- Defined the HMAC-scoped Telegram Bridge contract. The Bot sends a Telegram ID, allowed parameters, timestamp, nonce, and signature; new-api resolves the bound user server-side.
- Kept new-api as the sole owner of balances, usage, API keys, payment orders, callbacks, and ledger writes. The Bot persists only its own operational data.
- Added persistent update processing, notifications, support routing, and broadcast delivery state to the Bot repository.
- Kept production top-up disabled by default. Epay provider sandbox, live callback, refund, and production acceptance are still required before enabling live top-up.

### Verification evidence

- Bot: `npm run typecheck`, `npm run build`, and `npm test`.
- Bridge: `go test ./model ./service ./controller ./middleware ./router`.
- Local real Bridge: isolated Docker new-api with a separate SQLite volume; HMAC success and rejection, account reads, masked Key actions, disabled-payment behavior, and Bot command flows were exercised.

### Not release-ready

- No live Telegram webhook with the rotated production Bot token has been accepted.
- No Epay provider sandbox or production payment has been executed.
- No live USDT/USDC address allocation, chain monitoring, confirmation, reorganization handling, or fund sweeping exists.
- Multi-instance Bot deployment and PostgreSQL recovery have not been exercised.
