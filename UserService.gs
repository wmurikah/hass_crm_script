/**
 * HASS PETROLEUM CMS - USER SERVICE
 * Version: 3.0.0
 *
 * Manages staff users and customer accounts.
 * All reads/writes go to Turso via DatabaseSetup helpers.
 */

function handleUserRequest(params) {
  try {
    var action = params.action;
    var s = params._session;
    switch (action) {
      case 'getAllStaff':
        if (s) requirePermission(s, 'users.view');
        return getAllStaff();
      case 'getAllCustomers':
        if (s) requirePermission(s, 'customers.view');
        return getAllCustomers();
      case 'getStaffUser':
        if (s) requirePermission(s, 'users.view');
        return getStaffUser(params.userId);
      case 'addStaffUser':
        if (s) requirePermission(s, 'users.create');
        return addStaffUser(params.data);
      case 'updateStaffUser':
        if (s) requirePermission(s, 'users.edit');
        return updateStaffUser(params.userId, params.data);
      case 'updateStaffRole':
        if (s) requirePermission(s, 'roles.assign');
        return updateStaffRole(params.userId, params.newRole);
      case 'setUserStatus':
        if (s) requirePermission(s, 'users.delete');
        return setUserStatus(params.userId, params.status);
      case 'resetUserPassword':
        if (s) requirePermission(s, 'users.reset_password');
        return resetUserPassword(params.userId, params.userType);
      case 'getCustomerContacts':
        if (s) requirePermission(s, 'customers.view');
        return getCustomerContacts(params.customerId);
      case 'setContactPortalAccess':
        if (s) requirePermission(s, 'customers.edit');
        return setContactPortalAccess(params.contactId, params.hasAccess);
      case 'getPendingSignups':
        if (s) requirePermission(s, 'users.view');
        return getPendingSignups();
      case 'approveSignup':
        if (s) requirePermission(s, 'users.create');
        return approveSignup(params.requestId, params.approvedBy);
      case 'rejectSignup':
        if (s) requirePermission(s, 'users.create');
        return rejectSignup(params.requestId, params.reason);
      default:
        return { success: false, error: 'Unknown user action: ' + action };
    }
  } catch(e) {
    Logger.log('[UserService] error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// STAFF USERS
// ============================================================================

function getAllStaff() {
  var rows = getSheetData('Users');
  var staff = rows.map(function(row) {
    return {
      user_id:      row.user_id      || '',
      email:        row.email        || '',
      first_name:   row.first_name   || '',
      last_name:    row.last_name    || '',
      role:         row.role         || '',
      country_code: row.country_code || '',
      team_id:      row.team_id      || '',
      status:       row.status       || 'ACTIVE',
      last_login:   row.updated_at   || '',
      phone:        row.phone        || '',
    };
  });
  return { success: true, staff: staff };
}

function addStaffUser(data) {
  if (!data || !data.email || !data.first_name || !data.last_name || !data.role) {
    return { success: false, error: 'Missing required fields: first_name, last_name, email, role' };
  }

  // Check for duplicate email
  var existing = findRow('Users', 'email', data.email.trim().toLowerCase());
  if (existing) return { success: false, error: 'A user with this email already exists' };

  var tempPassword   = generateTempPassword();
  var hashedPassword = hashPassword(tempPassword);
  var userId = 'USR' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  var now    = new Date().toISOString();

  appendRow('Users', {
    user_id:          userId,
    email:            data.email.trim(),
    first_name:       data.first_name.trim(),
    last_name:        data.last_name.trim(),
    phone:            data.phone        || '',
    role:             data.role,
    team_id:          data.team_id      || '',
    country_code:     data.country_code || '',
    countries_access: data.country_code || '',
    status:           'ACTIVE',
    password_hash:    hashedPassword,
    created_at:       now,
    updated_at:       now,
  });

  try {
    MailApp.sendEmail({
      to:       data.email.trim(),
      subject:  'Welcome to Hass Petroleum Portal — Your Account',
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
        + '</div>',
    });
  } catch(e) {
    Logger.log('[UserService] Welcome email failed: ' + e.message);
  }

  return { success: true, userId: userId, message: 'Staff user created. Welcome email sent.' };
}

function getStaffUser(userId) {
  if (!userId) return { success: false, error: 'userId required' };
  var row = findRow('Users', 'user_id', userId);
  if (!row) return { success: false, error: 'User not found' };
  var safe = Object.assign({}, row);
  delete safe.password_hash;
  // Attach roles & permissions
  try {
    var roles = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [userId]);
    safe.assigned_roles = roles.map(function(r) { return r.role_code; });
    safe.permissions    = userPermissions(userId);
  } catch(e) {
    safe.assigned_roles = [];
    safe.permissions    = [];
  }
  return { success: true, user: safe };
}

/**
 * Edits arbitrary user details (Super Admin power).
 * Whitelisted fields only — never password_hash, never user_id.
 */
function updateStaffUser(userId, data) {
  if (!userId || !data) return { success: false, error: 'userId and data required' };
  var ALLOWED = ['first_name','last_name','email','phone','team_id','country_code',
                 'countries_access','reports_to','can_approve_orders','approval_limit',
                 'max_tickets','status','role'];
  var updates = {};
  ALLOWED.forEach(function(k) {
    if (data[k] !== undefined && data[k] !== null) updates[k] = data[k];
  });
  if (Object.keys(updates).length === 0) return { success: false, error: 'No editable fields provided' };

  // Email uniqueness check
  if (updates.email) {
    updates.email = String(updates.email).trim().toLowerCase();
    var dup = findRow('Users', 'email', updates.email);
    if (dup && dup.user_id !== userId) return { success: false, error: 'Email already in use by another user' };
  }
  var ok = updateRow('Users', 'user_id', userId, updates);
  if (!ok) return { success: false, error: 'User not found' };
  try { _invalidatePermissionCache(userId); } catch(e) {}
  return { success: true, message: 'User updated' };
}

function updateStaffRole(userId, newRole) {
  if (!userId || !newRole) return { success: false, error: 'userId and newRole required' };
  // Validate against Turso roles table (single source of truth)
  try {
    var found = tursoSelect('SELECT role_code FROM roles WHERE role_code = ?', [newRole]);
    if (!found.length) return { success: false, error: 'Invalid role: ' + newRole };
  } catch(e) {
    return { success: false, error: 'Could not validate role: ' + e.message };
  }

  var success = updateRow('Users', 'user_id', userId, { role: newRole });
  if (!success) return { success: false, error: 'User not found' };

  // Mirror to user_roles: clear other assignments, set this one as primary
  try {
    tursoWrite('DELETE FROM user_roles WHERE user_id = ?', [userId]);
    tursoWrite('INSERT INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
      [userId, newRole, 'STAFF_UI', new Date().toISOString()]);
    _invalidatePermissionCache(userId);
  } catch(e) {
    Logger.log('[UserService] user_roles sync failed: ' + e.message);
  }
  return { success: true, message: 'Role updated to ' + newRole };
}

function setUserStatus(userId, status) {
  if (!userId || !status) return { success: false, error: 'userId and status required' };
  if (['ACTIVE', 'INACTIVE'].indexOf(status) === -1) return { success: false, error: 'Invalid status' };

  var success = updateRow('Users', 'user_id', userId, { status: status });
  return success
    ? { success: true,  message: 'Status updated to ' + status }
    : { success: false, error:   'User not found' };
}

function resetUserPassword(userId, userType) {
  if (!userId) return { success: false, error: 'userId required' };

  var sheetName = (userType === 'CUSTOMER') ? 'Contacts' : 'Users';
  var idField   = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';

  var row = findRow(sheetName, idField, userId);
  if (!row) return { success: false, error: sheetName.replace('s','') + ' not found' };

  var tempPassword   = generateTempPassword();
  var hashedPassword = hashPassword(tempPassword);

  updateRow(sheetName, idField, userId, { password_hash: hashedPassword });

  var email = String(row.email || '').trim();
  var name  = String(row.first_name || 'User').trim();

  if (email) {
    try {
      MailApp.sendEmail({
        to:       email,
        subject:  'Hass Petroleum Portal — Password Reset',
        htmlBody: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">'
          + '<h2 style="color:#1A237E;">Password Reset</h2>'
          + '<p>Hi ' + name + ',</p>'
          + '<p>Your password has been reset. Your temporary password is:</p>'
          + '<div style="background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;text-align:center;">'
          + '<span style="font-family:monospace;font-size:20px;font-weight:700;letter-spacing:2px;">' + tempPassword + '</span>'
          + '</div>'
          + '<p style="color:#dc2626;font-weight:600;">Please change on first login.</p>'
          + '<p>Best regards,<br>Hass Petroleum IT Team</p>'
          + '</div>',
      });
    } catch(e) {
      Logger.log('[UserService] Reset email failed: ' + e.message);
    }
  }

  return { success: true, message: 'Password reset. Email sent to ' + email };
}

// ============================================================================
// CUSTOMERS
// ============================================================================

function getAllCustomers() {
  var customers = getSheetData('Customers');
  var contacts  = getSheetData('Contacts');

  // Build contact count index
  var contactCounts = {};
  contacts.forEach(function(c) {
    var cid = String(c.customer_id || '').trim();
    if (cid) contactCounts[cid] = (contactCounts[cid] || 0) + 1;
  });

  var result = customers.map(function(row) {
    var customerId = row.customer_id || '';
    return {
      customer_id:    customerId,
      company_name:   row.company_name   || '',
      account_number: row.account_number || '',
      country_code:   row.country_code   || '',
      credit_limit:   row.credit_limit   || 0,
      credit_used:    row.credit_used    || 0,
      status:         row.status         || 'ACTIVE',
      contact_count:  contactCounts[customerId] || 0,
      segment_id:     row.segment_id     || '',
      currency_code:  row.currency_code  || 'USD',
    };
  });

  return { success: true, customers: result };
}

function getCustomerContacts(customerId) {
  if (!customerId) return { success: false, error: 'customerId required' };
  var rows = findRows('Contacts', 'customer_id', customerId);
  // Exclude password_hash from response
  var contacts = rows.map(function(row) {
    var safe = Object.assign({}, row);
    delete safe.password_hash;
    return safe;
  });
  return { success: true, contacts: contacts };
}

function setContactPortalAccess(contactId, hasAccess) {
  if (!contactId) return { success: false, error: 'contactId required' };
  var success = updateRow('Contacts', 'contact_id', contactId, {
    is_portal_user: hasAccess ? true : false,
  });
  return success
    ? { success: true,  message: 'Portal access ' + (hasAccess ? 'enabled' : 'disabled') }
    : { success: false, error:   'Contact not found' };
}

// ============================================================================
// SIGNUP REQUESTS
// ============================================================================

function getPendingSignups() {
  try {
    var rows    = getSheetData('SignupRequests') || [];
    var pending = rows.filter(function(r) {
      return String(r.status || '').toUpperCase() === 'PENDING_APPROVAL';
    });
    return { success: true, requests: pending };
  } catch(e) {
    Logger.log('getPendingSignups error: ' + e.message);
    return { success: false, error: e.message, requests: [] };
  }
}

function approveSignup(requestId, approvedBy) {
  try {
    var rows = getSheetData('SignupRequests') || [];
    var req  = rows.find(function(r) { return r.request_id === requestId; });
    if (!req) return { success: false, error: 'Request not found' };

    var contactId = generateId('CON');
    appendRow('Contacts', {
      contact_id:     contactId,
      customer_id:    req.customer_id || '',
      first_name:     req.first_name  || req.company_name,
      last_name:      '',
      email:          req.email,
      contact_type:   'PRIMARY',
      is_portal_user: true,
      status:         'ACTIVE',
      created_at:     new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    });

    var tempPassword = generateTempPassword();
    appendRow('Users', {
      user_id:       contactId,
      email:         req.email,
      password_hash: hashPassword(tempPassword),
      role:          'CUSTOMER',
      status:        'ACTIVE',
      created_at:    new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    });

    updateRow('SignupRequests', 'request_id', requestId, {
      status:      'APPROVED',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
    });

    try {
      MailApp.sendEmail(req.email, 'Your Hass Petroleum Portal Access',
        'Dear ' + (req.first_name || req.company_name) + ',\n\n'
        + 'Your portal access has been approved.\n\n'
        + 'Email: '              + req.email + '\n'
        + 'Temporary Password: ' + tempPassword + '\n\n'
        + 'Please log in and change your password.\n\n'
        + 'Hass Petroleum Group');
    } catch(me) {
      Logger.log('approveSignup email error: ' + me.message);
    }

    clearSheetCache('SignupRequests');
    clearSheetCache('Contacts');
    clearSheetCache('Users');
    return { success: true, message: 'Signup approved and credentials sent' };
  } catch(e) {
    Logger.log('approveSignup error: ' + e.message);
    return { success: false, error: e.message };
  }
}

function rejectSignup(requestId, reason) {
  try {
    var rows = getSheetData('SignupRequests') || [];
    var req  = rows.find(function(r) { return r.request_id === requestId; });
    if (!req) return { success: false, error: 'Request not found' };

    updateRow('SignupRequests', 'request_id', requestId, {
      status:           'REJECTED',
      rejection_reason: reason || '',
      rejected_at:      new Date().toISOString(),
    });

    try {
      MailApp.sendEmail(req.email, 'Hass Petroleum Portal — Application Update',
        'Dear ' + (req.first_name || req.company_name) + ',\n\n'
        + 'We have reviewed your portal access request. Unfortunately we are unable to approve it at this time.'
        + (reason ? '\n\nReason: ' + reason : '')
        + '\n\nFor queries contact support@hasspetroleum.com\n\n'
        + 'Hass Petroleum Group');
    } catch(me) {
      Logger.log('rejectSignup email error: ' + me.message);
    }

    clearSheetCache('SignupRequests');
    return { success: true, message: 'Signup rejected' };
  } catch(e) {
    Logger.log('rejectSignup error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function generateTempPassword() {
  var upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var digits  = '23456789';
  var symbols = '!@#$%&*';
  var all     = upper + digits + symbols;
  var pw      = '';
  pw += upper.charAt(Math.floor(Math.random() * upper.length));
  pw += upper.charAt(Math.floor(Math.random() * upper.length));
  pw += digits.charAt(Math.floor(Math.random() * digits.length));
  pw += digits.charAt(Math.floor(Math.random() * digits.length));
  pw += symbols.charAt(Math.floor(Math.random() * symbols.length));
  for (var i = 0; i < 3; i++) {
    pw += all.charAt(Math.floor(Math.random() * all.length));
  }
  return pw.split('').sort(function() { return 0.5 - Math.random(); }).join('');
}
