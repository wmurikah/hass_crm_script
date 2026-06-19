# Step 3: approvals inbox unification, self-signup, portal profile/password/MFA

Repo: `wmurikah/hass_crm_script` (Google Apps Script V8, Turso/libSQL). This
change closes APR-1, APR-2, APR-3, AUTH-1, AUTH-3, AUTH-4 and AUTH-5 from
`docs/WORKFLOW_AUDIT.md`. No order approval rules or tiers were changed, `doGet`
keeps `ALLOWALL`, the `/exec` deployment and Cloudflare worker are untouched, the
`processRequest` contract is unchanged, and there are no em dashes in the new
code. The one deliberate session change is the partial pre-MFA enrol case in
Section C, described below.

## Design decision (confirmed): unify on the inline order path

Orders already approve through an inline path (`orders.approve` / `orders.reject`)
that is the single source of truth for an order's status and the only place the
amount tiers and separation-of-duties (SoD) are enforced. The old
`approval_requests` machine had no producer anywhere in the codebase, so the
inbox always read empty and the dashboard "pending approvals" count always read
zero.

Rather than build a second producer and a parallel decision path that can drift,
this work unifies on the inline path:

- the approvals inbox surfaces the real backlog (orders in `SUBMITTED`); and
- approve/reject on an inbox item delegate to the exact same
  `Orders._approveHandler_` / `Orders._rejectHandler_` the inline path uses, so
  there is one decision point and the decision updates the order itself
  (`APPROVED` / `REJECTED`), never just a request row.

`approval_requests` / `approval_workflows` are intentionally left unused; the
order state machine is the driver and `audit_log` is the decision log (the order
handlers already write `ORDER_APPROVED` / `ORDER_REJECTED`). If you would rather
keep `approval_requests` as the single driver and route the inline order approve
through it instead, the direction can flip; this PR takes the unification the task
recommended.

## Introspection results

This environment has no `TURSO_URL` / `TURSO_TOKEN` (they live in Script
Properties, `10_turso_client.gs`), so no live `PRAGMA` could be run from here, the
same constraint noted in `docs/WORKFLOW_AUDIT.md`. The change therefore relies on
columns proven by existing working code and the seed, and uses the repo's
established runtime adaptation pattern (`SchemaIntrospect` and additive
`ALTER TABLE ... ADD COLUMN` guarded by try/catch) for anything optional.

Columns relied on (proven by existing code/seed):

- `orders`: `order_id`, `order_number`, `status`, `total_amount`, `currency_code`,
  `country_code`, `created_by_id`, `submitted_at`, `created_at`, `customer_id`
  (all read by `40_svc_orders.gs`).
- `users`: `user_id`, `email`, `first_name`, `last_name`, `phone`, `status`,
  `country_code`, `password_hash`, `must_change_password`, `mfa_secret`,
  `mfa_enabled` (seed `99_dev_seed.gs`, `40_svc_users.gs`, `20_mfa.gs`).
- `contacts`: `contact_id`, `customer_id`, `first_name`, `last_name`, `email`,
  `phone`, `portal_role`, `is_portal_user`, `password_hash`, `status`
  (`40_svc_contacts.gs`, `40_svc_auth.gs`).
- `signup_requests`: `request_id`, `email`, `first_name`, `last_name`, `phone`,
  `status`, `submitted_at`, `created_at`, `updated_at` (written by `auth.signup`).
- `password_history`, `mfa_challenges`: as used by `20_password.gs` / `20_mfa.gs`.

Best-effort schema adaptation added by this change (never fails the request):

- `signup_requests`: optional review columns `reviewed_by`, `reviewed_at`,
  `decision_reason`, `provisioned_id`, `provisioned_type` are added if missing;
  if the ALTER cannot run, the handler falls back to setting only `status` +
  `updated_at`.
- `contacts.must_change_password` is set best-effort with a fallback that omits it.

No other approval-bearing pending state exists to surface. Credit-limit change
(`customers.setCredit`), customer onboarding (`customers.create` sets `ACTIVE`
immediately) and price overrides are all direct, immediately-applied actions in
this codebase, not gated work items, so there is nothing pending to queue for
them. If a gated path is added later, surface it in the inbox and route it
through its own inline handler the same way.

Reviewer can confirm the live schema with:

```sql
PRAGMA table_info(signup_requests);
PRAGMA table_info(contacts);
PRAGMA table_info(orders);
SELECT status, COUNT(*) FROM orders GROUP BY status;       -- real approval backlog
SELECT status, COUNT(*) FROM signup_requests GROUP BY status;
```

## Section A: unified approvals inbox (APR-1/2/3)

- `40_svc_approvals.gs` rewritten. `approvalRequests.inbox` returns `SUBMITTED`
  orders in the caller's country scope, excluding the caller's own orders (SoD)
  and limited to the tiers the caller can actually approve (the actionable
  queue). `approvalRequests.list` returns the broader `SUBMITTED`/`APPROVED`/
  `REJECTED` backlog for oversight. `get` returns one order shaped as an approval
  item. Each item keeps the fields the UI already used (`request_id` mapped to the
  order id, `entity_type`, `entity_id`, `country_code`, `status`, `created_at`)
  plus `order_number`, `amount`, `currency_code`, `company_name`, the tier as
  `required_approver_role`, and an `actionable` flag.
- `approvalRequests.approve` / `reject` delegate to `Orders._approveHandler_` /
  `Orders._rejectHandler_`. SoD, the SUBMITTED guard, the amount tiers and the
  notifications are therefore enforced once, by the order handlers, unchanged.
- Service keys and permissions are unchanged (`approvalRequests.*`, gated by
  `order.approve_low` / `order.view`).
- `partial_approvals.html` updated to an order-centric table (order, customer,
  amount, country, tier, status) and uses the `actionable` flag to show the
  approve/reject buttons.
- Dashboard and reports "pending approvals" now count `orders WHERE status =
  'SUBMITTED'` in scope (`40_svc_dashboard.gs`, `40_svc_reports.gs`), so the card
  reflects the same backlog the inbox shows instead of a permanent zero.

## Section B: self-signup provisioning (AUTH-1)

New service `40_svc_signups.gs`: `signupRequests.{ list, get, approve, reject }`.

- `approve` provisions the applicant, assigns a role, marks the request
  `APPROVED`, and sends a welcome through the step-1 emit (`Notify.emit`).
  `provision_as` chooses the target:
  - `STAFF` (default): reuses `_usersCreate_`, which validates the role set,
    enforces `role.assign` plus the anti-privilege-escalation grant-subset check,
    hashes the password, sets `must_change_password = 1`, records password history
    and audits.
  - `CONTACT` (portal): requires `customer_id` + `portal_role`, additionally
    enforces `contacts.manage`, creates the contact via `Contacts._createHandler`
    and sets sign-in credentials (`must_change_password = 1`).
  The welcome carries a temporary password and tells the applicant to change it on
  first sign-in. The temp password is single-use in effect because
  `must_change_password` is set.
- `reject` closes the request as `REJECTED` with a reason and notifies the
  applicant. The applicant has no user/contact yet, so the notification recipient
  is the signup request itself; `_resolveRecipientEmail_` gained a `SIGNUP` type
  that reads the email straight from `signup_requests`, keeping rejection notices
  on the same step-1 emit (no second notifier).
- Gating: `list`/`get` need `user.view`; `approve`/`reject` need `user.create`
  (plus `role.assign` / `contacts.manage` enforced by the provisioning paths).
- A minimal admin page `partial_signups.html` (route `signups`, menu item gated by
  `user.create`) makes the review reachable so it is not UI-dead.

The signup-to-verified-user chain now completes: a `PENDING_APPROVAL` row becomes
a real, ACTIVE, role-assigned account (or a closed-with-reason request), and the
applicant is notified.

## Section C: portal profile, password, MFA (AUTH-3/4/5)

- `auth.changePassword` (new handler): session-gated (any authenticated staff or
  portal contact), verifies the current password and enforces the SAME rules as
  the rest of auth via `Password.validatePolicy` (length/complexity plus the
  reuse-history check), writes password history, updates the hash and clears
  `must_change_password`. Not public.
- `users.updateProfile` (new handler): session-gated self-service update of the
  caller's own `first_name` / `last_name` / `phone` (staff or portal); email stays
  read-only (it is the login identity, changed only through the admin path). Not
  public.
- MFA enrolment endpoints aligned to the UI: `auth.mfaEnroll` and
  `auth.mfaVerifyEnroll` are now registered (alongside the prior
  `mfaEnrollStart` / `mfaEnrollVerify`), matching `MfaEnroll.html`.
- No-full-session enrol: `_authMfaEnrollStart_` accepts the `challengeId` minted
  at login (after the password step) as a short-lived partial pre-MFA token bound
  to the user, via `Mfa.enrolFromChallenge`, so a mid-login user enrols without a
  complete session. `_authMfaEnrollVerify_` completes the login by issuing the
  session when there is no full session yet (mirroring `auth.mfaVerify`). The MFA
  mid-login actions are added to `_PUBLIC_ACTIONS_` in both copies of the list;
  they remain safe because each requires a valid, unconsumed, unexpired challenge.
  `auth.changePassword` is deliberately NOT public.
- The login pages now pass the challenge to the server: `_renderPage_` (and the
  `doGet` default) inject `challengeId`, `MfaEnroll.html` sends it to `mfaEnroll`
  and `mfaVerifyEnroll`, and `MfaVerify.html` sends it to `mfaVerify`.
  `MfaEnroll.html` shows the setup key (secret) plus the `otpauth://` link for
  manual entry and deliberately does not send the TOTP secret to any third-party
  QR image service.
- Portal MFA is explicitly disabled (AUTH-5). This is consistent with
  `Mfa.isRequiredFor` returning false for `CUSTOMER` and with the portal login
  path issuing a session directly with no MFA gate, so a portal contact never
  reaches MFA verify in the normal flow. The non-staff branch of `_authMfaVerify_`
  now returns a clean, explicit "not enabled for portal accounts" message instead
  of a "not yet implemented" throw, and never half-blocks a portal login.

## Registered endpoints (new or aligned)

| Service.action | Gating | Notes |
|---|---|---|
| `approvalRequests.inbox/list/get/approve/reject` | order.approve_low / order.view | unchanged keys; now order-backed and delegating |
| `signupRequests.list/get` | user.view | signup review |
| `signupRequests.approve/reject` | user.create (+ role.assign / contacts.manage) | provision or reject |
| `auth.changePassword` | session only (not public) | self-service password change |
| `users.updateProfile` | session only (not public) | self-service profile |
| `auth.mfaEnroll`, `auth.mfaVerifyEnroll` | public (challenge-gated) | aliases matching MfaEnroll.html |
| `auth.mfaVerify` | public (challenge-gated) | now also receives challengeId from MfaVerify.html |

`smokeStep3()` in `99_smoke_test.gs` asserts the wiring (registration, public/
session gating, name alignment, delegation) without needing the database.

## Manual test checklist

Approvals (Section A):
- [ ] As an approver, create an order as another user and submit it; it appears in
      Approvals > My inbox with order number, customer and amount.
- [ ] An order you created yourself does not appear in My inbox (SoD).
- [ ] An order above your tier (mid/high, if you only hold low) shows in "All
      requests" without approve/reject buttons.
- [ ] Approve from the inbox: the order moves to APPROVED (check Orders), an
      `ORDER_APPROVED` audit row is written, and the approve notification is
      enqueued, identical to the inline Orders approve.
- [ ] Reject from the inbox with a reason: the order moves to REJECTED and the
      reason is recorded.
- [ ] Dashboard "Pending Approvals" equals the count of SUBMITTED orders in your
      scope and matches the inbox/all backlog; it is no longer zero when orders
      are pending.

Self-signup (Section B):
- [ ] Create a signup via `auth.signup`; it lands at PENDING_APPROVAL.
- [ ] In Sign-up Requests, approve as STAFF with a role: a user is created
      (ACTIVE, role assigned, must_change_password = 1), the request flips to
      APPROVED, and a welcome notification is enqueued for the new user.
- [ ] Approve another as CONTACT with a customer_id + portal_role: a portal
      contact is created with sign-in credentials and a welcome is enqueued.
- [ ] Reject a request with a reason: status REJECTED, reason stored, and a
      rejection notification is enqueued (resolves the applicant email from
      signup_requests).
- [ ] Re-approving an already-decided request is rejected with a clear message.

Portal profile / password / MFA (Section C):
- [ ] Portal > My Profile: change first/last/phone and Save succeeds; email is
      read-only.
- [ ] Portal > Change Password: wrong current password is rejected; a new
      password that violates policy or repeats a recent one is rejected; a valid
      change succeeds and the next login uses the new password.
- [ ] With `MFA.ENFORCED` on for a staff role with no secret: login routes to the
      enrol page, the setup key/otpauth link load (no third-party QR), entering a
      valid code activates MFA and lands on the dashboard with a session (the
      no-full-session enrol case).
- [ ] Next login for that user routes to MFA verify; a valid code logs in.
- [ ] A portal contact is never sent to MFA and logs in directly; the portal MFA
      verify path returns a clean "not enabled" message rather than an error.

## Safety and boundaries

- Order approval rules and tiers unchanged (the approvals service only reads the
  tier to label/filter and delegates the decision to the order handlers).
- Step-1 emit reused; the only notifier change is a `SIGNUP` recipient-type
  resolver, not a second notifier.
- `processRequest` contract, RBAC and sessions unchanged except the deliberate,
  challenge-gated partial-session MFA enrol case.
- `doGet` keeps `ALLOWALL`; no `/exec`, deployment or worker change.
- Deploy after merge.
