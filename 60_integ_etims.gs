/**
 * 60_integ_etims.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * KRA eTIMS (Electronic Tax Invoice Management System) integration.
 *
 * EtimsInteg.submitInvoice(invoiceId)   — submit invoice to eTIMS
 * EtimsInteg.getStatus(etimsId)         — check submission status
 *
 * Script Properties required:
 *   ETIMS_ENV             — 'sandbox' | 'production'
 *   ETIMS_API_URL         — Base URL for the eTIMS REST API
 *   ETIMS_CLIENT_ID       — Business registration number / PIN
 *   ETIMS_API_KEY         — API key from KRA portal
 *
 * Submission records a row in the audit_log with action=ETIMS_SUBMITTED.
 * If eTIMS is not configured (no API URL), the function logs a warning and returns.
 */

var EtimsInteg = (function () {

  function _headers_() {
    var props = PropertiesService.getScriptProperties();
    return {
      'Content-Type':  'application/json',
      'x-client-id':  props.getProperty('ETIMS_CLIENT_ID') || '',
      'x-api-key':    props.getProperty('ETIMS_API_KEY')   || '',
    };
  }

  function _apiUrl_() {
    var props = PropertiesService.getScriptProperties();
    return (props.getProperty('ETIMS_API_URL') || '').replace(/\/$/, '');
  }

  function submitInvoice(invoiceId) {
    var apiUrl = _apiUrl_();
    if (!apiUrl) {
      Log.warn({ service: 'integ_etims', msg: 'ETIMS_API_URL not configured — submission skipped', data: { invoiceId: invoiceId } });
      return { skipped: true };
    }

    var rows = TursoClient.select('SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1', [invoiceId]);
    if (!rows.length) throw new Error('Invoice not found: ' + invoiceId);
    var inv = rows[0];

    var payload = {
      invoiceNumber: inv.invoice_number,
      invoiceDate:   (inv.issued_at || inv.created_at || '').substring(0, 10),
      totalAmount:   parseFloat(inv.total_amount  || 0),
      taxAmount:     parseFloat(inv.tax_amount    || 0),
      netAmount:     parseFloat(inv.subtotal      || 0),
      currency:      inv.currency_code || 'KES',
      customerId:    inv.customer_id,
      orderId:       inv.order_id,
    };

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
      entity: 'invoices', entityId: invoiceId,
      after: { response_code: code, etims_id: result.etimsId || null },
    });

    if (!success) throw new Error('eTIMS submission failed (' + code + '): ' + JSON.stringify(result).substring(0, 200));

    // Record eTIMS ID on invoice if column exists.
    try {
      TursoClient.write(
        'UPDATE invoices SET etims_id = ?, etims_submitted_at = ?, updated_at = ? WHERE invoice_id = ?',
        [result.etimsId || '', nowIso(), nowIso(), invoiceId]
      );
    } catch (_) {}

    return result;
  }

  function getStatus(etimsId) {
    var apiUrl = _apiUrl_();
    if (!apiUrl) return { skipped: true };

    var resp = UrlFetchApp.fetch(apiUrl + '/invoices/' + encodeURIComponent(etimsId), {
      headers:            _headers_(),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}
    if (code >= 200 && code < 300) return result;
    throw new Error('eTIMS status query failed (' + code + '): ' + JSON.stringify(result).substring(0, 200));
  }

  return { submitInvoice: submitInvoice, getStatus: getStatus };
})();
