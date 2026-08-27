-- =====================================================================
-- Migration 0004 — Offer, Campaign, Lead, Lead Qualification
-- Traceability: PS-DATA-009 §20, §21, §22, §23, §24, §25
-- =====================================================================

CREATE TABLE IF NOT EXISTS offers (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_segment_id TEXT REFERENCES tenant_segments(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  value_proposition TEXT,
  price             REAL NOT NULL CHECK (price >= 0),
  terms             TEXT,
  cta               TEXT NOT NULL DEFAULT 'Tanya Sekarang',
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','READY','ACTIVE','PAUSED','EXPIRED')),
  published_at      TEXT,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_property ON offers(property_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);

CREATE TABLE IF NOT EXISTS campaigns (
  id         TEXT PRIMARY KEY,
  offer_id   TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'DIRECT_OUTREACH'
             CHECK (channel IN ('DIRECT_OUTREACH','WHATSAPP','INSTAGRAM','FACEBOOK','MARKETPLACE','OFFLINE','REFERRAL','OTHER')),
  objective  TEXT,
  status     TEXT NOT NULL DEFAULT 'DRAFT'
             CHECK (status IN ('DRAFT','RUNNING','PAUSED','ENDED')),
  start_at   TEXT,
  end_at     TEXT,
  budget     REAL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_offer ON campaigns(offer_id);

-- Lead = commercial opportunity linking tenant + property (DR-003: must have property context)
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,
  property_id       TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offer_id          TEXT REFERENCES offers(id) ON DELETE SET NULL,
  campaign_id       TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  source            TEXT NOT NULL
                    CHECK (source IN ('INBOUND','OUTBOUND','REFERRAL','ORGANIC','CAMPAIGN','OTHER')),
  status            TEXT NOT NULL DEFAULT 'NEW'
                    CHECK (status IN ('NEW','CONTACTED','RESPONDED','QUALIFIED','INTERESTED','VISIT_SCHEDULED','VISITED','NEGOTIATION','WON','LOST')),
  score             INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  temperature       TEXT NOT NULL DEFAULT 'COOL'
                    CHECK (temperature IN ('HOT','WARM','COOL','LOW')),
  lost_reason       TEXT,
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  first_contact_at  TEXT,
  last_contact_at   TEXT,
  next_follow_up_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_property ON leads(property_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up ON leads(next_follow_up_at);

CREATE TABLE IF NOT EXISTS lead_qualifications (
  id                   TEXT PRIMARY KEY,
  lead_id              TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  business_type        TEXT NOT NULL,
  budget               REAL NOT NULL,
  timeline             TEXT NOT NULL
                       CHECK (timeline IN ('IMMEDIATE','WITHIN_30_DAYS','WITHIN_90_DAYS','LATER','UNKNOWN')),
  space_need           REAL,
  location_need        TEXT CHECK (location_need IN ('HIGH','MEDIUM','LOW')),
  intended_use         TEXT,
  decision_status      TEXT CHECK (decision_status IN ('DECISION_MAKER','INFLUENCER','UNKNOWN')),
  fit_score            INTEGER NOT NULL CHECK (fit_score BETWEEN 0 AND 100),
  qualification_result TEXT NOT NULL
                       CHECK (qualification_result IN ('QUALIFIED','PARTIALLY_QUALIFIED','UNQUALIFIED')),
  reasoning            TEXT NOT NULL DEFAULT '[]',
  notes                TEXT,
  qualified_by         TEXT NOT NULL REFERENCES users(id),
  qualified_at         TEXT NOT NULL DEFAULT (datetime('now')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qualifications_lead ON lead_qualifications(lead_id);
