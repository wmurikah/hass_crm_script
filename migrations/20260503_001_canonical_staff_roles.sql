-- ============================================================================
-- HASS CMS - Canonical Staff Roles Migration (Stage 2)
-- ----------------------------------------------------------------------------
-- Brings the `roles` table in line with the canonical 12-role staff model
-- defined in docs/roles-permissions-gap-analysis.md §2.1.
--
-- IDEMPOTENT: every statement uses INSERT OR IGNORE / UPDATE patterns.
-- Re-running this script is a no-op once it has been applied successfully.
--
-- DOES NOT delete extra roles. If extras are flagged in the baseline report,
-- review them with Internal Audit before any cleanup.
--
-- Equivalent to running applyCanonicalStaffRolesMigration() from Apps Script.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Add roles.scope column if missing.
--    SQLite's ALTER TABLE has no IF NOT EXISTS - run only when column absent.
--    Comment this line out if it has already been applied.
-- ---------------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN scope TEXT DEFAULT 'COUNTRY';

-- ---------------------------------------------------------------------------
-- 2) Insert any missing canonical roles.
--    Names, descriptions, and is_system follow the policy table verbatim.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO roles (role_code, role_name, description, is_system, scope, created_at, updated_at) VALUES
  ('SUPER_ADMIN',  'Super Administrator',     'Group IT lead and designated CTO delegate. Full system access. Country scope: All.',                            1, 'GLOBAL',       datetime('now'), datetime('now')),
  ('ADMIN',        'Administrator',           'Country IT and system administrators. Country-bound.',                                                         1, 'COUNTRY',      datetime('now'), datetime('now')),
  ('CEO',          'Chief Executive',         'Group Chief Executive. Read-write across all countries. Final approver for high-value orders.',                1, 'GLOBAL',       datetime('now'), datetime('now')),
  ('CFO',          'Chief Financial Officer', 'Group Chief Financial Officer. Finance approvals, refunds, credit limits.',                                    1, 'GLOBAL',       datetime('now'), datetime('now')),
  ('COUNTRY_HEAD', 'Country General Manager', 'Country General Manager. Country-bound. Approves operations within country scope.',                            0, 'COUNTRY',      datetime('now'), datetime('now')),
  ('MANAGER',      'Department Manager',      'Department Manager. Country-bound. Approves orders and team operations.',                                      0, 'COUNTRY',      datetime('now'), datetime('now')),
  ('SUPERVISOR',   'Team Supervisor',         'Team Supervisor. Country + team-bound. Manages team queue, escalations, and SLA.',                              0, 'COUNTRY_TEAM', datetime('now'), datetime('now')),
  ('AGENT',        'Customer Service Agent',  'Customer Service Agent. Country + team-bound. Frontline ticket and order handling.',                            0, 'COUNTRY_TEAM', datetime('now'), datetime('now')),
  ('FINANCE',      'Finance Officer',         'Finance Officer. Country-bound. Invoice, payment, and reconciliation operations.',                              0, 'COUNTRY',      datetime('now'), datetime('now')),
  ('KYC_OFFICER',  'KYC Compliance Officer',  'KYC Compliance Officer. Country-bound. Customer onboarding and document verification.',                        0, 'COUNTRY',      datetime('now'), datetime('now')),
  ('OPS',          'Operations Officer',      'Operations Officer. Country-bound. Dispatch, depot, and fleet operations.',                                    0, 'COUNTRY',      datetime('now'), datetime('now')),
  ('AUDIT_VIEWER', 'Audit Read-Only',         'Audit Read-Only. All countries. Read-only access for internal and external auditors.',                         1, 'GLOBAL',       datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------------
-- 3) Bring existing rows in line with canonical names/descriptions/scope/is_system.
--    Only updates rows already present (the INSERT OR IGNORE above handles new rows).
-- ---------------------------------------------------------------------------
UPDATE roles SET role_name = 'Super Administrator',     description = 'Group IT lead and designated CTO delegate. Full system access. Country scope: All.',                       is_system = 1, scope = 'GLOBAL',       updated_at = datetime('now') WHERE role_code = 'SUPER_ADMIN';
UPDATE roles SET role_name = 'Administrator',           description = 'Country IT and system administrators. Country-bound.',                                                    is_system = 1, scope = 'COUNTRY',      updated_at = datetime('now') WHERE role_code = 'ADMIN';
UPDATE roles SET role_name = 'Chief Executive',         description = 'Group Chief Executive. Read-write across all countries. Final approver for high-value orders.',           is_system = 1, scope = 'GLOBAL',       updated_at = datetime('now') WHERE role_code = 'CEO';
UPDATE roles SET role_name = 'Chief Financial Officer', description = 'Group Chief Financial Officer. Finance approvals, refunds, credit limits.',                               is_system = 1, scope = 'GLOBAL',       updated_at = datetime('now') WHERE role_code = 'CFO';
UPDATE roles SET role_name = 'Country General Manager', description = 'Country General Manager. Country-bound. Approves operations within country scope.',                       is_system = 0, scope = 'COUNTRY',      updated_at = datetime('now') WHERE role_code = 'COUNTRY_HEAD';
UPDATE roles SET role_name = 'Department Manager',      description = 'Department Manager. Country-bound. Approves orders and team operations.',                                 is_system = 0, scope = 'COUNTRY',      updated_at = datetime('now') WHERE role_code = 'MANAGER';
UPDATE roles SET role_name = 'Team Supervisor',         description = 'Team Supervisor. Country + team-bound. Manages team queue, escalations, and SLA.',                         is_system = 0, scope = 'COUNTRY_TEAM', updated_at = datetime('now') WHERE role_code = 'SUPERVISOR';
UPDATE roles SET role_name = 'Customer Service Agent',  description = 'Customer Service Agent. Country + team-bound. Frontline ticket and order handling.',                       is_system = 0, scope = 'COUNTRY_TEAM', updated_at = datetime('now') WHERE role_code = 'AGENT';
UPDATE roles SET role_name = 'Finance Officer',         description = 'Finance Officer. Country-bound. Invoice, payment, and reconciliation operations.',                         is_system = 0, scope = 'COUNTRY',      updated_at = datetime('now') WHERE role_code = 'FINANCE';
UPDATE roles SET role_name = 'KYC Compliance Officer',  description = 'KYC Compliance Officer. Country-bound. Customer onboarding and document verification.',                    is_system = 0, scope = 'COUNTRY',      updated_at = datetime('now') WHERE role_code = 'KYC_OFFICER';
UPDATE roles SET role_name = 'Operations Officer',      description = 'Operations Officer. Country-bound. Dispatch, depot, and fleet operations.',                               is_system = 0, scope = 'COUNTRY',      updated_at = datetime('now') WHERE role_code = 'OPS';
UPDATE roles SET role_name = 'Audit Read-Only',         description = 'Audit Read-Only. All countries. Read-only access for internal and external auditors.',                     is_system = 1, scope = 'GLOBAL',       updated_at = datetime('now') WHERE role_code = 'AUDIT_VIEWER';

-- ---------------------------------------------------------------------------
-- 4) EXTRA ROLES - review with Internal Audit before any removal.
--    The query below identifies roles that are not in the canonical 12. Do NOT
--    drop or DELETE them in this migration. The customer-portal `CUSTOMER`
--    role is intentionally retained.
-- ---------------------------------------------------------------------------
-- EXTRA ROLE - review with Internal Audit before removal.
SELECT role_code, role_name,
       (SELECT COUNT(*) FROM user_roles       WHERE role_code = r.role_code) AS users_count,
       (SELECT COUNT(*) FROM role_permissions WHERE role_code = r.role_code) AS perms_count
FROM roles r
WHERE r.role_code NOT IN (
  'SUPER_ADMIN','ADMIN','CEO','CFO','COUNTRY_HEAD','MANAGER',
  'SUPERVISOR','AGENT','FINANCE','KYC_OFFICER','OPS','AUDIT_VIEWER',
  'CUSTOMER'
);

-- ---------------------------------------------------------------------------
-- 5) Post-migration verification: re-run baseline query 1 to confirm all 12
--    canonical roles now show exists_in_db=1 with matching role_name.
--    See migrations/20260503_000_staff_roles_baseline.sql.
-- ---------------------------------------------------------------------------
