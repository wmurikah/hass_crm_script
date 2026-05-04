# Staff Roles - Baseline Verification Report

> **Generated:** 2026-05-03 (skeleton; populate with live results before sign-off)
> **Source query:** `migrations/20260503_000_staff_roles_baseline.sql`
> **Live runner (Apps Script):** `runStaffRolesBaseline()` in `PermissionService.gs`
> **Purpose:** Read-only snapshot of the `roles` / `role_permissions` / `user_roles` tables before applying the canonical-roles migration (`20260503_001_canonical_staff_roles.sql`).

This file is a template. Run the SQL above in Turso Studio (or invoke `permissions.runStaffRolesBaseline` from the admin UI) and paste the results into the tables below. Both tools return the same rows.

---

## 1. Canonical roles - current state

For each of the 12 canonical staff roles defined in §2.1 of the gap analysis:

| Canonical code | Canonical name | Exists in DB | DB role_name | Name mismatch | perms_count | users_count |
|---|---|---|---|---|---|---|
| SUPER_ADMIN  | Super Administrator     | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| ADMIN        | Administrator           | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| CEO          | Chief Executive         | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| CFO          | Chief Financial Officer | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| COUNTRY_HEAD | Country General Manager | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| MANAGER      | Department Manager      | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| SUPERVISOR   | Team Supervisor         | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| AGENT        | Customer Service Agent  | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| FINANCE      | Finance Officer         | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| KYC_OFFICER  | KYC Compliance Officer  | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| OPS          | Operations Officer      | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| AUDIT_VIEWER | Audit Read-Only         | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |

**Expected on a fresh Phase-1 DB**: based on `PermissionService.gs#DEFAULT_ROLES_` prior to this PR, the legacy seed used codes such as `CS_MANAGER`, `CS_AGENT`, `BD_MANAGER`, `BD_REP`, `FINANCE_OFFICER`, `COUNTRY_MANAGER`, `REGIONAL_MANAGER`, `GROUP_HEAD`, `VIEWER`. Most of the canonical 12 are therefore **expected to be missing** prior to the migration.

## 2. Extra roles in DB (not in canonical policy)

Roles already in the database whose `role_code` is NOT one of the canonical 12. Do **not** delete blindly - some may still be referenced by user records.

| role_code | role_name | is_system | perms_count | users_count | Action |
|---|---|---|---|---|---|
| _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | REVIEW with Internal Audit |

The customer-portal role `CUSTOMER` is intentionally retained and is **not** considered an extra.

## 3. Users without any role

Count of `users` rows with no matching `user_roles` entry (orphan users):

| user_id | email | first_name | last_name | country_code | status |
|---|---|---|---|---|---|
| _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |

---

## Summary

- Canonical roles present:        _t.b.c._ / 12
- Canonical roles missing:        _t.b.c._
- Canonical roles name-mismatched: _t.b.c._
- Extras flagged for review:      _t.b.c._
- Orphan users (no role):         _t.b.c._

---

## Post-migration state

Re-run the baseline query after applying `20260503_001_canonical_staff_roles.sql`. All 12 canonical rows should show `exists_in_db = 1` and `name_mismatch = 0`.

| Canonical code | Exists | Name match | perms_count | users_count |
|---|---|---|---|---|
| SUPER_ADMIN  | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| ADMIN        | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| CEO          | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| CFO          | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| COUNTRY_HEAD | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| MANAGER      | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| SUPERVISOR   | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| AGENT        | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| FINANCE      | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| KYC_OFFICER  | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| OPS          | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| AUDIT_VIEWER | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |
