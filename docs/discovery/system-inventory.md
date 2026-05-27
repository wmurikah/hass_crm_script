# System inventory

> **Prepared by:** Claude Code (discovery pass, read-only)
> **Date:** 2026-05-27
> **Repo:** wmurikah/hass_crm_script
> **Branch:** claude/apps-script-turso-audit-HYqdy
> **Scope:** Pre-rebuild audit of Hass Petroleum CMS (Apps Script + Turso)

---

## 0. Executive summary

| Item | Count |
|---|---|
| .gs files | 30 |
| .html files | 10 |
| Tables referenced in code (TABLE_MAP) | 50 |
| Migrations | 6 |
| Active integrations (wired) | 1 (M-Pesa Daraja — partial) |
| Partial/stubbed integrations | 5 (Oracle EBS, KRA eTIMS, WhatsApp, Teams, Twilio) |
| Time-driven triggers defined in code | 5 (none confirmed installed in production) |
| Open gaps from gap doc | 18 (G-002 through G-021, 2 closed) |

**Three headline takeaways:**

1. **The approval engine and SLA breach detector are coded but not running.** `ApprovalEngine.gs` and `SLABreachDetector.gs` are complete; the time-driven triggers that would run them (`installJobProcessorTrigger`, `installSLABreachTrigger`) are written but require a manual one-time execution from the Apps Script IDE. Until they are installed, G-002 and G-003 remain open.

2. **There is a split-identity RBAC in flight.** The system has a legacy `users.role` string column and a new `user_roles` table (v3 RBAC). Both code paths coexist. Several permission checks (e.g. `Code.gs:111`) still call deprecated keys (`roles.assign`) while the canonical key is `role.assign`. Client-side role checks in `Staffdashboard.html` use old, undocumented role codes (`GROUP_HEAD`, `BD_MANAGER`, `CTO`) that do not appear in the 16-role taxonomy in the gap doc.

3. **~20 configuration items that the business will want to change live in code, not the database.** Country codes with affiliate mappings, approval KES thresholds, SLA escalation tier order, MFA-required roles, hardcoded email addresses, and the colour palette are all constants in `.gs` or `.html` files. These are the rebuild's primary data-migration targets.

---

## 1. Repository structure

```
hass_crm_script/              GAS project root (flat — no subdirectories for code)
├── *.gs (30 files)           All backend logic — no subdirectory organisation
├── *.html (10 files)         All frontend — full pages and MFA partials
├── appsscript.json           Manifest
├── HASS_CMS_DATABASE.xlsx    Legacy reference/seed data (not read at runtime)
├── docs/
│   ├── audit/                Three audit snapshots (roles baseline, headcount, portal audit)
│   └── roles-permissions-gap-analysis.md   Primary gap document (gap doc)
└── migrations/               6 SQL migration files (read-only reference; applied manually)
```

**Top-level folder purposes:**

| Folder | Purpose |
|---|---|
| _(root)_ | All GAS source — flat structure, no separation by layer |
| `docs/` | Gap analysis, audit snapshots, discovery (this file) |
| `migrations/` | Manual SQL DDL applied to Turso via Studio; not run automatically |

**Orphans / duplicates:**

- `HASS_CMS_DATABASE.xlsx` — original seed/reference spreadsheet; no runtime code reads it.
- `SheetDatabase.gs` — batch engine for Sheets (backup writes only); name implies it is a DB layer but its runtime role is purely backup-sink.
- `SeedData.gs` — bootstrap-only; contains plaintext test credentials in source (`HassAdmin2024!`, `Customer2024!`). Should be deleted after first run or credentials rotated. (See §10.)
- `LoginDiagnostics.gs` — diagnostic helper only; not called at runtime. Orphan if not removed after debugging.
- `TestSuite.gs` — test runner; not wired to any CI; effectively dead in production.

---

## 2. Apps Script backend (.gs)

### Code.gs
- **Path:** `Code.gs`
- **Purpose:** Main entry point — `doGet` router and `doPost` service dispatcher.
- **Public functions:**
  - `doGet(e)` — routes to login, MFA pages, or dashboards based on session+page param
  - `doPost(e)` — auth guard + 18-service dispatch switch; M-Pesa callback bypass before guard
  - `processRequest(params)` — `google.script.run`-callable wrapper that unwraps `doPost` result
  - `getBackgroundUrl()` — always returns `''`; dead code remnant
  - `include(filename)` — HtmlService template include helper
  - `serveLoginPage`, `serveStaffDashboard`, `serveCustomerPortal`, `serveApprovalsInbox`, `serveAuditViewer`, `serveStaffRoleManagement`, `serveStaffRoleAssignment`, `serveMfaEnrollPage`, `serveMfaVerifyPage` — page-serving helpers
- **Internal deps:** All service modules (called via switch in `doPost`)
- **External deps:** `HtmlService`, `ContentService`, `ScriptApp`
- **Type:** Entry point (doGet/doPost)
- **Note:** `serveStaffRoleManagement` checks `roles.assign` (deprecated); `serveStaffRoleAssignment` checks `role.assign` (canonical) — inconsistent permission keys (§10).

---

### TursoService.gs
- **Path:** `TursoService.gs`
- **Purpose:** All Turso (libSQL) HTTP I/O. The only file that calls `UrlFetchApp` against the Turso `/v2/pipeline` endpoint.
- **Public functions:**
  - `tursoSelect(sql, args)` — SELECT → array of objects
  - `tursoWrite(sql, args)` — single write statement
  - `tursoBatchWrite(statements)` — multi-statement batch in one HTTP round-trip
  - `_buildInsert(table, obj)` / `_buildUpdate(table, idCol, idVal, updates)` — SQL builders
  - `testTursoConnection()` — diagnostic (IDE use)
  - `benchmarkReadSpeed()` — diagnostic (IDE use)
  - `migrateAllSheetsToTurso()` / `verifyMigration()` — one-time migration helpers
- **Constants:** `TABLE_MAP` (50 entries, logical name → SQL table), `PK_MAP` (50 entries)
- **Internal deps:** `DatabaseSetup.gs` (`getSheetData` for migration), `CacheManager.gs` (none directly)
- **External deps:** `UrlFetchApp` → `TURSO_URL/v2/pipeline`; credentials from `PropertiesService` (`TURSO_URL`, `TURSO_TOKEN`)
- **Type:** Service module (data-access layer)

---

### DatabaseSetup.gs
- **Path:** `DatabaseSetup.gs`
- **Purpose:** Core CRUD layer — wraps Turso calls with entity-level helpers; defines SCHEMAS and ID generation.
- **Public functions:**
  - `getSheetData(sheetName)` — all rows from Turso table
  - `appendRow(sheetName, rowData)` — insert
  - `updateRow(sheetName, idColumn, idValue, updates)` — update
  - `deleteRow(sheetName, idColumn, idValue, hardDelete)` — soft or hard delete
  - `findRow(sheetName, columnName, value)` — first matching row
  - `findRows(sheetName, columnName, value)` — all matching rows
  - `getById(sheetName, id)` / `getByIds(sheetName, ids)` — PK lookups
  - `getCachedSheetData(sheetName)` — cache-aware read
  - `generateIdForSheet(sheetName)` / `generateId(prefix)` / `generateUUID()` — ID gen
  - `generateTicketNumber`, `generateOrderNumber`, `generateAccountNumber` — sequence numbers
  - `logAudit(...)` — legacy shim; delegates to `audit_log()` in AuditService
  - `logIntegrationCall(...)` — integration log writer
  - `getConfig(key, defaultValue)` / `getConfigNumber` / `setConfig` — Config table accessors
  - `getSpreadsheet()` / `sheetToObjects()` / `getHeaders_()` — backup-only Sheet accessors
- **Constants:** `COLLECTION_MAP` (backward compat alias), `SCHEMAS` (validation schemas for 8 entities), `AFFILIATE_CODES` (KE→HPK etc.), `CONFIG.CACHE_TTL_SECONDS`, `CONFIG.LOCK_TIMEOUT_MS`
- **Internal deps:** `TursoService.gs` (`tursoSelect`, `tursoWrite`), `CacheManager.gs` (`cachedGet`, `cacheInvalidate`), `AuditService.gs` (`audit_log`)
- **External deps:** `SpreadsheetApp` (backup only), `LockService`, `PropertiesService`
- **Type:** Service module (data-access layer)
- **Note:** `SCHEMAS.Users.validations.role` still lists old 9-role model (`SUPER_ADMIN, ADMIN, CS_MANAGER, CS_AGENT, SALES_REP, COUNTRY_MANAGER, REGIONAL_MANAGER, GROUP_HEAD, VIEWER`) — does not match current 16-role taxonomy. This will cause validation failures for new v3 roles.

---

### DatabaseService.gs
- **Path:** `DatabaseService.gs`
- **Purpose:** Advanced query and relationship layer — `findWhere`, `searchRecords`, pagination, aggregate helpers, relationship views (customer360, orderDetail, ticketDetail).
- **Public functions:**
  - `findWhere(sheetName, conditions, options)` — filtered, paginated query
  - `searchRecords(sheetName, searchText, searchFields, additionalFilters, options)` — full-text search
  - `countWhere(sheetName, conditions)` — count
  - `createRecord` / `updateRecord` / `softDeleteRecord` / `hardDeleteRecord` — CRUD with validation and audit
  - `bulkCreate` / `bulkUpdate` / `updateWhere` — batch mutations
  - `getCustomer360(customerId)` — denormalised customer detail with all related entities
  - `getOrderDetail(orderId)` / `getTicketDetail(ticketId)` — enriched views
  - `groupByCount` / `sumField` / `getByDateRange` — aggregation helpers
  - `getAllCountries` / `getAllSegments` / `getAllProducts` / `getAllDepots` / `getAllTeams` / `getAllSLAConfigs` — lookup helpers
  - `getUsersByRole` / `getUsersByTeam` / `getUsersByCountry` — user filters
- **Internal deps:** `DatabaseSetup.gs`, `TursoService.gs`, `CacheManager.gs`, `AuditService.gs`
- **External deps:** `LockService`
- **Type:** Service module (query layer)

---

### AuthService.gs
- **Path:** `AuthService.gs`
- **Purpose:** Authentication — login, session management, signup, OTP password reset, MFA orchestration.
- **Public functions:**
  - `handleAuthRequest(params)` — dispatcher (12 actions)
  - `loginUser(params)` — staff + customer login with MFA gate
  - `logoutUser(params)` — session invalidation + audit
  - `checkSession(params)` — token validation + idle timeout (G-010)
  - `createSession(userId, userType, role, hoursValid)` — concurrent session control (G-010)
  - `signupCustomer(params)` — creates `signup_requests` row; stores pending password hash in `PropertiesService` (risk: §10)
  - `verifyCustomerAccount(params)` — account lookup
  - `requestPasswordReset` / `verifyOtp` / `setNewPassword` — OTP flow with HTML email (G-006 closed)
  - `validatePasswordPolicy(password, userId, userType)` — G-009 enforcement
  - `mfaEnrollStart` / `mfaEnrollVerify` / `mfaVerify` / `mfaDisableForUser` — TOTP MFA (G-008)
  - `getStaffInfo(userId)` — basic staff info
  - `getLogoUrl()` — loads logo from Drive folder ID hardcoded in source (`1AL9fUgYXM9DXj9-X_0YonrloqCXat2wq`)
  - `hashPassword(plain)` — SHA-256 (not bcrypt)
- **Internal deps:** `DatabaseSetup.gs`, `TursoService.gs`, `MfaService.gs`, `AuditService.gs`, `PermissionService.gs`
- **External deps:** `MailApp` (password reset, signup notification), `PropertiesService`, `ScriptApp`, `DriveApp`
- **Type:** Service module

---

### PermissionService.gs
- **Path:** `PermissionService.gs`
- **Purpose:** RBAC engine — seeds and manages the `roles`, `permissions`, `role_permissions`, `user_roles` tables; exposes `userHasPermission`, `requirePermission`.
- **Public functions:**
  - `verifyAndMigrateRBAC()` — idempotent schema + seed for all 4 RBAC tables
  - `handlePermissionRequest(params)` — UI dispatcher
  - `userHasPermission(userId, permissionCode)` — per-request cached check; `SUPER_ADMIN` is wildcard
  - `userPermissions(userId)` — all permission codes for a user
  - `requirePermission(session, permissionCode)` — throws `PermissionDeniedError` if missing
  - `requireOrderApprovalPermission(userId, orderAmount, currencyCode)` — amount-tier check (reads thresholds from Config with hardcoded fallbacks)
  - `_getApprovalThresholds_()` — reads `APPROVAL_THRESHOLD_LOW_KES` / `APPROVAL_THRESHOLD_MID_KES` from Config; fallback `{ low: 100000, mid: 1000000 }`
  - `_exchangeRateToKES_(currencyCode)` — reads exchange rates from Config; hardcoded defaults `UGX: 0.034, TZS: 0.052, RWF: 0.10`
- **Constants:** `DEFAULT_PERMISSIONS_` (46 codes, including 9 deprecated), `DEFAULT_ROLES_` (16 staff roles with permission grants), `SUPER_ADMIN_ONLY_ROLES_`, `MFA_BYPASS_ROLES_`
- **Internal deps:** `DatabaseSetup.gs`, `TursoService.gs`, `AuditService.gs`, `MfaService.gs`
- **Type:** Service module

---

### RoleService.gs
- **Path:** `RoleService.gs`
- **Purpose:** Granular role assignment/revocation with protection rules (last SUPER_ADMIN, last role, system-role gating).
- **Public functions:**
  - `RoleService.assignRole(targetUserId, roleCode, reason, actorUserId)` — with audit
  - `RoleService.revokeRole(targetUserId, roleCode, reason, actorUserId)` — with guards
  - `RoleService.getUserRoles(userId)` — list role_codes
  - `RoleService.getRoleUsers(roleCode)` — list users
  - `listRoleAssignmentData(filters)` — page data: all roles + all users + assignments
  - `handleRoleRequest(params)` — doPost dispatcher
- **Constants:** `ROLE_SERVICE_SYSTEM_ROLES_` = `['SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR']`
- **Internal deps:** `PermissionService.gs` (`userHasPermission`), `TursoService.gs`, `DatabaseSetup.gs`, `AuditService.gs`
- **Type:** Service module

---

### ApprovalEngine.gs
- **Path:** `ApprovalEngine.gs`
- **Purpose:** Approval workflow runtime — reads `approval_workflows.rules` JSON, routes requests, enforces SoD, tracks state (G-002).
- **Public functions:**
  - `submitForApproval(entityType, entityId, context)` — creates `approval_requests` row; picks threshold tier
  - `approve(requestId, approverUserId, comment)` — validates SoD, updates state
  - `rejectApproval(requestId, approverUserId, reason)` — with audit
  - `escalateApproval(requestId, reason)` — bumps escalation level
  - `getPendingApprovals(userId, options)` — inbox query for a user
  - `listEntityApprovals(entityType, entityId)` — approval history
  - `runApprovalTimeoutCheck()` — sweeps for SLA-breached pending approvals; called via JobProcessor
  - `handleApprovalRequest(params)` — doPost dispatcher
- **Internal deps:** `TursoService.gs`, `DatabaseSetup.gs`, `PermissionService.gs`, `AuditService.gs`, `JobProcessor.gs` (enqueueJob)
- **Type:** Service module
- **Status:** Code complete; trigger not confirmed installed (G-002 partially closed at code level, G-003 still open at runtime).

---

### AuditService.gs
- **Path:** `AuditService.gs`
- **Purpose:** Centralised audit log writer (G-005) — all mutations should route through here.
- **Public functions:**
  - `setAuditRequestContext(ctx)` / `getAuditRequestContext()` — per-request IP/UA/actor
  - `audit_log(entry)` — low-level writer to `audit_log` table
  - `auditLogCreate` / `auditLogUpdate` / `auditLogDelete` / `auditLogCustom` — typed wrappers
  - `withAudit(spec, fn)` — decorator wrapper
  - `handleAuditRequest(params)` — doPost dispatcher
- **Internal deps:** `DatabaseSetup.gs`, `TursoService.gs`
- **Type:** Service module

---

### CacheManager.gs
- **Path:** `CacheManager.gs`
- **Purpose:** Two-tier cache — L1 `CacheService` (100 KB/key, chunked for large datasets), L2 `PropertiesService` (static reference data, 9 KB/key).
- **Public functions:**
  - `cachedGet(sheetName, loader)` — read-through cache
  - `cacheInvalidate(sheetName)` / `cacheInvalidateAll(sheetNames)` — invalidation
  - `cacheGetValue(key, loader, ttl)` / `cacheSetValue(key, value, ttl)` / `cacheDeleteValue(key)` — single-value cache
- **Constants:** Static sheets (longer TTL): `Countries, Segments, Products, Depots, SLAConfig, Config, Teams, KnowledgeCategories`
- **Type:** Utility

---

### MfaService.gs
- **Path:** `MfaService.gs`
- **Purpose:** TOTP MFA implementation — RFC 6238 HMAC-SHA1, challenge token management via `PropertiesService` (G-008).
- **Public functions:**
  - `isMfaEnforced()` — reads `MFA_ENFORCED` from Script Property or Config (default `false`)
  - `userRequiresMfa(userId)` — checks `user_roles` against `MFA_REQUIRED_ROLES`
  - `generateSecret()` / `verifyCode(secret, userCode)` / `provisioningUri` / `provisioningQrUrl`
  - `createMfaChallenge` / `getMfaChallenge` / `consumeMfaChallenge` / `incrementChallengeFailure` / `setMfaChallengePendingSecret`
  - `clearStaleMfaChallenges()` — housekeeping on each login
- **Constants:** `MFA_REQUIRED_ROLES` = `['SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR','FINANCE_MANAGER']`; `MFA_EXEMPT_USER_IDS` with one hardcoded dummy UUID
- **Type:** Service module

---

### JobProcessor.gs
- **Path:** `JobProcessor.gs`
- **Purpose:** Async job queue — dispatches `SEND_EMAIL`, `SEND_NOTIFICATION`, `SLA_BREACH_CHECK`, `SLA_BREACH_SWEEP`, `SESSION_CLEANUP`, `AUDIT_CLEANUP`, `ORACLE_SYNC`, `APPROVAL_TIMEOUT_CHECK`.
- **Public functions:**
  - `processJobQueue()` — trigger entry point (5-min time-driven)
  - `enqueueJob(type, payload, delaySecs)` / `enqueueEmail(...)` / `enqueueNotification(...)` — helpers
  - `installJobProcessorTrigger()` / `uninstallJobProcessorTrigger()` — trigger management
  - `scheduleDailyMaintenance()` / `installMaintenanceTrigger()` — daily maintenance
  - `scheduleApprovalTimeoutCheck()` / `installApprovalTimeoutTrigger()` — hourly approval sweep
- **Internal deps:** All service modules (via `_dispatch_`), `DatabaseSetup.gs`
- **External deps:** `GmailApp`, `LockService`, `ScriptApp`
- **Type:** Trigger handler + utility

---

### SLABreachDetector.gs
- **Path:** `SLABreachDetector.gs`
- **Purpose:** SLA sweep — scans open tickets for breaches, bumps `escalation_level`, routes to next tier, pauses clock outside business hours (G-003).
- **Public functions:**
  - `detectTicketBreaches()` — main sweep (also handles orders with missed requested_date and doc expiry via G-014 overlap)
  - `getActiveBreaches(options)` — dashboard data
  - `recalculateSLATargets(ticketId)` — recompute targets in flight
  - `scheduleSLABreachSweep()` — enqueue sweep job
  - `installSLABreachTrigger()` — 15-min time-driven trigger
- **Constants:** `SLA_BREACH_OPEN_STATUSES`; `SLA_BREACH_FINANCE_CATEGORIES_` = `['BILLING','PAYMENT','INVOICE','CREDIT']`; escalation path Level 0→CS_AGENT, 1→CS_MANAGER, 2→COUNTRY_MANAGER, 3→CFO (finance) / RMD (other) — all hardcoded
- **Internal deps:** `DatabaseService.gs`, `AuditService.gs`, `JobProcessor.gs`, `TursoService.gs`
- **Type:** Trigger handler + service module

---

### MpesaService.gs
- **Path:** `MpesaService.gs`
- **Purpose:** M-Pesa Daraja C2B integration — validation and confirmation callbacks, payment matching (G-012).
- **Public functions:**
  - `isMpesaDarajaCallback(params)` — sniffer called in `doPost`
  - `handleMpesaCallback(params, urlParams)` — routes to validation or confirmation
  - `handleMpesaValidation(body)` / `handleMpesaConfirmation(body)` — Daraja callbacks
  - `registerMpesaCallbackUrls()` — one-time Daraja registration (IDE call)
  - `retryUnmatchedMpesaPayments()` — manual reconciliation sweep
- **Internal deps:** `DatabaseSetup.gs`, `AuditService.gs`
- **External deps:** `UrlFetchApp` → `api.safaricom.co.ke` (production) / `sandbox.safaricom.co.ke`; credentials from Script Properties (`MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_ENV`)
- **Type:** Service module (integration)
- **Status:** Code complete; `MPESA_ENV` defaults to `sandbox`; production credentials and callback registration required (G-012).

---

### EtimsService.gs
- **Path:** `EtimsService.gs`
- **Purpose:** KRA eTIMS OSDC integration — transmits invoices to KRA; retries on failure (G-013).
- **Public functions:**
  - `submitInvoiceToEtims(invoiceId)` — called after invoice generation; skips gracefully if unconfigured
  - `retryFailedEtimsTransmissions()` — hourly retry sweep
  - `installEtimsRetryTrigger()` — hourly trigger installation
- **External deps:** `UrlFetchApp` → `etims-api.kra.go.ke` (prod) / `etims-sbx.kra.go.ke`; credentials from Script Properties (`ETIMS_API_URL`, `ETIMS_BRANCH_ID`, `ETIMS_DEVICE_SERIAL`, `ETIMS_PIN`, `ETIMS_PIN_KEY`, `ETIMS_ENV`)
- **Type:** Service module (integration)
- **Status:** Code complete; requires Finance+IT provisioning. Invoices table needs `etims_*` columns added (listed in file header).

---

### Integrationservice.gs
- **Path:** `Integrationservice.gs`
- **Purpose:** Oracle EBS multi-transport connector (REST/OIC, DB Gateway, S3/SFTP, DBLink) + WhatsApp inbound scan + Twilio Voice call pull + webhook processing + integration health monitoring.
- **Public functions:**
  - `handleIntegrationRequest(params)` — doPost dispatcher
  - `getIntegrationConfig()` / `saveIntegrationSetting(key, value)` — config CRUD
  - `testOracleAllTransports()` — per-transport health check
  - `oracleAutoSyncJob()` — scheduled auto-sync; trigger installable via `installOracleAutoSyncTrigger()`
  - `syncCustomersToOracle` / `syncOrderToOracle` / `syncInvoiceToOracle` — entity sync functions
  - `scanInboundWhatsApp()` / `scanInboundCalls()` / `getCallTranscription()` — channel inbound
  - `getSystemChannels()` — live status of all 6 channels
- **Internal deps:** `DatabaseSetup.gs`, `AuditService.gs`, `TursoService.gs`, `JobProcessor.gs`
- **External deps:** `UrlFetchApp` → multiple Oracle endpoints, WhatsApp Business API, Twilio, Microsoft Graph; credentials all in Script Properties
- **Type:** Service module (integrations)
- **Status:** All connectors wired but not connected to production credentials. All calls log to `integration_log` only. Partially wired (G-011, G-012 partially covered by MpesaService).

---

### DashboardService.gs
- **Path:** `DashboardService.gs`
- **Purpose:** Staff dashboard data — summary KPIs, order/ticket stats, SLA metrics, headcount, system channel health, PO approval pipeline.
- **Public functions:** `handleDashboardRequest(params)` — dispatcher; `getDashboardSummary(params)`, `getStaffHeadcountWidget(session)`, `getSystemChannels(session)`, `getDashboardOrders(params)`, `getDashboardTickets(params)`, `getDashboardFinance(params)`, `getDashboardSLA(params)`
- **Constants:** `DASHBOARD_GLOBAL_ROLES_` = `['SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR','GROUP_HEAD','CTO']`; `DASHBOARD_CHANNEL_ROLES_` = `['SUPER_ADMIN','CEO','CFO','CTO','GROUP_HEAD']` — both hardcoded; include `CTO` and `GROUP_HEAD` which are not in the 16-role taxonomy
- **Internal deps:** `DatabaseSetup.gs`, `DatabaseService.gs`, `TursoService.gs`, `PermissionService.gs`
- **Type:** Service module

---

### CustomerService.gs, CustomerStatementsService.gs, Orderservice.gs, Ticketservice.gs, Documentservice.gs, Knowledgeservice.gs
- **Paths:** as named
- **Purposes:**
  - `CustomerService.gs` — customer 360, credit limit, KYC submission, price list, consumption
  - `CustomerStatementsService.gs` — statement generation and export
  - `Orderservice.gs` — full order lifecycle (create, submit, approve, dispatch, deliver, recurring)
  - `Ticketservice.gs` — ticket lifecycle (create, assign, escalate, resolve, auto-assignment, SLA calculation)
  - `Documentservice.gs` — KYC document upload, verification, expiry tracking
  - `Knowledgeservice.gs` — knowledge base CRUD and search
- **Entry points:** `handleCustomerRequest`, `handleStatementRequest`, `handleOrderRequest`, `handleTicketRequest`, `handleDocumentRequest`, `handleKnowledgeRequest` — all called from `Code.gs`
- **Common deps:** `DatabaseSetup.gs`, `DatabaseService.gs`, `TursoService.gs`, `AuditService.gs`, `PermissionService.gs`
- **Orderservice.gs constants:** `ORDER_STATUS_FLOW` (valid state transitions), `ORDER_CONFIG` (`CREDIT_CHECK_THRESHOLD: 0.9`, `MAX_ORDER_LINES: 50`, `DRAFT_EXPIRY_DAYS: 30`, `ORDER_EDIT_CUTOFF_HOURS: 2`) — all hardcoded
- **Ticketservice.gs:** SLA fallbacks hardcoded — `acknowledge_minutes: 60`, `first_response_minutes: 120` (`Ticketservice.gs:1072-1075`)
- **Type:** Service modules

---

### NotificationService.gs
- **Path:** `Notificationservice.gs`
- **Purpose:** Email (Graph/MailApp fallback), WhatsApp, SMS, Teams notifications + template rendering.
- **Key constants:** `DEFAULT_SENDER_EMAIL: 'noreply@hasspetroleum.com'` hardcoded; `GRAPH_ENDPOINT` hardcoded to `hassaudit@outlook.com` (`Notificationservice.gs:252`)
- **External deps:** `UrlFetchApp` → Microsoft Graph, WhatsApp API, Twilio, SMS gateway; `MailApp`
- **Type:** Service module

---

### SLAService.gs
- **Path:** `SLAService.gs`
- **Purpose:** SLA data, configuration, reporting, and breach-status queries.
- **Entry point:** `handleSLARequest(params)`
- **Internal deps:** `DatabaseSetup.gs`, `TursoService.gs`, `PermissionService.gs`
- **Type:** Service module

---

### UserService.gs
- **Path:** `UserService.gs`
- **Purpose:** Staff user CRUD, password management, invite flow, signup approval, portal user management.
- **Entry point:** `handleUserRequest(params)`
- **Internal deps:** `DatabaseSetup.gs`, `TursoService.gs`, `AuthService.gs`, `AuditService.gs`, `PermissionService.gs`
- **Type:** Service module

---

### SettingsService.gs
- **Path:** `SettingsService.gs`
- **Purpose:** Config table CRUD, integration connection tests (Oracle, WhatsApp, Teams, Zoom, Twilio, Email), OneDrive/SharePoint backup destination management.
- **Entry point:** `handleSettingsRequest(params)` (14 actions)
- **Constants:** `ENCRYPTED_KEYS` — list of keys masked on read (passwords, tokens)
- **External deps:** `UrlFetchApp` → Microsoft Graph (OneDrive), Zoom, Twilio, Teams webhook; `LockService`
- **Type:** Service module

---

### BackupService.gs
- **Path:** `BackupService.gs`
- **Purpose:** Turso → Sheets backup (incremental every 60 min; full on demand). The only service that writes to Sheets at runtime.
- **Entry point:** `runIncrementalBackup_trigger()` (60-min trigger)
- **Internal deps:** `TursoService.gs`, `DatabaseSetup.gs` (`getSpreadsheet`, `sheetToObjects`, `getHeaders_`)
- **External deps:** `SpreadsheetApp`, `LockService`, `PropertiesService`, `ScriptApp`
- **Type:** Trigger handler

---

### Other .gs files (brief)

| File | Purpose | Type |
|---|---|---|
| `ChatService.gs` | Staff messaging (stub-level, reads/writes `staff_messages`) | Service module |
| `DataUploadService.gs` | Bulk CSV/Excel data import via `handleDataUploadRequest` | Service module |
| `DebugDB.gs` | Schema gap detector — reads EXPECTED_SCHEMA vs actual Turso; suggests DDL; pure read-only | Utility / diagnostic |
| `LoginDiagnostics.gs` | Login debugging helpers; not called at runtime | Utility / orphan |
| `Publish.gs` | One-click publisher — creates new GAS version, re-points existing deployment | Utility (deploy) |
| `SeedData.gs` | Bootstrap admin + test customer creation; plaintext credentials in source | Utility / risk |
| `TestSuite.gs` | Manual test runner; not integrated with CI | Utility / dead in prod |
| `SheetDatabase.gs` | Batch Turso write engine (`batchInsertRows`, `batchUpdateRows`, `bulkSetFields`) | Service module (data-access) |

---

## 3. Frontend (.html)

### Login.html
- **Path:** `Login.html`
- **Purpose:** Full page — staff + customer unified login, signup, OTP password reset. ~79 KB.
- **`google.script.run` calls:**
  - `handleAuthRequest({ action: 'login', ... })`
  - `handleAuthRequest({ action: 'signup', ... })`
  - `handleAuthRequest({ action: 'verifyAccount', ... })`
  - `handleAuthRequest({ action: 'requestPasswordReset', ... })`
  - `handleAuthRequest({ action: 'verifyOtp', ... })`
  - `handleAuthRequest({ action: 'setNewPassword', ... })`
  - `getBackgroundUrl()` (returns `''`)
- **Data shapes consumed:** Returns `{ success, token, role, userId, redirectUrl, mfaRequired, challengeToken }`
- **Permission gating:** None — unauthenticated by design
- **Hardcoded:** Brand colours (`--navy-800: #1A237E`), contact email `support@hasspetroleum.com`

---

### Staffdashboard.html
- **Path:** `Staffdashboard.html`
- **Purpose:** Full page — staff portal with all modules (customers, orders, tickets, finance, SLA, reports, settings, roles, audit). ~368 KB (largest file in repo).
- **`google.script.run` calls:**
  - `processRequest({ service:'dashboard', action:'getDashboardSummary', ... })`
  - `processRequest({ service:'dashboard', action:'staffHeadcountWidget', ... })`
  - `processRequest({ service:'customers', action:'list'/'get'/'create'/'update'/... })`
  - `processRequest({ service:'orders', action:'list'/'get'/'create'/'update'/... })`
  - `processRequest({ service:'tickets', action:'list'/'create'/'update'/... })`
  - `processRequest({ service:'sla', action:... })`
  - `processRequest({ service:'permissions', action:'getMyPermissions'/'listRoles'/'listPermissions'/... })`
  - `processRequest({ service:'roles', action:'listAssignmentData'/'assignRole'/'revokeRole'/... })`
  - `processRequest({ service:'users', action:'list'/'create'/'update'/... })`
  - `processRequest({ service:'settings', action:'getSettings'/'saveSettings'/'testOracle'/... })`
  - `processRequest({ service:'audit', action:... })`
  - `processRequest({ service:'approvals', action:... })`
  - `handleAuthRequest({ action: 'logout', ... })`
  - `handleAuthRequest({ action: 'getStaffInfo', ... })`
- **Data shapes consumed:** SESSION object injected via template (`{ userId, userType, role, token, name, scriptUrl }`)
- **Permission gating in markup:**
  - Tab visibility gated client-side on `SESSION.role` using old undocumented codes (`GROUP_HEAD`, `BD_MANAGER`, `CTO`) **not present in server-side 16-role model** (`Staffdashboard.html:2791-2860`)
  - Same gates **are** enforced server-side via `requirePermission` in service handlers — but the role code mismatch means the client may show/hide content using different codes than the server checks. **Flag: client role codes diverge from server 16-role taxonomy.**
- **Hardcoded:** Role display names map (`Staffdashboard.html:2991-2992`) including deprecated codes; role filter lists (`adminRoles`, `reportRoles`, `channelRoles`)

---

### Customerportal.html
- **Path:** `Customerportal.html`
- **Purpose:** Full page — customer self-service portal. ~148 KB.
- **`google.script.run` calls:**
  - `processRequest({ service:'orders', action:'list'/'get'/'create'/... })`
  - `processRequest({ service:'tickets', action:'create'/'list'/... })`
  - `processRequest({ service:'statements', action:... })`
  - `processRequest({ service:'notifications', action:... })`
  - `processRequest({ service:'customers', action:'customer360'/... })`
  - `handleAuthRequest({ action: 'logout', ... })`
- **Data shapes consumed:** SESSION object injected via template (`{ contactId, customerId, userType:'CUSTOMER', role:'CUSTOMER', token, name, scriptUrl }`)
- **Permission gating in markup:** No visible portal-role (`ADMIN`/`MANAGER`/`OPERATOR`/`VIEWER`) gating in markup — the portal shows the same UI to all customer contacts regardless of their `contacts.portal_role`. **Flag: portal_role not enforced client-side or server-side in current code.**

---

### Approvals.html
- **Path:** `Approvals.html`
- **Purpose:** Full page — staff approvals inbox.
- **`google.script.run` calls:** `processRequest({ service:'approvals', action:'getPendingApprovals'/'approve'/'reject'/'escalate'/... })`
- **Permission gating:** Served by `serveApprovalsInbox` in `Code.gs` which does **not** check any permission before rendering the page. **Flag: no server-side permission guard on the Approvals page entry point.**

---

### AuditViewer.html
- **Path:** `AuditViewer.html`
- **Purpose:** Full page — audit log viewer.
- **Permission gating:** `serveAuditViewer` in `Code.gs:59-82` correctly calls `userHasPermission(session.userId, 'audit_log.view')` before rendering. Server-side guard **is** present.

---

### Staff_RoleManagement.html, Staff_RoleAssignment.html
- **Paths:** as named
- **Purposes:** Full pages — role + permission matrix viewer (`RoleManagement`) and role assignment UI (`RoleAssignment`)
- **`google.script.run` calls:**
  - Both call `processRequest` with `service:'permissions'` and `service:'roles'` actions
- **Permission gating:**
  - `Staff_RoleAssignment.html` — served via `serveStaffRoleAssignment` which checks `role.assign` ✓
  - `Staff_RoleManagement.html` — served via `serveStaffRoleManagement` which checks `roles.assign` (deprecated key) — **Flag: uses deprecated permission code**

---

### MfaEnroll.html, MfaVerify.html
- **Paths:** as named
- **Purposes:** Partials — MFA setup (QR + code entry) and MFA verify (code entry) during login flow
- **`google.script.run` calls:**
  - `handleAuthRequest({ action: 'mfaEnrollStart', challengeToken })`
  - `handleAuthRequest({ action: 'mfaEnrollVerify', challengeToken, code })`
  - `handleAuthRequest({ action: 'mfaVerify', challengeToken, code })`
- **Permission gating:** Gated by short-lived challenge token; not by session (correct — pre-session flow)

---

## 4. Manifest (appsscript.json)

| Setting | Value |
|---|---|
| `timeZone` | `Africa/Nairobi` |
| `exceptionLogging` | `STACKDRIVER` |
| `runtimeVersion` | `V8` |
| `webapp.executeAs` | `USER_DEPLOYING` |
| `webapp.access` | `ANYONE` |

**oauthScopes:**

| Scope | What it enables |
|---|---|
| `auth/spreadsheets` | Read/write Google Sheets (used by BackupService) |
| `auth/drive.readonly` | Read Drive files (logo retrieval in AuthService) |
| `auth/script.external_request` | UrlFetchApp (Turso, Oracle, M-Pesa, etc.) |
| `auth/script.projects` | Apps Script Projects API (Publish.gs) |
| `auth/script.deployments` | Apps Script Deployments API (Publish.gs) |
| `auth/gmail.send` | MailApp.sendEmail (password reset, signup notifications) |
| `auth/script.scriptapp` | ScriptApp triggers |
| `auth/script.send_mail` | MailApp (legacy scope; partially redundant with gmail.send) |
| `auth/userinfo.email` | Email of the executing user |

No advanced services enabled. No `urlFetchWhitelist` configured (all external domains are reachable without explicit allow-listing in this manifest version).

---

## 5. Deployment and triggers

### Deployment
| Item | Value |
|---|---|
| Deployment ID | `AKfycbzaUVMghqie8EmgLvIMl-fa_5YeFDGurxjTA2QN5hhkCbOsKUN5MaaQRjq9VjMTj9LI` |
| Live URL | `https://script.google.com/macros/s/AKfycbzaUVMghqie8EmgLvIMl-fa_5YeFDGurxjTA2QN5hhkCbOsKUN5MaaQRjq9VjMTj9LI/exec` |
| Deploy mechanism | `publishToLiveUrl()` in `Publish.gs` — creates new version, re-points existing deployment |
| `SCRIPT_ID` in Publish.gs | `'PASTE_YOUR_SCRIPT_ID_HERE'` — **not set** (must be set before publishing) |

### Trigger registrations defined in code

| Function registered | Schedule | Installer | File | Status |
|---|---|---|---|---|
| `processJobQueue` | Every 5 min | `installJobProcessorTrigger()` | `JobProcessor.gs:334` | **Not confirmed installed** — installer must be run once from IDE |
| `scheduleDailyMaintenance` | Daily at 02:00 | `installMaintenanceTrigger()` | `JobProcessor.gs:405` | **Not confirmed installed** |
| `scheduleApprovalTimeoutCheck` | Hourly | `installApprovalTimeoutTrigger()` | `JobProcessor.gs:386` | **Not confirmed installed** |
| `scheduleSLABreachSweep` | Every 15 min | `installSLABreachTrigger()` | `SLABreachDetector.gs:872` | **Not confirmed installed** |
| `runIncrementalBackup_trigger` | Every 60 min | `installBackupTrigger()` | `BackupService.gs:394` | **Not confirmed installed** |
| `retryFailedEtimsTransmissions` | Hourly | `installEtimsRetryTrigger()` | `EtimsService.gs:502` | **Not confirmed installed** |
| `oracleAutoSyncJob` | Configurable (≥5 min) | `installOracleAutoSyncTrigger()` | `Integrationservice.gs:280` | **Not confirmed installed** |

**All trigger installers exist but require a one-time manual execution.** There is no evidence from the repo that any trigger is currently active.

---

## 6. Database (Turso)

### 6.1 Schema objects (tables, indexes, views, triggers)

**Pending owner-side dump** — the `debugFrontend()` function in `DebugDB.gs` will produce the definitive list. From code analysis, the 50 tables referenced in `TABLE_MAP` are:

`countries`, `segments`, `products`, `depots`, `teams`, `users`, `customers`, `contacts`, `delivery_locations`, `price_list`, `price_list_items`, `vehicles`, `drivers`, `orders`, `order_lines`, `order_status_history`, `invoices`, `payment_uploads`, `documents`, `sla_config`, `business_hours`, `holidays`, `tickets`, `ticket_comments`, `ticket_attachments`, `ticket_history`, `sla_data`, `po_approvals`, `approval_workflows`, `approval_requests`, `sessions`, `password_resets`, `signup_requests`, `notifications`, `notification_preferences`, `notification_templates`, `staff_messages`, `knowledge_categories`, `knowledge_articles`, `config`, `audit_log`, `integration_log`, `job_queue`, `recurring_schedule`, `recurring_schedule_lines`, `churn_risk_factors`, `retention_activities`

Plus RBAC tables (added by `verifyAndMigrateRBAC()`): `roles`, `role_permissions`, `user_roles` (3 additional = 53 total including RBAC)

Plus `password_history` (referenced in `AuthService.gs:141` but absent from `TABLE_MAP`) = **54 tables total** inferred from code.

### 6.2 Table columns and row counts

**Pending owner-side dump**

### 6.3 Foreign keys

**Pending owner-side dump**

### 6.4 Sample rows from configuration tables (sensitive columns masked)

**Pending owner-side dump**

---

## 7. Data flow walkthroughs

### Customer login

```
Login.html
  → google.script.run.handleAuthRequest({ action:'login', email, password })
      → AuthService.loginUser(params)
          → hashPassword(password)          [SHA-256]
          → findRow('Users', 'email', email) or findRow('Contacts', 'email', email)
              → tursoSelect('SELECT * FROM users WHERE email = ? LIMIT 1')
          → if staff & MFA enforced & required: createMfaChallenge (PropertiesService) → redirect to mfa-verify/enroll
          → if no MFA: createSession(userId, 'STAFF', role, 8h)
              → tursoWrite('INSERT INTO sessions ...')
          → updateRow('Users', 'user_id', userId, { last_login_at })
          → auditLogCustom('User', userId, userId, 'LOGIN', ...)
              → audit_log() → appendRow('AuditLog', ...)
          → returns { success, token, redirectUrl }
Login.html redirects to ?page=staff&token=<token>
  → Code.doGet → checkSession(token) → serveStaffDashboard(session, token)
```

**audit_log:** Yes — `LOGIN` event written via `auditLogCustom`.

---

### Place an order (customer portal)

```
Customerportal.html
  → processRequest({ service:'orders', action:'create', data:{...}, token })
      → Code.doPost → doPost auth guard → checkSession(token)
      → handleOrderRequest(params) → createOrder(orderData, context)
          → getById('Customers', customer_id)
          → generateId('ORD'), generateOrderNumber(countryCode)
          → appendRow('Orders', order)             [status: 'DRAFT']
          → appendRow('OrderLines', ...)           [for each line]
          → calculateOrderTotal(orderId, lines, priceListId)
          → updateRow('Orders', 'order_id', orderId, { subtotal, total })
          → auditLogCreate('Orders', orderId, actorId, order, countryCode)

  → processRequest({ service:'orders', action:'submit', orderId, token })
      → handleOrderRequest → submitOrder(orderId, context)
          → getById('Orders', orderId)
          → credit limit check (customer.credit_limit vs credit_used + total)
          → updateRow('Orders', ... { status:'SUBMITTED', submitted_at })
          → appendRow('OrderStatusHistory', ...)
          → submitForApproval('ORDER', orderId, { amount: total, currency })  [ApprovalEngine]
              → _approvalLoadWorkflow_('ORDER')    [reads approval_workflows table]
              → _approvalPickThreshold_(rules, context) → determines tier (low/mid/high)
              → tursoWrite('INSERT INTO approval_requests ...')
              → findUsersForRole(requiredRole, countryCode)
              → enqueueNotification(...) for each approver
          → auditLogUpdate('Orders', orderId, actorId, {...})
```

**audit_log:** Yes — `CREATE` and `UPDATE` events.

---

### Approve an order

```
Staffdashboard.html (Approvals tab)
  → processRequest({ service:'approvals', action:'getPendingApprovals', token })
      → handleApprovalRequest → getPendingApprovals(userId)
          → tursoSelect('SELECT * FROM approval_requests WHERE status=PENDING AND assigned_to=?')

  → processRequest({ service:'approvals', action:'approve', requestId, comment, token })
      → handleApprovalRequest → approve(requestId, approverUserId, comment)
          → load approval_requests row
          → SoD check: approver_user_id !== entity creator
          → requireOrderApprovalPermission(approverUserId, amount, currency)
              → _getApprovalThresholds_() → Config lookup or fallback {100k, 1M}
              → userHasPermission(approverUserId, 'order.approve_low/mid/high')
          → updateRow('ApprovalRequests', ... { status:'APPROVED', approved_by, approved_at })
          → updateRow('Orders', ... { status:'APPROVED', approved_by, approved_at })
          → appendRow('OrderStatusHistory', ...)
          → enqueueNotification to order creator
          → auditLogCustom('approval_request', requestId, approverUserId, 'APPROVED', ...)
```

**audit_log:** Yes.

---

### Raise a support ticket (customer portal)

```
Customerportal.html
  → processRequest({ service:'tickets', action:'create', data:{...}, token })
      → Code.doPost → auth guard → handleTicketRequest → createTicket(ticketData, context)
          → getById('Customers', customer_id)
          → generateTicketNumber(countryCode)
          → getSLAConfig(ticket.priority, customer.segment_id, countryCode)
              → findRow('SLAConfig', ...) or fallback: acknowledge_minutes=60, first_response_minutes=120
          → calculateSLATargets(ticket, slaConfig)  → sets sla_acknowledge_by, sla_response_by, sla_resolve_by
          → appendRow('Tickets', ticket)            [status:'NEW']
          → assignTicket(ticketId, ...)             [finds team/agent via round-robin or least-busy]
          → appendRow('TicketHistory', ...)
          → enqueueNotification to assigned agent
          → auditLogCreate('Tickets', ticketId, actorId, ticket, countryCode)
```

**audit_log:** Yes.

---

### View the staff dashboard

```
?page=staff&token=<token>
  → Code.doGet → checkSession(token) → session.userType==='STAFF'
  → serveStaffDashboard(session, token)
      → HtmlService.createTemplateFromFile('Staffdashboard')
      → tmpl.SESSION = JSON.stringify({ userId, role, token, scriptUrl })
      → tmpl.evaluate() → returns rendered HTML

Staffdashboard.html (client)
  → window.onload → initDashboard()
      → google.script.run.processRequest({ service:'dashboard', action:'getDashboardSummary' })
          → DashboardService.getDashboardSummary(params)
              → resolves country scope from user's role (GLOBAL_ROLES_ vs country_code)
              → tursoSelect for orders count, tickets count, revenue (last 30d)
              → tursoSelect for SLA metrics, headcount
              → getSystemChannels() → checks Script Properties for presence of integration keys
              → returns { summary, orders, tickets, sla, channels }
      → renders charts (Chart.js) from returned data
```

**audit_log:** No — dashboard reads do not write to audit_log (expected).

---

## 8. Integrations

| Integration | Status | Evidence |
|---|---|---|
| **Turso (libSQL)** | **Real — live** | `TursoService.gs` — all reads/writes go to `TURSO_URL/v2/pipeline`; credentials in Script Properties |
| **Oracle EBS** | **Stub / wired but not connected** | `Integrationservice.gs:289` — `oracleApiUrl`, `oracleUsername` read from Script Properties; all calls log to `integration_log` with no confirmed production endpoint; `JobProcessor._jobOracleSync_` reads `ORACLE_BASE_URL` from Config (G-011) |
| **WhatsApp Business API** | **Partially wired** | `Integrationservice.gs:1529-1550` — `scanInboundWhatsApp()` reads `WA_PHONE_ID`, `WA_TOKEN` from Config and calls `graph.facebook.com`; no confirmed production credentials (G-012 coverage gap) |
| **Microsoft Teams** | **Partially wired** | `SettingsService.gs:192` — `testTeams()` POSTs to `TEAMS_WEBHOOK_URL`; `Notificationservice.gs` sends to Teams webhooks; no confirmed production webhook |
| **Twilio Voice** | **Partially wired** | `Integrationservice.gs:1559-1650` — `scanInboundCalls()`, `getCallTranscription()` use `TWILIO_SID`/`TWILIO_TOKEN` from Config; not confirmed live |
| **Email (Graph/MailApp)** | **Partially wired** | `Notificationservice.gs:252` — Graph endpoint hardcoded to `hassaudit@outlook.com`; `MailApp` is the fallback (always works if GAS scope is granted); production Graph auth requires `MS_GRAPH_SECRET` |
| **OneDrive/SharePoint** | **Partially wired** | `SettingsService.gs:325-390` — OAuth flow, folder listing, file upload via Microsoft Graph; `ONEDRIVE_REFRESH_TOKEN` must be set |
| **M-Pesa Daraja C2B** | **Partially wired** | `MpesaService.gs` — full validation/confirmation handlers coded; `MPESA_ENV` defaults to `sandbox`; production requires credential provisioning + `registerMpesaCallbackUrls()` (G-012) |
| **KRA eTIMS** | **Stub / wired but not connected** | `EtimsService.gs` — full OSDC API implementation coded; skips gracefully when `ETIMS_PIN`/`ETIMS_DEVICE_SERIAL` not set; requires KRA registration and provisioning (G-013) |

---

## 9. Configuration that lives in code but should live in DB

### 9.1 Navigation and menu items
- `Staffdashboard.html` — module tabs (Customers, Orders, Tickets, Finance, SLA, Reports, Settings, Roles, Audit, Approvals) are hardcoded in HTML structure. No server-driven nav config exists.

### 9.2 Role names and labels
- `Staffdashboard.html:2991-2992` — role display-name map (`'SUPER_ADMIN':'Super Admin', 'GROUP_HEAD':'Group Head', 'CS_MANAGER':'CS Manager', ...`) — includes undocumented codes
- `DashboardService.gs:2-8` — `DASHBOARD_GLOBAL_ROLES_` and `DASHBOARD_CHANNEL_ROLES_` — hardcoded lists with `CTO`, `GROUP_HEAD` not in the 16-role model
- `Staffdashboard.html:2791-2860` — `adminRoles`, `reportRoles`, `channelRoles` — three separate client-side arrays, partially duplicating server-side lists

### 9.3 Permission keys
- `PermissionService.gs:35-96` — `DEFAULT_PERMISSIONS_` catalog (46 codes) — seeded to DB on `verifyAndMigrateRBAC()` but the seed definition lives in code. Once seeded the DB is the source of truth, but an empty DB can only be re-seeded to exactly these codes.

### 9.4 Status enum values per entity
- `DatabaseSetup.gs:465-489` — `SCHEMAS.*.validations` contains status enums in code (e.g. order statuses, customer statuses, ticket priorities)
- `Orderservice.gs:27-41` — `ORDER_STATUS_FLOW` transition map — hardcoded in code
- `Ticketservice.gs` — ticket status list scattered as string literals

### 9.5 Approval thresholds (amount tiers)
- `PermissionService.gs:1087` — fallback `{ low: 100000, mid: 1000000 }` (KES). **Partially promoted**: primary values come from Config keys `APPROVAL_THRESHOLD_LOW_KES` / `APPROVAL_THRESHOLD_MID_KES`. The Config table is the right place — the hardcoded fallback just needs to be removed once the Config is seeded.
- `PermissionService.gs:1053` — exchange rate defaults `{ UGX_TO_KES: 0.034, TZS_TO_KES: 0.052, RWF_TO_KES: 0.10 }` — hardcoded. **Should be Config rows updated on a schedule.**

### 9.6 Country list
- `DatabaseSetup.gs:452` — `SCHEMAS.Countries.validations.country_code: ['KE','UG','TZ','RW','SS','ZM','DRC','HTW']` — hardcoded validation list. Adding a new country requires editing this line.
- `DatabaseSetup.gs:501-503` — `AFFILIATE_CODES` map `{ KE:'HPK', UG:'HPU', ... }` — hardcoded.
- `SeedData.gs:40` — `countries_access: 'KE,UG,TZ,RW,SS,ZM,DRC'` — hardcoded string.

### 9.7 Currency formatting and decimal rules
- Not implemented as a configurable layer. Currency code is stored per customer/order but formatting rules (decimal places, thousands separator, symbol) are assumed to be standard and are not configurable from the DB.

### 9.8 Business hours defaults
- `SLABreachDetector.gs:548` — `'// Sensible default: Mon-Fri 08:00-17:00'` — used when no `business_hours` row exists. Should be a Config seed row.
- `Ticketservice.gs:1072-1075` — `acknowledge_minutes: 60`, `first_response_minutes: 120` — fallback SLA targets hardcoded.

### 9.9 SLA targets
- `Ticketservice.gs:1072-1075` — fallback SLA minutes hardcoded (see above). Primary values should come from `sla_config` table — table exists but fallbacks bypass it.

### 9.10 SLA escalation tier order
- `SLABreachDetector.gs:12-15` — Level 0→CS_AGENT, 1→CS_MANAGER, 2→COUNTRY_MANAGER, 3→CFO/RMD — hardcoded in the file header and in the breach processing logic. Should be a configurable escalation_path column or separate table.
- `SLA_BREACH_FINANCE_CATEGORIES_` (`SLABreachDetector.gs:49`) — hardcoded list of ticket categories that escalate to CFO vs RMD.

### 9.11 MFA-required roles
- `MfaService.gs:25-31` — `MFA_REQUIRED_ROLES = ['SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR','FINANCE_MANAGER']` — hardcoded. Should be a `roles.mfa_required` boolean column.
- `MfaService.gs:35-37` — `MFA_EXEMPT_USER_IDS` — hardcoded array with a dummy UUID.

### 9.12 System-reserved roles
- `RoleService.gs:42` — `ROLE_SERVICE_SYSTEM_ROLES_ = ['SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR']` — hardcoded. `roles.is_system` column already exists in DB — this list should be derived from it (and mostly is via `_roleService_isSystemRole_`, but the array is still a fallback).

### 9.13 Colour palette and theme variables
- `Login.html:12` — `--navy-800: #1A237E` CSS variable
- `Staffdashboard.html:24` — same navy + orange (`#FF6F00`) CSS variables
- `AuthService.gs:607` — `var brandNavy = '#1A237E'` in the password reset email template
- All hardcoded. Should be Config rows or a dedicated `branding` table.

### 9.14 Hardcoded email addresses (operational config)
- `Notificationservice.gs:20` — `DEFAULT_SENDER_EMAIL: 'noreply@hasspetroleum.com'`
- `Notificationservice.gs:227,252,275,278` — `hassaudit@outlook.com` hardcoded as Graph sender
- `JobProcessor.gs:151` — `replyTo: 'noreply@hasspetroleum.com'`
- `Code.gs:225` — `support@hasspetroleum.com` in error page HTML
- `AuthService.gs:607` — `support@hasspetroleum.com` in password reset email
- `UserService.gs:294` — same support email
- All should be Config keys.

### 9.15 Drive folder ID (logo)
- `AuthService.gs:988` — `DriveApp.getFolderById('1AL9fUgYXM9DXj9-X_0YonrloqCXat2wq')` — Drive folder ID for the Hass logo hardcoded in source. Should be a Script Property or Config key.

### 9.16 Order behaviour constants
- `Orderservice.gs:20-24` — `CREDIT_CHECK_THRESHOLD: 0.9`, `MAX_ORDER_LINES: 50`, `DRAFT_EXPIRY_DAYS: 30`, `ORDER_EDIT_CUTOFF_HOURS: 2` — all should be Config keys.

### 9.17 Deprecated permission codes retained in seed
- `PermissionService.gs:82-95` — 9 deprecated permission codes (`roles.view`, `roles.assign`, `roles.manage`, etc.) are seeded to the DB to maintain backward compatibility. These should be removed once all call sites migrate to canonical codes.

---

## 10. Code quality observations

### 10.1 Name collisions — permission keys
- `Code.gs:86` — `serveStaffRoleAssignment` checks `'role.assign'` (canonical ✓)
- `Code.gs:111` — `serveStaffRoleManagement` checks `'roles.assign'` (deprecated ✗)
- Both exist in `DEFAULT_PERMISSIONS_` but the inconsistency means the same action has two gating codes depending on which entry point is used.

### 10.2 Client-side role codes diverge from server 16-role model
- `Staffdashboard.html:2791-2860` uses `GROUP_HEAD`, `BD_MANAGER`, `CTO` which are not in `DEFAULT_ROLES_` in `PermissionService.gs`. Client-side visibility decisions may be wrong for users who do not hold these legacy codes.

### 10.3 SCHEMAS.Users.validations out of date
- `DatabaseSetup.gs:477` — validations still list the old 9-role model: `['SUPER_ADMIN','ADMIN','CS_MANAGER','CS_AGENT','SALES_REP','COUNTRY_MANAGER','REGIONAL_MANAGER','GROUP_HEAD','VIEWER']`. Creating/validating a user with role `CEO`, `CFO`, `CREDIT_MANAGER`, etc. will fail validation. The `SCHEMAS` validation is a code-level safeguard, not a DB constraint, but it still blocks `createRecord` calls.

### 10.4 EXPECTED_SCHEMA drift in DebugDB.gs
- `DebugDB.gs:424` — `KNOWN_DUPLICATIONS = []` — empty array means the drift detector reports no known duplications even though the file header documents them (e.g. `oracle_customer_id` vs `oracle_customer_code`, `gps_lat` vs `latitude`). Real duplications are noted in comments but not enumerated in the list the detector uses.
- `DebugDB.gs:858` — `sla_config.first_response_minutes` is renamed to `response_minutes` in the remediation script but `Ticketservice.gs:1075` still reads `first_response_minutes`. One of these is wrong.
- `DebugDB.gs:865` — `countries.phone_code` renamed to `dialing_code` in remediation but `EXPECTED_SCHEMA.countries` already lists `dialing_code` — suggests the DB may still have `phone_code`.

### 10.5 Duplicated role-list definitions
Five separate role-list arrays exist across the codebase that should be a single source of truth:
1. `PermissionService.gs: DEFAULT_ROLES_` (canonical seed)
2. `MfaService.gs: MFA_REQUIRED_ROLES`
3. `RoleService.gs: ROLE_SERVICE_SYSTEM_ROLES_`
4. `DashboardService.gs: DASHBOARD_GLOBAL_ROLES_`, `DASHBOARD_CHANNEL_ROLES_`
5. `Staffdashboard.html: adminRoles`, `reportRoles`, `channelRoles`

### 10.6 Hardcoded Drive folder ID in source
- `AuthService.gs:988` — `'1AL9fUgYXM9DXj9-X_0YonrloqCXat2wq'` — a Google Drive folder ID is hardcoded. Not a credential but environment-coupled.

### 10.7 Plaintext test credentials in SeedData.gs
- `SeedData.gs:9` — `var password = 'HassAdmin2024!';` — plaintext admin password
- `SeedData.gs:63` — `var password = 'Customer2024!';` — plaintext customer password
- **These are not secrets per se (hashed before insert) but they are default credentials that may remain unchanged in production.** Flag as a security finding; rotate after first use and confirm the file is not called at runtime.

### 10.8 Password hash algorithm
- `AuthService.gs:50-53` — `hashPassword` uses SHA-256 via `Utilities.computeDigest`. SHA-256 without a salt is not a password hashing algorithm — it is a fast digest susceptible to rainbow table attacks. **bcrypt, scrypt, or Argon2 should be used.** This is not trivially fixable in Apps Script which has no native bcrypt support — may require a Cloud Function bridge.

### 10.9 Pending password hash storage in PropertiesService
- `AuthService.gs:509-511` — during `signupCustomer`, the password hash for a pending signup is stored in Script Properties as `PENDING_SIGNUP_<requestId>`. Script Properties has no TTL and is accessible to any admin who can view the project. This is a temporary state between signup and approval; the risk window is bounded but worth noting.

### 10.10 Mixed naming conventions (DB columns)
Per `DebugDB.gs` remediation script: `gps_lat`/`gps_lng` vs `latitude`/`longitude` in `delivery_locations` and `depots`; `name` vs `segment_name`/`team_name`/`product_name` etc.; `phone_code` vs `dialing_code` in `countries`. These cause `EXPECTED_SCHEMA` false positives.

### 10.11 No environment separation
- One Turso DB; same `TURSO_URL` serves dev, UAT, and production. Noted in gap doc technical debt. Must split before go-live.

### 10.12 Dead-code functions
- `getBackgroundUrl()` in `Code.gs:418` — always returns `''`
- `LoginDiagnostics.gs` — not referenced at runtime

---

## 11. Cross-reference to the gap document

| Gap | Title | Code state today |
|---|---|---|
| **G-001** | Portal login redirect broken | ✅ **Closed** — `Code.gs:35-38` correctly routes `CUSTOMER` sessions to `?page=portal&token=...` |
| **G-002** | Approval workflow runtime not built | 🟡 **Partially closed** — `ApprovalEngine.gs` is fully coded; `submitForApproval` is called from `Orderservice.gs`; `handleApprovalRequest` is registered in `doPost`. **Gap remaining**: trigger for `runApprovalTimeoutCheck` not confirmed installed; `Approvals.html` page entry has no permission guard. |
| **G-003** | SLA breach detection not running | 🟡 **Partially closed** — `SLABreachDetector.gs` is complete; `_jobSlaCheck_` and `_jobSlaBreachSweep_` in `JobProcessor.gs`. **Gap remaining**: no trigger confirmed installed; `scheduleSLABreachSweep` must be called once from IDE. |
| **G-004** | SoD not enforced | 🟡 **In flight** — `ApprovalEngine.approve` checks `approver_user_id !== creator_user_id`; `PermissionService.requireOrderApprovalPermission` checks the tier. `requirePermission` guards added to most service handlers. Scope enforcement (country_code) not yet wired. |
| **G-005** | Audit log incomplete | 🟡 **In flight** — `AuditService.gs` centralises logging; `createRecord`/`updateRecord` call `audit_log()`; `doPost` sets request context. Some services still use the legacy `logAudit()` shim. Not all mutations verified. |
| **G-006** | Password reset email tone | ✅ **Closed** — `AuthService.gs:609-670` has full HTML email signed off as "Hass Petroleum Customer Experience Team" |
| **G-007** | Module/icon click freeze | 🟡 **In flight** — Not determinable from repo (fix likely in `Staffdashboard.html` JS; requires browser test) |
| **G-008** | MFA not enforced | 🟡 **Partially closed** — `MfaService.gs` implements TOTP; `AuthService.loginUser` gates on `isMfaEnforced()`. **Gap remaining**: `isMfaEnforced()` returns `false` by default — `MFA_ENFORCED` Script Property must be set to `"true"` to activate enforcement. |
| **G-009** | Password policy not enforced | 🟡 **Partially closed** — `validatePasswordPolicy()` in `AuthService.gs:99-131` enforces min length, complexity, common-password list, history. Policy reads from Config (`PW_MIN_LENGTH`, `PW_HISTORY_N`, `PW_MAX_AGE_DAYS`) with sensible defaults. **Gap remaining**: policy enforced on reset and signup; not confirmed enforced on admin-set-password path. |
| **G-010** | Session policy weak | 🟡 **Partially closed** — idle timeout in `checkSession` (reads `SESSION_IDLE_TIMEOUT_MIN` from Config, default 30 min); concurrent session cap in `createSession` (reads `SESSION_MAX_CONCURRENT`, default 5). |
| **G-011** | Oracle ERP connector stubbed | 🔴 **Confirmed open** — `Integrationservice.gs` has full multi-transport Oracle connector coded; no production credentials; all calls logged to `integration_log` only. |
| **G-012** | M-Pesa Daraja callback handler missing | 🟡 **Partially closed** — `MpesaService.gs` is fully coded including validation and confirmation handlers; `isMpesaDarajaCallback` is wired into `doPost` before the auth guard. **Gap remaining**: `MPESA_ENV` defaults to `sandbox`; production credentials and `registerMpesaCallbackUrls()` required. |
| **G-013** | KRA eTIMS not wired | 🟡 **Partially closed** — `EtimsService.gs` is fully coded; `submitInvoiceToEtims` called after invoice generation; skips gracefully if unconfigured. **Gap remaining**: KRA credentials and registration required. Invoices table needs `etims_*` columns. |
| **G-014** | Document expiry alerts not running | 🟡 **Partially closed** — `SLABreachDetector.detectTicketBreaches()` includes document expiry checks. **Gap remaining**: same as G-003 — trigger not confirmed installed. |
| **G-015** | Recurring order job runner not deployed | 🔴 **Confirmed open** — `JobProcessor` handles `RECURRING_ORDER_GEN` job type is **not listed** in `_dispatch_` switch. `RecurringSchedule` table exists and is referenced in `Orderservice.gs` but the generator job type is absent from the dispatcher. |
| **G-016** | Permission matrix not signed off | 🔴 **Confirmed open** — No evidence of business sign-off from repo. |
| **G-017** | Module ownership not assigned | 🔴 **Confirmed open** — `docs/roles-permissions-gap-analysis.md` §4 still shows TBD for all engineering owners. |
| **G-018** | No data retention policy | 🟡 **Partially addressed** — `JobProcessor._jobAuditClean_` hard-cuts `audit_log` rows older than 90 days. **Gap remaining**: 90-day cutoff is hardcoded (not policy-driven); no equivalent cleanup for `sessions`, `password_resets`, `integration_log`, `staff_messages`. |
| **G-019** | Mobile UX not tested | 🔴 **Confirmed open** — Not determinable from repo; desktop-first CSS confirmed. |
| **G-020** | No backup/disaster recovery rehearsal | 🔴 **Confirmed open** — `BackupService.gs` exists; no rehearsal evidence in repo. |
| **G-021** | Critical roles unassigned | 🔴 **Confirmed open** — Not determinable from repo (runtime DB state). Code constraint: `RoleService.revokeRole` prevents removing last SUPER_ADMIN; no equivalent guard for zero-CS_MANAGER-per-country at grant time. |

---

## 12. Restructure observations (not prescriptions)

- **Flat file structure at root.** All 40 files (30 .gs + 10 .html) live in the GAS project root with no layer separation. This is a GAS constraint but at rebuild time the structure should be designed first (e.g. `services/`, `handlers/`, `pages/`, `utils/`), even if GAS flattens them.

- **Two parallel RBAC paths.** `users.role` (legacy string) and `user_roles` (new join table) coexist. Both are consulted in `userHasPermission` and `userRequiresMfa`. Every new feature must handle both. The legacy path should be retired in a single migration pass at rebuild.

- **Permission catalog is a code-first seed.** The 46 permission codes in `DEFAULT_PERMISSIONS_` define what the system can check, but they live in `.gs` source. Adding a permission today requires a code change, not a DB insert. The rebuild should make the permission catalog DB-first.

- **Three giant HTML files.** `Staffdashboard.html` (368 KB), `Login.html` (79 KB), and `Customerportal.html` (148 KB) each contain full application logic in a single file. This makes diffs unreadable, imports untestable, and bundle size uncontrolled. The rebuild should apply a proper include/component model.

- **No async by default.** Every user-facing request is synchronous. Long-running ops (Oracle sync, bulk import, SLA sweep) are correctly pushed to `JobProcessor`, but the queue is pulled every 5 minutes — there is no push mechanism. Latency is structurally 0–5 min for async jobs.

- **SHA-256 passwords.** Not a password hashing function. The entire auth system's at-rest security depends on this choice. Rebuild must change to a proper KDF.

- **PropertiesService as session scratch-pad.** MFA challenge tokens and pending signup password hashes are stored in PropertiesService, which is a shared key-value store with no TTL enforcement beyond application logic. A proper session/state store (or the `sessions` table already in Turso) should be used instead.

- **Config table exists but is underused.** Twelve categories of hardcoded configuration identified in §9 should be in the `config` table. The infra is already present (`getConfig`, `setConfig`, `getConfigValues` helpers exist); it just needs to be used.

- **No automated tests or CI.** `TestSuite.gs` exists but is not connected to any pipeline. Every code change is deployed to production without a safety net. This is the single greatest quality risk for a rebuild of this complexity.

- **RECURRING_ORDER_GEN job type missing from dispatcher.** `JobProcessor._dispatch_` does not handle `RECURRING_ORDER_GEN`, meaning recurring orders (G-015) cannot be triggered via the job queue even if a trigger were installed. This is a structural gap — the feature is wired at the schedule-creation level but orphaned at the execution level.

---

*End of system inventory — pending owner-side DB dump to complete §6.*
