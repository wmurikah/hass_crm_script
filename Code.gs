/**
 * HASS PETROLEUM CMS - MAIN ENTRY POINT
 * Version: 2.0.0
 * Database: Turso (libSQL) — primary
 */

function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var page   = String(params.page  || '').trim();
  var token  = String(params.token || '').trim();

  // No token and not explicitly requesting login — go to login
  if (!token && page !== 'login') return serveLoginPage('');

  // Validate token if present
  if (token) {
    var session = checkSession({ token: token });
    if (!session.valid) return serveLoginPage('Your session has expired. Please sign in again.');
    if (session.userType === 'STAFF')    return serveStaffDashboard(session, token);
    if (session.userType === 'CUSTOMER') return serveCustomerPortal(session, token);
    return serveLoginPage('Unknown account type.');
  }

  return serveLoginPage('');
}

// ---------------------------------------------------------------------------
// Page Serving Helpers
// ---------------------------------------------------------------------------

function serveLoginPage(errorMessage) {
  var tmpl = HtmlService.createTemplateFromFile('Login');
  tmpl.errorMessage = errorMessage || '';
  tmpl.scriptUrl    = ScriptApp.getService().getUrl();
  return tmpl.evaluate()
    .setTitle('Hass Petroleum Group — Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveStaffDashboard(session, token) {
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
  return tmpl.evaluate()
    .setTitle('Hass Petroleum — Staff Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveCustomerPortal(session, token) {
  var customerId = '';
  try {
    var contact = findRow('Contacts', 'contact_id', session.userId);
    if (contact) {
      customerId   = String(contact.customer_id || '').trim();
      session.name = (String(contact.first_name || '').trim() + ' ' + String(contact.last_name || '').trim()).trim();
    }
  } catch(e) { Logger.log('serveCustomerPortal: ' + e.message); }

  if (!customerId) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:40px;text-align:center">' +
      '<h2>Account Not Linked</h2>' +
      '<p>Your portal account is not linked to a customer record. ' +
      'Please contact support@hasspetroleum.com</p></div>'
    ).setTitle('Account Error');
  }

  var tmpl = HtmlService.createTemplateFromFile('Customerportal');
  tmpl.SESSION = JSON.stringify({
    contactId:  session.userId,
    customerId: customerId,
    userType:   'CUSTOMER',
    role:       'CUSTOMER',
    token:      token,
    name:       session.name || ''
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

// Services that require a valid session token before dispatch.
// 'auth' is excluded so login/signup/reset flows remain unauthenticated.
var AUTHENTICATED_SERVICES_ = [
  'tickets', 'orders', 'customers', 'documents', 'knowledge',
  'notifications', 'integrations', 'sla', 'chat', 'settings',
  'upload', 'dashboard', 'users',
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

function processRequest(params) {
  return doPost({ postData: { contents: JSON.stringify(params) } });
}

// Background image removed — Login.html falls back to CSS gradient
function getBackgroundUrl() {
  return '';
}
