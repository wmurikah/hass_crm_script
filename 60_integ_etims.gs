/**
 * 60_integ_etims.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * KRA eTIMS (Electronic Tax Invoice Management System) integration.
 *
 * EtimsInteg.submit(payload)        — submit invoice payload to eTIMS
 * EtimsInteg.getStatus(invoiceId)   — poll eTIMS for invoice status
 *
 * Script Properties required:
 *   ETIMS_ENV         — 'sandbox' | 'production'
 *   ETIMS_API_URL     — Base URL for the eTIMS REST API
 *   ETIMS_CLIENT_ID   — Business registration number / PIN
 *   ETIMS_API_KEY     — API key from KRA portal
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure so the job runner can retry.
 */

var EtimsInteg = (function () {

  function _apiUrl_() {
    return (PropertiesService.getScriptProperties().getProperty('ETIMS_API_URL') || '').replace(/\/$/, '');
  }

  function _headers_() {
    var props = PropertiesService.getScriptProperties();
    return {
      'Content-Type': 'application/json',
      'x-client-id':  props.getProperty('ETIMS_CLIENT_ID') || '',
      'x-api-key':    props.getProperty('ETIMS_API_KEY')   || '',
    };
  }

  function _logInteg_(action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'etims', action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  /**
   * payload: { invoiceNumber, invoiceDate, totalAmount, taxAmount, netAmount,
   *            currency, customerId, orderId }
   */
  function submit(payload) {
    var apiUrl = _apiUrl_();
    if (!apiUrl) {
      _logInteg_('submit', 'SKIPPED', JSON.stringify(payload).substring(0, 200), '', 'ETIMS_API_URL not configured');
      Log.warn({ service: 'integ_etims', msg: 'ETIMS_API_URL not configured — submission skipped' });
      return { skipped: true };
    }

    var resp = UrlFetchApp.fetch(apiUrl + '/invoices', {
      method:             'post',
      headers:            _headers_(),
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    var code   = resp.getResponseCode();
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}

    var success = code >= 200 && code < 300;

    Audit.log({
      actor: 'ETIMS', action: success ? 'ETIMS_SUBMITTED' : 'ETIMS_SUBMIT_FAILED',
      entity: 'invoices', entityId: payload.invoiceNumber || '',
      after: { response_code: code, etims_id: result.etimsId || null },
    });

    if (!success) {
      _logInteg_('submit', 'FAILED', JSON.stringify(payload).substring(0, 300),
                 JSON.stringify(result).substring(0, 300), 'HTTP ' + code);
      throw new Errors.Integration('eTIMS submission failed (' + code + '): ' + JSON.stringify(result).substring(0, 200));
    }

    _logInteg_('submit', 'SUCCESS', 'invoiceNumber=' + payload.invoiceNumber,
               'etimsId=' + (result.etimsId || ''), null);
    return result;
  }

  function getStatus(invoiceId) {
    var apiUrl = _apiUrl_();
    if (!apiUrl) {
      _logInteg_('getStatus', 'SKIPPED', 'invoiceId=' + invoiceId, '', 'ETIMS_API_URL not configured');
      return { skipped: true };
    }

    var resp = UrlFetchApp.fetch(apiUrl + '/invoices/' + encodeURIComponent(invoiceId), {
      headers:            _headers_(),
      muteHttpExceptions: true,
    });
    var code   = resp.getResponseCode();
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}

    if (code >= 200 && code < 300) {
      _logInteg_('getStatus', 'SUCCESS', 'invoiceId=' + invoiceId, JSON.stringify(result).substring(0, 300), null);
      return result;
    }
    _logInteg_('getStatus', 'FAILED', 'invoiceId=' + invoiceId, resp.getContentText().substring(0, 300), 'HTTP ' + code);
    throw new Errors.Integration('eTIMS status query failed (' + code + '): ' + JSON.stringify(result).substring(0, 200));
  }

  return { submit: submit, getStatus: getStatus };
})();
