-- ============================================================================
-- HASS CMS - Staff Roles Baseline Verification (Stage 1)
-- ----------------------------------------------------------------------------
-- Read-only. Run in Turso Studio against the live DB BEFORE applying the
-- canonical roles migration (20260503_001_canonical_staff_roles.sql).
--
-- Output is captured into docs/audit/staff-roles-baseline-YYYY-MM-DD.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Canonical 12 staff roles vs current DB state.
--    Returns one row per canonical role with:
--      exists_in_db   - 1 if role_code is present
--      db_role_name   - what the DB currently has (may differ from canonical)
--      perms_count    - permissions mapped via role_permissions
--      users_count    - users currently holding the role
-- ---------------------------------------------------------------------------
WITH canonical(code, name) AS (VALUES
  ('SUPER_ADMIN',  'Super Administrator'),
  ('ADMIN',        'Administrator'),
  ('CEO',          'Chief Executive'),
  ('CFO',          'Chief Financial Officer'),
  ('COUNTRY_HEAD', 'Country General Manager'),
  ('MANAGER',      'Department Manager'),
  ('SUPERVISOR',   'Team Supervisor'),
  ('AGENT',        'Customer Service Agent'),
  ('FINANCE',      'Finance Officer'),
  ('KYC_OFFICER',  'KYC Compliance Officer'),
  ('OPS',          'Operations Officer'),
  ('AUDIT_VIEWER', 'Audit Read-Only')
)
SELECT
  c.code  AS canonical_code,
  c.name  AS canonical_name,
  CASE WHEN r.role_code IS NULL THEN 0 ELSE 1 END AS exists_in_db,
  r.role_name AS db_role_name,
  CASE WHEN r.role_name IS NOT NULL AND r.role_name != c.name THEN 1 ELSE 0 END AS name_mismatch,
  (SELECT COUNT(*) FROM role_permissions WHERE role_code = c.code) AS perms_count,
  (SELECT COUNT(*) FROM user_roles       WHERE role_code = c.code) AS users_count
FROM canonical c
LEFT JOIN roles r ON r.role_code = c.code
ORDER BY c.code;

-- ---------------------------------------------------------------------------
-- 2) Extras: roles that exist in DB but are NOT in the canonical 12.
--    Do NOT delete blindly. Some may be legacy roles still in active use.
-- ---------------------------------------------------------------------------
SELECT
  r.role_code,
  r.role_name,
  r.is_system,
  (SELECT COUNT(*) FROM role_permissions WHERE role_code = r.role_code) AS perms_count,
  (SELECT COUNT(*) FROM user_roles       WHERE role_code = r.role_code) AS users_count
FROM roles r
WHERE r.role_code NOT IN (
  'SUPER_ADMIN','ADMIN','CEO','CFO','COUNTRY_HEAD','MANAGER',
  'SUPERVISOR','AGENT','FINANCE','KYC_OFFICER','OPS','AUDIT_VIEWER'
)
ORDER BY users_count DESC, r.role_code;

-- ---------------------------------------------------------------------------
-- 3) Users with no role assigned (orphan users).
-- ---------------------------------------------------------------------------
SELECT
  u.user_id,
  u.email,
  u.first_name,
  u.last_name,
  u.country_code,
  u.status
FROM users u
LEFT JOIN user_roles ur ON ur.user_id = u.user_id
WHERE ur.role_code IS NULL
ORDER BY u.created_at;

-- ---------------------------------------------------------------------------
-- 4) Headcount totals per role (used by Stage 5 reconciliation).
-- ---------------------------------------------------------------------------
SELECT
  ur.role_code,
  COUNT(DISTINCT ur.user_id) AS users_count
FROM user_roles ur
GROUP BY ur.role_code
ORDER BY users_count DESC;
