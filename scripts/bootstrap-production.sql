-- =====================================================================
-- PRODUCTION BOOTSTRAP — reference data only.
--
-- This file is deliberately SEPARATE from seed.sql:
--   seed.sql  = development fixtures (properties, tenants, leads, ...)
--   this file = the minimum reference data a production system needs
--
-- Traceability: PS-MASTER-001 §3 (roles), §44 (production must never use
--               dev/test fixtures), §45 (secrets are never committed)
--
-- Apply:
--   npx wrangler d1 execute property-system-production --remote \
--     --file=./scripts/bootstrap-production.sql
--
-- The bootstrap ADMIN password hash is intentionally NOT stored here.
-- Generate a credential, then insert the admin separately:
--   node scripts/gen-admin-credential.mjs
--   npx wrangler d1 execute property-system-production --remote \
--     --command "INSERT OR REPLACE INTO users (id,name,email,password_hash,status) \
--                VALUES ('usr_bootstrap_admin','System Administrator', \
--                        '<email>','<password_hash>','ACTIVE'); \
--                INSERT OR IGNORE INTO user_roles (id,user_id,role_id) \
--                VALUES ('url_bootstrap_admin','usr_bootstrap_admin','rol_admin');"
--
-- Rotate that password after first login. All other users must then be
-- created through the application (POST /api/v1/users), never by SQL.
-- =====================================================================

/* ---------------------------------- Roles ---------------------------------- */
/* Role names are the contract consumed by src/shared/permissions.ts.          */
/* Permission codes themselves live in code, not in the database.              */

INSERT OR IGNORE INTO roles (id, name, description) VALUES
  ('rol_owner',     'OWNER',     'Property owner — oversight and rental authority'),
  ('rol_operator',  'OPERATOR',  'Daily operations across properties, leads and rentals'),
  ('rol_marketing', 'MARKETING', 'Offers, campaigns and lead acquisition'),
  ('rol_analyst',   'ANALYST',   'Market intelligence and performance analysis'),
  ('rol_admin',     'ADMIN',     'System administration and governance');
