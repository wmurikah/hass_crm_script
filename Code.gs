/**
 * HASS PETROLEUM CMS - MAIN ENTRY POINT
 * Version: 1.0.0
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
      case 'database':
        result = handleDatabaseRequest(params);
        break;
      default:
        result = { success: false, error: 'Unknown service: ' + service };
    }
    
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    Logger.log('doPost error: ' + error.message);
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function processRequest(params) {
  return doPost({ postData: { contents: JSON.stringify(params) } });
}
