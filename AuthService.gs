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
// LOGIN
// ================================================================

function loginUser(params) {
  var email    = String(params.email    || '').trim().toLowerCase();
  var password = String(params.password || '').trim();
  if (!email)    return { success: false, error: 'Email is required.' };
  if (!password) return { success: false, error: 'Password is required.' };
  var hashed = hashPassword(password);

  var sr = findStaffByEmail(email, hashed);
  if (sr.error) return { success: false, error: sr.error };
  if (sr.found) {
    var token = createSession(sr.user.user_id, 'STAFF', sr.user.role, 8);
    updateLastLogin('Users', 'user_id', sr.user.user_id);
    return { success: true, token: token, role: sr.user.role, userId: sr.user.user_id,
      name: trim2(sr.user.first_name) + ' ' + trim2(sr.user.last_name),
      email: email, userType: 'STAFF',
      redirectUrl: getScriptUrl() + '?page=staff&token=' + token };
  }

  var cr = findCustomerByEmail(email, hashed);
  if (cr.error) return { success: false, error: cr.error };
  if (cr.found) {
    var ctoken = createSession(cr.contact.contact_id, 'CUSTOMER', 'CUSTOMER', 24);
    updateLastLogin('Contacts', 'contact_id', cr.contact.contact_id);
    return { success: true, token: ctoken, role: 'CUSTOMER', userId: cr.contact.contact_id,
      customerId: String(cr.contact.customer_id || ''),
      name: trim2(cr.contact.first_name) + ' ' + trim2(cr.contact.last_name),
      email: email, userType: 'CUSTOMER',
      redirectUrl: getScriptUrl() + '?page=portal&token=' + ctoken };
  }

  return { success: false, error: 'No account found for this email address.' };
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
  tursoWrite(
    'INSERT INTO sessions (session_id, user_id, user_type, role, token_hash, ' +
    'is_active, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [sessionId, userId, userType, role, tokenHash, 1, expiresAt, now, now]
  );
  return rawToken;
}

function checkSession(params) {
  var token = String(params.token || '').trim();
  if (!token) return { valid: false };
  var tokenHash = hashPassword(token);
  var session = findRow('Sessions', 'token_hash', tokenHash);
  if (!session) return { valid: false };
  if (session.is_active != 1) return { valid: false };
  if (new Date(session.expires_at) < new Date()) return { valid: false };
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
  updateRow('Sessions', 'token_hash', tokenHash, { is_active: 0 });
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
  if (password.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
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
    MailApp.sendEmail({
      to:      email,
      subject: 'Hass Portal - Password reset code',
      body:    'Your reset code is: ' + otp + '\n\nExpires in 15 minutes.\n\nHass Petroleum Group',
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
  if (password.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
  var hashed = hashPassword(password);

  // Try Users first, then Contacts
  var staffRow    = findRow('Users',    'email', email);
  var contactRow  = findRow('Contacts', 'email', email);

  if (staffRow) {
    updateRow('Users', 'user_id', staffRow.user_id, { password_hash: hashed });
    return { success: true };
  }
  if (contactRow) {
    updateRow('Contacts', 'contact_id', contactRow.contact_id, { password_hash: hashed });
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
