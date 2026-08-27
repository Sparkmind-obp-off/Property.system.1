-- =====================================================================
-- Migration 0003 — Tenant Segment, Tenant, Tenant↔Property Match
-- Traceability: PS-DATA-009 §16, §17, §18, §19 | PS-TECH-008 §21
-- =====================================================================

CREATE TABLE IF NOT EXISTS tenant_segments (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  business_category TEXT NOT NULL
                    CHECK (business_category IN ('UMKM','BARBER','LAUNDRY','FOOD_BUSINESS','SERVICE_BUSINESS','RETAIL','WORKSHOP','OTHER')),
  minimum_space     REAL,
  maximum_space     REAL,
  budget_min        REAL,
  budget_max        REAL,
  requirements      TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  tenant_type          TEXT NOT NULL DEFAULT 'BUSINESS'
                       CHECK (tenant_type IN ('INDIVIDUAL','BUSINESS','ORGANIZATION')),
  business_category    TEXT NOT NULL DEFAULT 'OTHER'
                       CHECK (business_category IN ('UMKM','BARBER','LAUNDRY','FOOD_BUSINESS','SERVICE_BUSINESS','RETAIL','WORKSHOP','OTHER')),
  contact_name         TEXT,
  phone                TEXT,
  email                TEXT,
  budget_min           REAL,
  budget_max           REAL,
  space_need           REAL,
  location_preference  TEXT,
  business_description TEXT,
  status               TEXT NOT NULL DEFAULT 'PROSPECT'
                       CHECK (status IN ('PROSPECT','ACTIVE','INACTIVE')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_category ON tenants(business_category);

-- Matching result. fit_score MUST be traceable to component scores (§19).
CREATE TABLE IF NOT EXISTS tenant_property_matches (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id         TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_segment_id TEXT REFERENCES tenant_segments(id) ON DELETE CASCADE,
  fit_score         INTEGER NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  location_score    INTEGER NOT NULL DEFAULT 0,
  demand_score      INTEGER NOT NULL DEFAULT 0,
  space_score       INTEGER NOT NULL DEFAULT 0,
  price_score       INTEGER NOT NULL DEFAULT 0,
  business_score    INTEGER NOT NULL DEFAULT 0,
  competition_score INTEGER NOT NULL DEFAULT 0,
  operational_score INTEGER NOT NULL DEFAULT 0,
  recommendation    TEXT NOT NULL
                    CHECK (recommendation IN ('HIGH_FIT','MEDIUM_FIT','LOW_FIT','NO_FIT')),
  reasoning         TEXT NOT NULL DEFAULT '[]',
  risks             TEXT NOT NULL DEFAULT '[]',
  mismatches        TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_matches_property ON tenant_property_matches(property_id);
CREATE INDEX IF NOT EXISTS idx_matches_tenant ON tenant_property_matches(tenant_id);
