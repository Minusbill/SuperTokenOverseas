CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'zh',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_bindings (
  telegram_user_id TEXT PRIMARY KEY REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  new_api_user_id INTEGER NOT NULL UNIQUE,
  username_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  telegram_user_id TEXT PRIMARY KEY REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  low_quota_threshold INTEGER,
  subscription_notice_days INTEGER NOT NULL DEFAULT 3,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_events (
  event_key TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_no TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  ops_chat_id TEXT NOT NULL,
  ops_message_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  UNIQUE (ops_chat_id, ops_message_id)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_status
  ON support_tickets (telegram_user_id, status);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_telegram_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
