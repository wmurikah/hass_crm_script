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
      case 'addCustomerContact':
        if (s) requirePermission(s, 'customers.edit');
        return addCustomerContact(params.customerId, params.data, (s && s.userId) || 'STAFF');
      case 'updateCustomerContact':
        if (s) requirePermission(s, 'customers.edit');
        return updateCustomerContact(params.contactId, params.data);
      case 'setContactPortalAccess':
        if (s) requirePermission(s, 'customers.edit');
        return setContactPortalAccess(params.contactId, params.hasAccess);
      case 'createCustomerAccount':
        if (s) requirePermission(s, 'customers.create');
        return createCustomerAccount(params.data, (s && s.userId) || 'STAFF');
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
      subject:  'Welcome to Hass Petroleum Portal - Your Account',
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
 * Whitelisted fields only - never password_hash, never user_id.
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
  var name  = String(row.first_name || '').trim() || 'there';

  if (email) {
    try {
      var mail = renderPasswordResetEmail(name, tempPassword);
      MailApp.sendEmail({
        to:       email,
        name:     'Hass Petroleum Customer Experience',
        subject:  mail.subject,
        body:     mail.text,
        htmlBody: mail.html,
      });
    } catch(e) {
      Logger.log('[UserService] Reset email failed: ' + e.message);
    }
  }

  return { success: true, message: 'Password reset. Email sent to ' + email };
}

/**
 * Customer-experience-grade password reset email.
 * Table-based HTML for Outlook compatibility, all CSS inlined, no <style>
 * blocks. Plain-text fallback is written as a real plain-text email, not
 * the HTML stripped of tags.
 */
function renderPasswordResetEmail(firstName, tempPassword) {
  var greeting = firstName ? ('Hi ' + firstName + ',') : 'Hello,';
  var supportPhone = 'Hass Petroleum Customer Experience: +254 709 906 000';
  var supportEmail = 'support@hasspetroleum.com';
  var brandNavy    = '#1A237E';
  var brandOrange  = '#FF6F00';

  var html =
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 0;">' +
        '<tr><td align="center">' +
          '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e2e8f0;">' +
            '<tr><td style="background:' + brandNavy + ';padding:18px 24px;border-radius:10px 10px 0 0;color:#ffffff;font-size:14px;font-weight:600;letter-spacing:0.5px;">' +
              'Hass Petroleum Customer Experience' +
            '</td></tr>' +
            '<tr><td style="padding:28px 28px 8px 28px;font-size:18px;font-weight:600;color:#0f172a;">' +
              'Your Hass Petroleum portal password has been reset' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 16px 28px;font-size:14px;line-height:1.6;color:#334155;">' +
              greeting + '<br><br>' +
              'We have reset your portal password at the request of an administrator on our team. ' +
              'You can sign in with the temporary password below, and the portal will prompt you to choose a new password on your first login.' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 16px 28px;">' +
              '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
                '<tr><td style="padding:18px 20px;text-align:center;">' +
                  '<div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#64748b;text-transform:uppercase;margin-bottom:6px;">Temporary password</div>' +
                  '<div style="font-family:Consolas,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:' + brandNavy + ';">' + tempPassword + '</div>' +
                '</td></tr>' +
              '</table>' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 16px 28px;font-size:14px;line-height:1.6;color:#334155;">' +
              'For your security, this password will only work once. Please change it as soon as you sign in.' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 20px 28px;font-size:13px;line-height:1.6;color:#475569;">' +
              'If you did not ask for a reset, please reply to this email or call us on +254 709 906 000 ' +
              'so we can secure your account right away.' +
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
    'We have reset your Hass Petroleum portal password at the request of an administrator on our team. ' +
    'You can sign in with the temporary password below, and the portal will prompt you to choose a new password on your first login.\n\n' +
    'Temporary password: ' + tempPassword + '\n\n' +
    'For your security, this password will only work once. Please change it as soon as you sign in.\n\n' +
    'If you did not ask for a reset, just reply to this email or call us on +254 709 906 000 ' +
    'and we will secure your account right away.\n\n' +
    'Warm regards,\n' +
    'Hass Petroleum Customer Experience Team\n\n' +
    '---\n' +
    'Hass Petroleum Group, Hass Plaza, Mombasa Road, Nairobi, Kenya\n' +
    supportPhone + ' | ' + supportEmail + '\n' +
    'This message was sent on behalf of the Hass Petroleum Customer Experience team. We are here to help, just reply.\n';

  return {
    subject: 'Your Hass Petroleum portal password has been reset',
    html:    html,
    text:    text,
  };
}

function renderWelcomeEmail(firstName, companyName, accountNumber, email, tempPassword) {
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
              'Welcome to your Hass Petroleum portal' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 16px 28px;font-size:14px;line-height:1.6;color:#334155;">' +
              greeting + '<br><br>' +
              'We have set up a portal account for ' + (companyName || 'your company') + '. ' +
              'You can sign in with the details below, and the portal will prompt you to choose your own password on your first login.' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 16px 28px;">' +
              '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
                '<tr><td style="padding:14px 18px;font-size:13px;color:#475569;"><strong style="color:#0f172a;">Account number</strong></td><td style="padding:14px 18px;text-align:right;font-family:Consolas,Menlo,monospace;color:#0f172a;">' + (accountNumber || '') + '</td></tr>' +
                '<tr><td style="padding:14px 18px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;"><strong style="color:#0f172a;">Email</strong></td><td style="padding:14px 18px;border-top:1px solid #e2e8f0;text-align:right;color:#0f172a;">' + (email || '') + '</td></tr>' +
                '<tr><td style="padding:14px 18px;border-top:1px solid #e2e8f0;font-size:13px;color:#475569;"><strong style="color:#0f172a;">Temporary password</strong></td><td style="padding:14px 18px;border-top:1px solid #e2e8f0;text-align:right;font-family:Consolas,Menlo,monospace;font-weight:700;color:' + brandNavy + ';">' + (tempPassword || '') + '</td></tr>' +
              '</table>' +
            '</td></tr>' +
            '<tr><td style="padding:0 28px 20px 28px;font-size:13px;line-height:1.6;color:#475569;">' +
              'Once you are signed in, you can place fuel orders, raise tickets, view statements, and manage your team. ' +
              'If anything looks off or you need a hand getting started, just reply to this email or call us on +254 709 906 000.' +
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
    'We have set up a Hass Petroleum portal account for ' + (companyName || 'your company') + '. ' +
    'You can sign in with the details below, and the portal will prompt you to choose your own password on your first login.\n\n' +
    'Account number: ' + (accountNumber || '') + '\n' +
    'Email: ' + (email || '') + '\n' +
    'Temporary password: ' + (tempPassword || '') + '\n\n' +
    'Once you are signed in, you can place fuel orders, raise tickets, view statements, and manage your team. ' +
    'If anything looks off or you need a hand getting started, just reply to this email or call us on +254 709 906 000.\n\n' +
    'Warm regards,\n' +
    'Hass Petroleum Customer Experience Team\n\n' +
    '---\n' +
    'Hass Petroleum Group, Hass Plaza, Mombasa Road, Nairobi, Kenya\n' +
    supportPhone + ' | ' + supportEmail + '\n' +
    'This message was sent on behalf of the Hass Petroleum Customer Experience team. We are here to help, just reply.\n';

  return {
    subject: 'Welcome to Hass Petroleum, ' + (firstName || 'and thank you for joining us'),
    html:    html,
    text:    text,
  };
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

/**
 * Adds a new contact under a customer. Optionally provisions portal access
 * (creates a row in Users with a temp password and emails it).
 * Used by staff (Customer Accounts) and primary contacts (Customer Portal).
 */
function addCustomerContact(customerId, data, actorId) {
  if (!customerId) return { success: false, error: 'customerId required' };
  if (!data || !data.email || !data.first_name) {
    return { success: false, error: 'first_name and email are required' };
  }
  var email = String(data.email).trim().toLowerCase();
  if (!email) return { success: false, error: 'email is required' };

  // Duplicate check (across both contacts and staff)
  var existingContact = findRow('Contacts', 'email', email);
  if (existingContact) return { success: false, error: 'A contact with this email already exists' };
  var existingUser = findRow('Users', 'email', email);
  if (existingUser) return { success: false, error: 'A user with this email already exists' };

  var contactId = 'CON' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 8).toUpperCase();
  var now = new Date().toISOString();
  var grantPortal = !!data.is_portal_user;

  appendRow('Contacts', {
    contact_id:     contactId,
    customer_id:    customerId,
    first_name:     String(data.first_name).trim(),
    last_name:      String(data.last_name || '').trim(),
    email:          email,
    phone:          String(data.phone || '').trim(),
    job_title:      String(data.job_title || '').trim(),
    contact_type:   String(data.contact_type || 'CONTACT').toUpperCase(),
    is_portal_user: grantPortal,
    status:         'ACTIVE',
    created_by:     actorId || 'STAFF',
    created_at:     now,
    updated_at:     now,
  });

  var tempPassword = '';
  if (grantPortal) {
    tempPassword = generateTempPassword();
    // Store password_hash on the contact row so login flow works
    updateRow('Contacts', 'contact_id', contactId, { password_hash: hashPassword(tempPassword) });
    try {
      MailApp.sendEmail({
        to:       email,
        subject:  'Hass Petroleum Portal - Your Account',
        htmlBody: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">'
          + '<h2 style="color:#1A237E;">Welcome to Hass Petroleum Portal</h2>'
          + '<p>Hi ' + (data.first_name || '') + ',</p>'
          + '<p>You have been granted portal access to your company\'s Hass Petroleum account.</p>'
          + '<div style="background:#f8fafc;padding:16px;border-radius:8px;margin:16px 0;">'
          + '<p style="margin:4px 0;"><strong>Email:</strong> ' + email + '</p>'
          + '<p style="margin:4px 0;"><strong>Temporary Password:</strong> ' + tempPassword + '</p>'
          + '</div>'
          + '<p style="color:#dc2626;font-weight:600;">Please change your password on first login.</p>'
          + '<p>Best regards,<br>Hass Petroleum Group</p>'
          + '</div>',
      });
    } catch(e) { Logger.log('[UserService] addContact email failed: ' + e.message); }
  }

  try { clearSheetCache('Contacts'); } catch(e) {}
  return {
    success: true,
    contactId: contactId,
    tempPassword: tempPassword,
    message: grantPortal ? 'Contact created. Login email sent.' : 'Contact created.',
  };
}

function updateCustomerContact(contactId, data) {
  if (!contactId || !data) return { success: false, error: 'contactId and data required' };
  var ALLOWED = ['first_name','last_name','email','phone','job_title','contact_type','status','is_portal_user'];
  var updates = {};
  ALLOWED.forEach(function(k) {
    if (data[k] !== undefined && data[k] !== null) updates[k] = data[k];
  });
  if (!Object.keys(updates).length) return { success: false, error: 'No editable fields provided' };
  if (updates.email) {
    updates.email = String(updates.email).trim().toLowerCase();
    var dup = findRow('Contacts', 'email', updates.email);
    if (dup && dup.contact_id !== contactId) {
      return { success: false, error: 'Email already in use by another contact' };
    }
  }
  var ok = updateRow('Contacts', 'contact_id', contactId, updates);
  if (!ok) return { success: false, error: 'Contact not found' };
  try { clearSheetCache('Contacts'); } catch(e) {}
  return { success: true, message: 'Contact updated' };
}

/**
 * Super-Admin path: provision a new customer account with a primary contact
 * and a temporary password. Returns the temp password so the caller can
 * display it once; the password is also emailed to the contact.
 */
function createCustomerAccount(data, actorId) {
  if (!data) return { success: false, error: 'data required' };
  var company = String(data.company_name || '').trim();
  var email   = String(data.email || '').trim().toLowerCase();
  if (!company) return { success: false, error: 'company_name is required' };
  if (!email)   return { success: false, error: 'Primary contact email is required' };

  // Block duplicate primary email (must be unique across both Contacts and Users)
  var existingContact = findRow('Contacts', 'email', email);
  if (existingContact) return { success: false, error: 'A contact with this email already exists' };
  var existingUser = findRow('Users', 'email', email);
  if (existingUser) return { success: false, error: 'A user with this email already exists' };

  var customerId   = 'CUST' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
  var now          = new Date().toISOString();
  var country      = String(data.country_code || 'KE').toUpperCase();
  var accountNum   = String(data.account_number || ('HASS-' + country + '-' + customerId.substring(4, 10))).toUpperCase();

  appendRow('Customers', {
    customer_id:      customerId,
    company_name:     company,
    trading_name:     String(data.trading_name || company).trim(),
    account_number:   accountNum,
    country_code:     country,
    currency_code:    String(data.currency_code || 'KES').toUpperCase(),
    credit_limit:     Number(data.credit_limit || 0),
    credit_used:      0,
    payment_terms:    String(data.payment_terms || 'NET30'),
    tax_pin:          String(data.tax_pin || data.kra_pin || '').trim(),
    segment_id:       String(data.segment_id || '').trim(),
    status:           'ACTIVE',
    created_by:       actorId || 'SUPER_ADMIN',
    created_at:       now,
    updated_at:       now,
  });

  // Provision primary contact + portal user with a temp password.
  var contactId   = 'CON' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
  var tempPassword = generateTempPassword();
  var hashed = hashPassword(tempPassword);

  appendRow('Contacts', {
    contact_id:     contactId,
    customer_id:    customerId,
    first_name:     String(data.first_name || '').trim(),
    last_name:      String(data.last_name || '').trim(),
    email:          email,
    phone:          String(data.phone || '').trim(),
    job_title:      String(data.job_title || 'Primary Contact').trim(),
    contact_type:   'PRIMARY',
    is_portal_user: true,
    password_hash:  hashed,
    status:         'ACTIVE',
    created_by:     actorId || 'SUPER_ADMIN',
    created_at:     now,
    updated_at:     now,
  });

  try {
    var welcome = renderWelcomeEmail(data.first_name || company, company, accountNum, email, tempPassword);
    MailApp.sendEmail({
      to:       email,
      name:     'Hass Petroleum Customer Experience',
      subject:  welcome.subject,
      body:     welcome.text,
      htmlBody: welcome.html,
    });
  } catch(e) { Logger.log('[UserService] createCustomer email failed: ' + e.message); }

  try { clearSheetCache('Customers'); clearSheetCache('Contacts'); } catch(e) {}

  return {
    success: true,
    customerId: customerId,
    contactId: contactId,
    accountNumber: accountNum,
    tempPassword: tempPassword,
    message: 'Customer account created. Credentials emailed to ' + email + '.',
  };
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
      MailApp.sendEmail(req.email, 'Hass Petroleum Portal - Application Update',
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
