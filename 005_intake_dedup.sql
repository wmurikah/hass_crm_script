-- 005_intake_dedup.sql
-- Deduplication ledger for inbound intake (email + WhatsApp). One row per
-- processed source message, keyed by (channel, external_id), so a re-scanned
-- email or a retried/duplicated webhook never creates a second ticket. The
-- intake pipeline also creates this table at runtime (CREATE TABLE IF NOT
-- EXISTS), so intake works even before this migration is applied.

CREATE TABLE IF NOT EXISTS intake_messages (
  channel      TEXT NOT NULL,   -- 'EMAIL' | 'WHATSAPP'
  external_id  TEXT NOT NULL,   -- Graph message id / WhatsApp message id
  ticket_id    TEXT,            -- the ticket created from this message
  sender       TEXT,            -- sender email / phone (for audit)
  created_at   TEXT,
  PRIMARY KEY (channel, external_id)
);
