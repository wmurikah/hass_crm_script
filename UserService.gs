/**
 * HASS PETROLEUM CMS - USER SERVICE
 * Manages staff users and customer accounts
 */

function handleUserRequest(params) {
  try {
    var action = params.action;
    switch (action) {
      case 'getAllStaff':
        return getAllStaff();
      case 'getAllCustomers':
        return getAllCustomers();
      case 'addStaffUser':
        return addStaffUser(params.data);
      case 'updateStaffRole':
        return updateStaffRole(params.userId, params.newRole);
      case 'setUserStatus':
        return setUserStatus(params.userId, params.status);
      case 'resetUserPassword':
        return resetUserPassword(params.userId, params.userType);
      case 'getCustomerContacts':
        return getCustomerContacts(params.customerId);
      case 'setContactPortalAccess':
        return setContactPortalAccess(params.contactId, params.hasAccess);
      default:
        return { success: false, error: 'Unknown user action: ' + action };
    }
  } catch (e) {
    Logger.log('[UserService] error: ' + e.message);
    return { success: false, error: 'User service error: ' + e.message };
  }
}

/**
 * Returns all staff users from the Users sheet
 */
function getAllStaff() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  if (!sheet) return { success: false, error: 'Users sheet not found' };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, staff: [] };

  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var staff = [];

  for (var r = 1; r < data.length; r++) {
    var row = {};
    for (var c = 0; c < headers.length; c++) {
      row[headers[c]] = data[r][c];
    }
    staff.push({
      user_id: row.user_id || '',
      email: row.email || '',
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      role: row.role || '',
      country_code: row.country_code || '',
      team_id: row.team_id || '',
      status: row.status || 'ACTIVE',
      last_login: row.updated_at || '',
      phone: row.phone || ''
    });
  }

  return { success: true, staff: staff };
}

/**
 * Returns all customers with their contact counts
 */
function getAllCustomers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Get customers
  var custSheet = ss.getSheetByName('Customers');
  if (!custSheet) return { success: false, error: 'Customers sheet not found' };

  var custData = custSheet.getDataRange().getValues();
  if (custData.length < 2) return { success: true, customers: [] };

  var custHeaders = custData[0].map(function(h) { return String(h || '').toLowerCase().trim(); });

  // Get contacts for counting
  var contSheet = ss.getSheetByName('Contacts');
  var contactCounts = {};
  if (contSheet) {
    var contData = contSheet.getDataRange().getValues();
    var contHeaders = contData[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
    var custIdCol = contHeaders.indexOf('customer_id');
    for (var i = 1; i < contData.length; i++) {
      var cid = String(contData[i][custIdCol] || '').trim();
      if (cid) contactCounts[cid] = (contactCounts[cid] || 0) + 1;
    }
  }

  var customers = [];
  for (var r = 1; r < custData.length; r++) {
    var row = {};
    for (var c = 0; c < custHeaders.length; c++) {
      row[custHeaders[c]] = custData[r][c];
    }
    var customerId = row.customer_id || '';
    customers.push({
      customer_id: customerId,
      company_name: row.company_name || '',
      account_number: row.account_number || '',
      country_code: row.country_code || '',
      credit_limit: row.credit_limit || 0,
      credit_used: row.credit_used || 0,
      status: row.status || 'ACTIVE',
      contact_count: contactCounts[customerId] || 0,
      segment_id: row.segment_id || '',
      currency_code: row.currency_code || 'USD'
    });
  }

  return { success: true, customers: customers };
}

/**
 * Adds a new staff user
 */
function addStaffUser(data) {
  if (!data || !data.email || !data.first_name || !data.last_name || !data.role) {
    return { success: false, error: 'Missing required fields: first_name, last_name, email, role' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  if (!sheet) return { success: false, error: 'Users sheet not found' };

  // Check for duplicate email
  var existing = sheet.getDataRange().getValues();
  var headers = existing[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var emailCol = headers.indexOf('email');
  for (var r = 1; r < existing.length; r++) {
    if (String(existing[r][emailCol] || '').toLowerCase().trim() === data.email.toLowerCase().trim()) {
      return { success: false, error: 'A user with this email already exists' };
    }
  }

  // Generate temp password
  var tempPassword = generateTempPassword();
  var hashedPassword = hashPassword(tempPassword);

  // Generate user ID
  var userId = 'USR' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  var now = new Date().toISOString();

  // Build row matching headers
  var newRow = headers.map(function(h) {
    switch (h) {
      case 'user_id': return userId;
      case 'email': return data.email.trim();
      case 'first_name': return data.first_name.trim();
      case 'last_name': return data.last_name.trim();
      case 'phone': return data.phone || '';
      case 'role': return data.role;
      case 'team_id': return data.team_id || '';
      case 'country_code': return data.country_code || '';
      case 'countries_access': return data.country_code || '';
      case 'status': return 'ACTIVE';
      case 'password_hash': return hashedPassword;
      case 'created_at': return now;
      case 'updated_at': return now;
      default: return '';
    }
  });

  sheet.appendRow(newRow);

  // Send welcome email
  try {
    MailApp.sendEmail({
      to: data.email.trim(),
      subject: 'Welcome to Hass Petroleum Portal — Your Account',
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">'
        + '<h2 style="color:#1A237E;">Welcome to Hass Petroleum Portal</h2>'
        + '<p>Hi ' + data.first_name + ',</p>'
        + '<p>Your staff account has been created. Here are your login credentials:</p>'
        + '<div style="background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;">'
        + '<p style="margin:4px 0;"><strong>Email:</strong> ' + data.email + '</p>'
        + '<p style="margin:4px 0;"><strong>Temporary Password:</strong> ' + tempPassword + '</p>'
        + '</div>'
        + '<p style="color:#dc2626;font-weight:600;">Please change your password on first login.</p>'
        + '<p>Best regards,<br>Hass Petroleum IT Team</p>'
        + '</div>'
    });
  } catch (e) {
    Logger.log('[UserService] Welcome email failed: ' + e.message);
  }

  return { success: true, userId: userId, message: 'Staff user created. Welcome email sent.' };
}

/**
 * Updates a staff user's role
 */
function updateStaffRole(userId, newRole) {
  if (!userId || !newRole) return { success: false, error: 'userId and newRole required' };

  var validRoles = ['SUPER_ADMIN', 'ADMIN', 'CS_MANAGER', 'CS_SUPERVISOR', 'CS_AGENT', 'BD_MANAGER', 'BD_REP', 'FINANCE_OFFICER', 'COUNTRY_MANAGER', 'REGIONAL_MANAGER', 'GROUP_HEAD', 'VIEWER'];
  if (validRoles.indexOf(newRole) === -1) return { success: false, error: 'Invalid role: ' + newRole };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var idCol = headers.indexOf('user_id');
  var roleCol = headers.indexOf('role');
  var updatedCol = headers.indexOf('updated_at');

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === userId) {
      sheet.getRange(r + 1, roleCol + 1).setValue(newRole);
      if (updatedCol > -1) sheet.getRange(r + 1, updatedCol + 1).setValue(new Date().toISOString());
      return { success: true, message: 'Role updated to ' + newRole };
    }
  }

  return { success: false, error: 'User not found' };
}

/**
 * Sets user status to ACTIVE or INACTIVE
 */
function setUserStatus(userId, status) {
  if (!userId || !status) return { success: false, error: 'userId and status required' };
  if (['ACTIVE', 'INACTIVE'].indexOf(status) === -1) return { success: false, error: 'Invalid status' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var idCol = headers.indexOf('user_id');
  var statusCol = headers.indexOf('status');
  var updatedCol = headers.indexOf('updated_at');

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === userId) {
      sheet.getRange(r + 1, statusCol + 1).setValue(status);
      if (updatedCol > -1) sheet.getRange(r + 1, updatedCol + 1).setValue(new Date().toISOString());
      return { success: true, message: 'Status updated to ' + status };
    }
  }

  return { success: false, error: 'User not found' };
}

/**
 * Resets a user's password — generates temp password, hashes, saves, emails user
 */
function resetUserPassword(userId, userType) {
  if (!userId) return { success: false, error: 'userId required' };

  var sheetName = (userType === 'CUSTOMER') ? 'Contacts' : 'Users';
  var idField = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { success: false, error: sheetName + ' sheet not found' };

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var idCol = headers.indexOf(idField);
  var pwCol = headers.indexOf('password_hash');
  var emailCol = headers.indexOf('email');
  var nameCol = headers.indexOf('first_name');
  var updatedCol = headers.indexOf('updated_at');

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === userId) {
      var tempPassword = generateTempPassword();
      var hashedPassword = hashPassword(tempPassword);

      if (pwCol > -1) sheet.getRange(r + 1, pwCol + 1).setValue(hashedPassword);
      if (updatedCol > -1) sheet.getRange(r + 1, updatedCol + 1).setValue(new Date().toISOString());

      var email = String(data[r][emailCol] || '').trim();
      var name = String(data[r][nameCol] || 'User').trim();

      if (email) {
        try {
          MailApp.sendEmail({
            to: email,
            subject: 'Hass Petroleum Portal — Password Reset',
            htmlBody: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">'
              + '<h2 style="color:#1A237E;">Password Reset</h2>'
              + '<p>Hi ' + name + ',</p>'
              + '<p>Your password has been reset. Your temporary password is:</p>'
              + '<div style="background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;text-align:center;">'
              + '<span style="font-family:monospace;font-size:20px;font-weight:700;letter-spacing:2px;">' + tempPassword + '</span>'
              + '</div>'
              + '<p style="color:#dc2626;font-weight:600;">Please change on first login.</p>'
              + '<p>Best regards,<br>Hass Petroleum IT Team</p>'
              + '</div>'
          });
        } catch (e) {
          Logger.log('[UserService] Reset email failed: ' + e.message);
        }
      }

      return { success: true, message: 'Password reset. Email sent to ' + email };
    }
  }

  return { success: false, error: 'User not found' };
}

/**
 * Returns contacts for a specific customer
 */
function getCustomerContacts(customerId) {
  if (!customerId) return { success: false, error: 'customerId required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Contacts');
  if (!sheet) return { success: false, error: 'Contacts sheet not found' };

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var custCol = headers.indexOf('customer_id');
  var contacts = [];

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][custCol] || '').trim() === customerId) {
      var contact = {};
      for (var c = 0; c < headers.length; c++) {
        if (headers[c] !== 'password_hash') {
          contact[headers[c]] = data[r][c];
        }
      }
      contacts.push(contact);
    }
  }

  return { success: true, contacts: contacts };
}

/**
 * Toggles portal access for a contact
 */
function setContactPortalAccess(contactId, hasAccess) {
  if (!contactId) return { success: false, error: 'contactId required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Contacts');
  if (!sheet) return { success: false, error: 'Contacts sheet not found' };

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h || '').toLowerCase().trim(); });
  var idCol = headers.indexOf('contact_id');
  var portalCol = headers.indexOf('is_portal_user');
  var updatedCol = headers.indexOf('updated_at');

  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idCol] || '').trim() === contactId) {
      if (portalCol > -1) sheet.getRange(r + 1, portalCol + 1).setValue(hasAccess ? true : false);
      if (updatedCol > -1) sheet.getRange(r + 1, updatedCol + 1).setValue(new Date().toISOString());
      return { success: true, message: 'Portal access ' + (hasAccess ? 'enabled' : 'disabled') };
    }
  }

  return { success: false, error: 'Contact not found' };
}

/**
 * Generates an 8-char temp password: uppercase + numbers + symbol
 */
function generateTempPassword() {
  var upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var digits = '23456789';
  var symbols = '!@#$%&*';
  var all = upper + digits + symbols;

  var pw = '';
  // Ensure at least one of each type
  pw += upper.charAt(Math.floor(Math.random() * upper.length));
  pw += upper.charAt(Math.floor(Math.random() * upper.length));
  pw += digits.charAt(Math.floor(Math.random() * digits.length));
  pw += digits.charAt(Math.floor(Math.random() * digits.length));
  pw += symbols.charAt(Math.floor(Math.random() * symbols.length));

  // Fill remaining 3 chars
  for (var i = 0; i < 3; i++) {
    pw += all.charAt(Math.floor(Math.random() * all.length));
  }

  // Shuffle
  return pw.split('').sort(function() { return 0.5 - Math.random(); }).join('');
}

/**
 * Hashes a password with SHA-256
 */
function hashPassword(password) {
  var rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password);
  return rawHash.map(function(b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
}
