-- =====================================================================
-- Migration 0007 — Audit Log, Analytics Records, Notifications
-- Traceability: PS-DATA-009 §32, §33, §34 | DR-010 | BR-010
-- =====================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  ip_reference TEXT,
  request_id   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS analytics_records (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  property_id TEXT,
  lead_id     TEXT,
  campaign_id TEXT,
  value       REAL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_records(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_property ON analytics_records(property_id);
CREATE INDEX IF NOT EXISTS idx_analytics_lead ON analytics_records(lead_id);
CREATE INDEX IF NOT EXISTS idx_analytics_occurred ON analytics_records(occurred_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'UNREAD' CHECK (status IN ('UNREAD','READ')),
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, status);
