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
  if (table === 'users') {
    TursoClient.write(
      'UPDATE users SET last_login_at = ?, failed_login_attempts = 0, ' +
      'locked_until = NULL, updated_at = ? WHERE user_id = ?',
      [nowIso(), nowIso(), id]
    );
  } else {
    TursoClient.write(
      'UPDATE ' + table + ' SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE ' + idCol + ' = ?',
      [nowIso(), nowIso(), id]
    );
  }
}

// ── processRequest (public convenience wrapper) ───────────────────────────────

var _PUBLIC_ACTIONS_ = [
  'auth.login', 'auth.signup', 'auth.verifyAccount',
  'auth.requestPasswordReset', 'auth.verifyOtp', 'auth.setNewPassword',
  // Customer self-signup (signupRequests.create): writes one pending
  // signup_requests row pre-session, like login. No user is created here.
  'signupRequests.create',
  // MFA mid-login actions: a user partway through login has no full session yet,
  // only the challenge minted after the password step. These are gated by
  // possession of a valid, unconsumed, unexpired challengeId (the partial pre-MFA
  // token), so they are safe to expose without a session. auth.changePassword is
  // deliberately NOT public: it requires a real session (own-account change).
  'auth.mfaEnroll', 'auth.mfaVerifyEnroll',
  'auth.mfaEnrollStart', 'auth.mfaEnrollVerify', 'auth.mfaVerify',
];

/**
 * Convenience entry point usable from tests and IDE scripts.
 * Session gating is handled entirely by dispatch().
 */
function processRequest(requestBody) {
  try {
    var body = (typeof requestBody === 'string')
      ? JSON.parse(requestBody) : requestBody;
    var service = body.service || '';
    var action  = body.action  || '';
    var params  = body.params  || {};
    var ctx = { sessionToken: body.sessionToken || params.sessionToken };
    return dispatch(ctx, { service: service, action: action, params: params });
  } catch (e) {
    Logger.log('[processRequest] Unhandled error: ' + e.message +
               '\n' + (e.stack || ''));
    return {
      ok: false,
      error: {
        code: (e.code) || 'INTERNAL_ERROR',
        message: e.message || 'An unexpected error occurred.'
      }
    };
  }
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
    var roleRows = TursoClient.select('SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [user.user_id]);
    var primaryRole = roleRows.length ? roleRows[0].role_code : 'CS_AGENT';
    var sessionResult = Session.create(user.user_id, 'STAFF', primaryRole, ip, ua, user.country_code || null);
    _clearLoginFails_('users', 'user_id', user.user_id);
    Audit.log({ actor: user.user_id, action: 'LOGIN', entity: 'sessions',
                entityId: sessionResult.session_id, after: { email: user.email } });
    return {
      token:               sessionResult.token,
      userId:              user.user_id,
      role:                primaryRole,
      email:               user.email,
      firstName:           user.first_name,
      lastName:            user.last_name,
      countryCode:         user.country_code,
      mustChangePassword:  user.must_change_password === 1,
      mfaRequired:         false
    };
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
    var cSessionResult = Session.create(contact.contact_id, 'CUSTOMER', 'CUSTOMER', ip, ua, '');
    _clearLoginFails_('contacts', 'contact_id', contact.contact_id);
    Audit.log({ actor: contact.contact_id, action: 'LOGIN', entity: 'sessions',
                entityId: cSessionResult.session_id, after: { email: contact.email } });
    return { token: cSessionResult.token, role: 'CUSTOMER', userId: contact.contact_id,
             redirectUrl: '?page=portal&token=' + cSessionResult.token };
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
  // Lightweight implementation: create a signup_request row. No password is
  // collected at signup; credentials are issued by email only after an admin
  // approves, so pending_password_hash stays null.
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) throw new Errors.Validation('Email is required.');
  var existing = _findContactByEmail_(email);
  if (existing) throw new Errors.Validation('An account with this email already exists.');
  // Map onto the real signup_requests columns. status is written explicitly
  // (never relying on the column default) and submitted_at is the only timestamp
  // this table carries (there is no created_at / updated_at).
  Repo.create('signup_requests', {
    request_id:   uuidv4(),
    email:        email,
    first_name:   String(params.firstName || params.first_name || ''),
    last_name:    String(params.lastName  || params.last_name  || ''),
    phone:        String(params.phone     || ''),
    status:       'PENDING_APPROVAL',
    submitted_at: nowIso(),
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
    'INSERT INTO password_resets (reset_id, email, otp_hash, expires_at, consumed_at, created_at) VALUES (?,?,?,?,NULL,?)',
    [uuidv4(), email, otpHash, expires, nowIso()]
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
    'SELECT * FROM password_resets WHERE email = ? AND otp_hash = ? AND consumed_at IS NULL AND expires_at > ? LIMIT 1',
    [email, otpHash, nowIso()]
  );
  if (!rows.length) throw new Errors.Validation('Invalid or expired code.');
  TursoClient.write("UPDATE password_resets SET consumed_at = datetime('now') WHERE email = ?", [email]);
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

// MFA enrol start (AUTH-4). Registered under BOTH auth.mfaEnroll (the name the
// UI calls) and auth.mfaEnrollStart (the prior name). Handles the no-full-session
// case: a mid-login user has no session yet, only the enroll challenge minted at
// login (after the password step). That challengeId is a short-lived partial
// pre-MFA token bound to the user, so enrolment resumes from it. A logged-in user
// enabling MFA from settings (has a session, no challengeId) uses the session.
function _authMfaEnrollStart_(ctx, params) {
  var challengeId = String(params.challengeId || '');
  var enrol;
  if (challengeId) {
    enrol = Mfa.enrolFromChallenge(challengeId);
  } else {
    // Settings path: a logged-in user enabling MFA. These actions are public (so
    // the mid-login no-session case works), which means the dispatcher does not
    // populate ctx.session; resolve the bearer token here instead.
    var sess = ctx.session;
    if (!sess && params && params.sessionToken) sess = Session.validate(params.sessionToken);
    if (!sess) throw new Errors.PermissionDenied('Authentication required.');
    enrol = Mfa.enrolStart(sess.userType, sess.userId);
  }
  return {
    challengeId:      enrol.challenge_id,
    challenge_id:     enrol.challenge_id,
    provisioning_uri: enrol.provisioning_uri,
    secret:           enrol.secret,
  };
}

// MFA enrol verify (AUTH-4). Registered under BOTH auth.mfaVerifyEnroll and
// auth.mfaEnrollVerify. When the enrolment is part of a login (no full session
// yet), completing it completes the login, so a session is issued here, exactly
// as auth.mfaVerify does. When a logged-in user enrols from settings, the
// existing session stands and we just confirm success.
function _authMfaEnrollVerify_(ctx, params) {
  var challengeId = String(params.challengeId || '');
  var code        = String(params.code        || '');
  var result = Mfa.enrolVerify(challengeId, code);
  Audit.log({ actor: result.userId, action: 'MFA_ENROLLED', entity: 'users',
              entityId: result.userId, metadata: { userType: result.userType } });

  // These actions are public, so ctx.session is not set by the dispatcher;
  // resolve any bearer token to tell the settings path (already logged in) from
  // the mid-login path (no session yet, enrolment completes the login).
  var existingSession = ctx.session;
  if (!existingSession && params && params.sessionToken) existingSession = Session.validate(params.sessionToken);

  if (!existingSession && result.userType === 'STAFF') {
    var ip = String(params.ip || '');
    var ua = String(params.ua || '');
    var uRows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [result.userId]);
    if (!uRows.length) throw new Errors.NotFound('User not found.');
    var u = uRows[0];
    var rRows = TursoClient.select('SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [result.userId]);
    var role  = rRows.length ? rRows[0].role_code : 'CS_AGENT';
    var sessionResult = Session.create(result.userId, 'STAFF', role, ip, ua, u.country_code || '');
    _clearLoginFails_('users', 'user_id', result.userId);
    Audit.log({ actor: result.userId, action: 'MFA_LOGIN', entity: 'sessions',
                entityId: sessionResult.session_id, ip: ip, ua: ua, metadata: { role: role, via: 'enroll' } });
    return { success: true, token: sessionResult.token, role: role, userId: result.userId,
             redirectUrl: '?page=staff&token=' + sessionResult.token };
  }
  return { success: true };
}

// Self-service password change (AUTH-3). Session required (any authenticated
// user, staff or portal contact). Enforces the SAME rules as the rest of auth:
// the current password must verify, and the new one must pass Password
// .validatePolicy (length/complexity + the reuse-history check), the identical
// path used by auth.setNewPassword and users.resetPassword.
function _authChangePassword_(ctx, params) {
  var sess = ctx.session;
  if (!sess) throw new Errors.PermissionDenied('Authentication required.');
  var userId   = sess.userId   || sess.user_id   || '';
  var userType = String(sess.userType || sess.user_type || 'STAFF').toUpperCase();
  var current  = String(params.currentPassword || params.current_password || '');
  var newPass  = String(params.newPassword     || params.new_password     || '');
  if (!current || !newPass) throw new Errors.Validation('Current and new password are required.');

  var table       = (userType === 'CUSTOMER') ? 'contacts'   : 'users';
  var idCol       = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';
  var historyType = (userType === 'CUSTOMER') ? 'CUSTOMER'   : 'STAFF';

  var rows = TursoClient.select('SELECT * FROM ' + table + ' WHERE ' + idCol + ' = ? LIMIT 1', [userId]);
  if (!rows.length) throw new Errors.NotFound('Account not found.');
  var row = rows[0];

  if (!Password.verify(current, row.password_hash)) {
    Audit.log({ actor: userId, action: 'PASSWORD_CHANGE_FAILED', entity: table,
                entityId: userId, metadata: { reason: 'wrong_current' } });
    throw new Errors.Validation('Current password is incorrect.');
  }

  Password.validatePolicy(newPass, userId, historyType);
  var newHash = Password.hash(newPass);

  if (row.password_hash) {
    TursoClient.write(
      'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
      [uuidv4(), userId, historyType, row.password_hash, nowIso()]
    );
  }
  try {
    TursoClient.write(
      'UPDATE ' + table + ' SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE ' + idCol + ' = ?',
      [newHash, nowIso(), userId]
    );
  } catch (_) {
    TursoClient.write(
      'UPDATE ' + table + ' SET password_hash = ?, updated_at = ? WHERE ' + idCol + ' = ?',
      [newHash, nowIso(), userId]
    );
  }
  Audit.log({ actor: userId, action: 'PASSWORD_CHANGED', entity: table,
              entityId: userId, metadata: { userType: historyType, self: true } });
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
    var rRows = TursoClient.select('SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [userId]);
    var role  = rRows.length ? rRows[0].role_code : 'CS_AGENT';
    var sessionResult = Session.create(userId, 'STAFF', role, ip, ua, u.country_code || '');
    _clearLoginFails_('users', 'user_id', userId);
    Audit.log({ actor: userId, action: 'MFA_LOGIN', entity: 'sessions',
                entityId: sessionResult.session_id, ip: ip, ua: ua, metadata: { role: role } });
    return { token: sessionResult.token, role: role, userId: userId, redirectUrl: '?page=staff&token=' + sessionResult.token };
  }
  // AUTH-5: MFA is explicitly disabled for portal contacts. This is consistent
  // with Mfa.isRequiredFor, which returns false for CUSTOMER, and with the portal
  // login path, which issues a session directly with no MFA gate. A portal
  // contact therefore never reaches this branch in the normal flow; if one ever
  // does (e.g. a hand-crafted challenge), it gets a clean, explicit message
  // rather than a half-implemented error, and is never left half-blocked.
  throw new Errors.Validation('Two-factor authentication is not enabled for portal accounts.');
}

/**
 * auth.me — return the profile of the currently-authenticated user.
 *
 * The session has already been validated by dispatch() (this is a non-public
 * action), so we simply read ctx.session and hydrate it from the backing table.
 * This is a READ-ONLY identity lookup: it never creates or invalidates a
 * session. The staff dashboard's auth guard calls this immediately after login;
 * if it is missing the dashboard bounces straight back to the login page, which
 * looks to the user like the brand-new session was rejected on first use.
 */
function _authMe_(ctx, params) {
  var sess = ctx.session;
  if (!sess) throw new Errors.PermissionDenied('Authentication required.');
  var userId   = sess.userId   || sess.user_id   || '';
  var userType = sess.userType  || sess.user_type || 'STAFF';

  if (userType === 'CUSTOMER') {
    var cRows = TursoClient.select('SELECT * FROM contacts WHERE contact_id = ? LIMIT 1', [userId]);
    var c = cRows.length ? cRows[0] : {};
    return {
      userId:     userId,
      userType:   'CUSTOMER',
      email:      c.email      || '',
      first_name: c.first_name || '',
      last_name:  c.last_name  || '',
      role:       sess.role    || 'CUSTOMER',
      country:    c.country_code || sess.countryCode || '',
    };
  }

  var uRows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userId]);
  var u = uRows.length ? uRows[0] : {};
  var roleRows = TursoClient.select('SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [userId]);
  // Resolve the union of permission codes across ALL of this user's roles and
  // deliver it to the client. SUPER_ADMIN resolves to ['*']; every other role
  // resolves to its real granted codes. The client uses this set to render the
  // permission-filtered menu and to gate sections, so without it a non-admin
  // user receives no permissions and the whole app renders empty (the bug this
  // fixes). Resolution is memoized per request in Rbac, so this is cheap even
  // though the staff init bundle also calls into Rbac.
  var permissions = Rbac.userPermissions(userId);
  var me = {
    userId:      userId,
    userType:    'STAFF',
    email:       u.email      || '',
    first_name:  u.first_name || '',
    last_name:   u.last_name  || '',
    role:        sess.role || (roleRows.length ? roleRows[0].role_code : null),
    country:     u.country_code || sess.countryCode || '',
    team:        u.team_id || '',
    permissions: permissions,
  };

  // ── Init bundle (staff dashboard first-screen, ONE round-trip) ────────────
  // When the staff dashboard's auth guard asks for it (params.bundle), pigg-back
  // the first-screen data the dashboard would otherwise pull in a cascade of
  // separate google.script.run calls (branding, menu, the bot-admin flag, and
  // the dashboard summary + SLA panels). This reuses the EXISTING auth.me init
  // channel — no action is renamed and no new dispatcher route is added. The
  // customer-portal path never sets params.bundle, so it is unaffected. Within
  // this single invocation the Rbac per-request cache is shared across every
  // part, so permissions resolve once rather than five times.
  if (params && params.bundle) {
    me.bundle = _authMeStaffBundle_(sess);
  }
  return me;
}

/**
 * Assemble the staff dashboard first-screen bundle from in-process service
 * calls. Every part is best-effort: a failure omits that key and the client
 * falls back to its existing standalone API call for that widget. This neither
 * writes anything nor changes any existing return shape.
 */
function _authMeStaffBundle_(session) {
  var ctx = { session: session };
  var bundle = {};
  try { bundle.branding         = _brandingGet_(ctx, { scope_code: 'GLOBAL' }); } catch (e) {}
  try { bundle.menu             = _menuList_(ctx, {}); }                          catch (e) {}
  try { bundle.botAdmin         = !!Rbac.userHasPermission(session.userId, BOT_ADMIN_PERMISSION); } catch (e) { bundle.botAdmin = false; }
  try { bundle.dashboardSummary = _dashSummary_(ctx, {}); }                       catch (e) {}
  try { bundle.dashboardSla     = _dashSlaMetrics_(ctx, {}); }                    catch (e) {}
  try { bundle.dashboardCharts  = _dashCharts_(ctx, {}); }                        catch (e) {}
  return bundle;
}

function _authGetStaffInfo_(ctx, params) {
  var userId = String(params.userId || (ctx.session && ctx.session.userId) || '');
  if (!userId) throw new Errors.Validation('userId required.');
  var rows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new Errors.NotFound('User not found.');
  var u = rows[0];
  var staffRoleRows = TursoClient.select('SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [userId]);
  return {
    userId:    u.user_id,
    name:      (u.first_name || '') + ' ' + (u.last_name || ''),
    email:     u.email,
    role:      staffRoleRows.length ? staffRoleRows[0].role_code : null,
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
  // AUTH-4: aliases matching the names MfaEnroll.html actually calls.
  register({ service: 'auth', action: 'mfaEnroll',            permission: null,          handler: _authMfaEnrollStart_ });
  register({ service: 'auth', action: 'mfaVerifyEnroll',      permission: null,          handler: _authMfaEnrollVerify_ });
  register({ service: 'auth', action: 'mfaVerify',            permission: null,          handler: _authMfaVerify_ });
  // AUTH-3: self-service password change (session required; not public).
  register({ service: 'auth', action: 'changePassword',       permission: null,          handler: _authChangePassword_ });
  register({ service: 'auth', action: 'me',                   permission: null,          handler: _authMe_ });
  register({ service: 'auth', action: 'getStaffInfo',         permission: 'user.view',   handler: _authGetStaffInfo_ });
})();
