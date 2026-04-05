/**
 * HASS PETROLEUM CMS - MAIN ENTRY POINT
 * Version: 2.0.0
 * Database: Google Sheets (SPREADSHEET_ID in Script Properties)
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
    userId:   session.userId,
    userType: 'STAFF',
    role:     session.role,
    token:    token,
    name:     '',
    scriptUrl: scriptUrl
  });
  tmpl.scriptUrl = scriptUrl;
  return tmpl.evaluate()
    .setTitle('Hass Petroleum — Staff Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function serveCustomerPortal(session, token) {
  // Enrich with customerId from Contacts
  var customerId = '';
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Contacts');
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      var h = data[0].map(function(x){ return String(x||'').toLowerCase().trim(); });
      var cidCol  = h.indexOf('contact_id');
      var custCol = h.indexOf('customer_id');
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][cidCol]||'').trim() === session.userId) {
          customerId = String(data[r][custCol]||'').trim();
          break;
        }
      }
    }
  } catch(e) { Logger.log('serveCustomerPortal enrich: ' + e.message); }

  var scriptUrl2 = ScriptApp.getService().getUrl();
  var tmpl = HtmlService.createTemplateFromFile('Customerportal');
  tmpl.SESSION = JSON.stringify({
    contactId:  session.userId,
    customerId: customerId,
    userType:   'CUSTOMER',
    role:       'CUSTOMER',
    token:      token,
    name:       '',
    scriptUrl:  scriptUrl2
  });
  tmpl.scriptUrl = scriptUrl2;
  return tmpl.evaluate()
    .setTitle('Hass Petroleum — Customer Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
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

function getBackgroundUrl() {
  try {
    var folder = DriveApp.getFolderById('1AL9fUgYXM9DXj9-X_0YonrloqCXat2wq');
    var files = folder.getFilesByName('backround.png');
    if (files.hasNext()) {
      var file = files.next();
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return 'https://lh3.googleusercontent.com/d/' + file.getId();
    }
  } catch(e) { Logger.log('getBackgroundUrl: ' + e.message); }
  return '';
}
