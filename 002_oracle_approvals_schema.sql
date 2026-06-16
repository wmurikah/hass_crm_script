-- ============================================================================
-- 002_oracle_approvals_schema.sql  -  Hass CMS  (Oracle PO / SO / LA timing)
-- ============================================================================
-- REFERENCE DDL ONLY. This documents the two data tables the loader and the
-- analytics code target. They MIRROR THE ORACLE EXTRACTS ONE TO ONE and already
-- exist in Turso, so this file is NEVER run automatically. Every statement uses
-- CREATE TABLE IF NOT EXISTS, so running it by hand against a database that
-- already has these tables is a no-op and never drops or alters a column.
--
-- There is NO normalized step model and there are NO oracle_* tables. The
-- earlier four-table design (oracle_approvals / oracle_approval_steps / ...) is
-- abandoned and must not be created. The loader (60_integ_oracle_approvals.gs)
-- snake-cases each extract header and writes it straight into the matching
-- column; the timing maths is derived at read time in 40_svc_oracle_approvals.gs.
--
-- All variance columns are MINUTES. Dates are stored verbatim as text.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- po_approvals  -  one row per Purchase Order (the PO extract, 1:1)
--   Primary key: purchase_number
--   The seven *_approvals_variance columns are CUMULATIVE minutes from
--   submission_for_approval_date; per-step time is their delta (computed in code).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS po_approvals (
  purchase_number                  TEXT PRIMARY KEY,
  req_description                  TEXT,
  nature                           TEXT,
  original_creation_date           TEXT,
  submission_for_approval_date     TEXT,
  time_diff_raisepo_toaprovalsubmit REAL,
  purchase_order_created_by        TEXT,
  first_approval_date              TEXT,
  second_approval_date             TEXT,
  third_approval_date              TEXT,
  fourth_approval_date             TEXT,
  fifth_approval_date              TEXT,
  sixth_approval_date              TEXT,
  seventh_approval_date            TEXT,
  first_approver                   TEXT,
  second_approver                  TEXT,
  third_approver                   TEXT,
  fourth_approver                  TEXT,
  fifth_approver                   TEXT,
  sixth_approver                   TEXT,
  seventh_approver                 TEXT,
  first_approvals_variance         REAL,
  second_approvals_variance        REAL,
  third_approvals_variance         REAL,
  fourth_approvals_variance        REAL,
  fifth_approvals_variance         REAL,
  sixth_approvals_variance         REAL,
  seventh_approvals_variance       REAL,
  authorization_status             TEXT,
  -- load bookkeeping
  source                           TEXT,
  source_batch_id                  TEXT,
  loaded_at                        TEXT,
  updated_at                       TEXT
);

-- ---------------------------------------------------------------------------
-- so_approvals  -  one row per Sales Order LINE (the SO extract, 1:1)
--   Primary key: (document_number, line_number)
--   Document-level fields repeat across a document's lines, so analytics dedupe
--   to document level before counting an approval / credit hold / LA / invoice.
--   finance_variance = create -> approval ; credit_variance = hold -> release ;
--   loading_authority_variance = approval -> LA ; invoice_variance = invoice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS so_approvals (
  affiliate                  TEXT,
  document_number            TEXT NOT NULL,
  posting_date               TEXT,
  actual_order_date_user_input TEXT,
  customer_code              TEXT,
  customer_name              TEXT,
  user_name                  TEXT,
  create_date                TEXT,
  create_time                TEXT,
  create_date_time           TEXT,
  approval_date1             TEXT,
  approval_date              TEXT,
  approval_time              TEXT,
  approval_date_time         TEXT,
  finance_variance           REAL,
  delayed_raising_orders     REAL,
  approval_status            TEXT,
  approver                   TEXT,
  credit_hold_date           TEXT,
  credit_hold_name           TEXT,
  released_flag              TEXT,
  release_reason_code        TEXT,
  credit_hold_release_date   TEXT,
  hold_released_by           TEXT,
  credit_variance            REAL,
  invoice_creation_date      TEXT,
  invoice_variance           REAL,
  line_number                INTEGER NOT NULL,
  ordered_item               TEXT,
  loading_authority_date     TEXT,
  loading_authority_variance REAL,
  -- load bookkeeping
  source                     TEXT,
  source_batch_id            TEXT,
  loaded_at                  TEXT,
  updated_at                 TEXT,
  PRIMARY KEY (document_number, line_number)
);

-- ---------------------------------------------------------------------------
-- po_so_comments  -  the comment + email-dispatch record for the feature.
--   Created lazily at runtime by 40_svc_oracle_approvals.gs (_oaEnsureComments_)
--   using the same CREATE TABLE IF NOT EXISTS migration-helper pattern as
--   20_mfa.gs. Listed here for reference.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS po_so_comments (
  comment_id    TEXT PRIMARY KEY,
  doc_type      TEXT,
  doc_number    TEXT,
  author_id     TEXT,
  author_name   TEXT,
  recipient     TEXT,
  body          TEXT NOT NULL,
  email_sent    INTEGER NOT NULL DEFAULT 0,
  email_sent_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_so_appr_doc      ON so_approvals (document_number);
CREATE INDEX IF NOT EXISTS idx_so_appr_approver ON so_approvals (approver);
CREATE INDEX IF NOT EXISTS idx_po_appr_status   ON po_approvals (authorization_status);
CREATE INDEX IF NOT EXISTS idx_pso_comments_doc ON po_so_comments (doc_type, doc_number);
