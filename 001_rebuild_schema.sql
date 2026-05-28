-- ============================================================================
-- 001_rebuild_schema.sql  —  Hass CMS canonical rebuild schema
-- ============================================================================
-- Reference DDL for the rebuilt Turso (libSQL) database.
-- Run migrateAddSessionRole() from the IDE on existing DBs to backfill the
-- role column on the sessions table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  user_type      TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  expires_at     TEXT NOT NULL,
  last_active_at TEXT,
  ip             TEXT,
  ua             TEXT,
  country_code   TEXT,
  role           TEXT,                  -- primary role code cached for fast auth lookups
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
