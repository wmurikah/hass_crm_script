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

The Turso credentials live in Apps Script Script Properties (`TURSO_URL`,
`TURSO_TOKEN`) and are only reachable from the deployed GAS runtime, so the live
`PRAGMA table_info(signup_requests)` runs **inside the new code at request time**
(`_signupReqLiveColumns_`), exactly like the existing `SchemaIntrospect` and the
additive ALTER pattern in `40_svc_signups.gs`. The column and value names below were
confirmed by cross-referencing every piece of code that already reads or writes the
table.

Base columns (from `auth.signup`, `signupRequests.list`, `signupRequests.approve`,
and the notifications emit):

- `request_id` (PK, `TABLES.signup_requests` / `PK.signup_requests = request_id`)
- `email`, `first_name`, `last_name`, `phone`
- `status`, `submitted_at`, `created_at`, `updated_at`
- review/bookkeeping columns added by `_signupEnsureColumns_`: `reviewed_by`,
  `reviewed_at`, `decision_reason`, `provisioned_id`, `provisioned_type`

Pending status value (confirmed): **`PENDING_APPROVAL`**. This is the exact value
`signupRequests.list` filters on by default (`40_svc_signups.gs`), so a new row shows
under "Pending review" in the admin page.

### Columns this feature adds (additive, idempotent)

Added through the same guarded `ALTER TABLE signup_requests ADD COLUMN ...` helper
used elsewhere (a column that already exists makes the ALTER a no-op):

| Column | Holds |
| --- | --- |
| `company_name` | Company or trading name |
| `country_code` | Market code, one of `KE UG TZ RW DRC SS SO ZM MW` |
| `tax_pin` | Tax PIN or VAT number |
| `registration_number` | Business registration number |
| `contact_name` | Contact person full name (also split into `first_name`/`last_name`) |
| `contact_role` | Contact person role/title |
| `metadata` | JSON: optional fields + consent record |

The single contact name is also split into the existing `first_name`/`last_name`
columns so the admin list (which renders `first_name + last_name`) and the approve
flow (which reads `req.first_name` / `req.last_name`) keep working unchanged.

### Metadata JSON shape

```json
{
  "products_of_interest": ["AGO", "LPG"],
  "notes": "approx 30,000 L/month, credit terms preferred",
  "market_label": "Kenya",
  "consent": {
    "given": true,
    "version": "self-signup-v1-2026-06",
    "accepted_at": "2026-06-19T08:30:00.000Z",
    "statement": "Authorised to request an account for the business and consents to processing of the submitted details for verification."
  },
  "source": "login_self_signup"
}
```

Consent is captured as a flag, a version string, and a timestamp, per requirement.
Bump `_SIGNUP_CONSENT_VERSION_` whenever the consent wording or the linked privacy
notice changes.

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
5. **Consent recorded**: inspect the new row's `metadata` JSON and confirm
   `consent.given = true`, a `version`, and an `accepted_at` timestamp; confirm the
   first-class columns (`company_name`, `country_code`, `tax_pin`,
   `registration_number`, `contact_name`, `contact_role`) are populated.
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
