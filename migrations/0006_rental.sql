-- =====================================================================
-- Migration 0006 — Rental + double-rental protection
-- Traceability: PS-DATA-009 §30, §31 | PS-IMP-011 §18, §19 | DR-008
-- =====================================================================

CREATE TABLE IF NOT EXISTS rentals (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  negotiation_id  TEXT REFERENCES negotiations(id) ON DELETE SET NULL,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  price           REAL NOT NULL CHECK (price >= 0),
  payment_period  TEXT NOT NULL CHECK (payment_period IN ('MONTH','YEAR')),
  deposit         REAL NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  terms           TEXT,
  status          TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','PENDING','CONFIRMED','ACTIVE','EXPIRING','ENDED','CANCELLED')),
  activated_at    TEXT,
  ended_at        TEXT,
  end_reason      TEXT,
  idempotency_key TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS idx_rentals_property ON rentals(property_id);
CREATE INDEX IF NOT EXISTS idx_rentals_tenant ON rentals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_end_date ON rentals(end_date);

-- ---------------------------------------------------------------------
-- CRITICAL DOMAIN INVARIANT (PS-IMP-011 §18):
-- A single property MUST NOT hold two simultaneously-occupying rentals.
-- Enforced at the DATABASE level via a partial unique index, so a race
-- condition between two concurrent activate requests can never produce
-- two ACTIVE rentals. Application layer also validates (defence in depth).
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_rentals_one_occupying_per_property
  ON rentals(property_id)
  WHERE status IN ('CONFIRMED','ACTIVE','EXPIRING');

-- Idempotency guard for rental creation (§56 Idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS uq_rentals_idempotency
  ON rentals(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
