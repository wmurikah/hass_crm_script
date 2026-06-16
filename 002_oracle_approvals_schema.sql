-- ============================================================================
-- 002_oracle_approvals_schema.sql  -  Hass CMS  (Oracle PO / SO / LA timing)
-- ============================================================================
-- REFERENCE DDL ONLY. The four tables below already exist in Turso; this file
-- documents the exact columns the loader and analytics code target so the
-- physical tables can be aligned if a column name differs.
--
-- IT IS NEVER RUN AUTOMATICALLY. Every statement uses CREATE TABLE IF NOT
-- EXISTS, so running it by hand against a database that already has these
-- tables is a no-op and never drops or alters an existing column.
--
-- The loader (60_integ_oracle_approvals.gs) is schema aware: it introspects the
-- real columns via PRAGMA table_info and only writes columns that exist, using
-- the alias lists in that file. So a small naming difference on the physical
-- table degrades gracefully (that field is simply not stored) rather than
-- breaking the upload.
--
-- All timing is stored in MINUTES. A step with a null step_date is PENDING.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- oracle_approvals  -  one row per PO or SO document (the header)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_approvals (
  approval_id            TEXT PRIMARY KEY,
  doc_type               TEXT NOT NULL,            -- 'PO' | 'SO'
  doc_number             TEXT NOT NULL,            -- purchase Number (PO) | DOCUMENT_NUMBER (SO)
  description            TEXT,                      -- Req Description (PO)
  nature                 TEXT,                      -- NATURE (PO)
  affiliate              TEXT,                      -- AFFILIATE (SO)
  country_code           TEXT,                      -- derived from AFFILIATE (SO)
  customer_code          TEXT,                      -- SO
  customer_name          TEXT,                      -- SO
  created_by             TEXT,                      -- PURCHASE_ORDER_CREATED_BY (PO) | USER_NAME (SO)
  original_creation_date TEXT,                      -- ORIGINAL_CREATION_DATE (PO) | CREATE_DATE_TIME (SO)
  submission_date        TEXT,                      -- SUBMISSION_FOR_APPROVAL_DATE (PO)
  final_status           TEXT,                      -- AUTHORIZATION_STATUS (PO) | APPROVAL_STATUS (SO)
  source                 TEXT,                      -- 'UPLOAD' | 'INTEGRATION'
  source_batch_id        TEXT,                      -- groups one load together
  created_at             TEXT,
  updated_at             TEXT,
  UNIQUE (doc_type, doc_number)
);

-- ---------------------------------------------------------------------------
-- oracle_approval_steps  -  one typed step per approval / credit hold / LA / invoice
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_approval_steps (
  step_id          TEXT PRIMARY KEY,
  approval_id      TEXT,                              -- FK -> oracle_approvals.approval_id
  doc_type         TEXT,                              -- denormalised for fast aggregation
  doc_number       TEXT,
  step_no          INTEGER,                           -- 1..7 (PO) or ordering within SO
  step_type        TEXT,                              -- 'APPROVAL' | 'CREDIT_HOLD' | 'LA' | 'INVOICE'
  stage_label      TEXT,                              -- e.g. 'First Approval', 'Loading Authority'
  approver_name    TEXT,                              -- null for LA / INVOICE (no officer in extract)
  step_date        TEXT,                              -- null => the step is PENDING
  prior_date       TEXT,                              -- the date this step's clock started from
  duration_minutes REAL,                              -- step_date - prior_date, in minutes
  source_variance  TEXT,                              -- Oracle's own variance value, preserved verbatim
  is_pending       INTEGER DEFAULT 0,                 -- 1 when an expected approver has no date yet
  created_at       TEXT,
  updated_at       TEXT
);

-- ---------------------------------------------------------------------------
-- oracle_approval_comments  -  comments and the email dispatch record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_approval_comments (
  comment_id      TEXT PRIMARY KEY,
  approval_id     TEXT,
  doc_type        TEXT,
  doc_number      TEXT,
  step_id         TEXT,
  comment_text    TEXT,
  author_id       TEXT,
  author_name     TEXT,
  recipient_name  TEXT,
  recipient_email TEXT,
  email_status    TEXT,                               -- 'SENT' | 'FAILED' | 'SKIPPED'
  created_at      TEXT
);

-- ---------------------------------------------------------------------------
-- oracle_approval_targets  -  on-time thresholds per doc type and stage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_approval_targets (
  target_id      TEXT PRIMARY KEY,
  doc_type       TEXT,                                -- 'PO' | 'SO'
  stage          TEXT,                                -- stage_label or step_type this target applies to
  target_minutes REAL,                                -- on-time threshold, in minutes
  is_active      INTEGER DEFAULT 1,
  created_at     TEXT,
  updated_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_oa_steps_doc    ON oracle_approval_steps (doc_type, doc_number);
CREATE INDEX IF NOT EXISTS idx_oa_steps_apprv  ON oracle_approval_steps (approver_name);
CREATE INDEX IF NOT EXISTS idx_oa_steps_type   ON oracle_approval_steps (step_type);
CREATE INDEX IF NOT EXISTS idx_oa_steps_appr   ON oracle_approval_steps (approval_id);
CREATE INDEX IF NOT EXISTS idx_oa_comments_doc ON oracle_approval_comments (doc_type, doc_number);
CREATE INDEX IF NOT EXISTS idx_oa_targets_key  ON oracle_approval_targets (doc_type, stage);
