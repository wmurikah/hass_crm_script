# Staff Headcount Reconciliation Report

> **Generated:** 2026-05-03 (skeleton; populate with live counts before sign-off)
> **Source function:** `staffHeadcountReconciliation()` in `PermissionService.gs`
> **Live action:** invoke `permissions.staffHeadcountReconciliation` from the admin console (or call directly from the Apps Script IDE).
> **Purpose:** Compares the canonical staff role headcount targets (gap analysis §2.1) against actual users currently assigned, classifies real vs. test users, and recommends a provisioning timeline.

This file is a template. After running `staffHeadcountReconciliation()`, paste the JSON results into the tables below. Provisioning of real users is leadership/HR's call - this report is engineering-side reporting only.

---

## Section A - Target vs actual

| Role | Target (min) | Target (max) | Actual | Variance vs min | Status |
|---|---:|---:|---:|---:|:--:|
| SUPER_ADMIN  |  2 |  2 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| ADMIN        |  4 |  6 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| CEO          |  1 |  1 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| CFO          |  1 |  1 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| COUNTRY_HEAD |  4 |  4 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| MANAGER      |  8 | 12 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| SUPERVISOR   | 12 | 18 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| AGENT        | 20 | 40 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| FINANCE      | 10 | 15 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| KYC_OFFICER  |  4 |  6 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| OPS          | 15 | 25 | _t.b.c._ | _t.b.c._ | _t.b.c._ |
| AUDIT_VIEWER |  2 |  4 | _t.b.c._ | _t.b.c._ | _t.b.c._ |

**Status legend**
- `OK`        - actual is within `[min, max]`
- `UNDER`     - actual < min (need to provision more)
- `OVER`      - actual > max (review whether all assignments are still needed)
- `CRITICAL`  - actual = 0 (role is unmanned and not enforceable)

---

## Section B - Active vs test users

User classification heuristics:
- Email matches `@hass.co.{ke,ug,tz,rw}` -> likely **REAL** if also has `last_login_at`
- `last_login_at IS NULL` -> **NEVER_LOGGED_IN** (likely seed/test)
- Email outside the Hass domains -> **TEST_OR_SEED**

Don't delete on this signal alone - flag and review.

| user_id | Email | Name | last_login_at | Status | Classification |
|---|---|---|---|---|---|
| _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ | _t.b.c._ |

---

## Section C - Recommendations

Based on Section A:

- **Roles needing immediate provisioning** (CRITICAL or UNDER with min &ge; 1): _t.b.c._
- **Roles with no defined owner** (cross-reference §5 of the gap analysis doc): _t.b.c._
- **Suggested provisioning timeline**:
  - Week 1: roles with target 1-2 (SUPER_ADMIN, CEO, CFO, AUDIT_VIEWER)
  - Week 2: roles with target 3-10 (ADMIN, COUNTRY_HEAD, MANAGER, KYC_OFFICER, FINANCE)
  - Month 1: SUPERVISOR, AGENT, OPS

---

## Summary

- Roles OK:        _t.b.c._
- Roles UNDER:     _t.b.c._
- Roles OVER:      _t.b.c._
- Roles CRITICAL:  _t.b.c._
- Real users:      _t.b.c._
- Test/seed users: _t.b.c._
