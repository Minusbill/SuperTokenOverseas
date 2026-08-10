CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'zh',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_bindings (
  telegram_user_id TEXT PRIMARY KEY REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  new_api_user_id INTEGER NOT NULL UNIQUE,
  username_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_at TIMESTAMPTZ NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  telegram_user_id TEXT PRIMARY KEY REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  low_quota_threshold BIGINT,
  subscription_notice_days INTEGER NOT NULL DEFAULT 3,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_events (
  event_key TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_no TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  ops_chat_id TEXT NOT NULL,
  ops_message_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  UNIQUE (ops_chat_id, ops_message_id)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_status
  ON support_tickets (telegram_user_id, status);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id BIGINT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_update_queue (
  update_id BIGINT PRIMARY KEY,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_telegram_update_queue_available
  ON telegram_update_queue (status, available_at, update_id);

CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  admin_telegram_user_id TEXT NOT NULL,
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 3500),
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'running', 'paused', 'completed', 'cancelled')),
  target_count INTEGER NOT NULL CHECK (target_count >= 0),
  delivered_count INTEGER NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS broadcast_deliveries (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'delivered', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (broadcast_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_available
  ON broadcast_deliveries (status, available_at, broadcast_id, telegram_user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_telegram_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
