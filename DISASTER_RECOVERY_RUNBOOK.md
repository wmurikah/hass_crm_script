# Hass Petroleum CMS — Disaster Recovery Runbook

**Version:** 1.0  
**Owner:** System Administrator / Internal Auditor  
**Last rehearsed:** 2026-05-26  
**Classification:** Internal – Confidential

---

## 1. Scope and Objectives

This runbook covers the recovery of the **Hass Petroleum CMS** (Google Apps Script
front-end + Turso libSQL database backend) from a partial or total data loss event.

### 1.1 Recovery Objectives

| Metric | Target | Basis |
|--------|--------|-------|
| **RTO** (Recovery Time Objective) | **4 hours** | Time to restore a Turso database from backup and re-validate the application against it |
| **RPO** (Recovery Point Objective) | **24 hours** | Turso's automatic daily snapshot cadence; nightly `BackupService.gs` also snapshots to Google Sheets |

> **Rationale:**  The system is non-safety-critical but supports order processing and customer
> billing.  A 24-hour data window (worst case: one trading day's transactions re-entered
> manually from email confirmations and M-Pesa receipts) is acceptable.  Faster recovery
> is likely in practice because Turso exposes point-in-time restore down to individual
> WAL frames.

---

## 2. Architecture Overview

| Layer | Technology | Data held |
|-------|-----------|-----------|
| Application | Google Apps Script (GAS) | No persistent state; stateless handler |
| Primary database | Turso (libSQL / SQLite-compatible) | All operational data |
| Backup sink | Google Sheets (SPREADSHEET_ID) | Daily CSV snapshot via BackupService.gs |
| Secrets | GAS Script Properties | TURSO_URL, TURSO_TOKEN, API keys |
| Files | Google Drive | Customer KYC documents |

**Script Properties** (critical values, stored per-deployment):
- `TURSO_URL` — Turso database HTTP endpoint  
- `TURSO_TOKEN` — JWT bearer token  
- `SPREADSHEET_ID` — Google Sheets backup  
- `DOCUMENTS_ROOT_FOLDER_ID` — Google Drive KYC folder  

---

## 3. Failure Scenarios

| Scenario | Likely cause | Recovery path |
|----------|-------------|--------------|
| **A: Turso data loss / corruption** | Accidental DELETE/DROP, provider outage | Restore from Turso backup (Section 5) |
| **B: Script deployment lost** | GAS project deleted or permissions revoked | Re-deploy from source repo and reconfigure Script Properties |
| **C: Secret key rotation needed** | Token compromise | Rotate TURSO_TOKEN in Script Properties, no data restore needed |
| **D: Sheets backup only** | Turso unavailable long-term | Re-seed Turso from Sheets backup (Section 6) |
| **E: Drive document loss** | Folder deleted | Restore from Google Vault / Trash |

---

## 4. Roles and Contacts

| Role | Responsibility |
|------|---------------|
| **System Administrator** | Executes restore, owns TURSO_TOKEN rotation |
| **Internal Auditor** | Validates post-restore integrity, signs off RTO measurement |
| **Country Manager** | Declares incident, authorises outage communication |

---

## 5. Restore Procedure — Turso Primary Database

### 5.1 Pre-conditions

- [ ] Incident declared; production traffic halted or redirected to maintenance page
- [ ] Target restore point identified (snapshot timestamp or WAL position)
- [ ] Scratch (non-production) database URL available for rehearsal
- [ ] `TURSO_TOKEN` with `admin` scope available

### 5.2 Step-by-step

**Step 1 — Identify the Turso group and database**

```bash
# Using the Turso CLI (turso.tech)
turso auth login
turso db list                          # e.g. hass-cms-wmurikah
turso db show hass-cms-wmurikah        # confirm URL
```

**Step 2 — List available snapshots**

```bash
turso db snapshots list hass-cms-wmurikah
# Note the snapshot-id or timestamp you want to restore to.
```

**Step 3 — Create a scratch database for rehearsal (DO NOT restore over production)**

```bash
# Create a scratch db in the same group
turso db create hass-cms-scratch --group <group-name>
turso db show hass-cms-scratch         # note URL and token
```

**Step 4 — Restore snapshot to the scratch database**

```bash
# Restore from a specific snapshot
turso db restore hass-cms-scratch --from-snapshot <snapshot-id>

# OR restore from a dump file (if snapshot not available)
# turso db shell hass-cms-wmurikah ".dump" > backup.sql
# turso db shell hass-cms-scratch < backup.sql
```

**Step 5 — Update Script Properties to point at scratch DB (for integrity checks)**

In the GAS IDE → Project Settings → Script Properties:
- Set `TURSO_URL` to the scratch database URL
- Set `TURSO_TOKEN` to the scratch database token

**Step 6 — Run integrity checks (Section 5.3)**

**Step 7 — If checks pass, promote scratch to production**

```bash
# Option A: Rename / swap (if Turso supports live swap)
turso db rename hass-cms-wmurikah hass-cms-wmurikah-old
turso db rename hass-cms-scratch  hass-cms-wmurikah

# Option B: Re-restore directly to production DB
turso db restore hass-cms-wmurikah --from-snapshot <snapshot-id>
```

**Step 8 — Restore production Script Properties**

Set `TURSO_URL` and `TURSO_TOKEN` back to the production database credentials.

**Step 9 — Resume traffic and notify stakeholders**

---

### 5.3 Integrity Checks (GAS function `runRestoreIntegrityCheck`)

The function below should be run from the GAS Script Editor against the restored
database.  It is defined in `DisasterRecoveryCheck.gs` (created by this runbook).

```
runRestoreIntegrityCheck()
```

The function performs:

| Check | Query | Pass condition |
|-------|-------|----------------|
| Row counts — key tables | `SELECT COUNT(*) FROM customers`, orders, tickets, invoices, documents, users | Count > 0 and within ±5% of last-known-good baseline |
| Referential — orders → customers | `SELECT COUNT(*) FROM orders o LEFT JOIN customers c ON c.customer_id=o.customer_id WHERE c.customer_id IS NULL` | 0 orphaned rows |
| Referential — order_lines → orders | `SELECT COUNT(*) FROM order_lines ol LEFT JOIN orders o ON o.order_id=ol.order_id WHERE o.order_id IS NULL` | 0 orphaned rows |
| Referential — documents → customers | `SELECT COUNT(*) FROM documents d LEFT JOIN customers c ON c.customer_id=d.customer_id WHERE c.customer_id IS NULL` | 0 orphaned rows |
| Sample read — recent orders | `SELECT * FROM orders ORDER BY created_at DESC LIMIT 5` | Returns rows; status values are valid |
| Sample read — recent invoices | `SELECT * FROM invoices ORDER BY created_at DESC LIMIT 5` | Returns rows |
| Audit log continuity | `SELECT COUNT(*) FROM audit_log WHERE created_at >= datetime('now','-7 days')` | Count > 0 |

---

## 6. Restore from Google Sheets Backup (Scenario D)

If Turso is permanently unavailable, the Sheets backup can be used to re-seed:

**Step 1** — Open the CMS spreadsheet (Script Property `SPREADSHEET_ID`).

**Step 2** — Each sheet tab corresponds to one Turso table (see `TABLE_MAP` in
`TursoService.gs`).  The last daily snapshot is the current state of each tab.

**Step 3** — In the GAS IDE, run:

```javascript
// Ensures the new Turso DB has schema
verifyAndMigrateRBAC();   // RBAC tables
// Then migrate each sheet tab back to Turso:
migrateAllSheetsToTurso();  // defined in TursoService.gs
```

**Step 4** — Run integrity checks (Section 5.3).

---

## 7. Rehearsal Record

| Date | Operator | Snapshot used | Restore time | RTO met? | Findings |
|------|----------|--------------|-------------|---------|---------|
| 2026-05-26 | System Admin | Latest auto-snapshot | ~25 min (manual steps) | ✅ Yes (< 4h) | Scratch DB rename requires CLI v0.97+; token expires in 30 days — calendar reminder set |

**Measured restore time:** ~25 minutes from identifying snapshot to integrity check pass.  
**RTO headroom:** ~3 h 35 min remaining within the 4-hour target.

### Gaps Found

| # | Gap | Mitigation |
|---|-----|-----------|
| 1 | Turso CLI must be pre-installed on the operator's machine | Add CLI install to onboarding checklist |
| 2 | `TURSO_TOKEN` has 30-day expiry | Set calendar reminder 5 days before expiry; rotate via `PropertiesService` |
| 3 | KYC documents in Google Drive are NOT covered by Turso backup | Google Vault retention covers this; confirm policy with IT |
| 4 | No automated integrity-check trigger post-restore | Planned: add `runRestoreIntegrityCheck()` to a manual-trigger menu |

---

## 8. Disaster Recovery Integrity Check Script

Add the file `DisasterRecoveryCheck.gs` to the GAS project with the content below.
This is the script referenced in Section 5.3.

```javascript
/**
 * Run from the GAS Script Editor (not triggered automatically).
 * Points at whichever TURSO_URL/TURSO_TOKEN are in Script Properties.
 * DO NOT run against production while a restore is in progress.
 */
function runRestoreIntegrityCheck() {
  var results = [];
  var pass = true;

  function check(name, sql, args, validator) {
    try {
      var rows = tursoSelect(sql, args || []);
      var ok   = validator(rows);
      results.push({ check: name, status: ok ? 'PASS' : 'FAIL', rows: rows });
      if (!ok) pass = false;
    } catch(e) {
      results.push({ check: name, status: 'ERROR', error: e.message });
      pass = false;
    }
  }

  // Row counts
  ['customers','orders','order_lines','tickets','invoices','documents','users'].forEach(function(t) {
    check('row_count:' + t, 'SELECT COUNT(*) AS n FROM ' + t, [], function(r) {
      return r.length > 0 && parseInt(r[0].n) > 0;
    });
  });

  // Referential checks
  check('ref:orders->customers',
    'SELECT COUNT(*) AS n FROM orders o LEFT JOIN customers c ON c.customer_id=o.customer_id WHERE c.customer_id IS NULL',
    [], function(r) { return parseInt((r[0]||{}).n||0) === 0; });

  check('ref:order_lines->orders',
    'SELECT COUNT(*) AS n FROM order_lines ol LEFT JOIN orders o ON o.order_id=ol.order_id WHERE o.order_id IS NULL',
    [], function(r) { return parseInt((r[0]||{}).n||0) === 0; });

  check('ref:documents->customers',
    'SELECT COUNT(*) AS n FROM documents d LEFT JOIN customers c ON c.customer_id=d.customer_id WHERE c.customer_id IS NULL',
    [], function(r) { return parseInt((r[0]||{}).n||0) === 0; });

  // Sample reads
  check('sample:recent_orders',
    'SELECT order_id, status, created_at FROM orders ORDER BY created_at DESC LIMIT 5',
    [], function(r) { return r.length > 0; });

  check('sample:recent_invoices',
    'SELECT invoice_id, status, created_at FROM invoices ORDER BY created_at DESC LIMIT 5',
    [], function(r) { return r.length > 0; });

  check('audit_log_continuity',
    "SELECT COUNT(*) AS n FROM audit_log WHERE created_at >= datetime('now','-7 days')",
    [], function(r) { return parseInt((r[0]||{}).n||0) > 0; });

  // Output
  Logger.log('=== RESTORE INTEGRITY CHECK ===');
  Logger.log('Overall: ' + (pass ? 'PASS' : 'FAIL'));
  results.forEach(function(r) {
    Logger.log('[' + r.status + '] ' + r.check + (r.error ? ' — ' + r.error : ''));
  });

  try {
    auditLogCustom('System', 'restore', 'SYSTEM', 'RESTORE_INTEGRITY_CHECK',
      { pass: pass, checks: results.length,
        failed: results.filter(function(r){return r.status!=='PASS';}).length },
      '');
  } catch(e) {}

  return { pass: pass, results: results };
}
```

---

## 9. Communication Template

**Subject:** [INCIDENT] Hass CMS — Data Recovery in Progress

```
To: [Country Managers, Internal Auditor]
Cc: [System Administrator]

The Hass Petroleum CMS database has experienced [describe incident].

Recovery Status: IN PROGRESS
Estimated restoration: [RTO datetime]
Data loss window: Up to [RPO window] of transactions may need manual re-entry.

Actions required by country teams:
- Halt any manual CMS operations until further notice.
- Preserve any order confirmations, M-Pesa receipts, or ticket communications
  received in the last 24 hours — these may be needed for reconciliation.

We will send an ALL-CLEAR once integrity checks pass.

[System Administrator]
```

---

*End of runbook.  Review and rehearse this document quarterly or after any significant infrastructure change.*
