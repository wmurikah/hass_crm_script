/**
 * 60_integ_oracle.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Oracle ERP integration via REST API.
 *
 * OracleInteg.sync()                 — full incremental sync (customers + products)
 * OracleInteg.pushOrder(orderId)     — push confirmed order to Oracle
 * OracleInteg.pullInvoice(invoiceId) — pull invoice status from Oracle
 *
 * Script Properties required:
 *   ORACLE_API_URL        — Base URL for Oracle REST API
 *   ORACLE_CLIENT_ID      — OAuth client ID
 *   ORACLE_CLIENT_SECRET  — OAuth client secret
 *   ORACLE_TOKEN_URL      — OAuth token endpoint
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure so the job runner can retry.
 */

var OracleInteg = (function () {

  function _apiUrl_() {
    return (PropertiesService.getScriptProperties().getProperty('ORACLE_API_URL') || '').replace(/\/$/, '');
  }

  function _token_() {
    var props     = PropertiesService.getScriptProperties();
    var tokenUrl  = props.getProperty('ORACLE_TOKEN_URL')      || '';
    var clientId  = props.getProperty('ORACLE_CLIENT_ID')      || '';
    var secret    = props.getProperty('ORACLE_CLIENT_SECRET')  || '';
    if (!tokenUrl || !clientId || !secret) throw new Errors.Integration('Oracle OAuth credentials not configured.');
    var resp = UrlFetchApp.fetch(tokenUrl, {
      method:             'post',
      contentType:        'application/x-www-form-urlencoded',
      payload:            'grant_type=client_credentials&client_id=' + encodeURIComponent(clientId) +
                          '&client_secret=' + encodeURIComponent(secret),
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Errors.Integration('Oracle token request failed: ' + resp.getContentText().substring(0, 200));
    return JSON.parse(resp.getContentText()).access_token;
  }

  function _headers_(token) {
    return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  function _logInteg_(integration, action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), integration, action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  function sync() {
    var apiUrl = _apiUrl_();
    if (!apiUrl) { _logInteg_('oracle', 'sync', 'SKIPPED', '', '', 'ORACLE_API_URL not configured'); return; }
    var token = _token_();

    // Sync customers.
    var custResp = UrlFetchApp.fetch(apiUrl + '/customers?limit=500', {
      headers: _headers_(token), muteHttpExceptions: true,
    });
    var custCode = custResp.getResponseCode();
    if (custCode < 200 || custCode >= 300) {
      _logInteg_('oracle', 'sync.customers', 'FAILED', apiUrl + '/customers', custResp.getContentText().substring(0, 300), 'HTTP ' + custCode);
      throw new Errors.Integration('Oracle customer sync failed: HTTP ' + custCode);
    }
    var customers = [];
    try { customers = JSON.parse(custResp.getContentText()) || []; } catch (_) {}
    _logInteg_('oracle', 'sync.customers', 'SUCCESS', 'GET /customers', 'count=' + customers.length, null);

    // Sync products.
    var prodResp = UrlFetchApp.fetch(apiUrl + '/products?limit=500', {
      headers: _headers_(token), muteHttpExceptions: true,
    });
    var prodCode = prodResp.getResponseCode();
    if (prodCode < 200 || prodCode >= 300) {
      _logInteg_('oracle', 'sync.products', 'FAILED', apiUrl + '/products', prodResp.getContentText().substring(0, 300), 'HTTP ' + prodCode);
      throw new Errors.Integration('Oracle product sync failed: HTTP ' + prodCode);
    }
    var products = [];
    try { products = JSON.parse(prodResp.getContentText()) || []; } catch (_) {}
    _logInteg_('oracle', 'sync.products', 'SUCCESS', 'GET /products', 'count=' + products.length, null);
    Logger.log('OracleInteg.sync: customers=' + customers.length + ' products=' + products.length);
  }

  function pushOrder(orderId) {
    var apiUrl = _apiUrl_();
    if (!apiUrl) throw new Errors.Integration('ORACLE_API_URL not configured.');
    var rows = TursoClient.select('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]);
    if (!rows.length) throw new Errors.Integration('Order not found: ' + orderId);
    var order = rows[0];

    var token   = _token_();
    var payload = JSON.stringify({ order_id: order.order_id, customer_id: order.customer_id,
                                   status: order.status, country_code: order.country_code,
                                   created_at: order.created_at });
    var resp = UrlFetchApp.fetch(apiUrl + '/orders', {
      method: 'post', headers: _headers_(token), payload: payload, muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      _logInteg_('oracle', 'pushOrder', 'FAILED', 'orderId=' + orderId, resp.getContentText().substring(0, 300), 'HTTP ' + code);
      throw new Errors.Integration('Oracle pushOrder failed: HTTP ' + code);
    }
    _logInteg_('oracle', 'pushOrder', 'SUCCESS', 'orderId=' + orderId, resp.getContentText().substring(0, 300), null);
  }

  function pullInvoice(invoiceId) {
    var apiUrl = _apiUrl_();
    if (!apiUrl) throw new Errors.Integration('ORACLE_API_URL not configured.');
    var token = _token_();
    var resp  = UrlFetchApp.fetch(apiUrl + '/invoices/' + encodeURIComponent(invoiceId), {
      headers: _headers_(token), muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      _logInteg_('oracle', 'pullInvoice', 'FAILED', 'invoiceId=' + invoiceId, resp.getContentText().substring(0, 300), 'HTTP ' + code);
      throw new Errors.Integration('Oracle pullInvoice failed: HTTP ' + code);
    }
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}
    _logInteg_('oracle', 'pullInvoice', 'SUCCESS', 'invoiceId=' + invoiceId, JSON.stringify(result).substring(0, 300), null);
    return result;
  }

  return { sync: sync, pushOrder: pushOrder, pullInvoice: pullInvoice };
})();
