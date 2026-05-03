# Hass CMS — Roles, Workflows, Permissions & Gap Analysis

> **Document owner:** Wilbur Murikah, Group Head of Internal Audit
> **Document status:** Working draft — Phase 1 schema reconciliation complete, application UX in progress
> **Last reviewed:** 2026-05-03
> **Audience:** Engineering, Operations, Customer Experience, Internal Audit, Senior Leadership
> **Purpose:** Document end-to-end role workflows, permissions, current implementation state, and the gap between as-built and as-required. Supports control design, security review, and engineering prioritisation.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Role inventory](#2-role-inventory)
3. [Permission matrix](#3-permission-matrix)
4. [End-to-end workflows](#4-end-to-end-workflows)
5. [System modules and ownership](#5-system-modules-and-ownership)
6. [Current state vs target state](#6-current-state-vs-target-state)
7. [Gap register](#7-gap-register)
8. [Pending features](#8-pending-features)
9. [Technical debt](#9-technical-debt)
10. [Control framework alignment](#10-control-framework-alignment)
11. [Glossary](#11-glossary)

---

## 1. Executive summary

The Hass CMS is a multi-country (Kenya, Uganda, Tanzania, Rwanda, plus regional terminals) customer management and order processing system serving the Hass Petroleum Group. It sits between customer-facing channels (portal, email, phone, WhatsApp) and the back-office Oracle ERP.

As of 2026-05-03, the database tier is fully reconciled (50 tables present, 268 rows of seed data, 0 schema gaps, 0 FK violations). The application tier is partially functional: staff login and dashboard work; customer login authenticates but redirects to a broken page; transactional flows (orders, tickets, invoices) are present but not end-to-end tested with real workflows.

**Headline gaps**:
- Customer portal post-login redirect broken (immediate fix in progress).
- Password reset email tone and sign-off does not reflect Customer Experience brand voice.
- No documented role-permission matrix has been signed off by business stakeholders. The 12 roles + 37 permissions in the database were seeded by engineering without formal RACI review.
- SLA breach detection is implemented in the schema but the alerting/escalation logic is not wired end-to-end.
- Approval workflows for orders, credit increases, and refunds are defined as JSON in `approval_workflows` but the runtime engine that consumes them is not yet built.
- No segregation of duties (SoD) controls between order creation, approval, and dispatch — a single user with broad role grants could drive an order from draft to delivered without oversight.

**Risk posture:** Pre-launch. Acceptable risk for the current pilot stage. Not acceptable for production cutover without addressing the items in §7 and §10.

---

## 2. Role inventory

The system has 12 defined roles in the `roles` table. Roles are assigned to users (staff) via `user_roles` and to contacts (customers) via `contacts.portal_role`. Permissions are assigned to roles via `role_permissions`.

### 2.1 Staff roles

| Role code | Role name | Typical user | Country scope | Headcount (approx.) |
|---|---|---|---|---|
| `SUPER_ADMIN` | Super Administrator | Group IT lead, designated CTO delegate | All | 2 |
| `ADMIN` | Administrator | Country IT, system administrators | Country-bound | 4–6 |
| `CEO` | Chief Executive | Group CEO | All | 1 |
| `CFO` | Chief Financial Officer | Group CFO | All | 1 |
| `COUNTRY_HEAD` | Country General Manager | KE/UG/TZ/RW country GMs | Country-bound | 4 |
| `MANAGER` | Department Manager | Department heads | Country-bound | 8–12 |
| `SUPERVISOR` | Team Supervisor | Team leads (Operations, Customer Service) | Country + team-bound | 12–18 |
| `AGENT` | Customer Service Agent | Frontline customer service staff | Country + team-bound | 20–40 |
| `FINANCE` | Finance Officer | Finance team members | Country-bound | 10–15 |
| `KYC_OFFICER` | KYC Compliance Officer | Compliance / onboarding staff | Country-bound | 4–6 |
| `OPS` | Operations Officer | Dispatch, depot, fleet | Country-bound | 15–25 |
| `AUDIT_VIEWER` | Audit Read-Only | Internal/external audit staff | All (read-only) | 2–4 |

### 2.2 Customer (portal) roles

Customer-side roles are stored in `contacts.portal_role`. They govern what a customer's contact person can do inside the customer portal.

| Portal role | Description | Typical contact |
|---|---|---|
| `ADMIN` | Customer organisation admin — manages other portal users, account profile, billing | CEO, Operations Director |
| `MANAGER` | Approves orders, manages delivery locations | Procurement Manager, Operations Manager |
| `OPERATOR` | Places orders, tracks deliveries, raises tickets | Transport Officer, Site Supervisor |
| `VIEWER` | Read-only; sees orders, invoices, statements | Finance Clerk, Auditor |

---

## 3. Permission matrix

37 distinct permissions exist in the `permissions` table. Below is the canonical mapping by entity. **This matrix has not been formally signed off by business stakeholders — it is the engineering-implemented state, not the policy-approved state.** Treat as draft.

### 3.1 Customer entity permissions

| Permission code | SUPER_ADMIN | ADMIN | CEO | CFO | COUNTRY_HEAD | MANAGER | SUPERVISOR | AGENT | FINANCE | KYC_OFFICER | OPS | AUDIT_VIEWER |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `customer.view`         | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `customer.create`       | ✅ | ✅ | – | – | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `customer.update`       | ✅ | ✅ | – | – | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `customer.delete`       | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `customer.approve_kyc`  | ✅ | ❌ | – | – | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `customer.set_credit`   | ✅ | ❌ | – | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |

### 3.2 Order entity permissions

| Permission code | SUPER_ADMIN | ADMIN | CEO | CFO | COUNTRY_HEAD | MANAGER | SUPERVISOR | AGENT | FINANCE | OPS | AUDIT_VIEWER |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `order.view`            | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `order.create`          | ✅ | ✅ | – | – | – | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `order.approve_low`     | ✅ | ❌ | – | – | – | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `order.approve_mid`     | ✅ | ❌ | – | – | – | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `order.approve_high`    | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `order.cancel`          | ✅ | ❌ | – | – | – | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `order.dispatch`        | ✅ | ❌ | – | – | – | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| `order.confirm_delivery`| ✅ | ❌ | – | – | – | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |

### 3.3 Ticket and customer service permissions

| Permission code | SUPER_ADMIN | ADMIN | MANAGER | SUPERVISOR | AGENT | KYC_OFFICER | AUDIT_VIEWER |
|---|---|---|---|---|---|---|---|
| `ticket.view`           | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ticket.create`         | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `ticket.assign`         | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `ticket.escalate`       | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `ticket.close`          | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `ticket.reopen`         | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |

### 3.4 Finance and billing permissions

| Permission code | SUPER_ADMIN | CFO | FINANCE | MANAGER | AGENT | AUDIT_VIEWER |
|---|---|---|---|---|---|---|
| `invoice.view`          | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `invoice.generate`      | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `invoice.cancel`        | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `payment.review`        | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `payment.approve`       | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `payment.refund`        | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `statement.export`      | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |

### 3.5 System and configuration permissions

| Permission code | SUPER_ADMIN | ADMIN | AUDIT_VIEWER |
|---|---|---|---|
| `config.view`           | ✅ | ✅ | ✅ |
| `config.update`         | ✅ | ❌ | ❌ |
| `user.create`           | ✅ | ✅ | ❌ |
| `user.update`           | ✅ | ✅ | ❌ |
| `user.delete`           | ✅ | ❌ | ❌ |
| `user.reset_password`   | ✅ | ✅ | ❌ |
| `role.assign`           | ✅ | ❌ | ❌ |
| `audit_log.view`        | ✅ | ❌ | ✅ |
| `report.run`            | ✅ | ✅ | ✅ |

✅ = granted in current `role_permissions` rows
❌ = explicitly denied
– = not applicable (e.g. CEO does not "create customers" but can view)

---

## 4. End-to-end workflows

This section walks through every major workflow as currently implemented or specified, end-to-end, with the role at each step.

### 4.1 Customer onboarding

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | Prospective customer or AGENT | Submit signup request | `signup_requests` row created with `status='PENDING_APPROVAL'`, `kyc_status='PENDING'` | Channel: portal self-service or staff-side data entry |
| 2 | KYC_OFFICER | Reviews KYC documents | `documents` rows created (KRA PIN, Business Permit, etc.) with `status='PENDING_VERIFICATION'` | Customer uploads docs via portal; KYC officer downloads, reviews, marks verified |
| 3 | KYC_OFFICER | Approves or rejects KYC | `documents.status` → `VERIFIED` per doc; `signup_requests.kyc_status` → `COMPLETED` | If rejected, sends back with notes |
| 4 | FINANCE | Sets credit limit | `customers.credit_limit` set; uses customer segment (Bronze/Silver/Gold) as input | Manual review of risk score, payment terms |
| 5 | MANAGER or COUNTRY_HEAD | Final approval | `signup_requests.status` → `APPROVED`; `customers` row created from signup data | Customer ID issued, account number generated |
| 6 | System | Generate portal credentials | `contacts` row created with `is_portal_user=1`, password emailed | Welcome email sent via Customer Experience template |
| 7 | Customer | First login | Forces password change via `must_change_password` flow | Once changed, redirects to portal home |

**Current state:** Steps 1, 2, 4, 5 partially implemented. Step 3 (KYC verification) UI not yet built. Step 6 email template needs Customer Experience tone rewrite (per current PR). Step 7 password change flow not yet wired.

### 4.2 Order lifecycle (B2B credit customer)

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | OPERATOR (customer-side) or AGENT (staff-side) | Creates order | `orders` row, status `DRAFT` | Selects product, quantity, delivery location, requested date |
| 2 | OPERATOR or AGENT | Submits order | `orders.status` → `SUBMITTED`, `submitted_at` set; `order_status_history` entry written | Triggers approval workflow |
| 3 | System | Routes to approver per `approval_workflows.WF-001` rules | Looks up amount thresholds; assigns to AGENT/SUPERVISOR/MANAGER | **Approval engine not yet built — currently routes manually via assigned_to field** |
| 4 | Approver (AGENT for <100k, SUPERVISOR for <1M, MANAGER+FINANCE for >1M) | Approves or rejects | `orders.status` → `APPROVED` or `REJECTED`; `approved_by`, `approved_at` set | Credit limit check happens here; if `credit_used + total > credit_limit`, blocked |
| 5 | OPS | Schedules dispatch | `orders.vehicle_id`, `driver_id` assigned; `orders.status` → `SCHEDULED` | Dispatch UI assigns vehicle and driver based on availability |
| 6 | OPS | Dispatches | `orders.status` → `LOADING` → `LOADED` → `IN_TRANSIT`; `dispatched_at` set | Multiple status transitions; history tracked in `order_status_history` |
| 7 | Driver (DRV) | Confirms delivery | `orders.status` → `DELIVERED`; `delivered_at`, `delivery_confirmed_by` set | Customer signs delivery note (digital signature future) |
| 8 | FINANCE | Generates invoice | `invoices` row created from `orders` + `order_lines`; `oracle_invoice_id` populated via `integration_log` call | Job queue handles async Oracle ERP sync |
| 9 | Customer | Pays | `payment_uploads` row created; `payment_method='MPESA'/'BANK_TRANSFER'/'CARD'` | Via portal or via M-Pesa Paybill direct (callback to `INT-` log) |
| 10 | FINANCE | Reconciles | `payment_uploads.status` → `APPROVED`; `customers.credit_used` decremented; `invoices.status` → `PAID` | Auto-reconciliation for M-Pesa with matching reference; manual for bank |

**Current state:** Steps 1–2, 7, 9 partially functional. Step 3 (approval routing) entirely manual at present. Step 5–6 (dispatch UI) basic; advanced fleet routing not built. Step 8 (Oracle ERP sync) stubbed via `integration_log` but no real connector. Step 10 (reconciliation) UI not yet built.

### 4.3 Customer service ticket lifecycle

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | Customer (any portal role) or AGENT (on customer's behalf) | Creates ticket | `tickets` row, status `NEW`; channel set (PORTAL/EMAIL/PHONE/WHATSAPP) | Categorisation: BILLING/DELIVERY/ORDER/ACCOUNT/TECHNICAL/EMERGENCY |
| 2 | System | Auto-assigns | `tickets.assigned_to` set per team auto-assignment rules; `assigned_team_id` set; SLA targets calculated and stored | Uses `teams.assignment_method` and `business_hours` to compute SLA times |
| 3 | AGENT | Acknowledges | `tickets.acknowledged_at` set; `tickets.status` → `OPEN` | First-touch within `acknowledge_minutes` |
| 4 | AGENT | Investigates | `ticket_comments` rows added (internal + external); `ticket_history` rows for any field change | Internal comments not visible to customer |
| 5 | AGENT | Resolves | `tickets.status` → `RESOLVED`; `resolved_at`, `resolution_type`, `resolution_summary` set | Customer notified via email |
| 6 | Customer | Confirms or reopens | If confirmed, `closed_at` set after 24h; if reopened, `reopened_count++` | Auto-close after 24h if no customer response |
| 7 | SUPERVISOR | Reviews escalations | If SLA breached, `escalation_level++` and `escalated_to` set | **Escalation engine not yet built** |

**Current state:** Steps 1, 3, 4, 5 functional. Step 2 (auto-assignment) basic; advanced rules not implemented. Step 6 auto-close not wired. Step 7 SLA breach detection not running on schedule.

### 4.4 Password reset (super admin initiated)

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | SUPER_ADMIN | Identifies user needing reset | UI lookup of user/contact | Could be staff or customer |
| 2 | SUPER_ADMIN | Triggers reset | New temp password generated server-side; `users.password_hash` or `contacts.password_hash` updated; `must_change_password=1` | OR magic link / OTP — depends on policy |
| 3 | System | Sends email | Email rendered from `notification_templates` row TPL-PASSWORD-RESET; sent via SMTP | **Email tone needs rewrite (per current PR)** |
| 4 | User | Logs in with temp password | Auth handler validates against `password_hash`; checks `must_change_password` | If flag set, redirects to forced password change |
| 5 | User | Sets new password | Old hash overwritten; `must_change_password=0`; `password_changed_at` set | Audit log entry written |

**Current state:** Steps 1–2 functional. Step 3 email needs tone overhaul. Step 4–5 forced password change flow exists but not consistently enforced.

### 4.5 Recurring order automation

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | OPERATOR (customer) or AGENT | Creates schedule | `recurring_schedule` row, frequency configured; `recurring_schedule_lines` for products | |
| 2 | System (scheduled job) | Computes `next_order_date` | `job_queue` entry of type `RECURRING_ORDER_GEN` runs daily at 02:00 | |
| 3 | System | Generates draft order on next_order_date | Creates `orders` row in `DRAFT` status; lines from `recurring_schedule_lines` | |
| 4 | System | If `auto_submit=1`, submits and routes | Triggers approval workflow per §4.2 | If `auto_submit=0`, holds in DRAFT for manual review |

**Current state:** Step 1 functional. Steps 2–4 not yet running on schedule (job_queue runner not deployed).

---

## 5. System modules and ownership

| Module | Backend service | Frontend | Business owner | Engineering owner |
|---|---|---|---|---|
| Authentication | `AuthService.gs` | Login pages, session JS in both dashboards | IT Security | (TBD) |
| Customer Management | `CustomerService.gs` | Staff customer pages, customer portal profile | Customer Experience | (TBD) |
| Orders | `OrderService.gs` | Orders pages on both sides | Operations | (TBD) |
| Invoicing & Payments | `InvoiceService.gs`, `PaymentService.gs` | Finance pages, customer portal billing | Finance | (TBD) |
| Tickets | `TicketService.gs` | Tickets pages | Customer Experience | (TBD) |
| KYC & Documents | `DocumentService.gs` | Documents pages | Compliance / KYC | (TBD) |
| SLA & Reporting | `SLAService.gs` | SLA dashboard | Operations + Audit | (TBD) |
| Notifications | `NotificationService.gs`, `EmailService.gs` | Notification preferences | Customer Experience | (TBD) |
| Knowledge Base | `KnowledgeService.gs` | KB pages on both sides | Customer Experience | (TBD) |
| Recurring Orders | `RecurringService.gs` | Recurring schedules pages | Operations | (TBD) |
| Audit Log | `AuditService.gs` | Audit log viewer | Internal Audit | (TBD) |
| Integrations (Oracle, M-Pesa, KRA) | `IntegrationService.gs` | (none — backend only) | IT + Finance | (TBD) |
| Settings & Config | `ConfigService.gs` | Settings pages | IT + Operations | (TBD) |
| Approvals | (not yet built) | (not yet built) | Finance + Operations | (TBD) |

**Action:** Business and engineering owners must be assigned per module. Currently Wilbur is acting as informal owner across all modules. This is unsustainable and creates a single point of failure for both business decisions and engineering review.

---

## 6. Current state vs target state

| Capability | Target | Current | Gap |
|---|---|---|---|
| Database schema | 50 tables, 0 missing columns, 0 FK violations | 50 tables, 0 missing, 0 violations | ✅ Closed |
| Reference data seeded | All lookup tables populated | 11 reference tables, 268 rows | ✅ Closed |
| Sample transactional data | Demonstrable end-to-end records | 31 tables seeded with ≥10 rows each | ✅ Closed (this iteration) |
| Staff dashboard | Renders with real data, all modules functional | Renders, most modules functional | Minor: click feedback, skeleton loaders |
| Customer portal | Customer logs in, sees orders/invoices/tickets, places new order | Login redirects to blank page | 🔴 Major — fix in current PR |
| Approval workflows | Orders, credit limits, refunds route per `approval_workflows` JSON | JSON defined, runtime engine not built | 🔴 Major — required before production |
| SLA enforcement | Tickets auto-escalate on breach; alerts sent | SLA targets calculated; breach detection not running | 🔴 Major — required before production |
| Integrations live | Oracle ERP, M-Pesa Daraja, KRA eTIMS, SMS gateway connected | Stubbed via `integration_log` only | 🟡 Mid — required for go-live |
| Audit trail | Every business action logged with actor, before/after, IP, timestamp | `audit_log` schema present; not all services writing to it | 🟡 Mid — required for audit compliance |
| Segregation of Duties | Single user cannot create + approve + dispatch an order | All capabilities assignable to one role | 🔴 Major — control gap |
| MFA enforcement | Required for SUPER_ADMIN, ADMIN, FINANCE; optional for others | Schema supports it; not enforced | 🟡 Mid |
| Password policy | Min 12 chars, complexity, history, 90-day rotation | Not enforced at app layer | 🟡 Mid |
| Session management | Auto-expire, idle timeout, concurrent session control | Sessions table exists, expiry logic basic | 🟡 Mid |
| Customer experience tone | Warm, branded, signed off by Customer Experience team | Many emails IT-toned | 🟡 Mid — fix in current PR |
| Mobile UX | Responsive design, touch-friendly, mobile flows | Desktop-first, mobile not tested | 🟢 Low — Phase 2 |
| Multi-language | EN, KISW, FR (RW), other regional | EN only | 🟢 Low — Phase 2 |
| Offline mode | Customer can review and queue orders offline | Online-only | 🟢 Low — Phase 3 |

---

## 7. Gap register

Numbered for traceability in PRs and audit reports.

### G-001 — Customer portal login redirect broken (CRITICAL)
**Detail:** Successful customer login redirects to `https://script.google.com/macros/s/.../exec` with no routing parameter; page renders blank.
**Risk:** Customers cannot use the portal. Pilot launch blocker.
**Owner:** Engineering
**Status:** In progress — current PR

### G-002 — Approval workflow runtime not built (CRITICAL)
**Detail:** `approval_workflows` rows define rules in JSON; no engine reads them. All approvals manual via `assigned_to`.
**Risk:** No enforcement of segregation of duties; high-value orders could be self-approved by creator.
**Owner:** Engineering + Finance
**Status:** Not started

### G-003 — SLA breach detection not running (CRITICAL)
**Detail:** Ticket SLA targets calculated correctly at creation; nothing checks breach state on schedule.
**Risk:** SLAs unenforced; customer experience degrades silently.
**Owner:** Engineering + Customer Experience
**Status:** Not started

### G-004 — Segregation of Duties not enforced (CRITICAL)
**Detail:** A user with `MANAGER` role can create + approve + dispatch + invoice the same order with no second-person check.
**Risk:** Fraud risk, control failure for SOX-style audit posture.
**Owner:** Internal Audit + Engineering
**Status:** Design pending

### G-005 — Audit log incomplete (HIGH)
**Detail:** `audit_log` schema exists; only some services write to it. No central middleware ensures every mutation is logged.
**Risk:** Audit trail gaps; cannot reconstruct who did what after the fact.
**Owner:** Engineering + Internal Audit
**Status:** Design pending

### G-006 — Password reset email tone (HIGH)
**Detail:** Reset email reads as IT-flavoured, signed by IT. Should be Hass Petroleum Customer Experience team.
**Risk:** Customer experience erosion; reputational at scale.
**Owner:** Customer Experience + Engineering
**Status:** In progress — current PR

### G-007 — Module/icon click freeze (HIGH)
**Detail:** Clicks on dashboard icons freeze UI for 2–5s with no feedback.
**Risk:** Users perceive the app as broken; double-click leads to duplicate actions.
**Owner:** Engineering
**Status:** In progress — current PR

### G-008 — MFA not enforced (HIGH)
**Detail:** `mfa_enabled`, `mfa_secret` columns exist; enforcement depends on user opt-in. Privileged roles should be required.
**Risk:** Account takeover risk for SUPER_ADMIN, ADMIN, FINANCE.
**Owner:** IT Security
**Status:** Design pending

### G-009 — Password policy not enforced (HIGH)
**Detail:** Length, complexity, rotation, history not enforced server-side.
**Risk:** Weak credentials; ISO 27001 control failure.
**Owner:** IT Security + Engineering
**Status:** Design pending

### G-010 — Session policy weak (MID)
**Detail:** Sessions persist beyond what's appropriate; no idle timeout, no concurrent session control.
**Risk:** Unattended sessions hijacked; multi-device collision.
**Owner:** IT Security + Engineering
**Status:** Design pending

### G-011 — Oracle ERP connector stubbed (HIGH)
**Detail:** `integration_log` records mock calls to Oracle; no real connector.
**Risk:** Customers, invoices, payments not synced to ERP at go-live.
**Owner:** Finance + Engineering
**Status:** Design pending

### G-012 — M-Pesa Daraja callback handler missing (HIGH)
**Detail:** Schema supports M-Pesa payments; no production callback endpoint.
**Risk:** Cannot accept M-Pesa payments at go-live.
**Owner:** Finance + Engineering
**Status:** Design pending

### G-013 — KRA eTIMS integration not wired (HIGH)
**Detail:** Invoices not transmitted to KRA eTIMS; required by Kenya VAT regulations.
**Risk:** Regulatory non-compliance; penalties.
**Owner:** Finance + Engineering
**Status:** Design pending

### G-014 — Document expiry alerts not running (MID)
**Detail:** Documents have `expiry_date`; no scheduled job notifies KYC officer 30 days ahead.
**Risk:** Expired permits cause downstream invoicing failures.
**Owner:** KYC + Engineering
**Status:** Not started

### G-015 — Recurring order job runner not deployed (MID)
**Detail:** Schedules exist; nothing runs to generate orders on `next_order_date`.
**Risk:** Recurring customers don't get orders auto-generated.
**Owner:** Operations + Engineering
**Status:** Not started

### G-016 — Permission matrix not signed off (MID)
**Detail:** §3 above is engineering-implemented, not formally reviewed by business owners.
**Risk:** Permission grants may not match policy intent; segregation gaps possible.
**Owner:** Internal Audit + Business owners (per module)
**Status:** Document review pending

### G-017 — Module ownership not assigned (MID)
**Detail:** §5 ownership column is mostly TBD; Wilbur acting as informal proxy.
**Risk:** Decisions delayed; SPOF in business + engineering reviews.
**Owner:** Senior Leadership
**Status:** Pending leadership decision

### G-018 — No data retention policy (MID)
**Detail:** No defined retention for audit_log, sessions, password_resets, integration_log, staff_messages. Tables grow without bound.
**Risk:** Storage cost; data protection regulation exposure (Kenya DPA 2019).
**Owner:** Internal Audit + Engineering
**Status:** Policy draft pending

### G-019 — Mobile UX not tested (LOW)
**Detail:** Application designed desktop-first; mobile responsiveness not verified.
**Risk:** Customers on mobile (likely majority) have degraded experience.
**Owner:** Customer Experience + Engineering
**Status:** Phase 2 backlog

### G-020 — No backup/disaster recovery rehearsal (HIGH)
**Detail:** Turso provides backups but no RTO/RPO defined and no rehearsal performed.
**Risk:** Data loss scenarios untested; business continuity gap.
**Owner:** IT + Internal Audit
**Status:** Plan pending

---

## 8. Pending features

Items planned but not yet started, beyond gap-closure work.

| Feature | Description | Priority | Estimated complexity |
|---|---|---|---|
| Mobile-responsive redesign | Touch-first redesign of customer portal | Mid | Large |
| Multi-language support | KISW, FR, plus dynamic per-country defaults | Mid | Large |
| Customer self-service KYC | Customer uploads documents directly without staff intervention | Mid | Medium |
| Driver mobile app | Drivers update delivery status from phone | Mid | Large |
| GPS live tracking on portal | Customers see truck location in real-time | Mid | Medium |
| Bulk order import | Excel/CSV import for repeat orders | Low | Small |
| Customer chatbot | First-line ticket triage via WhatsApp/portal | Low | Large |
| Payment plan / instalments | Customers pay invoices in tranches | Low | Medium |
| API for ERP-to-CMS push | External ERPs can push orders directly to Hass | Low | Medium |
| Loyalty/rewards | Volume-based rewards programme | Low | Medium |
| Predictive demand forecasting | ML-based forecast of customer demand | Low | Large |
| Compliance dashboard | Live view of KYC + permit + insurance status across all customers | Mid | Small |
| Tender / contract management | Long-term supply contracts vs spot orders | Low | Medium |
| Self-service price negotiation | Customer requests quote for non-standard volumes | Low | Medium |

---

## 9. Technical debt

Existing implementation issues that are not gaps in functionality but will impede future work.

| Item | Detail | Impact |
|---|---|---|
| Apps Script + Turso architecture | Apps Script is a hard ceiling for scalability and developer experience | Will hit limits at ~100 concurrent users; eventual rebuild on a real backend (Node.js/Cloudflare Workers) likely needed |
| No CI/CD pipeline | Code lives in Apps Script editor; manual sync from GitHub | Hard to enforce code review; redeploy is manual |
| No automated tests | All testing manual | Regressions silent; refactoring risky |
| `EXPECTED_SCHEMA` in `DebugDB.gs` out of sync with reality | 22 legitimate columns flagged as "extras" | Audit script noisy; real issues could be missed in noise |
| Hardcoded country list in some services | Adding a new country requires code search + multi-file edit | Slows expansion (e.g. adding HTW required schema seed only after we caught it) |
| String literals for status values | `'ACTIVE'`, `'PENDING_APPROVAL'`, etc. scattered across code | Refactoring states is brittle; should be enums or constants |
| No centralised error handling | Each service catches errors differently | User-facing error messages inconsistent; debugging hard |
| No logging library | Logs scattered across `Logger.log` calls | Cannot search, filter, or alert on logs |
| Mixed naming conventions | Some columns `gps_lat`, others `latitude`; legacy renames pending | Confusion; current `extraColumns` debug warnings stem from this |
| No environment separation | One Turso DB; same DB serves dev + uat + production | High risk; must split before go-live |
| No secrets management | API tokens in script properties; not rotated | Audit finding; need a secret manager |

---

## 10. Control framework alignment

This section maps the system's controls (or absence of controls) to the frameworks the business operates under.

### 10.1 ISO 27001:2022 (Information Security Management)

| Control area | Annex A reference | Current state | Gap reference |
|---|---|---|---|
| Access control policy | A.5.15 | Roles defined, permissions granted; no formal policy document | G-016 |
| Privileged access management | A.8.2 | SUPER_ADMIN role exists; not under additional MFA/approval gate | G-008 |
| Authentication | A.8.5 | Password + optional MFA; password policy unenforced | G-008, G-009 |
| Logging and monitoring | A.8.15 | `audit_log` partial; no SIEM | G-005 |
| Cryptography | A.8.24 | Passwords bcrypt-hashed; data at rest depends on Turso; no field-level encryption for PII | Partially closed |
| Backup | A.8.13 | Turso automatic backups; no rehearsal | G-020 |
| Information transfer | A.5.14 | TLS enforced via Apps Script; email encryption not enforced | Partially closed |

### 10.2 ISO 42001:2023 (AI Management — relevant if AI features added)

Currently no AI/ML features in the system. Section reserved for future state.

### 10.3 Kenya Data Protection Act 2019

| Requirement | Current state | Gap reference |
|---|---|---|
| Lawful basis documented | Not documented | New gap — to be raised |
| Customer data subject rights flow (access, correct, delete) | No self-service flow built | New gap — to be raised |
| Data retention | No policy defined | G-018 |
| Cross-border transfers (data leaves Kenya?) | Turso hosting region needs verification | New gap — to be raised |
| Breach notification process | No process documented | New gap — to be raised |

### 10.4 Petroleum sector regulations (KE PA 2017, EPRA)

| Requirement | Current state | Notes |
|---|---|---|
| KRA eTIMS integration | Stubbed | G-013 |
| EPRA reporting | Not in scope of CMS | Out of scope |
| Tank measurement / fuel quality controls | Not in scope of CMS | Out of scope (handled by Forecourt Management System per Crato review) |

### 10.5 Internal control framework (COSO-style)

| Control objective | Implementation | Gap reference |
|---|---|---|
| Authorization controls | Approval workflows JSON exists; engine not built | G-002 |
| Segregation of duties | Single role can drive end-to-end transaction | G-004 |
| Independent reconciliation | Payment reconciliation manual; no auto vs Oracle | G-011 |
| Audit trail | Partial | G-005 |
| Performance review | No SLA reporting in place | G-003 |

---

## 11. Glossary

| Term | Definition |
|---|---|
| **Apps Script** | Google's JavaScript-based serverless platform; hosts the application backend |
| **Turso** | libSQL-based cloud database; the primary data store |
| **CMS** | This system — Customer Management System |
| **KYC** | Know Your Customer — onboarding compliance process |
| **SLA** | Service Level Agreement — time-bound commitments to customers |
| **Affiliate** | A country business unit (e.g. Hass Kenya, Hass Uganda) — `country_code` in DB |
| **Segment** | Customer tier (Bronze/Silver/Gold) determining pricing, SLA, credit terms |
| **Eseal / eTIMS** | Kenya Revenue Authority electronic tax invoice system |
| **MFA** | Multi-Factor Authentication |
| **RBAC** | Role-Based Access Control |
| **SoD** | Segregation of Duties |
| **RACI** | Responsible / Accountable / Consulted / Informed |

---

## Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-05-03 | Wilbur Murikah | Initial draft |

**Next review:** After current PR (customer portal UX fix pack) merges — expected 2026-05-10.

**Distribution:** Senior Leadership, Engineering Lead, Customer Experience Lead, Finance Lead, Compliance Lead, Internal Audit team.

---

*End of document.*
