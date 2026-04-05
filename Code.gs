/**
 * HASS PETROLEUM CMS - MAIN ENTRY POINT
 * Version: 2.0.0
 * Database: Google Cloud Firestore (hass-internal-audit-12345)
 */

function doGet(e) {
  const portal = (e && e.parameter && e.parameter.portal) || 'customer';

  if (portal === 'staff') {
    return HtmlService.createHtmlOutputFromFile('Staffdashboard')
      .setTitle('Hass Petroleum - Staff Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } else {
    return HtmlService.createHtmlOutputFromFile('Customerportal')
      .setTitle('Hass Petroleum - Customer Portal')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
