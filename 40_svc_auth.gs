/**
 * 40_svc_auth.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * Registers auth.* actions with the dispatcher.
 * Public actions (no session required): login, signup, verifyAccount,
 *   requestPasswordReset, verifyOtp, setNewPassword.
 *
 * Login flow:
 *   1. Find user by email (users → contacts)
 *   2. Reject inactive / locked
 *   3. Password.verify – on fail bump attempts, maybe lock; audit
 *   4. MFA gate if required
 *   5. Session.create, return token
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

var _LOGIN_FAIL_THRESHOLD_ = 5;
var _LOCK_MINUTES_         = 15;

function _isDateFuture_(val) {
  if (!val) return false;
  var d = new Date(String(val));
  return !isNaN(d.getTime()) && d > new Date();
}

function _findUserByEmail_(email) {
  var rows = TursoClient.select(
    'SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email.toLowerCase()]
  );
  return rows.length ? rows[0] : null;
}

function _findContactByEmail_(email) {
  var rows = TursoClient.select(
    'SELECT * FROM contacts WHERE LOWER(email) = ? LIMIT 1', [email.toLowerCase()]
  );
  return rows.length ? rows[0] : null;
}

function _bumpLoginFails_(table, idCol, id) {
  var rows = TursoClient.select('SELECT failed_login_attempts FROM ' + table + ' WHERE ' + idCol + ' = ? LIMIT 1', [id]);
  var fails = rows.length ? (parseInt(rows[0].failed_login_attempts, 10) || 0) + 1 : 1;
  var patch = { failed_login_attempts: fails, updated_at: nowIso() };
  if (fails >= _LOGIN_FAIL_THRESHOLD_) {
    patch.locked_until = addMinutes(new Date(), _LOCK_MINUTES_).toISOString();
  }
  var sets = Object.keys(patch).map(function (k) { return k + ' = ?'; }).join(', ');
  var args = Object.keys(patch).map(function (k) { return patch[k]; });
  args.push(id);
  TursoClient.write('UPDATE ' + table + ' SET ' + sets + ' WHERE ' + idCol + ' = ?', args);
}

function _clearLoginFails_(table, idCol, id) {
  TursoClient.write(
    'UPDATE ' + table + ' SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE ' + idCol + ' = ?',
    [nowIso(), nowIso(), id]
  );
}

// ── processRequest (public convenience wrapper) ───────────────────────────────

var _PUBLIC_ACTIONS_ = [
  'auth.login', 'auth.signup', 'auth.verifyAccount',
  'auth.requestPasswordReset', 'auth.verifyOtp', 'auth.setNewPassword',
];

/**
 * Convenience entry point usable from tests and IDE scripts.
 * Mirrors the same session-gating logic as doPost in 30_router.gs.
 */
function processRequest(call) {
  var service = String(call.service || '');
  var action  = String(call.action  || '');
  var key     = service + '.' + action;
  var token   = String(call.sessionToken || call.token || '');
  var params  = call.params || {};

  var ctx = { token: token, actor: null, session: null };

  if (_PUBLIC_ACTIONS_.indexOf(key) === -1) {
    if (!token) {
      return { ok: false, error: { code: 'NO_SESSION', message: 'Session token required.' } };
    }
    var sess = Session.validate(token);
    if (!sess) {
      return { ok: false, error: { code: 'NO_SESSION', message: 'Session invalid or expired.' } };
    }
    ctx.actor   = sess.userId;
    ctx.session = sess;
  }

  return dispatch(ctx, { service: service, action: action, params: params });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function _authLogin_(ctx, params) {
  var email    = String(params.email    || '').trim().toLowerCase();
  var password = String(params.password || '').trim();
  var ip       = String(params.ip       || ctx.ip || '');
  var ua       = String(params.ua       || ctx.ua || '');
  if (!email)    throw new Errors.Validation('Email is required.');
  if (!password) throw new Errors.Validation('Password is required.');

  // ── Try staff first ────────────────────────────────────────────────────────
  var user = _findUserByEmail_(email);
  if (user) {
    var status = String(user.status || '').toUpperCase();
    if (status !== 'ACTIVE') {
      Audit.log({ actor: user.user_id, action: 'LOGIN_FAILED', entity: 'users',
                  entityId: user.user_id, ip: ip, ua: ua,
                  metadata: { email: email, reason: 'status_' + status } });
      throw new Errors.PermissionDenied('Account is not active.');
    }
    if (_isDateFuture_(user.locked_until)) {
      Audit.log({ actor: user.user_id, action: 'LOGIN_FAILED', entity: 'users',
                  entityId: user.user_id, ip: ip, ua: ua,
                  metadata: { email: email, reason: 'locked' } });
      throw new Errors.PermissionDenied('Account is temporarily locked. Try again later.');
    }
    if (!Password.verify(password, user.password_hash)) {
      _bumpLoginFails_('users', 'user_id', user.user_id);
      Audit.log({ actor: user.user_id, action: 'LOGIN_FAILED', entity: 'users',
                  entityId: user.user_id, ip: ip, ua: ua,
                  metadata: { email: email, reason: 'wrong_password' } });
      throw new Errors.PermissionDenied('Incorrect email or password.');
    }
    // ── MFA gate ─────────────────────────────────────────────────────────────
    if (Mfa.isRequiredFor('STAFF', user.user_id)) {
      var secret = user.mfa_secret;
      if (secret) {
        var cid = Mfa.startVerify('STAFF', user.user_id);
        Audit.log({ actor: user.user_id, action: 'MFA_CHALLENGE_ISSUED', entity: 'users',
                    entityId: user.user_id, ip: ip, ua: ua,
                    metadata: { email: email, mode: 'verify' } });
        return { mfaRequired: true, challengeId: cid, mode: 'verify' };
      } else {
        var enrol = Mfa.enrolStart('STAFF', user.user_id);
        Audit.log({ actor: user.user_id, action: 'MFA_CHALLENGE_ISSUED', entity: 'users',
                    entityId: user.user_id, ip: ip, ua: ua,
                    metadata: { email: email, mode: 'enroll' } });
        return { mfaRequired: true, challengeId: enrol.challenge_id, mode: 'enroll',
                 provisioning_uri: enrol.provisioning_uri };
      }
    }
    // ── Issue session ─────────────────────────────────────────────────────────
    var roleCode = user.role || 'CS_AGENT';
    var token = Session.create(user.user_id, 'STAFF', roleCode, ip, ua, user.country_code || '');
    _clearLoginFails_('users', 'user_id', user.user_id);
    Audit.log({ actor: user.user_id, action: 'LOGIN', entity: 'users',
                entityId: user.user_id, ip: ip, ua: ua,
                metadata: { email: email, role: roleCode } });
    return { token: token, role: roleCode, userId: user.user_id,
             redirectUrl: '?page=staff&token=' + token };
  }

  // ── Try contact/portal ────────────────────────────────────────────────────
  var contact = _findContactByEmail_(email);
  if (contact) {
    var cStatus = String(contact.status || '').toUpperCase();
    if (cStatus !== 'ACTIVE') {
      Audit.log({ actor: contact.contact_id, action: 'LOGIN_FAILED', entity: 'contacts',
                  entityId: contact.contact_id, ip: ip, ua: ua,
                  metadata: { email: email, reason: 'status_' + cStatus } });
      throw new Errors.PermissionDenied('Account is not active.');
    }
    if (_isDateFuture_(contact.locked_until)) {
      Audit.log({ actor: contact.contact_id, action: 'LOGIN_FAILED', entity: 'contacts',
                  entityId: contact.contact_id, ip: ip, ua: ua,
                  metadata: { email: email, reason: 'locked' } });
      throw new Errors.PermissionDenied('Account is temporarily locked. Try again later.');
    }
    if (!Password.verify(password, contact.password_hash)) {
      _bumpLoginFails_('contacts', 'contact_id', contact.contact_id);
      Audit.log({ actor: contact.contact_id, action: 'LOGIN_FAILED', entity: 'contacts',
                  entityId: contact.contact_id, ip: ip, ua: ua,
                  metadata: { email: email, reason: 'wrong_password' } });
      throw new Errors.PermissionDenied('Incorrect email or password.');
    }
    var cToken = Session.create(contact.contact_id, 'CUSTOMER', 'CUSTOMER', ip, ua, '');
    _clearLoginFails_('contacts', 'contact_id', contact.contact_id);
    Audit.log({ actor: contact.contact_id, action: 'LOGIN', entity: 'contacts',
                entityId: contact.contact_id, ip: ip, ua: ua,
                metadata: { email: email, role: 'CUSTOMER' } });
    return { token: cToken, role: 'CUSTOMER', userId: contact.contact_id,
             redirectUrl: '?page=portal&token=' + cToken };
  }

  Audit.log({ actor: '', action: 'LOGIN_FAILED', entity: 'auth', entityId: email,
              ip: ip, ua: ua, metadata: { email: email, reason: 'not_found' } });
  throw new Errors.PermissionDenied('Incorrect email or password.');
}

function _authLogout_(ctx, params) {
  var token = String(params.token || ctx.token || '');
  if (token) {
    Session.invalidate(token);
    Audit.log({ actor: ctx.actor || '', action: 'LOGOUT', entity: 'sessions',
                entityId: '', metadata: {} });
  }
  return { success: true };
}

function _authSignup_(ctx, params) {
  // Lightweight implementation: create a signup_request row.
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) throw new Errors.Validation('Email is required.');
  Password.validatePolicy(String(params.password || ''));
  var existing = _findContactByEmail_(email);
  if (existing) throw new Errors.Validation('An account with this email already exists.');
  Repo.create('signup_requests', {
    request_id:   uuidv4(),
    email:        email,
    first_name:   String(params.firstName || params.first_name || ''),
    last_name:    String(params.lastName  || params.last_name  || ''),
    phone:        String(params.phone     || ''),
    status:       'PENDING_APPROVAL',
    submitted_at: nowIso(),
    created_at:   nowIso(),
    updated_at:   nowIso(),
  });
  Audit.log({ actor: '', action: 'SIGNUP_REQUESTED', entity: 'signup_requests',
              entityId: email, metadata: { email: email } });
  return { message: 'Signup request submitted. You will be contacted once reviewed.' };
}

function _authVerifyAccount_(ctx, params) {
  var companyName   = String(params.companyName   || '').trim().toLowerCase();
  var accountNumber = String(params.accountNumber || '').trim().toLowerCase();
  if (!companyName && !accountNumber) {
    throw new Errors.Validation('Provide company name or account number.');
  }
  var rows = TursoClient.select(
    'SELECT customer_id, company_name, account_number FROM customers WHERE 1=1' +
    (accountNumber ? ' AND LOWER(account_number) = ?' : '') +
    (companyName   ? ' AND LOWER(company_name)   LIKE ?' : '') +
    ' LIMIT 1',
    [].concat(accountNumber ? [accountNumber] : []).concat(companyName ? ['%' + companyName + '%'] : [])
  );
  if (!rows.length) throw new Errors.NotFound('Company not found.');
  return { verified: true, customerId: rows[0].customer_id,
           companyName: rows[0].company_name, accountNumber: rows[0].account_number };
}

function _authRequestPasswordReset_(ctx, params) {
  // Intentionally vague response to avoid user enumeration.
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) throw new Errors.Validation('Email is required.');
  var otp = String(Math.floor(100000 + Math.random() * 900000));
  // Store hashed OTP. Re-use sessions table pattern for simplicity.
  // We use SHA-256 for the OTP hash (it's not a password).
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, otp, Utilities.Charset.UTF_8);
  var otpHash = raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  var expires = addMinutes(new Date(), 15).toISOString();
  TursoClient.write(
    'DELETE FROM password_resets WHERE email = ?', [email]
  );
  TursoClient.write(
    'INSERT INTO password_resets (email, otp_hash, expires_at, used, created_at) VALUES (?,?,?,0,?)',
    [email, otpHash, expires, nowIso()]
  );
  Audit.log({ actor: '', action: 'PASSWORD_RESET_REQUESTED', entity: 'auth',
              entityId: email, metadata: { email: email } });
  // In production, send OTP by email; here we omit MailApp dependency.
  return { success: true };
}

function _authVerifyOtp_(ctx, params) {
  var email = String(params.email || '').trim().toLowerCase();
  var otp   = String(params.otp   || '').trim();
  if (!email || !otp) throw new Errors.Validation('Email and code are required.');
  var raw     = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, otp, Utilities.Charset.UTF_8);
  var otpHash = raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  var rows = TursoClient.select(
    'SELECT * FROM password_resets WHERE email = ? AND otp_hash = ? AND used = 0 AND expires_at > ? LIMIT 1',
    [email, otpHash, nowIso()]
  );
  if (!rows.length) throw new Errors.Validation('Invalid or expired code.');
  TursoClient.write('UPDATE password_resets SET used = 1 WHERE email = ?', [email]);
  return { success: true, email: email };
}

function _authSetNewPassword_(ctx, params) {
  var email    = String(params.email       || '').trim().toLowerCase();
  var newPass  = String(params.newPassword || '').trim();
  if (!email || !newPass) throw new Errors.Validation('Email and new password are required.');

  var staffRow   = _findUserByEmail_(email);
  var contactRow = staffRow ? null : _findContactByEmail_(email);
  var userId     = staffRow ? staffRow.user_id : (contactRow ? contactRow.contact_id : null);
  var userType   = staffRow ? 'STAFF' : 'CUSTOMER';

  if (!userId) throw new Errors.NotFound('Account not found.');
  Password.validatePolicy(newPass, userId, userType);
  var newHash = Password.hash(newPass);

  // Save to password_history before updating.
  var oldHash = staffRow ? staffRow.password_hash : contactRow.password_hash;
  if (oldHash) {
    TursoClient.write(
      'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
      [uuidv4(), userId, userType, oldHash, nowIso()]
    );
  }

  var table = staffRow ? 'users' : 'contacts';
  var idCol  = staffRow ? 'user_id' : 'contact_id';
  try {
    TursoClient.write(
      'UPDATE ' + table + ' SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE ' + idCol + ' = ?',
      [newHash, nowIso(), userId]
    );
  } catch (_) {
    // must_change_password column may not exist yet; update without it.
    TursoClient.write(
      'UPDATE ' + table + ' SET password_hash = ?, updated_at = ? WHERE ' + idCol + ' = ?',
      [newHash, nowIso(), userId]
    );
  }
  Audit.log({ actor: userId, action: 'PASSWORD_CHANGED', entity: table,
              entityId: userId, metadata: { email: email, userType: userType } });
  return { success: true };
}

function _authMfaEnrollStart_(ctx, params) {
  var sess = ctx.session;
  if (!sess) throw new Errors.PermissionDenied('Authentication required.');
  var enrol = Mfa.enrolStart(sess.userType, sess.userId);
  return { challengeId: enrol.challenge_id, provisioning_uri: enrol.provisioning_uri };
}

function _authMfaEnrollVerify_(ctx, params) {
  var challengeId = String(params.challengeId || '');
  var code        = String(params.code        || '');
  var result = Mfa.enrolVerify(challengeId, code);
  Audit.log({ actor: result.userId, action: 'MFA_ENROLLED', entity: 'users',
              entityId: result.userId, metadata: { userType: result.userType } });
  return { success: true };
}

function _authMfaVerify_(ctx, params) {
  var challengeId = String(params.challengeId || '');
  var code        = String(params.code        || '');
  var result = Mfa.verify(challengeId, code);
  // Complete login: look up the user and issue a session.
  var userId   = result.userId;
  var userType = result.userType;
  var ip       = String(params.ip || '');
  var ua       = String(params.ua || '');
  if (userType === 'STAFF') {
    var uRows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userId]);
    if (!uRows.length) throw new Errors.NotFound('User not found.');
    var u = uRows[0];
    var role  = u.role || 'CS_AGENT';
    var token = Session.create(userId, 'STAFF', role, ip, ua, u.country_code || '');
    _clearLoginFails_('users', 'user_id', userId);
    Audit.log({ actor: userId, action: 'MFA_LOGIN', entity: 'users',
                entityId: userId, ip: ip, ua: ua, metadata: { role: role } });
    return { token: token, role: role, userId: userId, redirectUrl: '?page=staff&token=' + token };
  }
  throw new Errors.AppError('MFA verify for non-staff not yet implemented.');
}

function _authGetStaffInfo_(ctx, params) {
  var userId = String(params.userId || (ctx.session && ctx.session.userId) || '');
  if (!userId) throw new Errors.Validation('userId required.');
  var rows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new Errors.NotFound('User not found.');
  var u = rows[0];
  return {
    userId:    u.user_id,
    name:      (u.first_name || '') + ' ' + (u.last_name || ''),
    email:     u.email,
    role:      u.role,
    country:   u.country_code,
    team:      u.team_id,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerAuth_() {
  register({ service: 'auth', action: 'login',                permission: null,          handler: _authLogin_ });
  register({ service: 'auth', action: 'logout',               permission: null,          handler: _authLogout_ });
  register({ service: 'auth', action: 'signup',               permission: null,          handler: _authSignup_ });
  register({ service: 'auth', action: 'verifyAccount',        permission: null,          handler: _authVerifyAccount_ });
  register({ service: 'auth', action: 'requestPasswordReset', permission: null,          handler: _authRequestPasswordReset_ });
  register({ service: 'auth', action: 'verifyOtp',            permission: null,          handler: _authVerifyOtp_ });
  register({ service: 'auth', action: 'setNewPassword',       permission: null,          handler: _authSetNewPassword_ });
  register({ service: 'auth', action: 'mfaEnrollStart',       permission: null,          handler: _authMfaEnrollStart_ });
  register({ service: 'auth', action: 'mfaEnrollVerify',      permission: null,          handler: _authMfaEnrollVerify_ });
  register({ service: 'auth', action: 'mfaVerify',            permission: null,          handler: _authMfaVerify_ });
  register({ service: 'auth', action: 'getStaffInfo',         permission: 'user.view',   handler: _authGetStaffInfo_ });
})();
