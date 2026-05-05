-- ============================================================================
-- HASS CMS - approval_requests table (G-002)
-- ----------------------------------------------------------------------------
-- One row per required approver per entity. The runtime engine
-- (ApprovalEngine.gs) creates a row for every approver in the matched
-- workflow tier (parallel approval) and advances entity status only when
-- all rows for the same (entity_type, entity_id) reach APPROVED.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ============================================================================

CREATE TABLE IF NOT EXISTS approval_requests (
  request_id                TEXT PRIMARY KEY,
  workflow_id               TEXT,
  entity_type               TEXT NOT NULL,
  entity_id                 TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  -- One of (required_approver_role, required_approver_user_id) must be set.
  -- Role-based rows match any user holding that role; user-targeted rows
  -- match exactly one user.
  required_approver_role    TEXT,
  required_approver_user_id TEXT,

  -- Resolved when the action is taken.
  approver_user_id          TEXT,
  approved_at               TEXT,
  comment                   TEXT,
  reason                    TEXT,

  escalation_level          INTEGER NOT NULL DEFAULT 0,
  expires_at                TEXT,

  -- Snapshot of context the engine was called with (JSON). Lets the inbox
  -- render an entity summary without re-loading the entity.
  context                   TEXT,
  country_code              TEXT,

  created_by                TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,

  FOREIGN KEY (workflow_id) REFERENCES approval_workflows(workflow_id)
);

CREATE INDEX IF NOT EXISTS ix_approval_requests_entity
  ON approval_requests (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS ix_approval_requests_status_expires
  ON approval_requests (status, expires_at);

CREATE INDEX IF NOT EXISTS ix_approval_requests_role
  ON approval_requests (required_approver_role, status);

CREATE INDEX IF NOT EXISTS ix_approval_requests_user
  ON approval_requests (required_approver_user_id, status);

CREATE INDEX IF NOT EXISTS ix_approval_requests_country
  ON approval_requests (country_code, status);
