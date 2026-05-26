# HASS Petroleum CMS — Portal Codebase Security and Quality Audit

**Prepared by:** Senior Application Security and Software Quality Auditor  
**Date:** 2026-05-26  
**Scope revision:** All *.gs source files and *.html front-end files in `/home/user/hass_crm_script/`, all SQL migrations in `migrations/`, and supporting documentation in `docs/`.  
**System version:** V8 runtime, Google Apps Script + Turso (libSQL) primary database  
**Audit methodology:** Static analysis, call-path tracing (UI → handler → query), cross-file dataflow analysis, and gap-register review against `docs/roles-permissions-gap-analysis.md`

---

## 1. Executive Summary

The HASS Petroleum CMS is a multi-country petroleum distribution management platform built on Google Apps Script (GAS) with a Turso (libSQL) primary database. The system handles customer onboarding, order management, ticketing, invoicing, payment uploads, documents, knowledge base, SLA tracking, and integrations with Oracle EBS, WhatsApp, Microsoft Graph, Twilio Voice, Microsoft Teams, and OneDrive/SharePoint. The codebase is architecturally sound in its use of parameterised SQL, a multi-tier RBAC model, and comprehensive audit logging infrastructure. However, a critical cluster of access-control deficiencies means the system cannot safely be promoted to production in its current state.

The most serious risk is that country/affiliate data-scope isolation — the boundary that prevents a CS_AGENT in Kenya from reading Uganda customer data — is defined in `PermissionService.gs` but is not called from the majority of service handlers. Any authenticated staff user can therefore enumerate data across all countries. Multiple service handlers additionally have no permission checks at all, meaning session authentication alone gates access to privileged mutations. Credential-handling weaknesses compound the risk: SHA-256 without salt for password storage, a non-cryptographic PRNG used for TOTP secret generation, and password hashes written to script-scoped `PropertiesService` during signup flows.

**Finding counts by severity:**

| Severity | Count |
|---|---|
| P1 Critical | 8 |
| P2 High | 9 |
| P3 Medium | 10 |
| P4 Low | 4 |
| **Total** | **31** |

---

## 2. Enforcement-Location Verdict (Mandatory First Check)

**Verdict: Access control is enforced server-side for authentication, but the majority of authorisation and all data-scoping decisions are NOT enforced at the query layer.**

### 2.1 Authentication — enforced server-side

`doPost()` in `Code.gs` (lines 266–289) validates a session token before dispatching to any service in the `AUTHENTICATED_SERVICES_` list. `checkSession()` in `AuthService.gs` (lines 177–191) queries the Turso `sessions` table, verifies `is_active = 1` and `expires_at > now`. This is genuine server-side authentication.

### 2.2 Permission checks — present in some handlers, absent in others

The `requirePermission()` helper (`PermissionService.gs` lines 436–441) checks `user_roles` ↔ `role_permissions` in Turso and throws on failure. Where it is called, the check is server-side and real. However, the following service handlers do not call `requirePermission()` on any action:

| Service handler | File | Privileged actions exposed without permission check |
|---|---|---|
| `handleIntegrationRequest()` | `Integrationservice.gs` line 1338 | `syncCustomer`, `syncOrder`, `fetchCustomer`, `fetchOrderStatus`, `fetchInvoices`, all scanner triggers, Oracle sync operations |
| `handleDocumentRequest()` | `Documentservice.gs` line 1043 | `upload`, `approve`, `reject`, `archive`, `getExpired`, `getExpiring` — any authenticated user can approve or reject KYC documents |
| `handleKnowledgeRequest()` | `Knowledgeservice.gs` line 961 | `createArticle`, `publishArticle`, `archiveArticle`, `createCategory` — any authenticated user can publish or archive knowledge base articles |
| `handleSettingsRequest()` | `SettingsService.gs` line 9 | `saveSettings` — any authenticated user can overwrite integration credentials and system configuration |
| `handleChatRequest()` | `ChatService.gs` line 10 | All actions including reading any room |

### 2.3 Data scoping — NOT enforced at the query layer

`requireScope()` (`PermissionService.gs` lines 1026–1041) and `getUserScope()` (lines 971–998) exist and are correctly designed. They consult `user_roles`, `roles.scope`, and `users.country_code` to determine what countries a caller is entitled to see. However, a search of every service handler confirms that `requireScope()` is never called from:

- `handleCustomerRequest()` — customer reads and writes are unscoped; `getAllCustomers()` (`UserService.gs` line 439) returns every customer across all countries with no `WHERE country_code = ?` filter.
- `handleOrderRequest()` — order queries are unscoped.
- `handleTicketRequest()` — ticket queries are unscoped.
- `handleUserRequest()` — staff and customer lists are unscoped; `getAllStaff()` (`UserService.gs` line 75) returns all users across all countries.
- `getDashboardSummary()` (`DashboardService.gs` line 43) — `affiliateFilter` is accepted from the client without verifying it against the caller's permitted countries.
- `getCustomer360()` (`DatabaseService.gs` line 494) — any authenticated user can query any customer's 360-view by supplying a `customerId`.
- `handleStatementRequest()` — staff path checks `customers.statements` permission but does not restrict to caller's country.

**The practical impact:** A CS_AGENT assigned only to Kenya can authenticate, then call any of the above handlers with any `country_code` or `customer_id` and receive data from Uganda, Tanzania, or any other country. The infrastructure to prevent this (the `requireScope()` function) exists but is not wired in.

### 2.4 Portal-side customer isolation — partially enforced

`handleStatementRequest()` (`CustomerStatementsService.gs` lines 41–55) does correctly resolve `customerId` from the session's linked contact when `userType === 'CUSTOMER'`, preventing a customer from pulling another customer's statement. `TicketService.gs` and `OrderService.gs` similarly scope customer-portal reads by session. This is positive. However `CustomerService.gs:getCustomerDeliveryLocations()` and `getCustomerConsumption()` receive `customerId` as a parameter without verifying it matches the calling customer's session, meaning a customer who discovers another `customerId` can read that customer's delivery locations and consumption data.

---

## 3. Access Control and Data Scoping Findings

### AC-01 [P1 Critical] — Country-scope isolation unenforced in query layer

**File:** `PermissionService.gs` line 1026 (`requireScope`); `UserService.gs` lines 75–92 (`getAllStaff`), lines 439–466 (`getAllCustomers`); `DashboardService.gs` line 43; `DatabaseService.gs` line 494; `Ticketservice.gs`; `Orderservice.gs`

**Detail:** `requireScope()` is defined and functional but never called from service handlers. Every service that returns a list of customers, staff, tickets, or orders does so without a WHERE clause on `country_code` bound to the caller's scope. A CS_AGENT for one country has full read access to every other country's data.

**Recommendation:** Add `requireScope(session)` calls at the top of each list/query action in `handleCustomerRequest`, `handleOrderRequest`, `handleTicketRequest`, and `handleUserRequest`. Translate the returned scope into a SQL `country_code IN (?, ...)` predicate appended to every affected query.

---

### AC-02 [P1 Critical] — `handleDocumentRequest()` has no permission checks

**File:** `Documentservice.gs` line 1043–1092

**Detail:** The handler dispatches all document actions — including `approve`, `reject`, `archive`, and `getExpired` — without calling `requirePermission()`. Any authenticated staff or customer user can approve or reject KYC documents for any customer, bypassing the KYC SoD workflow documented in `docs/roles-permissions-gap-analysis.md §3.1`.

**Recommendation:** Add `requirePermission(session, 'document.approve')` before the `approve`/`reject`/`requestRevision` cases and `requirePermission(session, 'document.view')` on read cases. For customer-portal calls, enforce document ownership by verifying `document.customer_id === contactLinkedCustomerId`.

---

### AC-03 [P1 Critical] — `handleSettingsRequest()` has no permission checks

**File:** `SettingsService.gs` line 9–41

**Detail:** Settings writes, including `saveSettings` which persists integration credentials (Oracle API URL/keys, WhatsApp API keys, Graph API tokens) to the Config table, are gated only by session presence. Any authenticated user can overwrite production integration credentials.

**Recommendation:** Add `requirePermission(session, 'config.update')` before any settings write action. Per the permissions matrix, only `SUPER_ADMIN` holds `config.update`.

---

### AC-04 [P1 Critical] — `handleIntegrationRequest()` has no permission checks

**File:** `Integrationservice.gs` line 1338–1430

**Detail:** The integration dispatcher executes Oracle EBS sync, WhatsApp/email/call scanner triggers, and ERP data fetches without any permission check. Actions like `syncCustomer`, `syncOrder`, `fetchInvoices`, and `triggerEmailScan` are reachable by any authenticated user.

**Recommendation:** Add `requirePermission(session, 'integration.run')` (or per-integration granular codes) at the top of each action case.

---

### AC-05 [P1 Critical] — `handleKnowledgeRequest()` has no permission checks

**File:** `Knowledgeservice.gs` line 961–1023

**Detail:** Mutating actions — `createArticle`, `updateArticle`, `publishArticle`, `unpublishArticle`, `archiveArticle`, `createCategory`, `updateCategory` — are dispatched without permission checks. Any authenticated user can publish or archive articles in the staff-facing knowledge base.

**Recommendation:** Add `requirePermission(session, 'knowledge.edit')` before write actions. Read-only actions such as `search` and `getArticle` may be left open for authenticated users.

---

### AC-06 [P1 Critical] — `sendChatMessage()` accepts senderId from client without session binding

**File:** `ChatService.gs` lines 51–79

**Detail:** The `senderId` parameter in `sendChatMessage()` originates from `params.senderId` supplied by the client (line 15 of the handler switch). The function inserts this into `staff_messages.sender_id` and also touches `Users` via `updateRow('Users', 'user_id', senderId, ...)`. There is no check that `senderId` matches the authenticated `session.userId`. Any authenticated user can impersonate any other staff member's identity in chat messages, and also silently touch any user's `updated_at` timestamp.

**Recommendation:** Replace `senderId` with `session.userId` on the server side. Ignore any client-supplied `senderId`.

---

### AC-07 [P1 Critical] — `handleChatRequest()` performs no room-membership check

**File:** `ChatService.gs` lines 30–46

**Detail:** `getChatMessages()` and `getNewChatMessages()` return all messages in any room whose `room_id` is supplied, without checking that the calling user is a member of that room. Staff-DM rooms (`room_type = 'DM'`) between two users are readable by any authenticated staff user who guesses or discovers the `room_id`.

**Recommendation:** Add a room-membership lookup (e.g. a `room_members` table or a convention that DM room IDs are deterministically derived from sorted user IDs and validated against the caller) before returning messages.

---

### AC-08 [P1 Critical] — Customer portal delivery-location and consumption APIs do not enforce customer ownership

**File:** `CustomerService.gs` lines 11–34 (`getCustomerDeliveryLocations`), lines 43–158 (`getCustomerConsumption`)

**Detail:** Both functions accept `customerId` as a parameter and return data for that customer without verifying the caller's session is linked to that customer. A portal user who discovers another `customerId` can enumerate that customer's delivery sites and full consumption history.

**Recommendation:** In the portal-side dispatch path, resolve `customerId` from the session (as `CustomerStatementsService.gs` correctly does) and reject any client-supplied `customerId` that does not match.

---

## 4. Data Integrity and Integration Findings

### DI-01 [P2 High] — `ExternalSLAEvents` table missing from TABLE_MAP

**File:** `Integrationservice.gs` line 1657 (`appendExternalSlaRecord_`); `TursoService.gs` lines 25–73

**Detail:** `appendExternalSlaRecord_()` calls `appendRow('ExternalSLAEvents', ...)`. `appendRow` routes via `TABLE_MAP[sheetName]`. `ExternalSLAEvents` is not present in `TABLE_MAP`. The call will silently fail or write to a fallback key `'externalslaevent'.toLowerCase()` that also does not exist in the Turso schema. Every inbound SLA event record collected by the call scanner, email scanner, and WhatsApp scanner is silently lost.

**Recommendation:** Add `'ExternalSLAEvents': 'external_sla_events'` to `TABLE_MAP` in `TursoService.gs` and add a corresponding entry to `PK_MAP`. Create the `external_sla_events` table in a migration if it does not exist.

---

### DI-02 [P2 High] — SHA-256 without salt used for password hashing

**File:** `AuthService.gs` lines 50–53 (`hashPassword`); `SeedData.gs` lines 16–23; `LoginDiagnostics.gs` lines 61–70

**Detail:** Passwords are hashed with `Utilities.computeDigest(SHA_256, password, UTF_8)` with no salt. This makes the system vulnerable to rainbow-table and pre-computed hash attacks. If the Turso database is exfiltrated, weak passwords are trivially recoverable. The Gap Register (`docs/roles-permissions-gap-analysis.md §9.1`) incorrectly notes "Passwords bcrypt-hashed" — they are not.

**Recommendation:** Implement bcrypt or Argon2 with a per-user random salt. Because GAS does not have a native bcrypt library, a lightweight pure-JS bcrypt implementation can be included as a library file, or passwords can be hashed via a small Cloud Function endpoint. As an interim measure, append a server-side pepper stored in Script Properties before hashing.

---

### DI-03 [P2 High] — Global function name collision: `logIntegrationCall()`

**File:** `DatabaseSetup.gs` line ~395; `Integrationservice.gs` line 1307

**Detail:** Both files define a top-level function named `logIntegrationCall()`. In the GAS V8 runtime, all `.gs` files share a single global namespace. The function that appears later in script alphabetical/load order silently shadows the other. Callers in `DatabaseSetup.gs` that expect the shim version will execute the full Turso-writing version, and vice versa, producing unpredictable behaviour.

**Recommendation:** Rename one of the implementations — for example, rename the shim in `DatabaseSetup.gs` to `_shimLogIntegrationCall()` and update its callers, or merge both into a single canonical implementation in `Integrationservice.gs`.

---

### DI-04 [P2 High] — TOTP MFA secret generated using `Math.random()`

**File:** `MfaService.gs` lines 127–132 (`generateSecret`)

**Detail:** The Base32-encoded TOTP secret used for RFC 6238 authentication codes is built from characters selected with `Math.random()`. `Math.random()` in V8 is a deterministic pseudo-random number generator with a 64-bit state; it does not meet the requirements for cryptographic entropy. An attacker who can observe the TOTP codes or brute-force MFA tokens has a smaller effective search space than the full 160-bit TOTP key space.

**Recommendation:** Replace `Math.random()` with a call to `Utilities.computeDigest(SHA_256, Utilities.getUuid() + Date.now(), ...)` seeded with multiple sources of entropy, or use GAS's `Utilities.getUuid()` (which is backed by Java's `SecureRandom`) as the entropy source.

---

### DI-05 [P2 High] — Pending-signup `password_hash` written to PropertiesService

**File:** `AuthService.gs` lines 286–289

**Detail:** During customer signup, `signupCustomer()` stores `password_hash` under the key `'PENDING_SIGNUP_' + requestId` in `PropertiesService.getScriptProperties()`. PropertiesService is accessible to any code running within the same script project and is readable via the Apps Script API by any OAuth user with the `script.scriptapp` scope (which this project requests). This means the password hash for an unconfirmed customer leaks to the script-property namespace until the signup is approved or rejected.

**Recommendation:** Do not store `password_hash` in PropertiesService at any stage. Store the signup request row in Turso without the password hash; require the user to re-set their password via the first-login flow after account approval.

---

### DI-06 [P2 High] — Oracle `oracle_customer_code` vs `oracle_customer_id` naming conflict

**File:** `DebugDB.gs` lines 123–125; `CustomerStatementsService.gs` line 89; `Integrationservice.gs` line 1086

**Detail:** The `customers` table is accessed with `oracle_customer_code` in `CustomerStatementsService.gs` line 89 and in `DebugDB.gs` (EXPECTED_SCHEMA), but `Integrationservice.gs` line 1086 filters on an empty-string `oracle_order_id` match. If the actual DB column is `oracle_customer_id` (the older name), the `getOracleCustomerId` call in `CustomerStatementsService.gs` will always return null, causing all statement requests to fall back to CMS-local data even when Oracle is configured. This issue is noted in `DebugDB.gs`'s `KNOWN_DUPLICATIONS` section but listed as empty, meaning the conflict is known but unresolved.

**Recommendation:** Run `runSmartCleanup()` rename steps for this column (or apply the migration manually), then settle on one canonical name and update all references.

---

### DI-07 [P2 High] — Approval workflow runtime absent (G-002)

**File:** `ApprovalEngine.gs` (fully implemented); `CustomerService.gs` lines 176–278; `docs/roles-permissions-gap-analysis.md §3.2`

**Detail:** `ApprovalEngine.gs` implements a complete engine for interpreting `approval_workflows.rules` JSON. `CustomerService.gs` calls `submitForApproval()` for credit-limit changes, refunds, and KYC sign-off. However, as confirmed in the gap register, no approval_workflows rows with valid thresholds exist in production, and no `handleApprovalRequest` entry-point is registered in `Code.gs`. Orders are approved by directly setting `orders.status` without traversing the engine, bypassing all SoD enforcement and tier-amount gating.

**Recommendation:** Register `handleApprovalRequest` in `Code.gs`, seed `approval_workflows` rows for the documented entity types, and verify that order-approval paths in `Orderservice.gs` call `submitForApproval()` rather than directly mutating `orders.status`.

---

### DI-08 [P2 High] — No environment separation (single Turso database for dev/prod)

**File:** `docs/roles-permissions-gap-analysis.md §8`; `TursoService.gs` lines 133–141

**Detail:** The same Turso URL and token are used regardless of deployment context. Development and testing operations write directly to the production database. Any debugging runs or schema-migration experiments (`runSmartCleanup()`, `migrateAllSheetsToTurso()`) execute against live data.

**Recommendation:** Create separate Turso databases for `dev`, `uat`, and `prod` environments. Use script-property naming conventions (`TURSO_URL_PROD`, `TURSO_URL_DEV`) with a deployment-time environment flag.

---

### DI-09 [P2 High] — Stale role codes in `SCHEMAS.Users.validations`

**File:** `DatabaseSetup.gs` lines 449–495 (SCHEMAS constant)

**Detail:** The `validations` list for the `Users` schema includes role codes `'ADMIN', 'CS_MANAGER', 'CS_AGENT', 'SALES_REP', 'COUNTRY_MANAGER', 'REGIONAL_MANAGER', 'GROUP_HEAD', 'VIEWER'`. The canonical 16-role taxonomy (`PermissionService.gs` `CANONICAL_STAFF_ROLES_`) lists `BD_REP`, `CREDIT_MANAGER`, `FINANCE_MANAGER`, `FINANCE_OFFICER`, `SUPPLY_OPS_MANAGER`, `SHARED_SERVICES_MANAGER`, `INTERNAL_AUDITOR`, `CEO`, `CFO`, `RMD` as additional valid codes, and `SALES_REP` and `GROUP_HEAD` are not canonical. Validation against the stale list will reject legitimate inserts or silently allow deprecated codes.

**Recommendation:** Replace `SCHEMAS.Users.validations.role` with a reference to `CANONICAL_STAFF_ROLES_` from `PermissionService.gs`, or derive it from the `roles` table at runtime.

---

## 5. Code Quality Findings

### CQ-01 [P3 Medium] — Permission code inconsistency between `serveStaffRoleAssignment` and `serveStaffRoleManagement`

**File:** `Code.gs` lines 86 and 111

**Detail:** `serveStaffRoleAssignment` checks `'role.assign'` (the canonical code from the v3 permission catalog), while `serveStaffRoleManagement` checks `'roles.assign'` (a deprecated code from the pre-v3 model). A user who holds `role.assign` but not `roles.assign` can access the assignment UI but not the management UI, or vice versa depending on which role_permissions rows are seeded. This inconsistency could silently lock out or silently over-grant access depending on the DB state.

**Recommendation:** Standardise both guards to `'role.assign'` (the canonical code). Remove `'roles.assign'` from `role_permissions` rows after confirming no other code references it.

---

### CQ-02 [P3 Medium] — Module-level permission cache `_PERM_CACHE_` is meaningless in GAS stateless model

**File:** `PermissionService.gs` line 379

**Detail:** `_PERM_CACHE_` is a module-level JavaScript variable used to cache permission lookups with a 60-second TTL. In the GAS V8 runtime, each HTTP request spawns a fresh isolate; module-level variables are never shared between requests and are destroyed at the end of each execution. The TTL check compares timestamps within a single execution that typically lasts under two seconds. The cache is never actually hit across requests, making it dead code that adds complexity without benefit.

**Recommendation:** Remove `_PERM_CACHE_` and its surrounding logic. Rely on `CacheService` (via `cachedGet()`) for cross-request caching, which `CacheManager.gs` already provides correctly.

---

### CQ-03 [P3 Medium] — Hard-coded MFA-exempt user ID in `MfaService.gs`

**File:** `MfaService.gs` line 37

**Detail:** `userRequiresMfa()` contains the literal `if (userId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') return false;`. This is a test/break-glass account that permanently bypasses MFA enforcement regardless of the user's role. If this UUID is ever assigned to a real user account (intentionally or by collision), that user permanently bypasses MFA.

**Recommendation:** Remove the hard-coded exemption. If a break-glass bypass is required, implement it via a script-property flag (`MFA_BYPASS_USER_ID`) that is explicitly documented and auditable, and log every bypass event to `audit_log`.

---

### CQ-04 [P3 Medium] — Password policy not enforced server-side

**File:** `AuthService.gs` — no server-side complexity validation found; `docs/roles-permissions-gap-analysis.md` G-009

**Detail:** There is no minimum-length, complexity, or rotation check on passwords during `setPassword`, `signup`, or `approveSignup` flows. A customer can set a single-character password. The gap register acknowledges this but marks it only as design-pending.

**Recommendation:** Add server-side validation in `hashPassword()` or its callers: minimum 12 characters, at least one digit, one uppercase letter, and one special character. Implement password history tracking (last 5 hashes) in the `contacts` and `users` tables.

---

### CQ-05 [P3 Medium] — `getCustomer360()` has no access-scope enforcement

**File:** `DatabaseService.gs` lines 494–531

**Detail:** `getCustomer360()` fetches a complete customer profile including orders, tickets, invoices, payment uploads, documents, contacts, and delivery locations. It accepts `customerId` as a parameter with no check against the caller's permitted countries. A CS_AGENT for Kenya calling this with a Uganda customer's `customer_id` receives the full customer 360-view.

**Recommendation:** Add a country-scope check: after loading the customer, verify `customer.country_code` is in the caller's permitted countries list before returning the aggregated data.

---

### CQ-06 [P3 Medium] — `getStaffMembers()` leaks all active staff names, roles, and activity status cross-country

**File:** `ChatService.gs` lines 105–128

**Detail:** `getStaffMembers()` calls `getSheetData('Users')` and returns `user_id`, `name`, `role`, and `online` status for every active user in the system with no country filter. A customer portal user who gains access to the chat API can enumerate all staff names, roles, and online presence across all countries.

**Recommendation:** This function should only be accessible to authenticated staff, and the result should be filtered to the caller's country unless the role is global-scope.

---

### CQ-07 [P3 Medium] — MFA enforcement gap for privileged roles

**File:** `MfaService.gs` lines 50–83; `docs/roles-permissions-gap-analysis.md` G-008

**Detail:** `userRequiresMfa()` checks a hardcoded `MFA_REQUIRED_ROLES` list, but the gap register confirms MFA is not yet consistently enforced at login time. A `SUPER_ADMIN` or CFO can authenticate with password alone if they have not opted in to MFA. The gap register acknowledges this as G-008 (High).

**Recommendation:** After fixing the TOTP secret entropy issue (DI-04), enforce MFA in `AuthService.gs:loginUser()` for all roles in `MFA_REQUIRED_ROLES`: check that `mfa_enabled = 1` and that the TOTP token is valid before issuing a session token. Allow a grace period only for the first-ever login to enroll.

---

### CQ-08 [P3 Medium] — `listUsersForRoleAdmin()` returns all users cross-country

**File:** `PermissionService.gs` lines 1128–1163

**Detail:** The role-administration function that populates the "assign role" dropdown returns all `user_roles` assignments without scoping by country. A `CS_MANAGER` using the role assignment UI can see (and potentially assign roles to) staff from all countries, not just their own.

**Recommendation:** Apply country-scope filtering in `listUsersForRoleAdmin()` using the caller's scope, unless the caller holds a `GLOBAL`-scope role.

---

### CQ-09 [P3 Medium] — SeedData.gs contains a plaintext default admin password and default customer password

**File:** `SeedData.gs` lines 8–9 and 62–63

**Detail:** `seedAdminUser()` contains `password = 'HassAdmin2024!'` and `seedTestCustomer()` contains `password = 'Customer2024!'` as plaintext literals. Even if the comment instructs users to change these before running, the credentials are committed to the repository and will appear in all code snapshots, PRs, and `git log` history.

**Recommendation:** Remove hardcoded credentials from the source file. Replace with a prompt that reads the password from a script-property (`SEED_ADMIN_PASSWORD`) set by the operator before running, or generate a random password and log it once to the execution log.

---

### CQ-10 [P3 Medium] — No data retention policy for sensitive tables

**File:** `docs/roles-permissions-gap-analysis.md` G-018

**Detail:** The `sessions`, `password_resets`, `audit_log`, `integration_log`, and `staff_messages` tables have no retention policy. Sessions and password-reset tokens that have expired remain permanently in the database. Integration logs that may contain request/response bodies with sensitive data (Oracle order details, customer PII) accumulate without bound.

**Recommendation:** Implement a scheduled purge job for each sensitive table: sessions expired > 30 days, password_resets used/expired > 7 days, integration_log entries > 90 days, staff_messages > 180 days. Document the retention periods in a data retention policy per the Kenya Data Protection Act 2019.

---

### CQ-11 [P4 Low] — `testWhatsApp()` in `SettingsService.gs` sends to a hardcoded number

**File:** `SettingsService.gs` lines 165–185

**Detail:** The test-WhatsApp function sends a test message to the hardcoded number `254700000000`. If a real SIM is ever assigned to this number, or if the number changes ownership, test messages will be sent to an unintended party whenever a staff member tests the WhatsApp integration.

**Recommendation:** Make the test phone number configurable via a script property or the UI settings form. Do not hardcode phone numbers in source code.

---

### CQ-12 [P4 Low] — `LoginDiagnostics.gs` contains plaintext credential in production code

**File:** `LoginDiagnostics.gs` lines 17–21

**Detail:** `testFullLoginPipeline()` contains `password: 'Catherine@Hass2026'` as a plaintext literal. This is a real (or test) staff credential committed to the codebase. The file is not excluded from deployment.

**Recommendation:** Remove plaintext credentials from all diagnostic/test functions. Read them from script properties or replace with instructions to set them before running.

---

### CQ-13 [P4 Low] — `backfillSLADataAffiliates()` contains hardcoded batch timestamps tied to specific historical imports

**File:** `DataUploadService.gs` lines 269–271

**Detail:** `var ZM_BATCH_TS = '2026-04-22T07:51'` and `var DRC_BATCH_TS = '2026-04-22T11:18'` are hardcoded date-time prefixes used to identify specific historical import batches. If this function is ever re-run, the logic will incorrectly re-classify any future rows whose `created_at` happens to match these prefixes.

**Recommendation:** Remove the one-time backfill function after it has served its purpose (or gate it with a run-once flag). Historical migration utilities should not remain in the production codebase.

---

### CQ-14 [P4 Low] — `Code.gs` AUTHENTICATED_SERVICES_ uses array linear scan for every request

**File:** `Code.gs` lines 266–271

**Detail:** `AUTHENTICATED_SERVICES_` is an array. Every `doPost` call iterates over it with `indexOf()`. While the performance impact is minimal (array length is ~15), converting it to an object `{}` would be O(1) and more maintainable.

**Recommendation:** Replace the array with an object keyed by service name: `var AUTHENTICATED_SERVICES_ = { 'handleUserRequest': true, ... }` and check with `!!AUTHENTICATED_SERVICES_[service]`.

---

## 6. Module-by-Module Findings Table

| Ref | Finding | Severity | File:Approximate Line | Recommendation |
|---|---|---|---|---|
| AC-01 | Country-scope isolation unenforced in query layer | P1 Critical | `PermissionService.gs:1026`, `UserService.gs:75`, `UserService.gs:439`, `DashboardService.gs:43`, `DatabaseService.gs:494` | Call `requireScope()` from each list handler; append `country_code IN (...)` predicate to queries |
| AC-02 | `handleDocumentRequest()` has no permission checks | P1 Critical | `Documentservice.gs:1043` | Add `requirePermission()` before each action case |
| AC-03 | `handleSettingsRequest()` has no permission checks | P1 Critical | `SettingsService.gs:9` | Add `requirePermission(session, 'config.update')` before write cases |
| AC-04 | `handleIntegrationRequest()` has no permission checks | P1 Critical | `Integrationservice.gs:1338` | Add `requirePermission()` per action case |
| AC-05 | `handleKnowledgeRequest()` has no permission checks | P1 Critical | `Knowledgeservice.gs:961` | Add `requirePermission()` before all mutating actions |
| AC-06 | `sendChatMessage()` accepts `senderId` from client | P1 Critical | `ChatService.gs:51` | Bind `senderId` to `session.userId`; discard client value |
| AC-07 | No room-membership check in `getChatMessages()` | P1 Critical | `ChatService.gs:30` | Implement room-membership verification before returning messages |
| AC-08 | Customer portal delivery/consumption APIs lack ownership enforcement | P1 Critical | `CustomerService.gs:11,43` | Resolve `customerId` from session; reject mismatched client value |
| DI-01 | `ExternalSLAEvents` missing from TABLE_MAP | P2 High | `Integrationservice.gs:1657`, `TursoService.gs:25` | Add to TABLE_MAP; create DB table in migration |
| DI-02 | SHA-256 without salt for password hashing | P2 High | `AuthService.gs:50` | Implement bcrypt/Argon2 with per-user salt |
| DI-03 | `logIntegrationCall()` global namespace collision | P2 High | `DatabaseSetup.gs:~395`, `Integrationservice.gs:1307` | Rename the shim in `DatabaseSetup.gs` |
| DI-04 | TOTP secret uses `Math.random()` (non-cryptographic) | P2 High | `MfaService.gs:127` | Replace with cryptographically secure entropy source |
| DI-05 | Pending-signup `password_hash` written to PropertiesService | P2 High | `AuthService.gs:286` | Remove; use first-login password-set flow instead |
| DI-06 | `oracle_customer_code` vs `oracle_customer_id` naming conflict | P2 High | `CustomerStatementsService.gs:89`, `Integrationservice.gs:1086` | Settle on one canonical column name; apply migration |
| DI-07 | Approval workflow runtime absent (G-002) | P2 High | `ApprovalEngine.gs`, `Code.gs` (missing registration) | Register handler; seed workflows; route order approvals through engine |
| DI-08 | No environment separation (single Turso DB for dev/prod) | P2 High | `TursoService.gs:133`, `docs/roles-permissions-gap-analysis.md §8` | Create separate dev/uat/prod Turso instances |
| DI-09 | Stale role codes in `SCHEMAS.Users.validations` | P2 High | `DatabaseSetup.gs:~449` | Sync validations with `CANONICAL_STAFF_ROLES_` |
| CQ-01 | Permission code inconsistency: `role.assign` vs `roles.assign` | P3 Medium | `Code.gs:86,111` | Standardise to `role.assign` |
| CQ-02 | Module-level `_PERM_CACHE_` is meaningless in GAS | P3 Medium | `PermissionService.gs:379` | Remove; use `CacheService` for cross-request caching |
| CQ-03 | Hard-coded MFA-exempt user ID | P3 Medium | `MfaService.gs:37` | Remove; implement auditable break-glass via script property |
| CQ-04 | No server-side password policy enforcement | P3 Medium | `AuthService.gs` | Add minimum-length and complexity validation |
| CQ-05 | `getCustomer360()` lacks country-scope enforcement | P3 Medium | `DatabaseService.gs:494` | Verify `customer.country_code` is in caller's scope before returning data |
| CQ-06 | `getStaffMembers()` leaks all staff cross-country | P3 Medium | `ChatService.gs:105` | Restrict to caller's country; guard to staff only |
| CQ-07 | MFA not enforced for privileged roles (G-008) | P3 Medium | `MfaService.gs:50`, `AuthService.gs` login flow | Enforce MFA check in `loginUser()` after fixing entropy (DI-04) |
| CQ-08 | `listUsersForRoleAdmin()` returns all users cross-country | P3 Medium | `PermissionService.gs:1128` | Apply country-scope filter unless caller is GLOBAL-scope |
| CQ-09 | Plaintext default credentials in `SeedData.gs` | P3 Medium | `SeedData.gs:8,62` | Remove hardcoded passwords; use script-property input |
| CQ-10 | No data retention policy for sensitive tables | P3 Medium | All log/session tables; `docs/roles-permissions-gap-analysis.md` G-018 | Implement scheduled purge job; document retention periods |
| CQ-11 | Hardcoded test phone number in `testWhatsApp()` | P4 Low | `SettingsService.gs:165` | Make configurable via script property |
| CQ-12 | Plaintext credential in `LoginDiagnostics.gs` | P4 Low | `LoginDiagnostics.gs:17` | Remove; read from script property |
| CQ-13 | Historical backfill function with hardcoded timestamps | P4 Low | `DataUploadService.gs:269` | Remove after one-time use is confirmed complete |
| CQ-14 | Linear scan on `AUTHENTICATED_SERVICES_` array | P4 Low | `Code.gs:266` | Convert to object for O(1) lookup |

---

## 7. Close-Out of Section 5 (Gap Register) Brief Register

The gap register in `docs/roles-permissions-gap-analysis.md` lists 21 items (G-001 through G-021). The table below states the audit's view of each gap's status as of the current codebase.

| Gap | Title | Register Status | Audit Observation |
|---|---|---|---|
| G-001 | Customer portal login redirect broken | CLOSED | Confirmed closed. doGet routing in Code.gs is correct. |
| G-002 | Approval workflow runtime not built | Not started | Confirmed open. `ApprovalEngine.gs` is fully coded but not registered in `Code.gs` and has no active workflow rows. Order approvals bypass the engine entirely. Raised as DI-07. |
| G-003 | SLA breach detection not running | Not started | Partially mitigated. `SLABreachDetector.gs` is fully implemented with `installSLABreachTrigger()`. The trigger has not been installed in production (no evidence of a time-driven trigger record). Action required: run `installSLABreachTrigger()`. |
| G-004 | Segregation of Duties not enforced | In flight | Partially mitigated. SoD checks exist in `ApprovalEngine.gs` `_approvalDomainSoD_()`. However, as noted in DI-07, the approval engine is not invoked for orders, so SoD is not active for the most common workflow. |
| G-005 | Audit log incomplete | In flight | `audit_log()` is called in many services (`DocumentService`, `KnowledgeService`, `AuditService`, `SLABreachDetector`). Not called from `ChatService`, `SettingsService`, or `handleIntegrationRequest`. |
| G-006 | Password reset email tone | CLOSED | Not re-audited; accepted as closed per register. |
| G-007 | Module/icon click freeze | In flight | Not a backend finding; out of scope for this audit. |
| G-008 | MFA not enforced | Design pending | Confirmed open. `MfaService.gs` implements TOTP infrastructure but `loginUser()` in `AuthService.gs` does not enforce TOTP for roles in `MFA_REQUIRED_ROLES`. Raised as CQ-07 with dependency on DI-04 (entropy fix). |
| G-009 | Password policy not enforced | Design pending | Confirmed open. No server-side complexity or length validation found. Raised as CQ-04. |
| G-010 | Session policy weak | Design pending | Partially mitigated. Sessions have TTLs (8h staff, 24h customer). No idle timeout or concurrent session control exists. Out of scope for this audit pass; recommend dedicated session hardening sprint. |
| G-011 | Oracle ERP connector stubbed | Design pending | Not fully accurate. `callOracleApi()` in `Integrationservice.gs` lines 600–657 makes real HTTP requests; `CustomerStatementsService.gs` calls it. Connectivity depends on `ORACLE_API_URL` script property being set. The connector exists but is not configured with live credentials. |
| G-012 | M-Pesa Daraja callback handler missing | Design pending | Confirmed open. No `doPost` route for M-Pesa callbacks found. |
| G-013 | KRA eTIMS integration not wired | Design pending | Confirmed open. No eTIMS-specific integration code found. |
| G-014 | Document expiry alerts not running | Not started | Partially mitigated. `SLABreachDetector.gs:detectDocumentExpiryAlerts()` and `Documentservice.gs:sendExpiryReminders()` both exist. Neither is registered as a scheduled trigger. |
| G-015 | Recurring order job runner not deployed | Not started | `JobProcessor.gs` exists (confirmed from SheetDatabase.gs references). `installJobProcessorTrigger()` must be called to activate it. |
| G-016 | Permission matrix not signed off | Pending | Out of scope for code audit. Business review required. |
| G-017 | Module ownership not assigned | Pending | Out of scope for code audit. Organisational decision required. |
| G-018 | No data retention policy | Policy draft pending | Confirmed open. No retention-purge jobs found in any service. Raised as CQ-10. |
| G-019 | Mobile UX not tested | Phase 2 backlog | Out of scope for code audit. |
| G-020 | No backup/disaster recovery rehearsal | Plan pending | Out of scope for code audit. Operational decision required. |
| G-021 | Critical roles unassigned | Identified | Out of scope for code audit. Operational and HR action required. |

---

## 8. Remediation Backlog — P1 to P4

### P1 — Critical (must fix before any production go-live)

| ID | Action | File(s) | Owner |
|---|---|---|---|
| AC-01 | Instrument `requireScope()` in every service handler that queries customer, order, ticket, or user lists; append returned country list as SQL WHERE predicate | `UserService.gs`, `Orderservice.gs`, `Ticketservice.gs`, `DashboardService.gs`, `DatabaseService.gs` | Engineering |
| AC-02 | Add `requirePermission()` to `handleDocumentRequest()` for all mutating and sensitive-read actions | `Documentservice.gs` | Engineering |
| AC-03 | Add `requirePermission(session, 'config.update')` to `handleSettingsRequest()` | `SettingsService.gs` | Engineering |
| AC-04 | Add per-action `requirePermission()` calls to `handleIntegrationRequest()` | `Integrationservice.gs` | Engineering |
| AC-05 | Add `requirePermission()` to all mutating actions in `handleKnowledgeRequest()` | `Knowledgeservice.gs` | Engineering |
| AC-06 | Bind chat `senderId` to `session.userId`; reject client-supplied value | `ChatService.gs` | Engineering |
| AC-07 | Implement room-membership check before returning messages in `getChatMessages()` | `ChatService.gs` | Engineering |
| AC-08 | Resolve `customerId` from session in customer-portal delivery/consumption paths | `CustomerService.gs` | Engineering |

### P2 — High (fix before go-live; schedule immediately)

| ID | Action | File(s) | Owner |
|---|---|---|---|
| DI-01 | Add `ExternalSLAEvents` to TABLE_MAP and PK_MAP; create `external_sla_events` table in migration | `TursoService.gs`, new migration | Engineering |
| DI-02 | Replace SHA-256 no-salt with bcrypt + per-user salt for all password hashing | `AuthService.gs`, `SeedData.gs` | Engineering + IT Security |
| DI-03 | Rename `logIntegrationCall()` shim in `DatabaseSetup.gs` to avoid global namespace collision | `DatabaseSetup.gs` | Engineering |
| DI-04 | Replace `Math.random()` in TOTP secret generation with a CSPRNG | `MfaService.gs` | Engineering + IT Security |
| DI-05 | Remove `password_hash` storage from `PropertiesService` in signup flow | `AuthService.gs` | Engineering |
| DI-06 | Resolve `oracle_customer_code` vs `oracle_customer_id` naming conflict; apply migration | `CustomerStatementsService.gs`, `Integrationservice.gs`, migration | Engineering |
| DI-07 | Register `handleApprovalRequest` in `Code.gs`; seed `approval_workflows` rows; route order approvals through engine | `Code.gs`, `ApprovalEngine.gs`, migration | Engineering + Finance |
| DI-08 | Create separate Turso databases for dev/uat/prod; parameterise credentials | `TursoService.gs`, deployment pipeline | Engineering + IT |
| DI-09 | Sync `SCHEMAS.Users.validations.role` with canonical role list | `DatabaseSetup.gs` | Engineering |

### P3 — Medium (address in the sprint after go-live)

| ID | Action | File(s) | Owner |
|---|---|---|---|
| CQ-01 | Standardise permission code to `role.assign` in all route guards | `Code.gs` | Engineering |
| CQ-02 | Remove ineffective `_PERM_CACHE_` module-level variable | `PermissionService.gs` | Engineering |
| CQ-03 | Remove hard-coded MFA-exempt user ID; implement auditable break-glass | `MfaService.gs` | Engineering + IT Security |
| CQ-04 | Add server-side password complexity and length validation | `AuthService.gs` | Engineering |
| CQ-05 | Add country-scope check to `getCustomer360()` | `DatabaseService.gs` | Engineering |
| CQ-06 | Add country-scope filter and staff-only guard to `getStaffMembers()` | `ChatService.gs` | Engineering |
| CQ-07 | Enforce TOTP MFA check in `loginUser()` for required roles (after DI-04 done) | `AuthService.gs`, `MfaService.gs` | Engineering + IT Security |
| CQ-08 | Add country-scope filter to `listUsersForRoleAdmin()` | `PermissionService.gs` | Engineering |
| CQ-09 | Remove hardcoded default credentials from `SeedData.gs` | `SeedData.gs` | Engineering |
| CQ-10 | Implement scheduled purge jobs for sessions, password_resets, audit_log, integration_log, staff_messages; publish retention policy | New `RetentionService.gs`, `Code.gs` | Engineering + Legal/Privacy |

### P4 — Low (schedule in subsequent maintenance cycle)

| ID | Action | File(s) | Owner |
|---|---|---|---|
| CQ-11 | Make WhatsApp test phone number configurable | `SettingsService.gs` | Engineering |
| CQ-12 | Remove plaintext credential from `LoginDiagnostics.gs` | `LoginDiagnostics.gs` | Engineering |
| CQ-13 | Remove or gate the one-time `backfillSLADataAffiliates()` function | `DataUploadService.gs` | Engineering |
| CQ-14 | Convert `AUTHENTICATED_SERVICES_` array to object for O(1) lookup | `Code.gs` | Engineering |

---

*End of audit report.*
