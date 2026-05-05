-- ============================================================================
-- HASS CMS - users MFA columns (G-008)
-- ----------------------------------------------------------------------------
-- Adds MFA + lockout columns to the users table so privileged roles can be
-- forced to enrol and verify TOTP at login.
--
--   mfa_enabled            0 = not enrolled, 1 = TOTP active
--   mfa_secret             Base32 TOTP shared secret. Stored plain for MVP;
--                          codebase has no field-level encryption helper yet
--                          (flagged as a hardening follow-up).
--   failed_login_attempts  Incremented on bad password OR bad MFA code.
--   locked_until           ISO timestamp; account refuses login until this
--                          passes. Cleared on successful login.
--
-- IDEMPOTENT: SQLite raises "duplicate column" on re-run, which the
-- application layer (DatabaseSetup runMigrations) swallows.
-- ============================================================================

ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_secret TEXT;
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;
