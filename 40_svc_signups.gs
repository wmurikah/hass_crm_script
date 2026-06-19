/**
 * 40_svc_signups.gs  -  Hass CMS rebuild  (AUTH-1)
 *
 * Self-signup review and provisioning.
 *
 * auth.signup (40_svc_auth.gs) writes a signup_requests row at PENDING_APPROVAL
 * and stops there. This service is the missing consumer: an admin reviews the
 * request and either provisions the applicant (a staff user OR a portal contact),
 * assigns a role, marks the request APPROVED and sends a welcome through the
 * step-1 notification emit; or rejects it with a reason and notifies the
 * applicant. Either way the request leaves PENDING_APPROVAL, so the
 * signup-to-verified-user chain completes.
 *
 *   signupRequests.{ list, get, approve, reject }
 *
 * Gating: list/get need user.view; approve/reject need user.create (provisioning
 * a user). The STAFF path reuses _usersCreate_ which additionally enforces
 * role.assign and the anti-privilege-escalation grant check; the CONTACT path
 * additionally requires contacts.manage. So a reviewer can only grant what they
 * are themselves entitled to grant.
 *
 * Notifications reuse the step-1 emit (Notify.emit) only; no second notifier is
 * built here.
 */

var _SIGNUP_COLS_READY_ = false;

// Best-effort: make sure the optional review/bookkeeping columns exist. Mirrors
// the additive ALTER pattern used elsewhere (contacts.portal_role,
// notifications.attempts). A column that already exists makes the ALTER a no-op.
function _signupEnsureColumns_() {
  if (_SIGNUP_COLS_READY_) return;
  [
    'reviewed_by TEXT',
    'reviewed_at TEXT',
    'decision_reason TEXT',
    'provisioned_id TEXT',
    'provisioned_type TEXT',
  ].forEach(function (def) {
    try { TursoClient.write('ALTER TABLE signup_requests ADD COLUMN ' + def); } catch (_) {}
  });
  _SIGNUP_COLS_READY_ = true;
}

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

// ── list ──────────────────────────────────────────────────────────────────────

function _signupsList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.view');
  _signupEnsureColumns_();
  var sql  = 'SELECT * FROM signup_requests WHERE 1=1';
  var args = [];
  // Default to the actionable queue; allow an explicit status filter.
  if (params.status) { sql += ' AND status = ?'; args.push(String(params.status).toUpperCase()); }
  else               { sql += " AND status = 'PENDING_APPROVAL'"; }
  sql += ' ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
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
  _signupEnsureColumns_();

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
  var actor        = _signupActor_(ctx);
  var provisioned  = { id: '', type: provisionAs };
  var welcome;

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
    welcome = {
      recipient_id:   created.userId,
      recipient_type: 'STAFF',
      entity_type:    'users',
      country_code:   String(params.country_code || params.countryCode || ''),
    };

  } else if (provisionAs === 'CONTACT') {
    // Portal contact: belongs to a customer and carries a portal_role.
    Rbac.requirePermission(ctx.session, 'contacts.manage');
    var customerId = String(params.customer_id || params.customerId || '').trim();
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
    welcome = {
      recipient_id:   contact.contact_id,
      recipient_type: 'CONTACT',
      entity_type:    'contacts',
      country_code:   '',
    };

  } else {
    throw new Errors.Validation('provision_as must be STAFF or CONTACT.');
  }

  // Mark the request APPROVED and record who/what/when (optional columns).
  var now = nowIso();
  try {
    TursoClient.write(
      'UPDATE signup_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, ' +
      'provisioned_id = ?, provisioned_type = ?, updated_at = ? WHERE request_id = ?',
      ['APPROVED', actor, now, provisioned.id, provisioned.type, now, requestId]
    );
  } catch (_) {
    TursoClient.write(
      'UPDATE signup_requests SET status = ?, updated_at = ? WHERE request_id = ?',
      ['APPROVED', now, requestId]
    );
  }

  Audit.log({
    actor: actor, action: 'SIGNUP_APPROVED', entity: 'signup_requests', entityId: requestId,
    before: { status: 'PENDING_APPROVAL' },
    after:  { status: 'APPROVED', provisioned_type: provisioned.type, provisioned_id: provisioned.id },
  });

  // Welcome through the step-1 emit (best-effort; never blocks provisioning). The
  // applicant now exists as the provisioned user/contact, so the emit resolves
  // their email by id. The temp password is single-use: must_change_password is
  // set so it has to be changed on first use.
  try {
    Notify.emit({
      recipient_id:   welcome.recipient_id,
      recipient_type: welcome.recipient_type,
      channel:        'EMAIL',
      event_key:      'SIGNUP_APPROVED',
      vars:           { email: email, temp_password: tempPassword },
      subject:        'Your Hass CMS account is ready',
      body:           'Welcome to Hass CMS. Your account has been approved.\n\n' +
                      'Sign in with this email (' + email + ') and the temporary password below, ' +
                      'then set a new password from your profile:\n\n' +
                      'Temporary password: ' + tempPassword + '\n\n' +
                      'For your security, change this password as soon as you sign in.',
      entity_type:    welcome.entity_type,
      entity_id:      welcome.recipient_id,
      country_code:   welcome.country_code,
    });
  } catch (_) {}

  return { success: true, status: 'APPROVED', provisioned: provisioned };
}

// ── reject: close with a reason + notify the applicant ────────────────────────

function _signupsReject_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.create');
  _signupEnsureColumns_();

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
  try {
    TursoClient.write(
      'UPDATE signup_requests SET status = ?, decision_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE request_id = ?',
      ['REJECTED', reason, actor, now, now, requestId]
    );
  } catch (_) {
    TursoClient.write(
      'UPDATE signup_requests SET status = ?, updated_at = ? WHERE request_id = ?',
      ['REJECTED', now, requestId]
    );
  }

  Audit.log({
    actor: actor, action: 'SIGNUP_REJECTED', entity: 'signup_requests', entityId: requestId,
    before: { status: 'PENDING_APPROVAL' }, after: { status: 'REJECTED', reason: reason },
  });

  // Notify the applicant through the step-1 emit. The applicant has no user or
  // contact record, so the recipient is the signup request itself (resolved to
  // its email by _resolveRecipientEmail_'s SIGNUP type).
  try {
    Notify.emit({
      recipient_id:   requestId,
      recipient_type: 'SIGNUP',
      channel:        'EMAIL',
      event_key:      'SIGNUP_REJECTED',
      vars:           { email: req.email || '', reason: reason },
      subject:        'Update on your Hass CMS sign-up',
      body:           'Thank you for your interest in Hass CMS. After review, your sign-up request ' +
                      'could not be approved at this time.\n\nReason: ' + reason,
      entity_type:    'signup_requests',
      entity_id:      requestId,
      country_code:   '',
    });
  } catch (_) {}

  return { success: true, status: 'REJECTED' };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerSignups_() {
  register({ service: 'signupRequests', action: 'list',    permission: 'user.view',   handler: _signupsList_ });
  register({ service: 'signupRequests', action: 'get',     permission: 'user.view',   handler: _signupsGet_ });
  register({ service: 'signupRequests', action: 'approve', permission: 'user.create', handler: _signupsApprove_ });
  register({ service: 'signupRequests', action: 'reject',  permission: 'user.create', handler: _signupsReject_ });
})();
