// ================================================================
// HASS PETROLEUM CMS - AuthService.gs
// Version: 3.0.0
//
// All data reads/writes go to Turso via DatabaseSetup helpers.
// No direct SpreadsheetApp access in this file.
//
// Users table    → staff login  (password_hash column)
// Contacts table → customer login (password_hash column)
// Sessions table → token_hash, is_active, expires_at, role
// ================================================================

function isDateInFuture(val) {
  if (!val) return false;
  var s = String(val).trim();
  if (s === '' || s === 'null' || s === 'undefined') return false;
  var d = new Date(s);
  return !isNaN(d.getTime()) && d > new Date();
}

function handleAuthRequest(params) {
  try {
    switch (params.action) {
      case 'login':                return loginUser(params);
      case 'logout':               return logoutUser(params);
      case 'checkSession':         return checkSession(params);
      case 'signup':               return signupCustomer(params);
      case 'verifyAccount':        return verifyCustomerAccount(params);
      case 'requestPasswordReset': return requestPasswordReset(params);
      case 'verifyOtp':            return verifyOtp(params);
      case 'setNewPassword':       return setNewPassword(params);
      case 'getStaffInfo':         return getStaffInfo(params.userId);
      case 'mfaEnrollStart':       return mfaEnrollStart(params);
      case 'mfaEnrollVerify':      return mfaEnrollVerify(params);
      case 'mfaVerify':            return mfaVerify(params);
      case 'mfaDisable':           return mfaDisableForUser(params);
      default:
        return { success: false, error: 'Unknown auth action: ' + params.action };
    }
  } catch(e) {
    Logger.log('handleAuthRequest error: ' + e.message + '\n' + e.stack);
    return { success: false, error: 'Authentication error. Please try again.' };
  }
}

function getScriptUrl() {
  try { return ScriptApp.getService().getUrl(); } catch(e) { return ''; }
}

function hashPassword(plain) {
  if (!plain || typeof plain !== 'string') throw new Error('Password cannot be empty');
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, plain, Utilities.Charset.UTF_8);
  return raw.map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function trim2(v) { return String(v || '').trim(); }

// ================================================================
// PASSWORD POLICY  (G-009)
// ================================================================

// Top-20 most-common passwords; configurable via Script Property COMMON_PASSWORDS_CSV.
var _DEFAULT_COMMON_PASSWORDS_ = [
  'password','123456','12345678','1234567890','qwerty','abc123','monkey',
  'letmein','111111','password1','iloveyou','adobe123','123123','sunshine',
  'princess','welcome','password123','dragon','master','passw0rd'
];

/**
 * Returns policy rules from Config, falling back to sane defaults.
 * Keys: PW_MIN_LENGTH, PW_HISTORY_N, PW_MAX_AGE_DAYS
 */
function _getPasswordPolicy_() {
  var defaults = { minLength: 12, historyN: 5, maxAgeDays: 90 };
  try {
    if (typeof getConfigValues === 'function') {
      var vals = getConfigValues(['PW_MIN_LENGTH', 'PW_HISTORY_N', 'PW_MAX_AGE_DAYS']);
      var ml = parseInt(vals['PW_MIN_LENGTH'], 10);
      var hn = parseInt(vals['PW_HISTORY_N'],  10);
      var ma = parseInt(vals['PW_MAX_AGE_DAYS'], 10);
      return {
        minLength:  (!isNaN(ml) && ml > 0)  ? ml : defaults.minLength,
        historyN:   (!isNaN(hn) && hn >= 0) ? hn : defaults.historyN,
        maxAgeDays: (!isNaN(ma) && ma > 0)  ? ma : defaults.maxAgeDays,
      };
    }
  } catch(e) {}
  return defaults;
}

/**
 * Validates password complexity and checks against common-password list.
 * Throws with a clear message on violation; returns true on pass.
 *
 * @param {string} password  - plaintext candidate
 * @param {string} [userId]  - optional, for history check
 * @param {string} [userType] - 'STAFF' | 'CUSTOMER'
 */
function validatePasswordPolicy(password, userId, userType) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required.');
  }
  var policy = _getPasswordPolicy_();
  if (password.length < policy.minLength) {
    throw new Error('Password must be at least ' + policy.minLength + ' characters.');
  }
  if (!/[A-Z]/.test(password)) throw new Error('Password must contain at least one uppercase letter.');
  if (!/[a-z]/.test(password)) throw new Error('Password must contain at least one lowercase letter.');
  if (!/[0-9]/.test(password)) throw new Error('Password must contain at least one digit.');
  if (!/[^A-Za-z0-9]/.test(password)) throw new Error('Password must contain at least one special character.');

  // Common/breached password check.
  var commonList = _DEFAULT_COMMON_PASSWORDS_;
  try {
    var customCsv = PropertiesService.getScriptProperties().getProperty('COMMON_PASSWORDS_CSV');
    if (customCsv) commonList = customCsv.split(',').map(function(p) { return p.trim().toLowerCase(); });
  } catch(e) {}
  if (commonList.indexOf(password.toLowerCase()) !== -1) {
    throw new Error('This password is too common. Please choose a more unique password.');
  }

  // History check (if userId supplied).
  if (userId && policy.historyN > 0) {
    var hashed = hashPassword(password);
    if (checkPasswordReuse(userId, userType || 'STAFF', hashed, policy.historyN)) {
      throw new Error('You cannot reuse one of your last ' + policy.historyN + ' passwords.');
    }
  }

  return true;
}

/**
 * Returns true if the hashed password matches any of the last N entries
 * in password_history for this user.
 */
function checkPasswordReuse(userId, userType, newPasswordHash, historyN) {
  if (!userId || !newPasswordHash || !(historyN > 0)) return false;
  try {
    var rows = tursoSelect(
      'SELECT password_hash FROM password_history WHERE user_id = ? AND user_type = ? ' +
      'ORDER BY created_at DESC LIMIT ?',
      [userId, userType || 'STAFF', historyN]
    );
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].password_hash === newPasswordHash) return true;
    }
  } catch(e) {
    Logger.log('[AuthService] checkPasswordReuse error: ' + e.message);
  }
  return false;
}

/**
 * Saves the current password hash to password_history.
 */
function recordPasswordHistory(userId, userType, passwordHash) {
  if (!userId || !passwordHash) return;
  try {
    tursoWrite(
      'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
      [generateId('PWH'), userId, userType || 'STAFF', passwordHash, new Date().toISOString()]
    );
  } catch(e) {
    Logger.log('[AuthService] recordPasswordHistory error: ' + e.message);
  }
}

/**
 * Returns true if the user's password is older than maxAgeDays.
 */
function isPasswordExpired(userId, userType) {
  var policy = _getPasswordPolicy_();
  try {
    var table    = (userType === 'CUSTOMER') ? 'contacts' : 'users';
    var idField  = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';
    var rows     = tursoSelect('SELECT password_changed_at FROM ' + table + ' WHERE ' + idField + ' = ? LIMIT 1', [userId]);
    if (!rows.length) return false;
    var changedAt = rows[0].password_changed_at;
    if (!changedAt) return false; // no history = not expired (migration grace)
    var changedDate = new Date(changedAt);
    if (isNaN(changedDate.getTime())) return false;
    var ageMs = Date.now() - changedDate.getTime();
    return ageMs > policy.maxAgeDays * 24 * 60 * 60 * 1000;
  } catch(e) {
    Logger.log('[AuthService] isPasswordExpired error: ' + e.message);
    return false;
  }
}

// ================================================================
// SESSION CONSTANTS (G-010)
// ================================================================

var SESSION_IDLE_TIMEOUT_DEFAULT_MIN_ = 30;
var SESSION_MAX_CONCURRENT_            = 5;

/**
 * Returns idle timeout in minutes from Config (default 30).
 */
function _getIdleTimeoutMinutes_() {
  try {
    if (typeof getConfigValues === 'function') {
      var v = getConfigValues(['SESSION_IDLE_TIMEOUT_MIN']);
      var n = parseInt(v['SESSION_IDLE_TIMEOUT_MIN'], 10);
      if (!isNaN(n) && n > 0) return n;
    }
  } catch(e) {}
  return SESSION_IDLE_TIMEOUT_DEFAULT_MIN_;
}

/**
 * Returns max concurrent sessions per user from Config (default 5).
 */
function _getMaxConcurrentSessions_() {
  try {
    if (typeof getConfigValues === 'function') {
      var v = getConfigValues(['SESSION_MAX_CONCURRENT']);
      var n = parseInt(v['SESSION_MAX_CONCURRENT'], 10);
      if (!isNaN(n) && n > 0) return n;
    }
  } catch(e) {}
  return SESSION_MAX_CONCURRENT_;
}

// ================================================================
// LOGIN
// ================================================================

function loginUser(params) {
  var email    = String(params.email    || '').trim().toLowerCase();
  var password = String(params.password || '').trim();
  if (!email)    return { success: false, error: 'Email is required.' };
  if (!password) return { success: false, error: 'Password is required.' };
  var hashed = hashPassword(password);

  var sr = findStaffByEmail(email, hashed);
  if (sr.error) {
    _auditLoginFailed_(email, sr.error, sr.user && sr.user.user_id, 'STAFF');
    return { success: false, error: sr.error };
  }
  if (sr.found) {
    // G-008: enforce MFA for privileged roles before issuing a session.
    if (typeof userRequiresMfa === 'function' && userRequiresMfa(sr.user.user_id)) {
      var enrolled = String(sr.user.mfa_enabled || '0') === '1';
      var mode = enrolled ? 'verify' : 'enroll';
      var challengeToken = createMfaChallenge(sr.user.user_id, 'STAFF', sr.user.role, mode);
      try {
        auditLogCustom('User', sr.user.user_id, sr.user.user_id, 'MFA_CHALLENGE_ISSUED',
          { email: email, role: sr.user.role, mode: mode }, sr.user.country_code || '');
      } catch(e) {}
      var page = enrolled ? 'mfa-verify' : 'mfa-enroll';
      return {
        success: true,
        mfaRequired: true,
        mfaMode: mode,
        challengeToken: challengeToken,
        email: email,
        redirectUrl: getScriptUrl() + '?page=' + page + '&challenge=' + encodeURIComponent(challengeToken),
      };
    }
    return _completeStaffLogin_(sr.user, email);
  }

  var cr = findCustomerByEmail(email, hashed);
  if (cr.error) {
    _auditLoginFailed_(email, cr.error, cr.contact && cr.contact.contact_id, 'CUSTOMER');
    return { success: false, error: cr.error };
  }
  if (cr.found) {
    var ctoken = createSession(cr.contact.contact_id, 'CUSTOMER', 'CUSTOMER', 24);
    updateLastLogin('Contacts', 'contact_id', cr.contact.contact_id);
    try {
      auditLogCustom('Contact', cr.contact.contact_id, cr.contact.contact_id, 'LOGIN',
        { email: email, userType: 'CUSTOMER', customer_id: cr.contact.customer_id || '' }, '');
    } catch(e) {}
    return { success: true, token: ctoken, role: 'CUSTOMER', userId: cr.contact.contact_id,
      customerId: String(cr.contact.customer_id || ''),
      name: trim2(cr.contact.first_name) + ' ' + trim2(cr.contact.last_name),
      email: email, userType: 'CUSTOMER',
      redirectUrl: getScriptUrl() + '?page=portal&token=' + ctoken };
  }

  _auditLoginFailed_(email, 'No account found for this email address.', '', '');
  return { success: false, error: 'No account found for this email address.' };
}

function _auditLoginFailed_(email, reason, userId, userType) {
  try {
    auditLogCustom(userType === 'STAFF' ? 'User' : (userType === 'CUSTOMER' ? 'Contact' : 'Auth'),
      userId || email, userId || '', 'LOGIN_FAILED',
      { email: email, reason: reason, userType: userType || 'UNKNOWN' }, '');
  } catch(e) {}
}

function findStaffByEmail(email, hashed) {
  var row = findRow('Users', 'email', email);
  if (!row) return { found: false };
  var status = String(row.status || '').toUpperCase();
  if (status === 'INACTIVE') return { found: false, error: 'Your account is inactive. Contact your administrator.' };
  if (status === 'LOCKED')   return { found: false, error: 'Your account is locked. Contact your administrator.' };
  if (isDateInFuture(row.locked_until))
    return { found: false, error: 'Account temporarily locked. Try again later.' };
  var storedHash = String(row.password_hash || '').trim();
  if (storedHash && storedHash !== hashed)
    return { found: false, wrongPassword: true, error: 'Incorrect password.' };
  return { found: true, user: row };
}

function findCustomerByEmail(email, hashed) {
  var row = findRow('Contacts', 'email', email);
  if (!row) return { found: false };
  var portalUser = String(row.is_portal_user || '').toUpperCase();
  if (portalUser === 'FALSE' || portalUser === '0')
    return { found: false, error: 'Portal access is not enabled for this account. Contact support.' };
  var status = String(row.status || '').toUpperCase();
  if (status === 'INACTIVE') return { found: false, error: 'Your account is inactive.' };
  if (status === 'LOCKED')   return { found: false, error: 'Your account is locked.' };
  if (isDateInFuture(row.locked_until))
    return { found: false, error: 'Account temporarily locked. Try again later.' };
  var storedHash = String(row.password_hash || '').trim();
  if (storedHash && storedHash !== hashed)
    return { found: false, wrongPassword: true, error: 'Incorrect password.' };
  return { found: true, contact: row };
}

// ================================================================
// SESSION MANAGEMENT
// ================================================================

function createSession(userId, userType, role, hoursValid) {
  var rawToken  = Utilities.getUuid() + Date.now().toString(36);
  var tokenHash = hashPassword(rawToken);
  var sessionId = generateUUID();
  var now       = new Date().toISOString();
  var expiresAt = new Date(Date.now() + hoursValid * 3600000).toISOString();

  // Concurrent session control: invalidate oldest sessions over the limit.
  try {
    var maxSessions = _getMaxConcurrentSessions_();
    var activeSessions = tursoSelect(
      "SELECT session_id FROM sessions WHERE user_id = ? AND is_active = 1 AND expires_at > ? " +
      "ORDER BY created_at ASC",
      [userId, now]
    );
    if (activeSessions.length >= maxSessions) {
      var toExpire = activeSessions.slice(0, activeSessions.length - maxSessions + 1);
      toExpire.forEach(function(s) {
        try {
          tursoWrite('UPDATE sessions SET is_active = 0, updated_at = ? WHERE session_id = ?',
            [now, s.session_id]);
        } catch(e) {}
      });
    }
  } catch(e) {
    Logger.log('[AuthService] concurrent session cleanup error: ' + e.message);
  }

  tursoWrite(
    'INSERT INTO sessions (session_id, user_id, user_type, role, token_hash, ' +
    'is_active, expires_at, last_active_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [sessionId, userId, userType, role, tokenHash, 1, expiresAt, now, now, now]
  );
  return rawToken;
}

function checkSession(params) {
  var token = String(params.token || '').trim();
  if (!token) return { valid: false };
  var tokenHash = hashPassword(token);
  var session = findRow('Sessions', 'token_hash', tokenHash);
  if (!session)              return { valid: false };
  if (session.is_active != 1) return { valid: false };
  var now = new Date();
  if (new Date(session.expires_at) < now) return { valid: false };

  // Idle timeout check (G-010).
  if (session.last_active_at) {
    var idleMs      = now - new Date(session.last_active_at);
    var idleTimeout = _getIdleTimeoutMinutes_() * 60 * 1000;
    if (idleMs > idleTimeout) {
      try {
        tursoWrite('UPDATE sessions SET is_active = 0, updated_at = ? WHERE session_id = ?',
          [now.toISOString(), session.session_id]);
      } catch(e) {}
      try {
        auditLogCustom(session.user_type === 'STAFF' ? 'User' : 'Contact',
          session.user_id, session.user_id, 'SESSION_IDLE_EXPIRED',
          { session_id: session.session_id, idle_minutes: Math.round(idleMs / 60000) }, '');
      } catch(e) {}
      return { valid: false, reason: 'idle_timeout' };
    }
  }

  // Touch last_active_at to keep the idle clock fresh (best-effort).
  try {
    tursoWrite('UPDATE sessions SET last_active_at = ?, updated_at = ? WHERE session_id = ?',
      [now.toISOString(), now.toISOString(), session.session_id]);
  } catch(e) {}

  return {
    valid:    true,
    userId:   session.user_id,
    userType: session.user_type,
    role:     session.role,
    token:    token,
  };
}

function logoutUser(params) {
  var token = String(params.token || '').trim();
  if (!token) return { success: true };
  var tokenHash = hashPassword(token);
  var sess = findRow('Sessions', 'token_hash', tokenHash);
  updateRow('Sessions', 'token_hash', tokenHash, { is_active: 0 });
  if (sess) {
    try {
      var entityType = sess.user_type === 'STAFF' ? 'User'
                     : sess.user_type === 'CUSTOMER' ? 'Contact' : 'Session';
      auditLogCustom(entityType, sess.user_id, sess.user_id, 'LOGOUT',
        { session_id: sess.session_id, userType: sess.user_type }, '');
    } catch(e) {}
  }
  return { success: true };
}

function updateLastLogin(sheetName, idField, idValue) {
  try {
    updateRow(sheetName, idField, idValue, { last_login_at: new Date().toISOString() });
  } catch(e) {
    Logger.log('updateLastLogin: ' + e.message);
  }
}

// ================================================================
// CUSTOMER SIGNUP
// ================================================================

function signupCustomer(params) {
  var email       = String(params.email       || '').trim().toLowerCase();
  var name        = String(params.name        || '').trim();
  var phone       = String(params.phone       || '').trim();
  var password    = String(params.password    || '').trim();
  var accountType = String(params.accountType || params.account_type  || '').trim();
  var companyName = String(params.companyName || params.company_name  || '').trim();
  var extra       = (params.extraFields && typeof params.extraFields === 'object') ? params.extraFields : {};
  if (!email)    return { success: false, error: 'Email is required.' };
  if (!name)     return { success: false, error: 'Full name is required.' };
  if (!password) return { success: false, error: 'Password is required.' };
  // G-009: enforce full policy on new signups.
  try { validatePasswordPolicy(password); } catch(pe) { return { success: false, error: pe.message }; }
  if (accountType === 'Corporate Account' && !String(extra.kraPin || '').trim()) {
    return { success: false, error: 'KRA PIN is required for corporate sign-ups.' };
  }

  var existing = findCustomerByEmail(email, '');
  if (existing.found) return { success: false, error: 'An account with this email already exists. Please sign in.' };

  // Check for duplicate pending signup
  var pendingRows = getSheetData('SignupRequests');
  for (var p = 0; p < pendingRows.length; p++) {
    if (String(pendingRows[p].email || '').trim().toLowerCase() === email &&
        String(pendingRows[p].status || '').toUpperCase() === 'PENDING_APPROVAL') {
      return { success: false, error: 'A signup request for this email is already pending approval.' };
    }
  }

  var parts     = name.split(' ');
  var firstName = parts[0] || name;
  var lastName  = parts.length > 1 ? parts.slice(1).join(' ') : '';
  var requestId = 'SRQ' + Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
  var now       = new Date().toISOString();
  var kraPin    = String(extra.kraPin || '').trim().toUpperCase();
  var accountNo = String(extra.accountNumber || params.accountNumber || '').trim();

  appendRow('SignupRequests', {
    request_id:          requestId,
    company_name:        companyName || (accountType !== 'Corporate Account' ? name : ''),
    first_name:          firstName,
    last_name:           lastName,
    email:               email,
    phone:               phone,
    account_type:        accountType,
    customer_id:         String(params.verifiedCustomerId || ''),
    job_title:           String(extra.jobTitle || params.jobTitle || ''),
    kra_pin:             kraPin,
    tax_pin:             kraPin,
    account_number:      accountNo,
    certificate_of_incorporation: String(extra.certificateOfIncorporation || ''),
    company_address:     String(extra.companyAddress || ''),
    card_number:         String(extra.cardNumber || ''),
    dealer_code:         String(extra.dealerCode || ''),
    station_name:        String(extra.stationName || ''),
    kyc_status:          'PENDING_DOCS',
    submitted_at:        now,
    status:              'PENDING_APPROVAL',
    approved_by:         '',
    approved_at:         '',
    rejection_reason:    '',
    rejected_at:         '',
  });

  PropertiesService.getScriptProperties().setProperty(
    'PENDING_SIGNUP_' + requestId,
    JSON.stringify({ password_hash: hashPassword(password), phone: phone, name: name, extra: extra })
  );

  try {
    var adminEmail = PropertiesService.getScriptProperties().getProperty('SUPER_ADMIN_EMAIL');
    if (adminEmail) {
      MailApp.sendEmail({
        to:      adminEmail,
        subject: 'New Customer Portal Signup - Pending Approval',
        body:    'A new customer portal signup request has been submitted.\n\n'
          + 'Company: ' + (companyName || '(not provided)') + '\n'
          + 'Name: '    + name + '\n'
          + 'Email: '   + email + '\n'
          + 'Account Type: ' + (accountType || '(not provided)') + '\n\n'
          + 'Review and approve in the Staff Portal under Users & Roles > Pending Signups.\n\n'
          + 'Hass Petroleum Group',
      });
    }
  } catch(e) { Logger.log('Super Admin notification failed: ' + e.message); }

  try {
    MailApp.sendEmail({
      to:      email,
      subject: 'Hass Petroleum Portal - Signup Received',
      body:    'Hello ' + firstName + ',\n\n'
        + 'Your portal signup request has been received and is pending approval by our team.\n'
        + 'You will receive an email once your account has been reviewed.\n\n'
        + 'Hass Petroleum Group',
    });
  } catch(e) { Logger.log('Signup ack email failed: ' + e.message); }

  return { success: true, message: 'Signup request submitted. You will receive an email once approved.' };
}

function verifyCustomerAccount(params) {
  var companyName   = String(params.companyName   || '').trim().toLowerCase();
  var accountNumber = String(params.accountNumber || '').trim().toLowerCase();
  if (!companyName && !accountNumber)
    return { verified: false, error: 'Enter your company name or account number.' };

  var rows = getSheetData('Customers');
  for (var i = 0; i < rows.length; i++) {
    var row   = rows[i];
    var acct  = String(row.account_number || '').trim().toLowerCase();
    var cname = String(row.company_name   || '').trim().toLowerCase();
    var trade = String(row.trading_name   || '').trim().toLowerCase();
    if ((accountNumber && acct === accountNumber) ||
        (companyName && (cname.indexOf(companyName) !== -1 || trade.indexOf(companyName) !== -1))) {
      return {
        verified:      true,
        customerId:    String(row.customer_id),
        companyName:   String(row.company_name),
        accountNumber: String(row.account_number),
      };
    }
  }
  return { verified: false, error: 'Company not found. Check your account number or company name.' };
}

// ================================================================
// PASSWORD RESET
// ================================================================

function requestPasswordReset(params) {
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) return { success: false, error: 'Email is required.' };
  var sr = findStaffByEmail(email, '');
  var cr = sr.found ? null : findCustomerByEmail(email, '');
  if (!sr.found && (!cr || !cr.found)) return { success: true };
  var otp       = Math.floor(100000 + Math.random() * 900000).toString();
  var hashedOtp = hashPassword(otp);
  var expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  var userType  = sr.found ? 'STAFF'    : 'CUSTOMER';
  var userId    = sr.found ? sr.user.user_id : cr.contact.contact_id;

  appendRow('PasswordResets', {
    email:      email,
    otp_hash:   hashedOtp,
    expires_at: expiresAt,
    user_type:  userType,
    user_id:    userId,
    used:       false,
    created_at: new Date().toISOString(),
  });
  try {
    auditLogCustom(userType === 'STAFF' ? 'User' : 'Contact', userId, userId,
      'PASSWORD_RESET_INITIATED', { email: email, userType: userType }, '');
  } catch(e) {}

  try {
    var firstName = '';
    if (sr.found)        firstName = String((sr.user && sr.user.first_name) || '').trim();
    else if (cr && cr.found) firstName = String((cr.contact && cr.contact.first_name) || '').trim();
    var greeting = firstName ? ('Hi ' + firstName + ',') : 'Hello,';
    var brandNavy = '#1A237E';
    var supportPhone = 'Hass Petroleum Customer Experience: +254 709 906 000';
    var supportEmail = 'support@hasspetroleum.com';

    var html =
      '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 0;">' +
          '<tr><td align="center">' +
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e2e8f0;">' +
              '<tr><td style="background:' + brandNavy + ';padding:18px 24px;border-radius:10px 10px 0 0;color:#ffffff;font-size:14px;font-weight:600;letter-spacing:0.5px;">' +
                'Hass Petroleum Customer Experience' +
              '</td></tr>' +
              '<tr><td style="padding:28px 28px 8px 28px;font-size:18px;font-weight:600;color:#0f172a;">' +
                'Your password reset code' +
              '</td></tr>' +
              '<tr><td style="padding:0 28px 16px 28px;font-size:14px;line-height:1.6;color:#334155;">' +
                greeting + '<br><br>' +
                'Use the code below to reset your Hass Petroleum portal password. ' +
                'It is good for the next 15 minutes.' +
              '</td></tr>' +
              '<tr><td style="padding:0 28px 16px 28px;">' +
                '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
                  '<tr><td style="padding:18px 20px;text-align:center;">' +
                    '<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#64748b;text-transform:uppercase;margin-bottom:6px;">Reset code</div>' +
                    '<div style="font-family:Consolas,Menlo,monospace;font-size:26px;font-weight:700;letter-spacing:6px;color:' + brandNavy + ';">' + otp + '</div>' +
                  '</td></tr>' +
                '</table>' +
              '</td></tr>' +
              '<tr><td style="padding:0 28px 20px 28px;font-size:13px;line-height:1.6;color:#475569;">' +
                'If you did not ask for a reset, you can safely ignore this email and your password will stay the same. ' +
                'If you would like us to look into it, just reply or call us on +254 709 906 000.' +
              '</td></tr>' +
              '<tr><td style="padding:18px 28px 22px 28px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;">' +
                'Warm regards,<br>' +
                '<strong style="color:#0f172a;">Hass Petroleum Customer Experience Team</strong>' +
              '</td></tr>' +
              '<tr><td style="padding:14px 28px 22px 28px;border-top:1px solid #e2e8f0;background:#f8fafc;border-radius:0 0 10px 10px;font-size:11px;color:#64748b;line-height:1.6;">' +
                'Hass Petroleum Group, Hass Plaza, Mombasa Road, Nairobi, Kenya<br>' +
                supportPhone + ' &nbsp;|&nbsp; ' + supportEmail + '<br><br>' +
                'This message was sent on behalf of the Hass Petroleum Customer Experience team. We are here to help, just reply.' +
              '</td></tr>' +
            '</table>' +
          '</td></tr>' +
        '</table>' +
      '</body></html>';

    var text =
      greeting + '\n\n' +
      'Use the code below to reset your Hass Petroleum portal password. It is good for the next 15 minutes.\n\n' +
      'Reset code: ' + otp + '\n\n' +
      'If you did not ask for a reset, you can safely ignore this email and your password will stay the same. ' +
      'If you would like us to look into it, just reply or call us on +254 709 906 000.\n\n' +
      'Warm regards,\n' +
      'Hass Petroleum Customer Experience Team\n\n' +
      '---\n' +
      'Hass Petroleum Group, Hass Plaza, Mombasa Road, Nairobi, Kenya\n' +
      supportPhone + ' | ' + supportEmail + '\n' +
      'This message was sent on behalf of the Hass Petroleum Customer Experience team. We are here to help, just reply.\n';

    MailApp.sendEmail({
      to:       email,
      name:     'Hass Petroleum Customer Experience',
      subject:  'Your Hass Petroleum portal password reset code',
      body:     text,
      htmlBody: html,
    });
  } catch(e) {
    return { success: false, error: 'Could not send reset email. Contact support.' };
  }
  return { success: true };
}

function verifyOtp(params) {
  var email = String(params.email || '').trim().toLowerCase();
  var otp   = String(params.otp   || '').trim();
  if (!email || !otp) return { success: false, error: 'Email and code are required.' };
  var hashed = hashPassword(otp);

  // Find most recent matching OTP row
  var rows = getSheetData('PasswordResets');
  for (var r = rows.length - 1; r >= 0; r--) {
    var row = rows[r];
    if (String(row.email    || '').trim().toLowerCase() !== email)  continue;
    if (String(row.otp_hash || '').trim()               !== hashed) continue;
    var used = String(row.used || '').toUpperCase();
    if (used === 'TRUE' || used === '1') continue;
    if (new Date(row.expires_at) < new Date())
      return { success: false, error: 'Code expired. Request a new one.' };
    // Mark as used
    updateRow('PasswordResets', 'email', email, { used: true });
    return { success: true, email: email };
  }
  return { success: false, error: 'Invalid or expired code.' };
}

function setNewPassword(params) {
  var email    = String(params.email       || '').trim().toLowerCase();
  var password = String(params.newPassword || '').trim();
  if (!email || !password) return { success: false, error: 'Email and new password are required.' };

  // Apply full password policy (G-009).
  // Resolve userId first for history check.
  var staffRow   = findRow('Users',    'email', email);
  var contactRow = findRow('Contacts', 'email', email);
  var userId   = staffRow ? staffRow.user_id : (contactRow ? contactRow.contact_id : null);
  var userType = staffRow ? 'STAFF' : 'CUSTOMER';
  try {
    validatePasswordPolicy(password, userId, userType);
  } catch(pe) {
    return { success: false, error: pe.message };
  }

  var hashed = hashPassword(password);
  var now    = new Date().toISOString();

  if (staffRow) {
    recordPasswordHistory(staffRow.user_id, 'STAFF', String(staffRow.password_hash || ''));
    updateRow('Users', 'user_id', staffRow.user_id, { password_hash: hashed, password_changed_at: now });
    try {
      auditLogCustom('User', staffRow.user_id, staffRow.user_id, 'PASSWORD_RESET_COMPLETED',
        { email: email, userType: 'STAFF' }, staffRow.country_code || '');
    } catch(e) {}
    return { success: true };
  }
  if (contactRow) {
    recordPasswordHistory(contactRow.contact_id, 'CUSTOMER', String(contactRow.password_hash || ''));
    updateRow('Contacts', 'contact_id', contactRow.contact_id, { password_hash: hashed, password_changed_at: now });
    try {
      auditLogCustom('Contact', contactRow.contact_id, contactRow.contact_id, 'PASSWORD_RESET_COMPLETED',
        { email: email, userType: 'CUSTOMER' }, '');
    } catch(e) {}
    return { success: true };
  }
  return { success: false, error: 'Account not found.' };
}

// ================================================================
// STAFF INFO
// ================================================================

function getStaffInfo(userId) {
  try {
    var user = findRow('Users', 'user_id', userId);
    if (!user) return { name: userId, role: 'CS_AGENT' };
    return {
      name:    (user.first_name || '') + ' ' + (user.last_name || ''),
      role:    user.role,
      email:   user.email,
      country: user.country_code,
      team:    user.team_id,
    };
  } catch(e) {
    return { name: userId, role: 'CS_AGENT' };
  }
}

// ================================================================
// MFA ENROLMENT / CHALLENGE / DISABLE  (G-008)
// ================================================================

function _completeStaffLogin_(user, email) {
  // G-009: Force password change if expired.
  var expired = false;
  try { expired = isPasswordExpired(user.user_id, 'STAFF'); } catch(e) {}
  if (expired) {
    try {
      auditLogCustom('User', user.user_id, user.user_id, 'PASSWORD_EXPIRED',
        { email: email, userType: 'STAFF' }, user.country_code || '');
    } catch(e) {}
    return {
      success:          false,
      passwordExpired:  true,
      email:            email,
      error:            'Your password has expired. Please reset it to continue.',
      redirectUrl:      getScriptUrl() + '?page=reset-password&email=' + encodeURIComponent(email),
    };
  }

  var token = createSession(user.user_id, 'STAFF', user.role, 8);
  try {
    updateRow('Users', 'user_id', user.user_id, {
      last_login_at:         new Date().toISOString(),
      failed_login_attempts: 0,
      locked_until:          '',
    });
  } catch(e) {
    updateLastLogin('Users', 'user_id', user.user_id);
  }
  try {
    auditLogCustom('User', user.user_id, user.user_id, 'LOGIN',
      { email: email, role: user.role, userType: 'STAFF' }, user.country_code || '');
  } catch(e) {}
  return {
    success:  true,
    token:    token,
    role:     user.role,
    userId:   user.user_id,
    name:     trim2(user.first_name) + ' ' + trim2(user.last_name),
    email:    email,
    userType: 'STAFF',
    redirectUrl: getScriptUrl() + '?page=staff&token=' + token,
  };
}

function _bumpStaffFailedAttempts_(userId) {
  if (!userId) return;
  try {
    var u = findRow('Users', 'user_id', userId);
    if (!u) return;
    var fails = (parseInt(u.failed_login_attempts, 10) || 0) + 1;
    var updates = { failed_login_attempts: fails };
    if (fails >= 5) {
      updates.locked_until = new Date(Date.now() + 15 * 60000).toISOString();
    }
    updateRow('Users', 'user_id', userId, updates);
  } catch(e) {
    Logger.log('[AuthService] _bumpStaffFailedAttempts_: ' + e.message);
  }
}

/**
 * Step 1 of enrolment: caller holds an enroll-mode challenge token.
 * Returns a freshly-generated TOTP secret + provisioning URI + QR URL.
 * Calling this resets any prior pending secret on the challenge.
 */
function mfaEnrollStart(params) {
  var token = String(params.challengeToken || '').trim();
  var entry = getMfaChallenge(token);
  if (!entry) return { success: false, error: 'Your enrolment session has expired. Please sign in again.' };
  if (entry.mode !== 'enroll') return { success: false, error: 'Invalid MFA mode for this challenge.' };

  var user = findRow('Users', 'user_id', entry.user_id);
  if (!user) return { success: false, error: 'Account not found.' };

  var secret = generateSecret();
  setMfaChallengePendingSecret(token, secret);
  var uri = provisioningUri(user.email, secret, 'Hass Petroleum');
  return {
    success:  true,
    secret:   secret,
    uri:      uri,
    qrUrl:    provisioningQrUrl(uri),
    email:    user.email,
    issuer:   'Hass Petroleum',
  };
}

/**
 * Step 2 of enrolment: verify the first TOTP code against the pending
 * secret. On success, persist the secret, set mfa_enabled=1, audit, and
 * issue a real session.
 */
function mfaEnrollVerify(params) {
  var token = String(params.challengeToken || '').trim();
  var code  = String(params.code           || '').trim();
  var entry = getMfaChallenge(token);
  if (!entry) return { success: false, error: 'Your enrolment session has expired. Please sign in again.' };
  if (entry.mode !== 'enroll') return { success: false, error: 'Invalid MFA mode for this challenge.' };
  if (!entry.pending_secret)   return { success: false, error: 'Start enrolment first.' };

  if (!verifyCode(entry.pending_secret, code)) {
    var bump = incrementChallengeFailure(token);
    if (bump && bump.exhausted) {
      try {
        auditLogCustom('User', entry.user_id, entry.user_id, 'MFA_VERIFY_FAILED',
          { stage: 'enroll', reason: 'too_many_attempts' }, '');
      } catch(e) {}
      return { success: false, error: 'Too many invalid attempts. Please sign in again.', restart: true };
    }
    try {
      auditLogCustom('User', entry.user_id, entry.user_id, 'MFA_VERIFY_FAILED',
        { stage: 'enroll' }, '');
    } catch(e) {}
    return { success: false, error: 'Invalid code. Try again.' };
  }

  var user = findRow('Users', 'user_id', entry.user_id);
  if (!user) return { success: false, error: 'Account not found.' };

  updateRow('Users', 'user_id', entry.user_id, {
    mfa_enabled: 1,
    mfa_secret:  entry.pending_secret,
  });
  try {
    auditLogCustom('User', entry.user_id, entry.user_id, 'MFA_ENROLLED',
      { email: user.email, role: user.role }, user.country_code || '');
  } catch(e) {}

  consumeMfaChallenge(token);
  // Re-load so completed login sees mfa_enabled=1.
  user = findRow('Users', 'user_id', entry.user_id) || user;
  return _completeStaffLogin_(user, String(user.email || '').toLowerCase());
}

/**
 * MFA challenge for already-enrolled users. Verifies the code against
 * the stored secret. On success, completes the session.
 */
function mfaVerify(params) {
  var token = String(params.challengeToken || '').trim();
  var code  = String(params.code           || '').trim();
  var entry = getMfaChallenge(token);
  if (!entry) return { success: false, error: 'Your sign-in session has expired. Please try again.' };
  if (entry.mode !== 'verify') return { success: false, error: 'Invalid MFA mode for this challenge.' };

  var user = findRow('Users', 'user_id', entry.user_id);
  if (!user) return { success: false, error: 'Account not found.' };

  if (String(user.mfa_enabled || '0') !== '1' || !user.mfa_secret) {
    consumeMfaChallenge(token);
    return { success: false, error: 'MFA is not active on this account. Please sign in again.', restart: true };
  }

  if (!verifyCode(user.mfa_secret, code)) {
    _bumpStaffFailedAttempts_(entry.user_id);
    var bump = incrementChallengeFailure(token);
    try {
      auditLogCustom('User', entry.user_id, entry.user_id, 'MFA_VERIFY_FAILED',
        { stage: 'verify' }, user.country_code || '');
    } catch(e) {}
    if (bump && bump.exhausted) {
      return { success: false, error: 'Too many invalid attempts. Please sign in again.', restart: true };
    }
    return { success: false, error: 'Invalid code. Try again.' };
  }

  consumeMfaChallenge(token);
  try {
    auditLogCustom('User', entry.user_id, entry.user_id, 'MFA_VERIFIED',
      { email: user.email, role: user.role }, user.country_code || '');
  } catch(e) {}
  return _completeStaffLogin_(user, String(user.email || '').toLowerCase());
}

/**
 * SUPER_ADMIN-only: clear MFA on another user's account so the user can
 * re-enrol on next login. Caller must (a) be authenticated, (b) hold
 * SUPER_ADMIN, (c) have MFA enrolled themselves (no chicken-and-egg).
 *
 * Required params:
 *   token       - caller's session token
 *   targetUserId
 *   reason      - free text, written to audit metadata
 */
function mfaDisableForUser(params) {
  var sessionToken = String(params.token || '').trim();
  var targetId     = String(params.targetUserId || '').trim();
  var reason       = String(params.reason       || '').trim();
  if (!sessionToken) return { success: false, error: 'Authentication required.' };
  if (!targetId)     return { success: false, error: 'targetUserId is required.' };
  if (!reason)       return { success: false, error: 'A reason is required for the audit log.' };

  var session = checkSession({ token: sessionToken });
  if (!session.valid || session.userType !== 'STAFF') {
    return { success: false, error: 'Authentication required.' };
  }

  var caller = findRow('Users', 'user_id', session.userId);
  if (!caller) return { success: false, error: 'Caller not found.' };
  if (String(caller.role || '').toUpperCase() !== 'SUPER_ADMIN') {
    return { success: false, error: 'Only SUPER_ADMIN can disable MFA on another user.' };
  }
  if (String(caller.mfa_enabled || '0') !== '1') {
    return { success: false, error: 'You must have MFA enrolled before you can disable it for other users.' };
  }

  var target = findRow('Users', 'user_id', targetId);
  if (!target) return { success: false, error: 'Target user not found.' };

  updateRow('Users', 'user_id', targetId, {
    mfa_enabled: 0,
    mfa_secret:  '',
  });
  try {
    auditLogCustom('User', targetId, session.userId, 'MFA_DISABLED',
      { reason: reason, target_email: target.email || '', target_role: target.role || '' },
      target.country_code || '');
  } catch(e) {}
  return { success: true };
}

function getLogoUrl() {
  try {
    var folder = DriveApp.getFolderById('1AL9fUgYXM9DXj9-X_0YonrloqCXat2wq');
    var files  = folder.getFilesByName('Hass-Group-Google-Logo.png');
    if (files.hasNext()) {
      var file = files.next();
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return 'https://lh3.googleusercontent.com/d/' + file.getId();
    }
  } catch(e) { Logger.log('getLogoUrl: ' + e.message); }
  return '';
}
