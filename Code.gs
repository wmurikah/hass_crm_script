/**
 * HASS PETROLEUM CMS - MAIN ENTRY POINT
 * Version: 2.0.0
 * Database: Turso (libSQL) - primary
 */

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var page   = String(params.page  || '').trim().toLowerCase();
  var token  = String(params.token || '').trim();
  Logger.log('[Code] doGet page=' + page + ' tokenLen=' + token.length);

  // No token: always serve the login page (covers bare /exec, /exec?page=login,
  // and any unrecognised page). The previous behaviour rendered a blank
  // response when the redirect target dropped its query string mid-navigation.
  if (!token) return serveLoginPage('');

  var session = checkSession({ token: token });
  Logger.log('[Code] doGet checkSession valid=' + session.valid + ' userType=' + session.userType + ' role=' + session.role);
  if (!session.valid) return serveLoginPage('Your session has expired. Please sign in again.');

  // If the URL forces a specific page, honour it as long as it matches the
  // session's userType. Otherwise route by userType.
  if (page === 'staff'  && session.userType === 'STAFF')    return serveStaffDashboard(session, token);
  if (page === 'roles'  && session.userType === 'STAFF')    return serveStaffRoleManagement(session, token);
  if (page === 'portal' && session.userType === 'CUSTOMER') return serveCustomerPortal(session, token);
  if (session.userType === 'STAFF')    return serveStaffDashboard(session, token);
  if (session.userType === 'CUSTOMER') return serveCustomerPortal(session, token);
  return serveLoginPage('Unknown account type.');
}

function serveStaffRoleManagement(session, token) {
  if (!userHasPermission(session.userId, 'roles.assign')) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:48px;text-align:center;max-width:640px;margin:auto">' +
      '<h2 style="color:#1A237E">Permission denied</h2>' +
      '<p>You don\'t have permission to manage user roles. Contact your administrator if you need access.</p>' +
      '</div>'
    ).setTitle('Role Management - Permission denied');
  }
  var tmpl = HtmlService.createTemplateFromFile('Staff_RoleManagement');
  var scriptUrl = ScriptApp.getService().getUrl();
  tmpl.SESSION = JSON.stringify({
    userId:    session.userId,
    userType:  'STAFF',
    role:      session.role,
    token:     token,
    scriptUrl: scriptUrl
  });
  tmpl.scriptUrl = scriptUrl;
  return tmpl.evaluate()
    .setTitle('Hass Petroleum - User Role Management')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------------------------------------------------------------------------
// Page Serving Helpers
// ---------------------------------------------------------------------------

function serveLoginPage(errorMessage) {
  var tmpl = HtmlService.createTemplateFromFile('Login');
  tmpl.errorMessage = errorMessage || '';
  tmpl.scriptUrl    = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('Hass Petroleum Group - Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveStaffDashboard(session, token) {
  try {
    Logger.log('[Code] serveStaffDashboard userId=' + session.userId + ' role=' + session.role);
    var tmpl = HtmlService.createTemplateFromFile('Staffdashboard');
    var scriptUrl = ScriptApp.getService().getUrl();
    tmpl.SESSION = JSON.stringify({
      userId:    session.userId,
      userType:  'STAFF',
      role:      session.role,
      token:     token,
      name:      '',
      scriptUrl: scriptUrl
    });
    tmpl.scriptUrl = scriptUrl;
    var output = tmpl.evaluate()
      .setTitle('Hass Petroleum - Staff Portal')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    Logger.log('[Code] serveStaffDashboard rendered ' + output.getContent().length + ' chars');
    return output;
  } catch (err) {
    Logger.log('[Code] serveStaffDashboard ERROR: ' + err.message + '\n' + err.stack);
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:48px;text-align:center;max-width:640px;margin:auto">' +
      '<h2 style="color:#1A237E">Staff Portal could not load</h2>' +
      '<p>The dashboard template failed to render. Please contact your administrator.</p>' +
      '<pre style="text-align:left;background:#f5f5f5;padding:12px;border-radius:6px;font-size:11px;color:#555;overflow:auto">' +
      String(err.message).replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>' +
      '</div>'
    ).setTitle('Staff Portal Error');
  }
}

function serveCustomerPortal(session, token) {
  try {
    Logger.log('[Code] serveCustomerPortal userId=' + session.userId);
    var customerId = '';
    try {
      var contact = findRow('Contacts', 'contact_id', session.userId);
      if (contact) {
        customerId   = String(contact.customer_id || '').trim();
        session.name = (String(contact.first_name || '').trim() + ' ' + String(contact.last_name || '').trim()).trim();
      }
    } catch(e) { Logger.log('[Code] serveCustomerPortal lookup: ' + e.message); }

    if (!customerId) {
      return HtmlService.createHtmlOutput(
        '<div style="font-family:sans-serif;padding:40px;text-align:center">' +
        '<h2>Account Not Linked</h2>' +
        '<p>Your portal account is not linked to a customer record. ' +
        'Please contact support@hasspetroleum.com</p></div>'
      ).setTitle('Account Error');
    }

    var tmpl = HtmlService.createTemplateFromFile('Customerportal');
    var scriptUrl = ScriptApp.getService().getUrl();
    tmpl.SESSION = JSON.stringify({
      contactId:  session.userId,
      customerId: customerId,
      userType:   'CUSTOMER',
      role:       'CUSTOMER',
      token:      token,
      name:       session.name || '',
      scriptUrl:  scriptUrl
    });
    tmpl.scriptUrl = scriptUrl;
    var output = tmpl.evaluate()
      .setTitle('Hass Petroleum - Customer Portal')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    Logger.log('[Code] serveCustomerPortal rendered ' + output.getContent().length + ' chars');
    return output;
  } catch (err) {
    Logger.log('[Code] serveCustomerPortal ERROR: ' + err.message + '\n' + err.stack);
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:48px;text-align:center;max-width:640px;margin:auto">' +
      '<h2 style="color:#1A237E">Customer Portal could not load</h2>' +
      '<p>The portal template failed to render. Please contact support.</p>' +
      '<pre style="text-align:left;background:#f5f5f5;padding:12px;border-radius:6px;font-size:11px;color:#555;overflow:auto">' +
      String(err.message).replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>' +
      '</div>'
    ).setTitle('Customer Portal Error');
  }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// Services that require a valid session token before dispatch.
// 'auth' is excluded so login/signup/reset flows remain unauthenticated.
var AUTHENTICATED_SERVICES_ = [
  'tickets', 'orders', 'customers', 'documents', 'knowledge',
  'notifications', 'integrations', 'sla', 'chat', 'settings',
  'upload', 'dashboard', 'users', 'permissions', 'statements',
];

function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var service = params.service;

    // --- Authentication guard ---
    if (AUTHENTICATED_SERVICES_.indexOf(service) !== -1) {
      var token = String(params.token || '').trim();
      if (!token) {
        return _jsonResponse_({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
      }
      var session = checkSession({ token: token });
      if (!session.valid) {
        return _jsonResponse_({ success: false, error: 'Session expired or invalid.', code: 'UNAUTHORIZED' });
      }
      params._session = session;
    }

    var result;
    switch (service) {
      case 'auth':          result = handleAuthRequest(params);         break;
      case 'tickets':       result = handleTicketRequest(params);       break;
      case 'orders':        result = handleOrderRequest(params);        break;
      case 'customers':     result = handleCustomerRequest(params);     break;
      case 'documents':     result = handleDocumentRequest(params);     break;
      case 'knowledge':     result = handleKnowledgeRequest(params);    break;
      case 'notifications': result = handleNotificationRequest(params); break;
      case 'integrations':  result = handleIntegrationRequest(params);  break;
      case 'sla':           result = handleSLARequest(params);          break;
      case 'chat':          result = handleChatRequest(params);         break;
      case 'settings':      result = handleSettingsRequest(params);     break;
      case 'upload':        result = handleDataUploadRequest(params);   break;
      case 'dashboard':     result = handleDashboardRequest(params);    break;
      case 'users':         result = handleUserRequest(params);         break;
      case 'permissions':   result = handlePermissionRequest(params);   break;
      case 'statements':    result = handleStatementRequest(params);    break;
      default:
        result = { success: false, error: 'Unknown service: ' + service };
    }

    return _jsonResponse_(result);

  } catch (error) {
    Logger.log('[Code] doPost error: ' + error.message);
    return _jsonResponse_({ success: false, error: error.message });
  }
}

function _jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleCustomerRequest(params) {
  try {
    var action = params.action;
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
      case 'getConsumption':
        return getCustomerConsumption(params.customerId, params.period);
      case 'getPriceList':
        return getCustomerPriceList(params.customerId);
      default:
        return { success: false, error: 'Unknown customer action: ' + action };
    }
  } catch (e) {
    Logger.log('[Code] handleCustomerRequest error: ' + e.message);
    return { success: false, error: 'Customer request failed' };
  }
}

/**
 * Client entry point invoked via google.script.run.
 *
 * doPost() returns a ContentService.TextOutput which google.script.run
 * cannot serialize back to a plain JS object on the client. Without this
 * unwrap step, withSuccessHandler receives an opaque object and any
 * client-side logic that reads `r.success` / `r.error` silently fails
 * (this is what was breaking the staff Edit modal and the RBAC matrix).
 */
function processRequest(params) {
  try {
    var resp = doPost({ postData: { contents: JSON.stringify(params || {}) } });
    var text = (resp && typeof resp.getContent === 'function') ? resp.getContent() : '';
    if (!text) return { success: false, error: 'Empty server response' };
    return JSON.parse(text);
  } catch (e) {
    Logger.log('[Code] processRequest unwrap error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// Background image removed - Login.html falls back to CSS gradient
function getBackgroundUrl() {
  return '';
}
