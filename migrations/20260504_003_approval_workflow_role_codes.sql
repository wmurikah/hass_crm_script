-- ============================================================================
-- HASS CMS - Approval workflow role codes (G-002)
-- ----------------------------------------------------------------------------
-- Brings every row in `approval_workflows.rules` JSON in line with the v3
-- 16-role taxonomy (see migrations/20260504_002_v3_role_model.sql).
--
-- Mapping applied to legacy role codes that may appear inside
-- approver/required_approver_roles arrays:
--
--   AGENT       -> CS_AGENT
--   SUPERVISOR  -> CS_MANAGER
--   MANAGER     -> CS_MANAGER          (default)
--                  FINANCE_MANAGER     (refund / payment workflows)
--                  CREDIT_MANAGER      (credit-limit-change workflow)
--   KYC_OFFICER -> CS_AGENT  (collector role, used by the document collector)
--                  CS_MANAGER (approver role, used by the workflow approver)
--   FINANCE     -> FINANCE_MANAGER
--   COUNTRY_HEAD-> COUNTRY_MANAGER
--   ADMIN       -> SUPER_ADMIN
--
-- Approach
--   1) Replace the literal role-code strings inside the JSON with v3 codes.
--      SQLite's REPLACE() is sufficient here because we only ever match the
--      quoted role name (e.g. `"AGENT"`).
--   2) Re-seed (INSERT OR REPLACE) the canonical default workflows for the
--      five entity types the approval engine knows about:
--        order | customer_credit_limit | payment_refund |
--        document_kyc | customer_kyc
--      so that fresh deployments come up with correct rules even if the
--      table was never populated.
--
-- IDEMPOTENT: every statement is INSERT OR REPLACE / UPDATE-on-existing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Patch existing JSON in-place. Order matters: do MANAGER last because
--    SUPERVISOR/AGENT may legitimately contain the substring "MANAGER" in
--    longer codes (none currently do, but keep the order conservative).
-- ---------------------------------------------------------------------------
UPDATE approval_workflows SET rules = REPLACE(rules, '"AGENT"',       '"CS_AGENT"')        WHERE rules LIKE '%"AGENT"%';
UPDATE approval_workflows SET rules = REPLACE(rules, '"SUPERVISOR"',  '"CS_MANAGER"')      WHERE rules LIKE '%"SUPERVISOR"%';
UPDATE approval_workflows SET rules = REPLACE(rules, '"FINANCE"',     '"FINANCE_MANAGER"') WHERE rules LIKE '%"FINANCE"%';
UPDATE approval_workflows SET rules = REPLACE(rules, '"COUNTRY_HEAD"','"COUNTRY_MANAGER"') WHERE rules LIKE '%"COUNTRY_HEAD"%';
UPDATE approval_workflows SET rules = REPLACE(rules, '"ADMIN"',       '"SUPER_ADMIN"')     WHERE rules LIKE '%"ADMIN"%';

-- KYC_OFFICER: in approval workflows it always meant "the approver", not the
-- collector. Map to CS_MANAGER. Document collector role is set on the
-- workflow row separately (see seeds below).
UPDATE approval_workflows SET rules = REPLACE(rules, '"KYC_OFFICER"', '"CS_MANAGER"') WHERE rules LIKE '%"KYC_OFFICER"%';

-- MANAGER is overloaded. Patch per-domain, then default what is left to CS_MANAGER.
UPDATE approval_workflows SET rules = REPLACE(rules, '"MANAGER"', '"FINANCE_MANAGER"')
  WHERE rules LIKE '%"MANAGER"%' AND entity_type IN ('payment','refund','payment_refund','invoice');
UPDATE approval_workflows SET rules = REPLACE(rules, '"MANAGER"', '"CREDIT_MANAGER"')
  WHERE rules LIKE '%"MANAGER"%' AND entity_type IN ('customer_credit_limit','credit_limit');
UPDATE approval_workflows SET rules = REPLACE(rules, '"MANAGER"', '"CS_MANAGER"')
  WHERE rules LIKE '%"MANAGER"%';

-- ---------------------------------------------------------------------------
-- 2) Re-seed canonical default workflows for the engine. All amounts in KES.
--    `rules.thresholds` is evaluated by ApprovalEngine.gs in order: the
--    first row whose `max_amount` is null OR >= context amount wins.
--    Each threshold's `approvers` is an array of role codes; the engine
--    creates one approval_request per role (parallel approval).
-- ---------------------------------------------------------------------------
INSERT OR REPLACE INTO approval_workflows (workflow_id, workflow_name, entity_type, rules, is_active, created_at, updated_at) VALUES
  ('WF-ORDER-V3',
   'Order approval (v3 16-role)',
   'order',
   '{"amount_field":"amount","currency_field":"currency","sla_minutes":1440,"thresholds":[{"max_amount":100000,"approvers":["CS_MANAGER"]},{"max_amount":1000000,"approvers":["COUNTRY_MANAGER"]},{"max_amount":5000000,"approvers":["CFO"]},{"max_amount":null,"approvers":["CEO"]}]}',
   1, datetime('now'), datetime('now')),

  ('WF-CUSTOMER-CREDIT-V3',
   'Customer credit limit change',
   'customer_credit_limit',
   '{"amount_field":"new_limit","currency_field":"currency","sla_minutes":2880,"thresholds":[{"max_amount":500000,"approvers":["CREDIT_MANAGER"]},{"max_amount":5000000,"approvers":["FINANCE_MANAGER","CREDIT_MANAGER"]},{"max_amount":null,"approvers":["CFO","CREDIT_MANAGER"]}]}',
   1, datetime('now'), datetime('now')),

  ('WF-PAYMENT-REFUND-V3',
   'Payment refund approval',
   'payment_refund',
   '{"amount_field":"amount","currency_field":"currency","sla_minutes":1440,"thresholds":[{"max_amount":50000,"approvers":["FINANCE_MANAGER"]},{"max_amount":1000000,"approvers":["FINANCE_MANAGER","COUNTRY_MANAGER"]},{"max_amount":null,"approvers":["CFO"]}]}',
   1, datetime('now'), datetime('now')),

  ('WF-CUSTOMER-KYC-V3',
   'Customer KYC final approval',
   'customer_kyc',
   '{"sla_minutes":2880,"thresholds":[{"max_amount":null,"approvers":["CS_MANAGER"]}]}',
   1, datetime('now'), datetime('now')),

  ('WF-DOCUMENT-KYC-V3',
   'KYC document verification',
   'document',
   '{"sla_minutes":1440,"thresholds":[{"max_amount":null,"approvers":["CS_MANAGER"]}]}',
   1, datetime('now'), datetime('now')),

  ('WF-TICKET-ESCALATION-V3',
   'Ticket escalation approval',
   'ticket',
   '{"sla_minutes":480,"thresholds":[{"max_amount":null,"approvers":["CS_MANAGER"]}]}',
   1, datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------------
-- 3) Deactivate the deprecated v0.1 12-role workflow rows so the engine only
--    picks up the v3 seeds going forward. Rows are not deleted - they are
--    retained for review with Internal Audit.
-- ---------------------------------------------------------------------------
UPDATE approval_workflows
   SET is_active = 0,
       updated_at = datetime('now')
 WHERE workflow_id NOT IN (
        'WF-ORDER-V3',
        'WF-CUSTOMER-CREDIT-V3',
        'WF-PAYMENT-REFUND-V3',
        'WF-CUSTOMER-KYC-V3',
        'WF-DOCUMENT-KYC-V3',
        'WF-TICKET-ESCALATION-V3'
      );
