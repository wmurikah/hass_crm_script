# Customer self-signup (login page)

A public, pre-authentication entry point on the login page that lets a prospective
customer request an account. It opens a light-KYC modal and submits one **pending**
row to `signup_requests`, which the existing admin Sign-up Requests page reviews and
approves. No account is created, no role is assigned, and nobody is logged in at
signup. Provisioning happens only when an admin approves through the existing
`signupRequests.approve` flow, which this change does not touch.

## What was added

| Area | File | Change |
| --- | --- | --- |
| Public create action | `40_svc_signup_request.gs` (new) | `signupRequests.create` handler + registration |
| Pre-auth allowlist | `30_dispatcher.gs`, `40_svc_auth.gs` | `signupRequests.create` added to both `_PUBLIC_ACTIONS_` copies |
| Login affordance + modal | `Login.html` | Gold "Request an account" link, brand-styled accessible modal, submit script |

The login form, its layout, and its flow are unchanged. The new styles are scoped
under fresh `.hl-signup*` / `.hl-modal*` classes and the modal script is a separate,
self-contained block that never touches the login handler.

## Introspection results (`signup_requests`)

The live columns are authoritative. Run `smokeSignupSchema()` from the Apps Script
IDE to print `PRAGMA table_info(signup_requests)` (the credentials live in Script
Properties `TURSO_URL` / `TURSO_TOKEN` and are reachable only from the deployed GAS
runtime); the same introspection backs `migrateSignupStatusDefault()`. The canonical
DDL is in `003_signup_requests_schema.sql`.

Confirmed columns:

- `request_id` (PK, `TABLES.signup_requests` / `PK.signup_requests = request_id`)
- identity / KYC: `company_name`, `first_name`, `last_name`, `email`, `phone`,
  `job_title`, `account_type`, `customer_id`, `country_code`, `tax_pin`,
  `registration_number`, `certificate_of_incorporation`, `dealer_code`,
  `station_name`, `card_number`, `kra_pin`, `account_number`, `company_address`
- credential placeholder: `pending_password_hash` (left null at signup)
- lifecycle: `kyc_status` (default `PENDING`), `status` (default `PENDING_APPROVAL`)
- review: `approved_by`, `approved_at`, `rejection_reason`, `rejected_at`
- timestamp: `submitted_at` (default `datetime('now')`)

There is **no** `created_at`, `updated_at`, `reviewed_by`, `reviewed_at`,
`decision_reason`, `provisioned_id`, `provisioned_type`, `contact_name`,
`contact_role`, or `metadata` column. PR #160 assumed several of those; this PR
repoints every read/write onto the real columns and removes the best-effort
`ALTER TABLE ... ADD COLUMN` helpers so no duplicate column can ever be created.

Pending status value: **`PENDING_APPROVAL`**. This is the value `signupRequests.list`
filters on by default (`40_svc_signups.gs`), so a new row shows under "Pending
review". Both producers (`auth.signup`, `signupRequests.create`) write it explicitly,
and the column default is moved from `PENDING` to `PENDING_APPROVAL` by
`migrateSignupStatusDefault()` so the default agrees with the queue.

### Columns the producer writes (all already exist; nothing is created)

`signupRequests.create` maps its inputs onto existing columns only:

| Input | Column |
| --- | --- |
| Company or trading name | `company_name` |
| Country/market (`KE UG TZ RW DRC SS SO ZM MW`) | `country_code` |
| Tax PIN or VAT number | `tax_pin` |
| Business registration number | `registration_number` |
| Contact person name | split into `first_name` / `last_name` |
| Role | `job_title` |
| Work email | `email` |
| Phone | `phone` |
| (constant) | `status` = `PENDING_APPROVAL` |
| (constant) | `submitted_at` |

The INSERT names only columns that physically exist (`_signupReqLiveColumns_`
filters the candidate against `PRAGMA table_info`), so the producer can never add a
column. No password is collected, so `pending_password_hash` stays null, and
`kyc_status` is left to its own default.

### Consent, products, notes

Consent remains a required gate (validated client- and server-side), but the live
schema has no column to persist it, so it is not stored. The optional "products of
interest" and "notes" fields likewise have no column and are not persisted. The
modal still collects them (the modal is unchanged apart from the scroll fix); the
server simply ignores anything without a real column.

## Form fields (light KYC only)

- **Required**: company or trading name, country/market (the nine markets), tax PIN
  or VAT number, business registration number, contact person name, role, work email
  (their future login), phone, and a consent checkbox linked to the privacy notice.
- **Optional**: products of interest (AGO, PMS, LPG, lubricants) and a free-text notes
  field.

No documents, director details, or bank details are collected here; those belong to
the post-approval onboarding/KYC flow.

## Safety behaviours

- **Public, no session**: `signupRequests.create` is on `_PUBLIC_ACTIONS_` (both
  copies), so `dispatch()` runs it without a session, exactly like `auth.login`. RBAC
  is out of the path (`permission: null`).
- **Server-side validation**: every required field is validated server-side in
  addition to the client; the country must be one of the nine codes; the email must
  match a basic shape; consent must be true.
- **Honeypot**: a visually hidden `website` field. A filled value is dropped silently
  (no row written) and returns the normal confirmation shape, so a bot gets no signal
  it was caught.
- **Dedupe without enumeration**: a pending request for the same email returns a
  friendly "already under review" message. The check looks **only** at pending
  `signup_requests`, never at `users`/`contacts`, so the response can never reveal
  whether the email already belongs to a registered account.
- **Basic rate limit**: a 30-second per-email cooldown via `CacheService` blunts rapid
  double-submits. (Client IP is not exposed to a `google.script.run` handler, so
  IP-based limiting is not feasible; the durable case is covered by the DB dedupe.)
- **Writes only `signup_requests`**: no user is created, no role assigned, no session
  issued.

## Why a native modal (not Bootstrap)

The app does not load Bootstrap anywhere; the login page is fully self-contained and
the rest of the app hand-rolls its own `.modal`. The signup modal is therefore built
in the login page's own navy/gold design language (Outfit + Fraunces), and meets the
accessibility intent directly: real `<label>`s, `role="dialog"` + `aria-modal`, focus
trapping, escape-to-close, backdrop/Cancel close, and a fully responsive layout.

## Manual test checklist

1. **Affordance visible, login unchanged**: load the login page. A gold "New customer?
   Request an account" link sits below Sign in. The login form, fields, and Sign in
   button are visually and behaviourally unchanged.
2. **Modal opens / accessible**: click the link. The modal opens, focus lands in the
   first field. Tab cycles within the dialog (focus trap). `Esc`, the X, Cancel, and a
   backdrop click all close it and return focus to the link.
3. **Required validation**: submit empty. The browser flags the required fields.
   Uncheck consent and submit: a clear inline error appears. Server-side, omit a field
   in a direct `processRequest` call and confirm it is rejected too.
4. **Happy path creates a pending row**: fill all required fields (pick a market,
   optionally tick products/notes), accept consent, submit. The modal shows the
   "Request received" confirmation explaining credentials arrive by email after review.
   In the admin app, open Sign-up Requests, filter Pending review, and confirm the new
   row shows (email, name, phone, status PENDING_APPROVAL, submitted time).
5. **Real columns populated**: inspect the new row and confirm the existing columns
   `company_name`, `country_code`, `tax_pin`, `registration_number`, `first_name`,
   `last_name`, and `job_title` (the contact role) are populated, `status` is
   `PENDING_APPROVAL`, and `pending_password_hash` is null. (Consent is a required
   gate but has no column to persist; products/notes have no column either.)
5b. **Approve/reject write the real columns**: approve a request and confirm
   `status='APPROVED'`, `approved_by`, and `approved_at` are set (and `customer_id`
   when provisioning a portal contact); reject another and confirm `status='REJECTED'`,
   `rejection_reason`, and `rejected_at` are set. Confirm no `reviewed_*`,
   `decision_reason`, or `provisioned_*` columns were added (`smokeSignupSchema()`
   asserts this automatically).
6. **Duplicate handled gracefully**: submit again with the same email. A quiet,
   specific "already under review" message shows and the form stays usable. No second
   row is created. The message never indicates whether a real account exists.
7. **Honeypot rejects bots**: in dev tools set `#su_website` to any value and submit
   (or POST `website` directly). No row is created; the response still looks like a
   normal success.
8. **No account / no login at signup**: confirm no `users` or `contacts` row is
   created and no session is issued by the submit. Credentials only ever arrive after
   an admin approves via the existing flow.
9. **Boundaries intact**: confirm `doGet` still returns `ALLOWALL`, the `/exec` URL and
   worker are unchanged, and only `signup_requests` was written.

## Going live

This is code only. To serve it on the live `/exec` URL: pull the code into the Apps
Script project, then **New version** and **Deploy** (run `publishToLiveUrl` in
`Publish.gs`, which creates a new version and repoints the existing deployment so the
URL never changes).
