-- ============================================================================
-- HASS CMS - v3 Role Model Migration (16 staff roles)
-- ----------------------------------------------------------------------------
-- Adopts the 16-role staff taxonomy defined in
--   docs/roles-permissions-gap-analysis.md v0.2 §1.1
--
-- Tier breakdown:
--   - System (1):           SUPER_ADMIN
--   - C-Suite (3):          CEO, CFO, RMD
--   - Group functional (4): CREDIT_MANAGER, INTERNAL_AUDITOR,
--                           SHARED_SERVICES_MANAGER, SUPPLY_OPS_MANAGER
--   - Country functional (8): COUNTRY_MANAGER, REGIONAL_MANAGER, CS_MANAGER,
--                             CS_AGENT, BD_REP, FINANCE_MANAGER,
--                             FINANCE_OFFICER, VIEWER
--
-- IDEMPOTENT: every statement uses INSERT OR IGNORE / UPDATE patterns.
-- DOES NOT delete the prior 12-role canonical (ADMIN, COUNTRY_HEAD, MANAGER,
-- SUPERVISOR, AGENT, KYC_OFFICER, OPS, AUDIT_VIEWER, FINANCE). Those rows
-- are preserved for rollback and for review with Internal Audit. The
-- companion code (PermissionService.gs CANONICAL_STAFF_ROLES_) treats them
-- as DEPRECATED and excludes them from the canonical headcount report.
--
-- The 37-permission catalog and the per-role grants are seeded by
-- verifyAndMigrateRBAC() in PermissionService.gs (v3) on next start. This
-- migration only handles the `roles` table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Ensure roles.scope column exists (added by 20260503_001 in earlier
--    deployments; safe to re-attempt; SQLite raises "duplicate column" which
--    the application layer swallows).
-- ---------------------------------------------------------------------------
-- ALTER TABLE roles ADD COLUMN scope TEXT DEFAULT 'COUNTRY';

-- ---------------------------------------------------------------------------
-- 2) Insert v3 canonical roles. INSERT OR IGNORE leaves any existing rows
--    untouched; the UPDATE block below normalises them.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO roles (role_code, role_name, description, is_system, scope, created_at, updated_at) VALUES
  -- System
  ('SUPER_ADMIN',             'Super Administrator',           'System-level access reserved for designated technical and governance leads. Full read/write across all modules and countries.', 1, 'GLOBAL',  datetime('now'), datetime('now')),

  -- C-Suite
  ('CEO',                     'Chief Executive Officer',       'Group Chief Executive. Final approver for highest-tier orders. Read-write across all countries.',                              1, 'GLOBAL',  datetime('now'), datetime('now')),
  ('CFO',                     'Chief Financial Officer',       'Group Chief Financial Officer. Approves refunds, credit limit changes, and finance exceptions.',                              1, 'GLOBAL',  datetime('now'), datetime('now')),
  ('RMD',                     'Regional Managing Director',    'C-Suite executive overseeing regional operations.',                                                                          1, 'GLOBAL',  datetime('now'), datetime('now')),

  -- Group functional
  ('CREDIT_MANAGER',          'Credit Manager',                'Manages credit policy, customer credit limits, and credit risk assessments across all countries.',                           0, 'GLOBAL',  datetime('now'), datetime('now')),
  ('INTERNAL_AUDITOR',        'Internal Auditor',              'Read-only access across all entities for internal and external audit work.',                                                 1, 'GLOBAL',  datetime('now'), datetime('now')),
  ('SHARED_SERVICES_MANAGER', 'Shared Services Manager',       'Manages cross-country shared services functions including HR, admin, and group support.',                                    0, 'GLOBAL',  datetime('now'), datetime('now')),
  ('SUPPLY_OPS_MANAGER',      'Supply and Operations Manager', 'Group-wide head of supply chain and operations. Procurement, depot stock, inbound logistics, and operational oversight.',    0, 'GLOBAL',  datetime('now'), datetime('now')),

  -- Country functional
  ('COUNTRY_MANAGER',         'Country Manager',               'Country General Manager. Approves operations and exceptions within country scope.',                                          0, 'COUNTRY', datetime('now'), datetime('now')),
  ('REGIONAL_MANAGER',        'Regional Manager',              'Regional operations oversight within country (sub-country regional structure).',                                             0, 'COUNTRY', datetime('now'), datetime('now')),
  ('CS_MANAGER',              'CS and BD Manager',             'Highest functional authority within country. Heads CS and BD teams. Approves orders within country tier.',                   0, 'COUNTRY', datetime('now'), datetime('now')),
  ('CS_AGENT',                'CS Agent',                      'Frontline customer service agent. Tickets, order handling, customer communications.',                                        0, 'COUNTRY', datetime('now'), datetime('now')),
  ('BD_REP',                  'BD Representative',             'Business development field staff. Customer relationship development within country.',                                        0, 'COUNTRY', datetime('now'), datetime('now')),
  ('FINANCE_MANAGER',         'Finance Manager',               'Country-level finance head. Approves payments, refunds, invoice exceptions within country scope.',                           0, 'COUNTRY', datetime('now'), datetime('now')),
  ('FINANCE_OFFICER',         'Finance Officer',               'Country-level finance operator. Invoice generation, payment processing, reconciliation.',                                    0, 'COUNTRY', datetime('now'), datetime('now')),
  ('VIEWER',                  'Viewer',                        'Generic country-scoped read-only viewer.',                                                                                   0, 'COUNTRY', datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------------
-- 3) Normalise role_name / description / is_system / scope for any rows
--    that already existed before this migration ran.
-- ---------------------------------------------------------------------------
UPDATE roles SET role_name = 'Super Administrator',           is_system = 1, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'SUPER_ADMIN';
UPDATE roles SET role_name = 'Chief Executive Officer',       is_system = 1, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'CEO';
UPDATE roles SET role_name = 'Chief Financial Officer',       is_system = 1, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'CFO';
UPDATE roles SET role_name = 'Regional Managing Director',    is_system = 1, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'RMD';
UPDATE roles SET role_name = 'Credit Manager',                is_system = 0, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'CREDIT_MANAGER';
UPDATE roles SET role_name = 'Internal Auditor',              is_system = 1, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'INTERNAL_AUDITOR';
UPDATE roles SET role_name = 'Shared Services Manager',       is_system = 0, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'SHARED_SERVICES_MANAGER';
UPDATE roles SET role_name = 'Supply and Operations Manager', is_system = 0, scope = 'GLOBAL',  updated_at = datetime('now') WHERE role_code = 'SUPPLY_OPS_MANAGER';
UPDATE roles SET role_name = 'Country Manager',               is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'COUNTRY_MANAGER';
UPDATE roles SET role_name = 'Regional Manager',              is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'REGIONAL_MANAGER';
UPDATE roles SET role_name = 'CS and BD Manager',             is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'CS_MANAGER';
UPDATE roles SET role_name = 'CS Agent',                      is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'CS_AGENT';
UPDATE roles SET role_name = 'BD Representative',             is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'BD_REP';
UPDATE roles SET role_name = 'Finance Manager',               is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'FINANCE_MANAGER';
UPDATE roles SET role_name = 'Finance Officer',               is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'FINANCE_OFFICER';
UPDATE roles SET role_name = 'Viewer',                        is_system = 0, scope = 'COUNTRY', updated_at = datetime('now') WHERE role_code = 'VIEWER';

-- ---------------------------------------------------------------------------
-- 4) Deprecated roles from the v0.1 12-role canonical.
--    Listed here for review with Internal Audit. NOT DROPPED.
--    To migrate users, run setUserRoles() through the admin UI to re-assign
--    them to a v3 canonical role with the closest responsibilities, e.g.:
--      ADMIN         -> SUPER_ADMIN  (where appropriate, otherwise drop)
--      COUNTRY_HEAD  -> COUNTRY_MANAGER
--      MANAGER       -> CS_MANAGER   (or COUNTRY_MANAGER)
--      SUPERVISOR    -> CS_MANAGER   (per-team supervisor concept retired)
--      AGENT         -> CS_AGENT
--      KYC_OFFICER   -> CS_AGENT     (KYC handled by CS_AGENT collectors,
--                                     CS_MANAGER approvers per §3.1)
--      OPS           -> SUPPLY_OPS_MANAGER (or REGIONAL_MANAGER)
--      AUDIT_VIEWER  -> INTERNAL_AUDITOR
--      FINANCE       -> FINANCE_OFFICER
-- ---------------------------------------------------------------------------
SELECT role_code, role_name,
       (SELECT COUNT(*) FROM user_roles       WHERE role_code = r.role_code) AS users_count,
       (SELECT COUNT(*) FROM role_permissions WHERE role_code = r.role_code) AS perms_count
FROM roles r
WHERE r.role_code IN (
  'ADMIN','COUNTRY_HEAD','MANAGER','SUPERVISOR','AGENT',
  'KYC_OFFICER','OPS','AUDIT_VIEWER','FINANCE'
);

-- ---------------------------------------------------------------------------
-- 5) Post-migration verification: should return 16 v3 canonical role rows.
-- ---------------------------------------------------------------------------
SELECT role_code, role_name, scope, is_system
FROM roles
WHERE role_code IN (
  'SUPER_ADMIN',
  'CEO','CFO','RMD',
  'CREDIT_MANAGER','INTERNAL_AUDITOR','SHARED_SERVICES_MANAGER','SUPPLY_OPS_MANAGER',
  'COUNTRY_MANAGER','REGIONAL_MANAGER','CS_MANAGER','CS_AGENT','BD_REP',
  'FINANCE_MANAGER','FINANCE_OFFICER','VIEWER'
)
ORDER BY scope DESC, is_system DESC, role_code;
