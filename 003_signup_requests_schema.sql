-- ============================================================================
-- 003_signup_requests_schema.sql  -  Hass CMS  (self-signup capture + review)
-- ============================================================================
-- REFERENCE DDL ONLY. This documents the live signup_requests table, which
-- ALREADY EXISTS in Turso. The live columns are authoritative; this file was
-- written from PRAGMA table_info(signup_requests) (see migrateSignupStatusDefault
-- in 99_dev_seed.gs, which prints/uses the same introspection). Every statement
-- uses CREATE TABLE IF NOT EXISTS, so running it by hand against the live
-- database is a no-op and never drops or alters a column.
--
-- One row is written per self-signup request, pending an admin decision:
--   * producers  : auth.signup (40_svc_auth.gs), signupRequests.create
--                  (40_svc_signup_request.gs) - both write status explicitly as
--                  'PENDING_APPROVAL' and never collect a password
--                  (pending_password_hash stays null).
--   * review     : signupRequests.approve sets status='APPROVED', approved_by,
--                  approved_at (and customer_id when linking a portal contact);
--                  signupRequests.reject sets status='REJECTED',
--                  rejection_reason, rejected_at (40_svc_signups.gs).
--   * list filter: signupRequests.list defaults to status='PENDING_APPROVAL'.
--
-- There are NO created_at / updated_at / reviewed_by / reviewed_at /
-- decision_reason / provisioned_id / provisioned_type columns. submitted_at is
-- the only timestamp. kyc_status is a separate post-approval lifecycle and keeps
-- its own default of 'PENDING'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS signup_requests (
  request_id                   TEXT PRIMARY KEY,
  company_name                 TEXT,
  first_name                   TEXT,
  last_name                    TEXT,
  email                        TEXT,
  phone                        TEXT,
  job_title                    TEXT,
  account_type                 TEXT,
  customer_id                  TEXT,
  country_code                 TEXT,
  tax_pin                      TEXT,
  registration_number          TEXT,
  certificate_of_incorporation TEXT,
  dealer_code                  TEXT,
  station_name                 TEXT,
  card_number                  TEXT,
  kra_pin                      TEXT,
  account_number               TEXT,
  company_address              TEXT,
  pending_password_hash        TEXT,
  kyc_status                   TEXT DEFAULT 'PENDING',
  status                       TEXT DEFAULT 'PENDING_APPROVAL',
  approved_by                  TEXT,
  approved_at                  TEXT,
  rejection_reason             TEXT,
  rejected_at                  TEXT,
  submitted_at                 TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Changing the status DEFAULT on the EXISTING table
-- ---------------------------------------------------------------------------
-- The live table predates this change with status DEFAULT 'PENDING'. SQLite
-- cannot ALTER a column default in place, so the default is changed by rebuilding
-- the table. Run migrateSignupStatusDefault() from the Apps Script IDE: it
-- guards on an EMPTY table (so no data is migrated or lost), preserves every
-- column via introspection, and overrides only the status default. The manual
-- equivalent, while the table is empty, is:
--
--   BEGIN IMMEDIATE;
--   CREATE TABLE signup_requests__new ( ...the columns above... );
--   INSERT INTO signup_requests__new SELECT * FROM signup_requests;
--   DROP TABLE signup_requests;
--   ALTER TABLE signup_requests__new RENAME TO signup_requests;
--   COMMIT;
