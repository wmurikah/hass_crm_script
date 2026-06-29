-- 004_oracle_customers_mirror.sql
-- Read-only mirror of Oracle customer master (credit limit, balance/exposure,
-- on-hold status). Populated only by the Oracle customer sync; the app never
-- writes here. Keyed by the Oracle customer identifier. The connector also
-- creates this table at runtime (CREATE TABLE IF NOT EXISTS) so the integration
-- works even before this migration is applied.

CREATE TABLE IF NOT EXISTS oracle_customers (
  oracle_customer_id  TEXT PRIMARY KEY,   -- the mapped Oracle customer identifier
  account_number      TEXT,               -- matching key to customers.account_number
  name                TEXT,
  credit_limit        REAL,
  balance             REAL,               -- current balance / exposure
  on_hold             INTEGER DEFAULT 0,  -- 1 = on hold, 0 = not on hold
  hold_status         TEXT,               -- raw hold/status value from Oracle
  currency_code       TEXT,
  source              TEXT DEFAULT 'ORACLE',
  raw_json            TEXT,               -- the raw source row, for audit/debug
  synced_at           TEXT,
  sync_batch_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_oracle_customers_account ON oracle_customers(account_number);
