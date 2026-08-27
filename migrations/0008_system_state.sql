-- =====================================================================
-- Migration 0008 — System state & credential lifecycle
-- Traceability: PS-MASTER-001 §3 (admin bootstrap), §4 (bootstrap behavior),
--               §5 (password security), §9 (admin setup dashboard),
--               §10 (user management)
--
-- `system_state` is the durable marker that answers "has this deployment
-- already been bootstrapped?". Without it, every cold start would have to
-- re-derive that answer from user data, and §4 forbids re-creating or
-- overwriting an existing Admin account on redeploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Credential lifecycle on users.
--   password_updated_at  — WHEN the secret last changed (§9 status, never the value)
--   must_change_password — forces rotation of a bootstrap/reset credential (§8)
--   bootstrap_origin     — marks the account created by the bootstrap mechanism
-- SQLite forbids a non-constant DEFAULT in ALTER TABLE, so these default to
-- NULL / 0 and are set explicitly by the application.
ALTER TABLE users ADD COLUMN password_updated_at TEXT;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN bootstrap_origin INTEGER NOT NULL DEFAULT 0;
