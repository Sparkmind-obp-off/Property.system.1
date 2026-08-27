-- =====================================================================
-- Migration 0005 — Activity, Follow-Up, Visit, Negotiation
-- Traceability: PS-DATA-009 §26, §27, §28, §29
-- =====================================================================

CREATE TABLE IF NOT EXISTS activities (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL
                CHECK (activity_type IN ('CALL','MESSAGE','EMAIL','NOTE','FOLLOW_UP','VISIT','NEGOTIATION','STATUS_CHANGE','QUALIFICATION','RENTAL','OTHER')),
  subject       TEXT NOT NULL,
  description   TEXT,
  occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_activities_occurred ON activities(occurred_at);

CREATE TABLE IF NOT EXISTS follow_ups (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to  TEXT REFERENCES users(id) ON DELETE SET NULL,
  action_type  TEXT NOT NULL
               CHECK (action_type IN ('CALL','MESSAGE','EMAIL','VISIT_REMINDER','SEND_DETAILS','OTHER')),
  due_at       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','COMPLETED','CANCELLED','RESCHEDULED')),
  notes        TEXT,
  outcome      TEXT,
  completed_at TEXT,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_lead ON follow_ups(lead_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(due_at);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status);

-- DR-005: Visit MUST relate to property + lead
CREATE TABLE IF NOT EXISTS visits (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lead_id      TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scheduled_by TEXT NOT NULL REFERENCES users(id),
  scheduled_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'SCHEDULED'
               CHECK (status IN ('SCHEDULED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
  result       TEXT CHECK (result IN ('STRONG_FIT','POTENTIAL','WEAK_FIT','NO_FIT')),
  notes        TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_property ON visits(property_id);
CREATE INDEX IF NOT EXISTS idx_visits_lead ON visits(lead_id);
CREATE INDEX IF NOT EXISTS idx_visits_scheduled ON visits(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status);

-- DR-006: Negotiation MUST have property + lead
CREATE TABLE IF NOT EXISTS negotiations (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lead_id        TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  visit_id       TEXT REFERENCES visits(id) ON DELETE SET NULL,
  created_by     TEXT NOT NULL REFERENCES users(id),
  current_price  REAL NOT NULL CHECK (current_price >= 0),
  proposed_price REAL NOT NULL CHECK (proposed_price >= 0),
  agreed_price   REAL,
  terms          TEXT,
  status         TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN','COUNTER_OFFER','AGREED','FAILED')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  agreed_at      TEXT,
  closed_at      TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_negotiations_property ON negotiations(property_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_lead ON negotiations(lead_id);
CREATE INDEX IF NOT EXISTS idx_negotiations_status ON negotiations(status);

-- Negotiation round history (§29 "history")
CREATE TABLE IF NOT EXISTS negotiation_rounds (
  id             TEXT PRIMARY KEY,
  negotiation_id TEXT NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  actor          TEXT NOT NULL CHECK (actor IN ('TENANT','OWNER')),
  round_type     TEXT NOT NULL CHECK (round_type IN ('PROPOSAL','COUNTER_OFFER','ACCEPT','REJECT')),
  price          REAL,
  terms          TEXT,
  notes          TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rounds_negotiation ON negotiation_rounds(negotiation_id);
