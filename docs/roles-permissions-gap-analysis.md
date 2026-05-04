# Hass CMS — Roles, Workflows, Permissions & Gap Analysis

> **Document owner:** Wilbur Murikah, Group Head of Internal Audit
> **Document status:** Working draft v0.2 — 16-role staff taxonomy adopted; v3 RBAC enforcement in flight
> **Last reviewed:** 2026-05-04
> **Audience:** Engineering, Operations, Customer Experience, Internal Audit, Senior Leadership
> **Purpose:** Document end-to-end role workflows, permissions, current implementation state, and the gap between as-built and as-required. Supports control design, security review, and engineering prioritisation.

---

## 1. Role inventory

The system uses a 16-role staff taxonomy plus 4 customer portal roles. Roles are stored in `roles`, mapped to permissions via `role_permissions`, assigned to staff via `user_roles`, and assigned to customer contacts via `contacts.portal_role`.

### 1.1 Staff roles (16)

The 16 staff roles are organised by tier:

#### System (1)

| role_code | role_name | scope | is_system | Purpose |
|---|---|---|---|---|
| `SUPER_ADMIN` | Super Administrator | GLOBAL | 1 | System-level access reserved for designated technical and governance leads. Full read/write across all modules and countries. Performs role assignments, configuration changes, and break-glass operations. |

#### C-Suite (3) — GLOBAL scope, system-reserved

| role_code | role_name | scope | is_system | Purpose |
|---|---|---|---|---|
| `CEO` | Chief Executive Officer | GLOBAL | 1 | Group Chief Executive. Final approver for highest-tier orders. Read-write across all countries. |
| `CFO` | Chief Financial Officer | GLOBAL | 1 | Group Chief Financial Officer. Approves refunds, credit limit changes, and finance exceptions. |
| `RMD` | Regional Managing Director | GLOBAL | 1 | C-Suite executive overseeing regional operations. |

#### Group functional (4) — GLOBAL scope

| role_code | role_name | scope | is_system | Purpose |
|---|---|---|---|---|
| `CREDIT_MANAGER` | Credit Manager | GLOBAL | 0 | Manages credit policy, customer credit limits, and credit risk assessments across all countries. Group-wide because credit relationships span multiple country operations. |
| `INTERNAL_AUDITOR` | Internal Auditor | GLOBAL | 1 | Read-only access across all entities for internal and external audit work. |
| `SHARED_SERVICES_MANAGER` | Shared Services Manager | GLOBAL | 0 | Manages cross-country shared services functions including HR, admin, and group support. |
| `SUPPLY_OPS_MANAGER` | Supply and Operations Manager | GLOBAL | 0 | Group-wide head of supply chain and operations. Procurement, depot stock, inbound logistics, and operational oversight across all countries. |

#### Country functional (8) — COUNTRY scope

| role_code | role_name | scope | is_system | Purpose |
|---|---|---|---|---|
| `COUNTRY_MANAGER` | Country Manager | COUNTRY | 0 | Country General Manager. Approves operations and exceptions within country scope. |
| `REGIONAL_MANAGER` | Regional Manager | COUNTRY | 0 | Regional operations oversight within country (sub-country regional structure). |
| `CS_MANAGER` | CS and BD Manager | COUNTRY | 0 | **Highest functional authority within country.** Heads customer service and business development teams. Approves orders within country tier. |
| `CS_AGENT` | CS Agent | COUNTRY | 0 | Frontline customer service agent. Tickets, order handling, customer communications. |
| `BD_REP` | BD Representative | COUNTRY | 0 | Business development field staff. Customer relationship development within country. |
| `FINANCE_MANAGER` | Finance Manager | COUNTRY | 0 | Country-level finance head. Approves payments, refunds, invoice exceptions within country scope. |
| `FINANCE_OFFICER` | Finance Officer | COUNTRY | 0 | Country-level finance operator. Invoice generation, payment processing, reconciliation. |
| `VIEWER` | Viewer | COUNTRY | 0 | Generic country-scoped read-only viewer. |

### 1.2 Customer portal roles (4)

Customer-side roles are stored in `contacts.portal_role`. They govern what a customer's contact person can do inside the customer portal. **Not stored in the staff `roles` table.**

| Portal role | Description | Typical contact |
|---|---|---|
| `ADMIN` | Customer organisation admin. Manages other portal users, account profile, billing. | CEO, Operations Director |
| `MANAGER` | Approves orders, manages delivery locations. | Procurement Manager, Operations Manager |
| `OPERATOR` | Places orders, tracks deliveries, raises tickets. | Transport Officer, Site Supervisor |
| `VIEWER` | Read-only. Sees orders, invoices, statements. | Finance Clerk, Auditor |

## 2. Permission matrix

The system has 37 permissions in the `permissions` table. The matrix below is the engineering-implemented intent for the 16-role model. **It has not been formally signed off by business stakeholders. Treat as a draft for review.**

Legend:
- ✅ = granted
- ❌ = explicitly denied
- – = not applicable for that role's responsibilities
- ⚠️ = granted with additional gating (SoD, amount tier, scope, etc.)

### 2.1 Customer entity permissions

| Permission | SUPER_ADMIN | CEO | CFO | RMD | CREDIT_MGR | INT_AUD | SHRD_SVCS | SUPPLY_OPS | COUNTRY_MGR | REGIONAL | CS_MGR | CS_AGENT | BD_REP | FIN_MGR | FIN_OFC | VIEWER |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `customer.view`         | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `customer.create`       | ✅ | – | – | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `customer.update`       | ✅ | – | – | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `customer.delete`       | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `customer.approve_kyc`  | ✅ | – | – | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `customer.set_credit`   | ✅ | – | ✅ ⚠️ | – | ✅ ⚠️ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

⚠️ on `customer.set_credit`: SoD enforced — setter ≠ requester.

### 2.2 Order entity permissions

| Permission | SUPER_ADMIN | CEO | CFO | RMD | SUPPLY_OPS | COUNTRY_MGR | REGIONAL | CS_MGR | CS_AGENT | BD_REP | FIN_MGR | FIN_OFC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `order.view`            | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `order.create`          | ✅ | – | – | – | ❌ | – | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `order.approve_low`     | ✅ | – | ✅ | – | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| `order.approve_mid`     | ✅ | – | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ |
| `order.approve_high`    | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `order.cancel`          | ✅ | – | – | – | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `order.dispatch`        | ✅ | – | – | – | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `order.confirm_delivery`| ✅ | – | – | – | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

**Amount tier mapping** (KES-equivalent):
- `order.approve_low` — orders ≤ 100,000 KES
- `order.approve_mid` — orders ≤ 1,000,000 KES
- `order.approve_high` — orders > 1,000,000 KES

**SoD on all approve permissions:** the order creator cannot approve their own order. Enforced in `OrderService.approve` regardless of role tier.

### 2.3 Ticket and customer service permissions

| Permission | SUPER_ADMIN | COUNTRY_MGR | REGIONAL | CS_MGR | CS_AGENT | BD_REP | INT_AUD |
|---|---|---|---|---|---|---|---|
| `ticket.view`           | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `ticket.create`         | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `ticket.assign`         | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `ticket.escalate`       | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `ticket.close`          | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `ticket.reopen`         | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

### 2.4 Finance and billing permissions

| Permission | SUPER_ADMIN | CEO | CFO | COUNTRY_MGR | FIN_MGR | FIN_OFC | INT_AUD |
|---|---|---|---|---|---|---|---|
| `invoice.view`          | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `invoice.generate`      | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `invoice.cancel`        | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `payment.review`        | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `payment.approve`       | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `payment.refund`        | ✅ | ❌ | ✅ ⚠️ | ❌ | ✅ ⚠️ | ❌ | ❌ |
| `statement.export`      | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

⚠️ on `payment.refund`: SoD enforced — refunder ≠ original payment receiver.

### 2.5 System and configuration permissions

| Permission | SUPER_ADMIN | CFO | INT_AUD |
|---|---|---|---|
| `config.view`           | ✅ | ✅ | ✅ |
| `config.update`         | ✅ | ❌ | ❌ |
| `user.create`           | ✅ | ❌ | ❌ |
| `user.update`           | ✅ | ❌ | ❌ |
| `user.delete`           | ✅ | ❌ | ❌ |
| `user.reset_password`   | ✅ | ❌ | ❌ |
| `role.assign`           | ✅ | ❌ | ❌ |
| `audit_log.view`        | ✅ | ❌ | ✅ |
| `report.run`            | ✅ | ✅ | ✅ |

Other roles inherit `report.run` for reports relevant to their scope (filtered at query time).

### 2.6 C-Suite role grant restrictions

| Constraint | Enforced where |
|---|---|
| `SUPER_ADMIN` only grantable by another `SUPER_ADMIN` | `RoleService.assign` |
| `CEO`, `CFO`, `RMD` only grantable by `SUPER_ADMIN` | `RoleService.assign` |
| `INTERNAL_AUDITOR` only grantable by `SUPER_ADMIN` (system-reserved) | `RoleService.assign` |
| Last `SUPER_ADMIN` cannot be removed | `RoleService.revoke` |
| Last `CS_MANAGER` per country cannot be removed | `RoleService.revoke` |
| `is_system=1` role grants require `reason` text logged | `RoleService.assign` |

---

## 3. End-to-end workflows

This section walks through every major workflow with the 16-role actor names.

### 3.1 Customer onboarding

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | Prospective customer or `CS_AGENT` | Submit signup request | `signup_requests` row created with `status='PENDING_APPROVAL'`, `kyc_status='PENDING'` | Channel: portal self-service or staff-side data entry |
| 2 | `CS_AGENT` (collector) | Reviews KYC documents uploaded by customer | `documents` rows created with `status='PENDING_VERIFICATION'` | Customer uploads via portal; agent downloads, reviews |
| 3 | `CS_MANAGER` (approver) | Approves or rejects KYC | `documents.status` → `VERIFIED` per doc; `signup_requests.kyc_status` → `COMPLETED` | **SoD: approver ≠ collector.** If rejected, returns to step 2 with notes. |
| 4 | `CREDIT_MANAGER` or `CFO` | Sets credit limit | `customers.credit_limit` set; uses customer segment as input | Manual review of risk score, payment terms. SoD: setter ≠ requester (CS_MANAGER who escalated). |
| 5 | `CS_MANAGER` or `COUNTRY_MANAGER` | Final approval | `signup_requests.status` → `APPROVED`; `customers` row created | Customer ID issued, account number generated |
| 6 | System | Generate portal credentials | `contacts` row created with `is_portal_user=1`, password emailed | Welcome email sent via Customer Experience template |
| 7 | Customer | First login | Forces password change via `must_change_password` flow | Once changed, redirects to portal home |

**Current state:** Steps 1, 4, 5 partially functional. Step 2 working (uploads). Step 3 KYC verification UI not built. Step 6 email template merged with Customer Experience tone (per portal-fix-pack PR). Step 7 forced password change flow exists but not consistently enforced.

### 3.2 Order lifecycle (B2B credit customer)

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | Customer (`OPERATOR`) or `CS_AGENT` | Creates order | `orders` row, status `DRAFT` | Selects product, quantity, delivery location, requested date |
| 2 | Customer (`OPERATOR`) or `CS_AGENT` | Submits order | `orders.status` → `SUBMITTED`, `submitted_at` set; `order_status_history` entry written | Triggers approval routing |
| 3 | System | Routes to approver per amount tier | Looks up amount thresholds in approval rules; assigns to appropriate role | **Approval engine not yet built.** Currently routes manually via `assigned_to`. |
| 4 | Approver per tier | Approves or rejects | `orders.status` → `APPROVED` or `REJECTED`; `approved_by`, `approved_at` set | Tier 1 (≤100k KES): `CS_MANAGER`, `FINANCE_OFFICER`, or higher. Tier 2 (≤1M): `CS_MANAGER`, `FINANCE_MANAGER`, `COUNTRY_MANAGER`, or higher. Tier 3 (>1M): `CFO`, `CEO`, or `SUPER_ADMIN`. Credit-limit check happens here. **SoD: approver ≠ creator.** |
| 5 | `SUPPLY_OPS_MANAGER` or `REGIONAL_MANAGER` | Schedules dispatch | `orders.vehicle_id`, `driver_id` assigned; status → `SCHEDULED` | Vehicle and driver assigned based on availability |
| 6 | `SUPPLY_OPS_MANAGER` or `REGIONAL_MANAGER` | Dispatches | Status → `LOADING` → `LOADED` → `IN_TRANSIT`; `dispatched_at` set | Multiple status transitions; history tracked |
| 7 | Driver (`drivers` table, not a system role) | Confirms delivery | Status → `DELIVERED`; `delivered_at`, `delivery_confirmed_by` set | Customer signs delivery note (digital signature future) |
| 8 | `FINANCE_OFFICER` | Generates invoice | `invoices` row created from `orders` + `order_lines`; `oracle_invoice_id` populated | Job queue handles async Oracle ERP sync |
| 9 | Customer | Pays | `payment_uploads` row created; method M-Pesa/Bank/Card | Via portal or M-Pesa Paybill direct |
| 10 | `FINANCE_MANAGER` or `CFO` | Reconciles and refunds (if needed) | Payment approved; credit decremented; invoice → `PAID`. Refunds: **SoD — refunder ≠ original receiver.** | Auto-reconciliation for M-Pesa with matching reference; manual for bank |

**Current state:** Steps 1, 2, 7, 9 partially functional. Step 3 approval routing entirely manual. Step 4 amount-tier checks targeted by v3 RBAC PR. Step 5–6 dispatch UI basic. Step 8 Oracle ERP sync stubbed. Step 10 reconciliation UI not built; SoD enforcement in v3 RBAC PR.

### 3.3 Customer service ticket lifecycle

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | Customer or `CS_AGENT` | Creates ticket | `tickets` row, status `NEW`; channel set | Channels: PORTAL/EMAIL/PHONE/WHATSAPP |
| 2 | System | Auto-assigns | `tickets.assigned_to` set per team rules; SLA targets calculated | Uses `teams.assignment_method` and `business_hours` to compute SLA |
| 3 | `CS_AGENT` | Acknowledges | `acknowledged_at` set; status → `OPEN` | First-touch within `acknowledge_minutes` |
| 4 | `CS_AGENT` | Investigates | `ticket_comments` rows added; `ticket_history` for any field change | Internal comments not visible to customer |
| 5 | `CS_AGENT` | Resolves | Status → `RESOLVED`; `resolved_at`, `resolution_type`, `resolution_summary` set | Customer notified |
| 6 | Customer | Confirms or reopens | If confirmed, `closed_at` set after 24h; if reopened, `reopened_count++` | Auto-close after 24h not yet wired |
| 7 | `CS_MANAGER` | Reviews escalations | If SLA breached, `escalation_level++` and `escalated_to` set | **Escalation engine not yet built (G-003)** |

**Current state:** Steps 1, 3, 4, 5 functional. Step 2 basic auto-assignment works; advanced rules not implemented. Step 6 auto-close not wired. Step 7 SLA breach detection not running.

### 3.4 Password reset (super admin initiated)

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | `SUPER_ADMIN` | Identifies user needing reset | UI lookup of user/contact | Could be staff or customer |
| 2 | `SUPER_ADMIN` | Triggers reset | New temp password generated server-side; `password_hash` updated; `must_change_password=1` | OR magic link / OTP — depends on policy |
| 3 | System | Sends email | Email rendered from `notification_templates` row TPL-PASSWORD-RESET; sent via SMTP | Tone now Customer Experience-grade per portal-fix-pack PR |
| 4 | User | Logs in with temp password | Auth handler validates against hash; checks `must_change_password` | If flag set, redirects to forced password change |
| 5 | User | Sets new password | Old hash overwritten; `must_change_password=0`; `password_changed_at` set | Audit log entry written |

**Current state:** Steps 1–2 functional. Step 3 email rewritten in portal-fix-pack PR (now signs off as Hass Petroleum Customer Experience Team). Step 4–5 forced password change exists but not consistently enforced.

### 3.5 Recurring order automation

| Step | Actor | Action | System touch | Notes |
|---|---|---|---|---|
| 1 | Customer (`OPERATOR`) or `CS_AGENT` | Creates schedule | `recurring_schedule` row; products in `recurring_schedule_lines` | |
| 2 | System (scheduled job) | Computes `next_order_date` | `job_queue` entry of type `RECURRING_ORDER_GEN` runs daily at 02:00 | |
| 3 | System | Generates draft order on next_order_date | Creates `orders` row in `DRAFT` from `recurring_schedule_lines` | |
| 4 | System | If `auto_submit=1`, submits and routes per §3.2 | Triggers approval workflow | If `auto_submit=0`, holds in DRAFT for manual review |

**Current state:** Step 1 functional. Steps 2–4 not yet running on schedule (job_queue runner not deployed).

---

## 4. System modules and ownership

| Module | Backend service | Frontend | Business owner | Engineering owner |
|---|---|---|---|---|
| Authentication | `AuthService.gs` | Login pages, session JS in both dashboards | IT Security | (TBD) |
| Customer Management | `CustomerService.gs` | Staff customer pages, customer portal profile | Customer Experience | (TBD) |
| Orders | `OrderService.gs` | Orders pages on both sides | Operations / SUPPLY_OPS_MANAGER | (TBD) |
| Invoicing & Payments | `InvoiceService.gs`, `PaymentService.gs` | Finance pages, customer portal billing | Finance / FINANCE_MANAGER | (TBD) |
| Tickets | `TicketService.gs` | Tickets pages | Customer Experience / CS_MANAGER | (TBD) |
| KYC & Documents | `DocumentService.gs` | Documents pages | Customer Experience / CS_MANAGER | (TBD) |
| SLA & Reporting | `SLAService.gs` | SLA dashboard | Operations + Audit / CS_MANAGER + INTERNAL_AUDITOR | (TBD) |
| Notifications | `NotificationService.gs`, `EmailService.gs` | Notification preferences | Customer Experience | (TBD) |
| Knowledge Base | `KnowledgeService.gs` | KB pages on both sides | Customer Experience | (TBD) |
| Recurring Orders | `RecurringService.gs` | Recurring schedules pages | Operations | (TBD) |
| Audit Log | `AuditService.gs` | Audit log viewer | Internal Audit / INTERNAL_AUDITOR | (TBD) |
| Integrations (Oracle, M-Pesa, KRA) | `IntegrationService.gs` | (none — backend only) | IT + Finance | (TBD) |
| Settings & Config | `ConfigService.gs` | Settings pages | IT + Operations | (TBD) |
| Approvals | (not yet built) | (not yet built) | Finance + Operations | (TBD) |
| Roles & Permissions | `RoleService.gs` (in v3 RBAC PR) | Admin UI at `?page=roles` (in v3 RBAC PR) | Internal Audit + SUPER_ADMIN | (TBD) |

**Action:** Engineering owners must be assigned per module. Wilbur is currently acting as informal proxy across all modules. This is unsustainable and creates a single point of failure.

---

## 5. Current state vs target state

| Capability | Target | Current | Gap |
|---|---|---|---|
| Database schema | 50 tables, 0 missing columns, 0 FK violations | 50 tables, 0 missing, 0 violations | ✅ Closed |
| Reference data seeded | All lookup tables populated | 11 reference tables, 268 rows | ✅ Closed |
| Sample transactional data | Demonstrable end-to-end records | 31 tables seeded with ≥10 rows each | ✅ Closed |
| Role model | Department-shaped, audit-traceable | 16 staff roles + 4 portal roles | ✅ Closed |
| Staff dashboard | Renders with real data, all modules functional | Renders, most modules functional | Minor: click feedback (in fix-pack PR), skeleton loaders |
| Customer portal login | Customer logs in, sees orders/invoices/tickets, places new order | Login + redirect fixed in portal-fix-pack PR | ✅ Closed |
| Application RBAC enforcement | Service methods permission-guarded; SoD enforced | In progress via v3 RBAC PR | 🟡 In flight (G-004) |
| Approval workflows | Orders, credit limits, refunds route per approval rules | JSON defined, runtime engine not built | 🔴 Major (G-002) |
| SLA enforcement | Tickets auto-escalate on breach; alerts sent | SLA targets calculated; breach detection not running | 🔴 Major (G-003) |
| Integrations live | Oracle ERP, M-Pesa Daraja, KRA eTIMS, SMS gateway connected | Stubbed via `integration_log` only | 🟡 Mid (G-011, G-012, G-013) |
| Audit trail | Every business action logged with actor, before/after, IP, timestamp | `audit_log` schema present; not all services writing to it | 🟡 Mid (G-005) |
| Segregation of Duties | Single user cannot create + approve + dispatch an order | Enforcement in v3 RBAC PR | 🟡 In flight (G-004) |
| MFA enforcement | Required for SUPER_ADMIN, C-Suite, FINANCE_MANAGER; optional for others | Schema supports it; not enforced | 🟡 Mid (G-008) |
| Password policy | Min 12 chars, complexity, history, 90-day rotation | Not enforced at app layer | 🟡 Mid (G-009) |
| Session management | Auto-expire, idle timeout, concurrent session control | Sessions table exists, expiry logic basic | 🟡 Mid (G-010) |
| Customer experience tone | Warm, branded, signed off by Customer Experience team | Many emails IT-toned; password reset rewritten in portal-fix-pack PR | 🟡 In flight (G-006) |
| Mobile UX | Responsive design, touch-friendly, mobile flows | Desktop-first, mobile not tested | 🟢 Low (G-019) — Phase 2 |
| Multi-language | EN, KISW, FR (RW), other regional | EN only | 🟢 Low — Phase 2 |
| Offline mode | Customer can review and queue orders offline | Online-only | 🟢 Low — Phase 3 |

---

## 6. Gap register

Numbered for traceability in PRs and audit reports. Status updated 2026-05-04.

### G-001 — Customer portal login redirect broken (CLOSED)
**Detail:** Successful customer login redirected to bare /exec URL.
**Status:** ✅ Closed via portal-fix-pack PR.

### G-002 — Approval workflow runtime not built (CRITICAL)
**Detail:** `approval_workflows` rows define rules in JSON; no engine reads them. Manual routing via `assigned_to`.
**Risk:** No enforcement of SoD on approvals via routing; v3 RBAC PR enforces SoD at service-method level which mitigates the worst case but doesn't replace a workflow engine.
**Owner:** Engineering + Finance
**Status:** Not started

### G-003 — SLA breach detection not running (CRITICAL)
**Detail:** Ticket SLA targets calculated correctly at creation; nothing checks breach state on schedule.
**Risk:** SLAs unenforced; customer experience degrades silently.
**Owner:** Engineering + Customer Experience
**Status:** Not started

### G-004 — Segregation of Duties not enforced (HIGH — in flight)
**Detail:** Without permission enforcement, a user with broad role grants can drive an order from creation to delivery without oversight.
**Risk:** Fraud risk, control failure for SOX-style audit posture.
**Owner:** Internal Audit + Engineering
**Status:** 🟡 In flight via v3 RBAC PR. Stages 4.2 (scope) and 4.3 (SoD) close the immediate enforcement gap.

### G-005 — Audit log incomplete (HIGH)
**Detail:** `audit_log` schema exists; only some services write to it. No central middleware ensures every mutation is logged.
**Risk:** Audit trail gaps; cannot reconstruct who did what after the fact.
**Owner:** Engineering + Internal Audit
**Status:** Design pending. v3 RBAC PR adds permission-denial logging which partially helps.

### G-006 — Password reset email tone (CLOSED)
**Detail:** Reset email reads as IT-flavoured.
**Status:** ✅ Closed via portal-fix-pack PR. Now signs off as Hass Petroleum Customer Experience Team.

### G-007 — Module/icon click freeze (HIGH — in flight)
**Detail:** Clicks on dashboard icons freeze UI for 2–5s with no feedback.
**Status:** 🟡 In flight via portal-fix-pack PR.

### G-008 — MFA not enforced (HIGH)
**Detail:** `mfa_enabled`, `mfa_secret` columns exist; enforcement depends on user opt-in. SUPER_ADMIN, C-Suite, FINANCE_MANAGER should be required.
**Risk:** Account takeover risk for privileged roles.
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
**Detail:** Documents have `expiry_date`; no scheduled job notifies CS_MANAGER 30 days ahead.
**Risk:** Expired permits cause downstream invoicing failures.
**Owner:** Customer Experience + Engineering
**Status:** Not started

### G-015 — Recurring order job runner not deployed (MID)
**Detail:** Schedules exist; nothing runs to generate orders on `next_order_date`.
**Risk:** Recurring customers don't get orders auto-generated.
**Owner:** Operations + Engineering
**Status:** Not started

### G-016 — Permission matrix not signed off (MID)
**Detail:** §2 above is engineering-implemented, not formally reviewed by business owners.
**Risk:** Permission grants may not match policy intent; segregation gaps possible.
**Owner:** Internal Audit + Business owners (per module)
**Status:** Document review pending. This document is intended as the basis for that review.

### G-017 — Module ownership not assigned (MID)
**Detail:** §4 ownership column is mostly TBD; Wilbur acting as informal proxy.
**Risk:** Decisions delayed; SPOF in business + engineering reviews.
**Owner:** Senior Leadership
**Status:** Pending leadership decision

### G-018 — No data retention policy (MID)
**Detail:** No defined retention for audit_log, sessions, password_resets, integration_log, staff_messages.
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

### G-021 — Critical roles unassigned (HIGH)
**Detail:** As of 2026-05-04, the following roles have 0 users assigned: `CS_MANAGER` (apex functional authority), all C-Suite (`CEO`, `CFO`, `RMD`), `FINANCE_OFFICER`, `REGIONAL_MANAGER`, `VIEWER`. The system cannot operationally function in production without `CS_MANAGER` assigned per country.
**Risk:** Operational paralysis on go-live. Approvals impossible.
**Owner:** Senior Leadership + HR
**Status:** Identified in v3 RBAC PR Stage 6 headcount reconciliation

---

## 7. Pending features

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

## 8. Technical debt

| Item | Detail | Impact |
|---|---|---|
| Apps Script + Turso architecture | Apps Script is a hard ceiling for scalability | Will hit limits at ~100 concurrent users; eventual rebuild on Node.js/Cloudflare Workers likely needed |
| No CI/CD pipeline | Code lives in Apps Script editor; manual sync from GitHub | Hard to enforce code review; redeploy is manual |
| No automated tests | All testing manual | Regressions silent; refactoring risky |
| `EXPECTED_SCHEMA` in `DebugDB.gs` out of sync | Some legitimate columns flagged as "extras" | Audit script noisy; real issues could be missed in noise |
| Hardcoded country list in some services | Adding a new country requires multi-file edit | Slows expansion |
| String literals for status values | `'ACTIVE'`, `'PENDING_APPROVAL'`, etc. scattered across code | Refactoring states is brittle |
| No centralised error handling | Each service catches errors differently | User-facing error messages inconsistent |
| No logging library | Logs scattered across `Logger.log` calls | Cannot search, filter, or alert on logs |
| Mixed naming conventions | Some columns `gps_lat`, others `latitude`; legacy renames pending | Confusion; extraColumns warnings stem from this |
| No environment separation | One Turso DB; same DB serves dev + uat + production | High risk; must split before go-live |
| No secrets management | API tokens in script properties; not rotated | Audit finding; need a secret manager |

---

## 9. Control framework alignment

### 9.1 ISO 27001:2022

| Control area | Annex A reference | Current state | Gap reference |
|---|---|---|---|
| Access control policy | A.5.15 | Roles defined, permissions granted; v3 RBAC PR enforces them; no formal policy document | G-016 |
| Privileged access management | A.8.2 | SUPER_ADMIN role exists; not under additional MFA/approval gate | G-008 |
| Authentication | A.8.5 | Password + optional MFA; password policy unenforced | G-008, G-009 |
| Logging and monitoring | A.8.15 | `audit_log` partial; v3 RBAC PR adds permission-denial logging; no SIEM | G-005 |
| Cryptography | A.8.24 | Passwords bcrypt-hashed; data at rest depends on Turso; no field-level encryption for PII | Partially closed |
| Backup | A.8.13 | Turso automatic backups; no rehearsal | G-020 |
| Information transfer | A.5.14 | TLS enforced via Apps Script; email encryption not enforced | Partially closed |
| Segregation of Duties | A.5.3 | v3 RBAC PR enforces creator ≠ approver and similar SoD checks at service level | G-004 (in flight) |

### 9.2 ISO 42001:2023 (AI Management)

Currently no AI/ML features in the system. Section reserved for future state.

### 9.3 Kenya Data Protection Act 2019

| Requirement | Current state | Gap reference |
|---|---|---|
| Lawful basis documented | Not documented | New gap — to be raised |
| Customer data subject rights flow (access, correct, delete) | No self-service flow built | New gap — to be raised |
| Data retention | No policy defined | G-018 |
| Cross-border transfers (data leaves Kenya?) | Turso hosting region needs verification | New gap — to be raised |
| Breach notification process | No process documented | New gap — to be raised |

### 9.4 Petroleum sector regulations (KE PA 2017, EPRA)

| Requirement | Current state | Notes |
|---|---|---|
| KRA eTIMS integration | Stubbed | G-013 |
| EPRA reporting | Not in scope of CMS | Out of scope |
| Tank measurement / fuel quality controls | Not in scope of CMS | Out of scope (handled by Forecourt Management System) |

### 9.5 Internal control framework (COSO-style)

| Control objective | Implementation | Gap reference |
|---|---|---|
| Authorization controls | v3 RBAC PR enforces permission checks at service-method level; approval workflow engine still missing | G-002, G-004 (in flight) |
| Segregation of duties | v3 RBAC PR enforces creator ≠ approver, refunder ≠ receiver, KYC approver ≠ collector, credit setter ≠ requester | G-004 (in flight) |
| Independent reconciliation | Payment reconciliation manual; no auto vs Oracle | G-011 |
| Audit trail | Partial; v3 RBAC PR improves coverage with permission-denial logging | G-005 |
| Performance review | No SLA reporting in place | G-003 |

---

## 10. Glossary

| Term | Definition |
|---|---|
| **Apps Script** | Google's JavaScript-based serverless platform; hosts the application backend |
| **Turso** | libSQL-based cloud database; the primary data store |
| **CMS** | This system — Customer Management System for Hass Petroleum |
| **KYC** | Know Your Customer — onboarding compliance process |
| **SLA** | Service Level Agreement — time-bound commitments to customers |
| **Affiliate** | A country business unit (e.g. Hass Kenya, Hass Uganda) — `country_code` in DB |
| **Segment** | Customer tier (Bronze/Silver/Gold) determining pricing, SLA, credit terms |
| **eTIMS** | Kenya Revenue Authority electronic tax invoice system |
| **MFA** | Multi-Factor Authentication |
| **RBAC** | Role-Based Access Control |
| **SoD** | Segregation of Duties |
| **RACI** | Responsible / Accountable / Consulted / Informed |
| **CS Manager** | Customer Service and Business Development Manager — `CS_MANAGER` in DB. Highest functional authority within country. |
| **RMD** | Regional Managing Director — C-Suite executive |
| **Apex functional authority** | The highest functional role in the customer service hierarchy. Within each country, `CS_MANAGER`. Group-wide, `CEO`. System-wide, `SUPER_ADMIN`. |
| **Country-bound role** | Role whose `scope = COUNTRY` in `roles` table; can only act on resources in their assigned country |
| **Global-scope role** | Role whose `scope = GLOBAL`; can act across all countries |

---

## Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-05-03 | Wilbur Murikah | Initial draft (12-role model) |
| 0.2 | 2026-05-04 | Wilbur Murikah | Adopted 16-role taxonomy (3 C-Suite + 4 group + 8 country + 1 system); v3 RBAC PR scope; gap register refreshed; G-021 added |

**Next review:** After v3 RBAC PR merges.

---

*End of document.*
