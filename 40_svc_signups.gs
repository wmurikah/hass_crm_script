/**
 * 40_svc_signups.gs  -  Hass CMS rebuild  (AUTH-1)
 *
 * Self-signup review and provisioning.
 *
 * auth.signup (40_svc_auth.gs) writes a signup_requests row at PENDING_APPROVAL
 * and stops there. This service is the missing consumer: an admin reviews the
 * request and either provisions the applicant (a staff user OR a portal contact),
 * assigns a role, marks the request APPROVED and emails a welcome; or rejects it
 * with a reason and emails the outcome. Either way the request leaves
 * PENDING_APPROVAL, so the signup-to-verified-user chain completes.
 *
 *   signupRequests.{ list, get, approve, reject }
 *
 * Gating: list/get need user.view; approve/reject need user.create (provisioning
 * a user). The STAFF path reuses _usersCreate_ which additionally enforces
 * role.assign and the anti-privilege-escalation grant check; the CONTACT path
 * additionally requires contacts.manage. So a reviewer can only grant what they
 * are themselves entitled to grant.
 *
 * Email goes directly through the Graph path (EmailInteg.send), not the step-1
 * notification queue, so the welcome/rejection is delivered as part of the action
 * and does not depend on the notifications flush job. EmailInteg.send has its own
 * MailApp fallback and is best-effort here: provisioning and the status change are
 * committed first, so a mail hiccup never undoes an approval or a rejection.
 */

// The review columns this service writes (status, approved_by, approved_at,
// customer_id, rejection_reason, rejected_at) all already exist on the live
// signup_requests table, so there is nothing to ALTER. The live columns are
// authoritative; see 003_signup_requests_schema.sql for the canonical DDL.

// A temporary password that always satisfies the password policy (upper, lower,
// digit, special, length). Used when the reviewer does not set an explicit one.
function _signupTempPassword_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  var pw = 'Aa1!';
  for (var i = 0; i < 12; i++) pw += chars.charAt(Math.floor(Math.random() * chars.length));
  return pw;
}

function _signupActor_(ctx) {
  return (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';
}

// Minimal HTML escape for values interpolated into the HTML email body. The
// applicant email comes from the (untrusted) signup form and the reason from the
// reviewer, so escape both before they land in markup.
function _signupEsc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── list ──────────────────────────────────────────────────────────────────────

function _signupsList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.view');
  var sql  = 'SELECT * FROM signup_requests WHERE 1=1';
  var args = [];
  // Default to the actionable queue; allow an explicit status filter.
  if (params.status) { sql += ' AND status = ?'; args.push(String(params.status).toUpperCase()); }
  else               { sql += " AND status = 'PENDING_APPROVAL'"; }
  // Newest first, paginated. submitted_at is the table's only timestamp (there is
  // no created_at). limit/offset are integer-coerced (never interpolated from raw
  // input) so the LIMIT/OFFSET clause cannot be injected.
  var limit  = Math.min(Math.max(parseInt(params.limit, 10) || 100, 1), 500);
  var offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  sql += ' ORDER BY submitted_at DESC LIMIT ' + limit + ' OFFSET ' + offset;
  return TursoClient.select(sql, args);
}

// ── get ───────────────────────────────────────────────────────────────────────

function _signupsGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.view');
  var requestId = String(params.requestId || params.request_id || '');
  if (!requestId) throw new Errors.Validation('requestId required.');
  var rows = TursoClient.select('SELECT * FROM signup_requests WHERE request_id = ? LIMIT 1', [requestId]);
  if (!rows.length) throw new Errors.NotFound('Signup request not found.');
  return rows[0];
}

// ── approve: provision + assign role + mark APPROVED + welcome ─────────────────

function _signupsApprove_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.create');

  var requestId = String(params.requestId || params.request_id || '');
  if (!requestId) throw new Errors.Validation('requestId required.');

  var rows = TursoClient.select('SELECT * FROM signup_requests WHERE request_id = ? LIMIT 1', [requestId]);
  if (!rows.length) throw new Errors.NotFound('Signup request not found.');
  var req = rows[0];
  if (String(req.status || '').toUpperCase() !== 'PENDING_APPROVAL') {
    throw new Errors.Validation('Signup request is not pending approval.');
  }

  var email = String(req.email || '').trim().toLowerCase();
  if (!email) throw new Errors.Validation('Signup request has no email to provision.');
  if (_findUserByEmail_(email))    throw new Errors.Validation('A staff user with this email already exists.');
  if (_findContactByEmail_(email)) throw new Errors.Validation('A portal contact with this email already exists.');

  var provisionAs = String(params.provision_as || params.provisionAs || 'STAFF').trim().toUpperCase();
  if (provisionAs === 'PORTAL') provisionAs = 'CONTACT';

  var tempPassword = String(params.password || '').trim() || _signupTempPassword_();
  // Same password rules as the rest of auth for this credential-set path. The
  // generated temp password always passes; a reviewer-supplied one is enforced
  // here before anything is provisioned (the STAFF path also re-checks inside
  // _usersCreate_). No userId yet, so this is the length/complexity check.
  Password.validatePolicy(tempPassword);
  var actor        = _signupActor_(ctx);
  var provisioned  = { id: '', type: provisionAs };
  // Captured for the portal-contact path so the approval can link the request to
  // the customer via signup_requests.customer_id.
  var customerId   = '';

  if (provisionAs === 'STAFF') {
    // Reuse the canonical staff-create path: it validates the role set, enforces
    // role.assign + the grant-subset check, hashes the password, sets
    // must_change_password=1, records password history and audits USER_CREATED.
    var created = _usersCreate_(ctx, {
      email:       email,
      firstName:   req.first_name || '',
      lastName:    req.last_name  || '',
      roleCodes:   params.roleCodes || params.role || params.roleCode || 'CS_AGENT',
      countryCode: params.country_code || params.countryCode || null,
      password:    tempPassword,
    });
    provisioned.id = created.userId;

  } else if (provisionAs === 'CONTACT') {
    // Portal contact: belongs to a customer and carries a portal_role.
    Rbac.requirePermission(ctx.session, 'contacts.manage');
    customerId = String(params.customer_id || params.customerId || '').trim();
    var portalRole = String(params.portal_role || params.portalRole || '').trim();
    if (!customerId) throw new Errors.Validation('customer_id is required to provision a portal contact.');
    if (!portalRole) throw new Errors.Validation('portal_role is required to provision a portal contact.');

    var contact = Contacts._createHandler(ctx, {
      customer_id:    customerId,
      first_name:     req.first_name || '',
      last_name:      req.last_name  || '',
      email:          email,
      phone:          req.phone || '',
      portal_role:    portalRole,
      is_portal_user: 1,
    });
    provisioned.id = contact.contact_id;

    // Give the contact sign-in credentials so the portal login works. password
    // columns are set best-effort to tolerate schema variance.
    var hash = Password.hash(tempPassword);
    try {
      TursoClient.write(
        'UPDATE contacts SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE contact_id = ?',
        [hash, nowIso(), contact.contact_id]
      );
    } catch (_) {
      try {
        TursoClient.write(
          'UPDATE contacts SET password_hash = ?, updated_at = ? WHERE contact_id = ?',
          [hash, nowIso(), contact.contact_id]
        );
      } catch (__) {}
    }

  } else {
    throw new Errors.Validation('provision_as must be STAFF or CONTACT.');
  }

  // Mark the request APPROVED on the real review columns: status, approved_by,
  // approved_at. For a portal contact, also set customer_id to link the request
  // to the customer. (There are no reviewed_*/provisioned_* columns; who/what was
  // provisioned is recorded in the SIGNUP_APPROVED audit entry below.)
  var now = nowIso();
  if (provisionAs === 'CONTACT') {
    TursoClient.write(
      'UPDATE signup_requests SET status = ?, approved_by = ?, approved_at = ?, customer_id = ? WHERE request_id = ?',
      ['APPROVED', actor, now, customerId, requestId]
    );
  } else {
    TursoClient.write(
      'UPDATE signup_requests SET status = ?, approved_by = ?, approved_at = ? WHERE request_id = ?',
      ['APPROVED', actor, now, requestId]
    );
  }

  Audit.log({
    actor: actor, action: 'SIGNUP_APPROVED', entity: 'signup_requests', entityId: requestId,
    before: { status: 'PENDING_APPROVAL' },
    // provisioned is audit context (what was created), not a signup_requests column.
    after:  { status: 'APPROVED', provisioned: { type: provisioned.type, id: provisioned.id } },
  });

  // Welcome the applicant directly via the Graph email path (EmailInteg.send), so
  // delivery is part of this action and does not depend on the step-1 notification
  // queue/flush job. Best-effort: the user/contact is provisioned and the request
  // is already marked APPROVED above, so a mail failure must not undo the approval.
  // The temp password is effectively single-use because must_change_password is
  // set, so it has to be changed on first sign-in.
  var subject  = 'Your Hass CMS account is ready';
  var textBody =
    'Welcome to Hass CMS. Your account has been approved.\n\n' +
    'Sign in with this email (' + email + ') and the temporary password below, ' +
    'then set a new password from your profile:\n\n' +
    'Temporary password: ' + tempPassword + '\n\n' +
    'For your security, change this password as soon as you sign in.';
  var htmlBody =
    '<p>Welcome to Hass CMS. Your account has been approved.</p>' +
    '<p>Sign in with this email (<strong>' + _signupEsc_(email) + '</strong>) and the ' +
    'temporary password below, then set a new password from your profile:</p>' +
    '<p>Temporary password: <strong>' + _signupEsc_(tempPassword) + '</strong></p>' +
    '<p>For your security, change this password as soon as you sign in.</p>';
  try {
    EmailInteg.send(email, subject, htmlBody, textBody);
  } catch (mailErr) {
    try { Log.warn({ service: 'svc_signups', action: 'approve', msg: 'welcome email failed: ' + mailErr.message }); } catch (_) {}
  }

  return { success: true, status: 'APPROVED', provisioned: provisioned };
}

// ── reject: close with a reason + notify the applicant ────────────────────────

function _signupsReject_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.create');

  var requestId = String(params.requestId || params.request_id || '');
  var reason    = String(params.reason || '').trim();
  if (!requestId) throw new Errors.Validation('requestId required.');
  if (!reason)    throw new Errors.Validation('reason required.');

  var rows = TursoClient.select('SELECT * FROM signup_requests WHERE request_id = ? LIMIT 1', [requestId]);
  if (!rows.length) throw new Errors.NotFound('Signup request not found.');
  var req = rows[0];
  if (String(req.status || '').toUpperCase() !== 'PENDING_APPROVAL') {
    throw new Errors.Validation('Signup request is not pending approval.');
  }

  var actor = _signupActor_(ctx);
  var now   = nowIso();
  // Reject on the real review columns: status, rejection_reason, rejected_at.
  // There is no rejected_by column; the rejecting user is captured as the actor
  // on the SIGNUP_REJECTED audit entry below.
  TursoClient.write(
    'UPDATE signup_requests SET status = ?, rejection_reason = ?, rejected_at = ? WHERE request_id = ?',
    ['REJECTED', reason, now, requestId]
  );

  Audit.log({
    actor: actor, action: 'SIGNUP_REJECTED', entity: 'signup_requests', entityId: requestId,
    before: { status: 'PENDING_APPROVAL' }, after: { status: 'REJECTED', reason: reason },
  });

  // Email the outcome directly via the Graph email path (EmailInteg.send). The
  // applicant has no user/contact record yet, so we send to the email captured on
  // the signup request itself. Best-effort: the request is already REJECTED above,
  // so a mail failure must not reopen it.
  var rejectTo = String(req.email || '').trim();
  if (rejectTo) {
    var subject  = 'Update on your Hass CMS sign-up';
    var textBody =
      'Thank you for your interest in Hass CMS. After review, your sign-up request ' +
      'could not be approved at this time.\n\nReason: ' + reason;
    var htmlBody =
      '<p>Thank you for your interest in Hass CMS. After review, your sign-up ' +
      'request could not be approved at this time.</p>' +
      '<p>Reason: ' + _signupEsc_(reason) + '</p>';
    try {
      EmailInteg.send(rejectTo, subject, htmlBody, textBody);
    } catch (mailErr) {
      try { Log.warn({ service: 'svc_signups', action: 'reject', msg: 'rejection email failed: ' + mailErr.message }); } catch (_) {}
    }
  }

  return { success: true, status: 'REJECTED' };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerSignups_() {
  register({ service: 'signupRequests', action: 'list',    permission: 'user.view',   handler: _signupsList_ });
  register({ service: 'signupRequests', action: 'get',     permission: 'user.view',   handler: _signupsGet_ });
  register({ service: 'signupRequests', action: 'approve', permission: 'user.create', handler: _signupsApprove_ });
  register({ service: 'signupRequests', action: 'reject',  permission: 'user.create', handler: _signupsReject_ });
})();
