/**
 * 40_svc_signup_request.gs  -  Hass CMS
 *
 * Public, pre-authentication customer self-signup capture (light KYC).
 *
 * signupRequests.create writes ONE pending row to signup_requests so the
 * existing admin Sign-up Requests page (signupRequests.list, which filters on
 * status = 'PENDING_APPROVAL') can review and approve it. This is one of the
 * few actions the dispatcher allows WITHOUT a session, exactly like auth.login;
 * the allowlist entry lives in _PUBLIC_ACTIONS_ (30_dispatcher.gs and the copy
 * in 40_svc_auth.gs).
 *
 * It does NOT create a user, assign a role, or sign anyone in. Provisioning
 * happens only when an admin approves through the existing signupRequests
 * .approve flow in 40_svc_signups.gs, which this file deliberately does not
 * touch. The only table written here is signup_requests.
 *
 * Schema (the live signup_requests columns are authoritative; confirmed by
 * PRAGMA table_info introspection - see migrateSignupStatusDefault and the
 * canonical DDL in 003_signup_requests_schema.sql). The producer maps its inputs
 * onto columns that already exist and creates NO new columns:
 *   request_id (PK), company_name, country_code, tax_pin, registration_number,
 *   first_name, last_name, job_title, email, phone, status, submitted_at.
 * The single contact name is split into first_name/last_name and the contact's
 * role maps onto job_title. status is written as 'PENDING_APPROVAL' explicitly
 * (never relying on the column default) so the row shows under "Pending review".
 * No password is collected at signup, so pending_password_hash stays null;
 * credentials are emailed only after an admin approves. submitted_at is the only
 * timestamp this table carries (there is no created_at / updated_at).
 */

// The nine Hass markets offered on the public form (code to label). Kept in sync
// with the country dropdown in Login.html. Used to validate the submitted code
// server-side before it is written to country_code.
var _SIGNUP_MARKETS_ = {
  KE: 'Kenya', UG: 'Uganda', TZ: 'Tanzania', RW: 'Rwanda', DRC: 'DR Congo',
  SS: 'South Sudan', SO: 'Somalia', ZM: 'Zambia', MW: 'Malawi',
};

// Returned to an unauthenticated visitor, so the wording is deliberately neutral:
// it never confirms or denies that an email already maps to a registered account.
var _SIGNUP_REQ_OK_MSG_ =
  'Thanks. Your request has been received and is pending review. If it is ' +
  'approved you will receive an email with sign-in credentials. No account ' +
  'exists until a reviewer approves this request.';
var _SIGNUP_REQ_DUP_MSG_ =
  'A request for this email is already under review. We will be in touch by ' +
  'email once it has been assessed.';

// Live column set read straight from PRAGMA. Used so the INSERT only ever names
// columns that physically exist, making the write robust to schema variance and
// guaranteeing this producer can never create a column. It never ALTERs.
function _signupReqLiveColumns_() {
  try {
    var rows = TursoClient.select('PRAGMA table_info(signup_requests)');
    return rows.map(function (r) { return String(r.name); });
  } catch (_) {
    return [];
  }
}

function _signupReqEmailValid_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Basic, IP-free rate limit feasible inside a google.script.run web app (the
// client IP is not exposed to the handler). A short per-email cooldown blunts a
// rapid double-submit or retry loop; the durable case is covered by the DB
// dedupe below. Best-effort: a cache hiccup never blocks a real submission.
function _signupReqRateLimited_(emailLc) {
  try {
    var cache = CacheService.getScriptCache();
    var key   = 'signupreq:cooldown:' + emailLc;
    if (cache.get(key)) return true;
    cache.put(key, '1', 30);
  } catch (_) {}
  return false;
}

/**
 * signupRequests.create  -  public, no session required.
 *
 * Validates the light-KYC payload server-side, dedupes by pending email without
 * account enumeration, rejects honeypot-filled (bot) submissions, and writes a
 * single PENDING_APPROVAL row to signup_requests. Returns a neutral confirmation.
 */
function _signupRequestCreate_(ctx, params) {
  params = params || {};

  // 1) Honeypot. A real person never sees or fills this field; a bot that
  // auto-fills every input trips it. Drop the submission silently and return the
  // normal confirmation shape so the bot gets no signal that it was caught.
  var honeypot = String(params.website || params.contact_website || '').trim();
  if (honeypot) {
    try {
      Audit.log({ actor: '', action: 'SIGNUP_REQUESTED', entity: 'signup_requests',
                  entityId: '', metadata: { rejected: 'honeypot', source: 'login_self_signup' } });
    } catch (_) {}
    return { received: true, duplicate: false, message: _SIGNUP_REQ_OK_MSG_ };
  }

  // 2) Collect + trim the required identifying fields.
  var companyName = String(params.company_name || params.companyName || '').trim();
  var country     = String(params.country_code || params.country || '').trim().toUpperCase();
  var taxPin      = String(params.tax_pin || params.taxPin || '').trim();
  var regNumber   = String(params.registration_number || params.registrationNumber || '').trim();
  var contactName = String(params.contact_name || params.contactName || '').trim();
  var contactRole = String(params.contact_role || params.contactRole || params.role || '').trim();
  var email       = String(params.email || '').trim().toLowerCase();
  var phone       = String(params.phone || '').trim();
  var consent     = params.consent === true || params.consent === 'true' ||
                    params.consent === 1 || params.consent === '1' || params.consent === 'on';

  // 3) Server-side validation (mirrors the client, never trusts it). Consent is
  // required as a gate even though the real schema has no column to persist it.
  if (!companyName) throw new Errors.Validation('Company or trading name is required.');
  if (!country || !_SIGNUP_MARKETS_[country]) throw new Errors.Validation('Select a valid country or market.');
  if (!taxPin) throw new Errors.Validation('Tax PIN or VAT number is required.');
  if (!regNumber) throw new Errors.Validation('Business registration number is required.');
  if (!contactName) throw new Errors.Validation('Contact person name is required.');
  if (!contactRole) throw new Errors.Validation('Role is required.');
  if (!email) throw new Errors.Validation('Work email is required.');
  if (!_signupReqEmailValid_(email)) throw new Errors.Validation('Enter a valid work email address.');
  if (!phone) throw new Errors.Validation('Phone number is required.');
  if (!consent) throw new Errors.Validation('Please confirm you are authorised and consent to processing.');

  // 4) Basic rate limit (per-email cooldown). Placed after validation so a human
  // correcting a validation error is never throttled.
  if (_signupReqRateLimited_(email)) {
    return { received: true, duplicate: true, message: _SIGNUP_REQ_DUP_MSG_ };
  }

  // 5) Dedupe by email WITHOUT account enumeration. We look ONLY at pending
  // signup_requests, never at users/contacts, so the response can never reveal
  // whether the email already belongs to a registered account.
  var pending = TursoClient.select(
    "SELECT request_id FROM signup_requests WHERE LOWER(email) = ? AND status = 'PENDING_APPROVAL' LIMIT 1",
    [email]
  );
  if (pending.length) {
    return { received: true, duplicate: true, message: _SIGNUP_REQ_DUP_MSG_ };
  }

  // 6) Build the row on the REAL columns only. Split the single contact name into
  // first/last so the admin list (renders first_name + last_name) and the approve
  // flow (reads req.first_name / req.last_name) keep working; the role maps onto
  // job_title. No password is collected, so pending_password_hash stays null, and
  // kyc_status is left to its own default (a separate post-approval lifecycle).
  var nameParts = contactName.split(/\s+/);
  var firstName = nameParts.shift() || contactName;
  var lastName  = nameParts.join(' ');

  var candidate = {
    request_id:          uuidv4(),
    company_name:        companyName,
    country_code:        country,
    tax_pin:             taxPin,
    registration_number: regNumber,
    first_name:          firstName,
    last_name:           lastName,
    job_title:           contactRole,
    email:               email,
    phone:               phone,
    status:              'PENDING_APPROVAL',
    submitted_at:        nowIso(),
  };

  // Insert only the columns the table physically has, preserving each column's
  // real on-disk spelling. If introspection comes back empty (a transient read
  // issue), fall back to the full candidate, the same posture auth.signup takes
  // with its fixed column set. Either way no column is ever created here.
  var live = _signupReqLiveColumns_();
  var row;
  if (live.length) {
    var liveLc = {};
    live.forEach(function (c) { liveLc[c.toLowerCase()] = c; });
    row = {};
    Object.keys(candidate).forEach(function (k) {
      var real = liveLc[k.toLowerCase()];
      if (real) row[real] = candidate[k];
    });
    // request_id and status anchor a valid pending row even on a sparse schema.
    if (!row.request_id) row.request_id = candidate.request_id;
    if (liveLc['status'] && !row[liveLc['status']]) row[liveLc['status']] = 'PENDING_APPROVAL';
  } else {
    row = candidate;
  }

  Repo.create('signup_requests', row);

  // Audit without leaking new-vs-returning applicant. SIGNUP_REQUESTED is on the
  // AggCache no-bump list, so it does not churn the dashboard aggregate cache.
  try {
    Audit.log({
      actor: '', action: 'SIGNUP_REQUESTED', entity: 'signup_requests',
      entityId: row.request_id, after: { status: 'PENDING_APPROVAL', country_code: country },
      countryCode: country, metadata: { source: 'login_self_signup', company: companyName },
    });
  } catch (_) {}

  return { received: true, duplicate: false, message: _SIGNUP_REQ_OK_MSG_ };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerSignupRequest_() {
  // Public, pre-auth create. permission:null keeps RBAC out of the path; the
  // dispatcher allows it pre-session via _PUBLIC_ACTIONS_ ('signupRequests
  // .create'). Registering 'create' under the existing signupRequests service
  // sits alongside list/get/approve/reject without touching that file.
  register({ service: 'signupRequests', action: 'create', permission: null, handler: _signupRequestCreate_ });
})();
