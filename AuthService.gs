// ================================================================
// HASS PETROLEUM CMS — AuthService.gs
// Sheet-based auth. No Firebase. No Google OAuth.
// Matches HASS_CMS_DATABASE actual column structure.
//
// Users sheet    → staff login  (password_hash col added by setupAuth)
// Contacts sheet → customer login (password_hash col 14)
// Sessions sheet → token_hash, is_active, expires_at, role
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
  } catch (e) {
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

function normaliseHeaders(row) {
  return row.map(function(h) { return String(h || '').toLowerCase().trim().replace(/\s+/g, '_'); });
}

function trim2(v) { return String(v || '').trim(); }

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
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  if (!sheet) return { found: false, error: 'System error: Users sheet missing.' };
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.email || '').trim().toLowerCase() !== email) continue;
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
  return { found: false };
}

function findCustomerByEmail(email, hashed) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Contacts');
  if (!sheet) return { found: false, error: 'System error: Contacts sheet missing.' };
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.email || '').trim().toLowerCase() !== email) continue;
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
  return { found: false };
}

function createSession(userId, userType, role, hoursValid) {
  var rawToken  = Utilities.getUuid() + Utilities.getUuid().replace(/-/g,'');
  var tokenHash = hashPassword(rawToken);
  var now       = new Date();
  var expiresAt = new Date(now.getTime() + hoursValid * 3600000);
  var sessionId = 'SES' + Utilities.getUuid().replace(/-/g,'').substring(0, 16).toUpperCase();
  // Object-based appendRow so column reordering in the sheet never silently corrupts data.
  appendRow('Sessions', {
    session_id:  sessionId,
    user_type:   userType,
    user_id:     userId,
    token_hash:  tokenHash,
    role:        role,
    is_active:   true,
    expires_at:  expiresAt.toISOString(),
    created_at:  now.toISOString(),
    updated_at:  now.toISOString(),
  });
  return rawToken;
}

function checkSession(params) {
  var token = String(params.token || '').trim();
  if (!token) return { valid: false, reason: 'no_token' };
  var tokenHash = hashPassword(token);
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Sessions');
  if (!sheet) return { valid: false, reason: 'no_sheet' };
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.token_hash || '').trim() !== tokenHash) continue;
    if (String(row.is_active || '').toUpperCase() === 'FALSE') return { valid: false, reason: 'logged_out' };
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false, reason: 'expired' };
    return { valid: true, userId: String(row.user_id || ''), userType: String(row.user_type || ''),
      role: String(row.role || ''), token: token };
  }
  return { valid: false, reason: 'not_found' };
}

function logoutUser(params) {
  var token = String(params.token || '').trim();
  if (!token) return { success: true };
  var tokenHash = hashPassword(token);
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Sessions');
  if (!sheet) return { success: true };
  var data = sheet.getDataRange().getValues();
  var h = normaliseHeaders(data[0]);
  var hashCol = h.indexOf('token_hash'), activeCol = h.indexOf('is_active');
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][hashCol] || '').trim() === tokenHash) {
      sheet.getRange(r + 1, activeCol + 1).setValue(false);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { success: true };
}

function updateLastLogin(sheetName, idField, idValue) {
  try {
    var ss = getSpreadsheet(), sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var h = normaliseHeaders(data[0]);
    var idCol = h.indexOf(idField), llCol = h.indexOf('last_login');
    if (idCol < 0 || llCol < 0) return;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idCol] || '').trim() === idValue) {
        sheet.getRange(r + 1, llCol + 1).setValue(new Date().toISOString());
        SpreadsheetApp.flush(); return;
      }
    }
  } catch(e) { Logger.log('updateLastLogin: ' + e.message); }
}

function signupCustomer(params) {
  var email = String(params.email || '').trim().toLowerCase();
  var name  = String(params.name  || '').trim();
  var phone = String(params.phone || '').trim();
  var password = String(params.password || '').trim();
  var accountType = String(params.accountType || params.account_type || '').trim();
  var companyName = String(params.companyName || params.company_name || '').trim();
  if (!email)    return { success: false, error: 'Email is required.' };
  if (!name)     return { success: false, error: 'Full name is required.' };
  if (!password) return { success: false, error: 'Password is required.' };
  if (password.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
  var existing = findCustomerByEmail(email, '');
  if (existing.found) return { success: false, error: 'An account with this email already exists. Please sign in.' };

  var ss = getSpreadsheet();
  var reqSheet = ss.getSheetByName('SignupRequests');
  if (!reqSheet) {
    reqSheet = ss.insertSheet('SignupRequests');
    reqSheet.appendRow([
      'request_id','company_name','first_name','email','account_type','customer_id',
      'submitted_at','status','approved_by','approved_at','rejection_reason','rejected_at'
    ]);
  }

  var parts = name.split(' ');
  var firstName = parts[0] || name;
  var requestId = 'SRQ' + Utilities.getUuid().replace(/-/g,'').substring(0,12).toUpperCase();
  var now = new Date().toISOString();
  var pendingCheck = reqSheet.getDataRange().getValues();
  if (pendingCheck.length > 1) {
    var headers = pendingCheck[0].map(function(h){ return String(h||'').toLowerCase().trim(); });
    var emailCol = headers.indexOf('email');
    var statusCol = headers.indexOf('status');
    for (var r = 1; r < pendingCheck.length; r++) {
      if (String(pendingCheck[r][emailCol]||'').trim().toLowerCase() === email
          && String(pendingCheck[r][statusCol]||'').toUpperCase() === 'PENDING_APPROVAL') {
        return { success: false, error: 'A signup request for this email is already pending approval.' };
      }
    }
  }

  reqSheet.appendRow([
    requestId, companyName, firstName, email, accountType, String(params.verifiedCustomerId || ''),
    now, 'PENDING_APPROVAL', '', '', '', ''
  ]);
  SpreadsheetApp.flush();

  PropertiesService.getScriptProperties().setProperty('PENDING_SIGNUP_' + requestId,
    JSON.stringify({ password_hash: hashPassword(password), phone: phone, name: name }));

  try {
    var adminEmail = PropertiesService.getScriptProperties().getProperty('SUPER_ADMIN_EMAIL');
    if (adminEmail) {
      MailApp.sendEmail({
        to: adminEmail,
        subject: 'New Customer Portal Signup — Pending Approval',
        body: 'A new customer portal signup request has been submitted.\n\n'
          + 'Company: ' + (companyName || '(not provided)') + '\n'
          + 'Name: ' + name + '\n'
          + 'Email: ' + email + '\n'
          + 'Account Type: ' + (accountType || '(not provided)') + '\n\n'
          + 'Review and approve in the Staff Portal under Users & Roles > Pending Signups.\n\n'
          + 'Hass Petroleum Group'
      });
    }
  } catch(e) { Logger.log('Super Admin notification failed: ' + e.message); }

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Hass Petroleum Portal — Signup Received',
      body: 'Hello ' + firstName + ',\n\n'
        + 'Your portal signup request has been received and is pending approval by our team.\n'
        + 'You will receive an email once your account has been reviewed.\n\n'
        + 'Hass Petroleum Group'
    });
  } catch(e) { Logger.log('Signup ack email failed: ' + e.message); }

  return { success: true, message: 'Signup request submitted. You will receive an email once approved.' };
}

function verifyCustomerAccount(params) {
  var companyName   = String(params.companyName   || '').trim().toLowerCase();
  var accountNumber = String(params.accountNumber || '').trim().toLowerCase();
  if (!companyName && !accountNumber)
    return { verified: false, error: 'Enter your company name or account number.' };
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('Customers');
  if (!sheet) return { verified: false, error: 'System error.' };
  var rows = sheetToObjects(sheet);
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var acct  = String(row.account_number || '').trim().toLowerCase();
    var cname = String(row.company_name   || '').trim().toLowerCase();
    var trade = String(row.trading_name   || '').trim().toLowerCase();
    if ((accountNumber && acct === accountNumber) ||
        (companyName && (cname.includes(companyName) || trade.includes(companyName)))) {
      return { verified: true, customerId: String(row.customer_id),
        companyName: String(row.company_name), accountNumber: String(row.account_number) };
    }
  }
  return { verified: false, error: 'Company not found. Check your account number or company name.' };
}

function requestPasswordReset(params) {
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) return { success: false, error: 'Email is required.' };
  var sr = findStaffByEmail(email, '');
  var cr = sr.found ? null : findCustomerByEmail(email, '');
  if (!sr.found && (!cr || !cr.found)) return { success: true };
  var otp = Math.floor(100000 + Math.random() * 900000).toString();
  var hashedOtp = hashPassword(otp);
  var expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  var userType = sr.found ? 'STAFF' : 'CUSTOMER';
  var userId   = sr.found ? sr.user.user_id : cr.contact.contact_id;
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('PasswordResets');
  if (!sheet) {
    sheet = ss.insertSheet('PasswordResets');
    sheet.appendRow(['email','otp_hash','expires_at','user_type','user_id','used','created_at']);
  }
  sheet.appendRow([email, hashedOtp, expiresAt, userType, userId, false, new Date().toISOString()]);
  SpreadsheetApp.flush();
  try {
    MailApp.sendEmail({ to: email, subject: 'Hass Portal — Password reset code',
      body: 'Your reset code is: ' + otp + '\n\nExpires in 15 minutes.\n\nHass Petroleum Group' });
  } catch(e) { return { success: false, error: 'Could not send reset email. Contact support.' }; }
  return { success: true };
}

function verifyOtp(params) {
  var email = String(params.email || '').trim().toLowerCase();
  var otp   = String(params.otp   || '').trim();
  if (!email || !otp) return { success: false, error: 'Email and code are required.' };
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName('PasswordResets');
  if (!sheet) return { success: false, error: 'Invalid or expired code.' };
  var data = sheet.getDataRange().getValues();
  var h = normaliseHeaders(data[0]);
  var eCol = h.indexOf('email'), oCol = h.indexOf('otp_hash'),
      xCol = h.indexOf('expires_at'), uCol = h.indexOf('used');
  var hashed = hashPassword(otp);
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][eCol]||'').trim().toLowerCase() !== email) continue;
    if (String(data[r][oCol]||'').trim() !== hashed) continue;
    var used = String(data[r][uCol]||'').toUpperCase();
    if (used === 'TRUE' || used === '1') continue;
    if (new Date(data[r][xCol]) < new Date()) return { success: false, error: 'Code expired. Request a new one.' };
    sheet.getRange(r + 1, uCol + 1).setValue(true);
    SpreadsheetApp.flush();
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
  var ss = getSpreadsheet();
  var sheets = [ ['Users','email','password_hash'], ['Contacts','email','password_hash'] ];
  for (var s = 0; s < sheets.length; s++) {
    var sheet = ss.getSheetByName(sheets[s][0]);
    if (!sheet) continue;
    var data = sheet.getDataRange().getValues();
    var h = normaliseHeaders(data[0]);
    var eCol = h.indexOf(sheets[s][1]), pwCol = h.indexOf(sheets[s][2]);
    if (eCol < 0 || pwCol < 0) continue;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][eCol]||'').trim().toLowerCase() === email) {
        sheet.getRange(r + 1, pwCol + 1).setValue(hashed);
        SpreadsheetApp.flush();
        return { success: true };
      }
    }
  }
  return { success: false, error: 'Account not found.' };
}

function getStaffInfo(userId) {
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName('Users');
    var rows = sheetToObjects(sheet);
    var user = rows.find(function(r){ return r.user_id === userId; });
    if (!user) return { name: userId, role: 'CS_AGENT' };
    return {
      name: (user.first_name||'') + ' ' + (user.last_name||''),
      role: user.role,
      email: user.email,
      country: user.country_code,
      team: user.team_id
    };
  } catch(e) { return { name: userId, role: 'CS_AGENT' }; }
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