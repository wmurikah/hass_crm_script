/**
 * HASS PETROLEUM CMS - MAIN ENTRY POINT
 * Version: 2.0.0
 * Database: Google Sheets (SPREADSHEET_ID in Script Properties)
 */

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var page = params.page || '';
  var token = params.token || '';

  // No token and not explicitly requesting login → show login
  if (!token && page !== 'login') {
    return serveLoginPage();
  }

  // Validate token if present
  if (token) {
    var session = checkSession({ token: token });
    if (!session.valid) {
      return serveLoginPage('Session expired. Please sign in again.');
    }
    if (session.userType === 'STAFF') {
      return serveStaffDashboard(session, token);
    }
    if (session.userType === 'CUSTOMER') {
      return serveCustomerPortal(session, token);
    }
    return serveLoginPage('Unknown account type.');
  }

  // Fallback: show login
  return serveLoginPage();
}

// ---------------------------------------------------------------------------
// Page Serving Helpers
// ---------------------------------------------------------------------------

function serveLoginPage(errorMessage) {
  var tmpl = HtmlService.createTemplateFromFile('Login');
  tmpl.errorMessage = errorMessage || '';
  tmpl.scriptUrl = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('Hass Petroleum Group — Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveStaffDashboard(session, token) {
  var tmpl = HtmlService.createTemplateFromFile('Staffdashboard');
  tmpl.SESSION = JSON.stringify({
    userId:   session.userId,
    userType: 'STAFF',
    role:     session.role,
    name:     session.name || '',
    token:    token
  });
  tmpl.scriptUrl = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('Hass Petroleum — Staff Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveCustomerPortal(session, token) {
  // Enrich session with customer data
  var customerId = '';
  try {
    var contacts = getSheetData('Contacts');
    var contact = contacts.find(function(c) { return c.contact_id === session.userId; });
    if (contact) customerId = contact.customer_id || '';
  } catch(e) { Logger.log('Customer enrich error: ' + e.message); }

  var tmpl = HtmlService.createTemplateFromFile('Customerportal');
  tmpl.SESSION = JSON.stringify({
    contactId:  session.userId,
    customerId: customerId,
    userType:   'CUSTOMER',
    role:       'CUSTOMER',
    name:       session.name || '',
    token:      token
  });
  tmpl.scriptUrl = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('Hass Petroleum — Customer Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getLogoUrl() {
  try {
    var folder = DriveApp.getFolderById('1AL9fUgYXM9DXj9-X_0YonrloqCXat2wq');
    var files = folder.getFilesByName('Hass-Group-Google-Logo.png');
    if (files.hasNext()) {
      var file = files.next();
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return 'https://lh3.googleusercontent.com/d/' + file.getId();
    }
  } catch(e) { Logger.log('getLogoUrl error: ' + e.message); }
  return '';
}

// ---------------------------------------------------------------------------
// Session Check (used by doGet for token-based routing)
// ---------------------------------------------------------------------------

function checkSession(params) {
  try {
    var result = validateSession({ session_id: params.token });
    if (!result.success) {
      return { valid: false };
    }
    var sess = result.data.session;
    var meta = sess.metadata || {};
    return {
      valid:    true,
      userId:   sess.user_id,
      userType: (sess.user_type || '').toUpperCase(),
      role:     meta.role || (sess.user_type === 'customer' ? 'CUSTOMER' : ''),
      name:     meta.name || '',
      token:    params.token
    };
  } catch(e) {
    Logger.log('checkSession error: ' + e.message);
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Portal Auth Bridge (called by Login.html via google.script.run)
// Maps Login.html action names to existing AuthService functions.
// ---------------------------------------------------------------------------

function handlePortalAuth(params) {
  try {
    if (!params || !params.action) {
      return { success: false, error: 'Missing action' };
    }

    switch (params.action) {

      case 'login':
        return _portalLogin(params);

      case 'signup':
        return _portalSignup(params);

      case 'checkSession':
        var sess = checkSession({ token: params.token });
        return sess;

      case 'verifyAccount':
        return _portalVerifyAccount(params);

      case 'requestPasswordReset':
        return handleAuthRequest({ action: 'resetPassword', email: params.email });

      case 'logout':
        return handleAuthRequest({ action: 'logout', session_id: params.token });

      default:
        return { success: false, error: 'Unknown portal action: ' + params.action };
    }
  } catch(e) {
    Logger.log('[Code] handlePortalAuth error: ' + e.message);
    return { success: false, error: 'Auth error: ' + e.message };
  }
}

function _portalLogin(params) {
  var email = (params.email || '').toLowerCase().trim();
  var password = params.password || '';
  var accountType = params.accountType || '';
  var scriptUrl = ScriptApp.getService().getUrl();

  if (!email || !password) {
    return { success: false, error: 'Email and password are required.' };
  }

  // Determine if staff or customer login
  var isStaff = false;
  var user = null;

  // Check Users sheet first for staff accounts
  try {
    user = findRow('Users', 'email', email);
    if (user) isStaff = true;
  } catch(e) { /* not found */ }

  // If not staff, check Contacts for customer
  var contact = null;
  if (!isStaff) {
    try {
      contact = findRow('Contacts', 'email', email);
    } catch(e) { /* not found */ }
  }

  if (!user && !contact) {
    return { success: false, error: 'No account found for this email address.' };
  }

  if (isStaff) {
    // Staff password verification
    var hashedInput = hashPassword(password);
    if (hashedInput !== user.password_hash) {
      return { success: false, error: 'Incorrect password.' };
    }
    if (user.status === 'inactive' || user.status === 'suspended') {
      return { success: false, error: 'Account is ' + user.status + '. Contact an administrator.' };
    }

    var staffSession = createSession('staff', user.id || user.user_id, {
      email: email,
      name: user.name || user.full_name || '',
      role: user.role || 'CS_AGENT'
    });

    // Update last login
    try {
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);
      updateRow('Users', 'email', email, { last_login: new Date().toISOString() });
      lock.releaseLock();
    } catch(e) { Logger.log('Staff last_login update error: ' + e.message); }

    return {
      success:     true,
      token:       staffSession.session_id,
      userId:      user.id || user.user_id,
      role:        user.role || 'CS_AGENT',
      userType:    'STAFF',
      name:        user.name || user.full_name || '',
      redirectUrl: scriptUrl + '?page=staff&token=' + staffSession.session_id
    };
  }

  // Customer login — delegate to existing AuthService
  var custResult = customerLogin({ email: email, password: password });
  if (!custResult.success) {
    // Map generic error to user-friendly message
    var errMsg = custResult.error || 'Login failed.';
    if (errMsg.indexOf('Invalid email or password') !== -1) {
      errMsg = 'Incorrect password.';
    }
    return { success: false, error: errMsg };
  }

  var custSession = custResult.data.session;
  var custContact = custResult.data.contact;

  return {
    success:     true,
    token:       custSession.session_id,
    userId:      custContact.id,
    role:        'CUSTOMER',
    userType:    'CUSTOMER',
    name:        custContact.name || '',
    customerId:  custContact.customer_id || '',
    redirectUrl: scriptUrl + '?page=portal&token=' + custSession.session_id
  };
}

function _portalSignup(params) {
  var result = customerRegister({
    email:        params.email,
    password:     params.password,
    name:         params.name || '',
    phone:        params.phone || '',
    contact_type: params.accountType || 'individual',
    first_name:   params.name || '',
    last_name:    ''
  });
  return result;
}

function _portalVerifyAccount(params) {
  try {
    var companyName = (params.companyName || '').trim();
    var accountNumber = (params.accountNumber || '').trim();

    if (!companyName && !accountNumber) {
      return { verified: false, error: 'Enter your company name or account number.' };
    }

    var customers = getSheetData('Customers');
    var match = null;

    for (var i = 0; i < customers.length; i++) {
      var c = customers[i];
      if (accountNumber && (c.account_number === accountNumber || c.kra_pin === accountNumber)) {
        match = c;
        break;
      }
      if (companyName && c.company_name &&
          c.company_name.toLowerCase() === companyName.toLowerCase()) {
        match = c;
        break;
      }
    }

    if (match) {
      return {
        verified:   true,
        customerId: match.customer_id || match.id || ''
      };
    }
    return { verified: false, error: 'Company not found. Check your account number.' };
  } catch(e) {
    Logger.log('_portalVerifyAccount error: ' + e.message);
    return { verified: false, error: 'Verification failed.' };
  }
}

function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const service = params.service;

    let result;

    switch (service) {
      case 'auth':
        result = handleAuthRequest(params);
        break;
      case 'tickets':
        result = handleTicketRequest(params);
        break;
      case 'orders':
        result = handleOrderRequest(params);
        break;
      case 'customers':
        result = handleCustomerRequest(params);
        break;
      case 'documents':
        result = handleDocumentRequest(params);
        break;
      case 'knowledge':
        result = handleKnowledgeRequest(params);
        break;
      case 'notifications':
        result = handleNotificationRequest(params);
        break;
      case 'integrations':
        result = handleIntegrationRequest(params);
        break;
      default:
        result = { success: false, error: 'Unknown service' };
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('[Code] doPost error: ' + error.message);
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handles customer service requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleCustomerRequest(params) {
  try {
    const action = params.action;

    switch (action) {
      case 'get':
        return { success: true, data: getById('Customers', params.id) };

      case 'list':
        return findWhere('Customers', params.conditions || {}, params.options || {});

      case 'search':
        return searchRecords('Customers', params.searchText,
          params.searchFields || ['company_name', 'trading_name', 'account_number'],
          params.filters || {}, params.options || {});

      case 'create':
        return createRecord('Customers', params.data, params.context);

      case 'update':
        return updateRecord('Customers', params.id, params.data, params.context);

      case 'customer360':
        return getCustomer360(params.customerId);

      case 'creditSummary':
        return getCustomerCreditSummary(params.customerId);

      case 'documents':
        return getCustomerDocuments(params.customerId, params.options || {});

      case 'documentStatus':
        return getDocumentCompletionStatus(params.customerId);

      default:
        return { success: false, error: 'Unknown customer action: ' + action };
    }
  } catch (e) {
    Logger.log('[Code] handleCustomerRequest error: ' + e.message);
    return { success: false, error: 'Customer request failed' };
  }
}

function processRequest(params) {
  return doPost({ postData: { contents: JSON.stringify(params) } });
}
