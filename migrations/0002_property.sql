-- =====================================================================
-- Migration 0002 — Property, Property Analysis, Market Area, Businesses
-- Traceability: PS-DATA-009 §11, §12, §13, §14, §15
-- =====================================================================

CREATE TABLE IF NOT EXISTS market_areas (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  latitude     REAL,
  longitude    REAL,
  radius       REAL,
  market_notes TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS properties (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES users(id),
  market_area_id      TEXT REFERENCES market_areas(id),
  name                TEXT NOT NULL,
  property_type       TEXT NOT NULL
                      CHECK (property_type IN ('SHOPHOUSE','KIOSK','HOUSE','BOARDING_HOUSE','COMMERCIAL_SPACE','WAREHOUSE','LAND','OTHER')),
  address             TEXT NOT NULL,
  latitude            REAL,
  longitude           REAL,
  width               REAL,
  length              REAL,
  area_size           REAL,
  price               REAL NOT NULL CHECK (price >= 0),
  price_period        TEXT NOT NULL
                      CHECK (price_period IN ('MONTH','YEAR')),
  availability_status TEXT NOT NULL DEFAULT 'UNAVAILABLE'
                      CHECK (availability_status IN ('AVAILABLE','RESERVED','RENTED','UNAVAILABLE')),
  lifecycle_status    TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (lifecycle_status IN ('DRAFT','PENDING_VERIFICATION','VERIFIED','ACTIVE','MARKETED','RESERVED','RENTED','INACTIVE')),
  description         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_properties_owner ON properties(owner_id);
CREATE INDEX IF NOT EXISTS idx_properties_lifecycle ON properties(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_properties_availability ON properties(availability_status);
CREATE INDEX IF NOT EXISTS idx_properties_market_area ON properties(market_area_id);

CREATE TABLE IF NOT EXISTS property_analyses (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  access_score     INTEGER CHECK (access_score BETWEEN 0 AND 10),
  visibility_score INTEGER CHECK (visibility_score BETWEEN 0 AND 10),
  location_score   INTEGER CHECK (location_score BETWEEN 0 AND 10),
  space_score      INTEGER CHECK (space_score BETWEEN 0 AND 10),
  overall_score    INTEGER,
  strengths        TEXT NOT NULL DEFAULT '[]',
  weaknesses       TEXT NOT NULL DEFAULT '[]',
  opportunities    TEXT NOT NULL DEFAULT '[]',
  risks            TEXT NOT NULL DEFAULT '[]',
  recommended_uses TEXT NOT NULL DEFAULT '[]',
  analysis_status  TEXT NOT NULL DEFAULT 'COMPLETED'
                   CHECK (analysis_status IN ('DRAFT','COMPLETED')),
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_property_analyses_property ON property_analyses(property_id);

CREATE TABLE IF NOT EXISTS businesses (
  id                     TEXT PRIMARY KEY,
  market_area_id         TEXT REFERENCES market_areas(id) ON DELETE SET NULL,
  name                   TEXT NOT NULL,
  business_type          TEXT,
  category               TEXT NOT NULL DEFAULT 'OTHER'
                         CHECK (category IN ('GROCERY','FOOD','BARBER','FEED_STORE','WORKSHOP','SERVICE','RETAIL','LAUNDRY','OTHER')),
  address                TEXT,
  latitude               REAL,
  longitude              REAL,
  distance_from_property REAL,
  source                 TEXT,
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_businesses_market_area ON businesses(market_area_id);
