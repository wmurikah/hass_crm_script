/**
 * 60_integ_mpesa.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * M-Pesa Daraja API integration.
 *
 * MpesaInteg.initiate(params)        — initiate STK push payment
 * MpesaInteg.callback(payload)       - handle Daraja callback (routed from doPost)
 * MpesaInteg.reconcile()             - reconcile pending payment_uploads vs M-Pesa status API
 *
 * INTG-1: the Daraja STK result is an EXTERNAL callback, so it is routed through
 * doPost as a deliberate webhook gated by a shared secret carried in the callback
 * URL (?hook=mpesa&secret=...). The webhook writes ONLY the payment table
 * (payment_uploads); the invoice/order settlement runs in the reconcile JOB.
 *
 * Script Properties required:
 *   MPESA_ENV              — 'sandbox' | 'production'
 *   MPESA_CONSUMER_KEY
 *   MPESA_CONSUMER_SECRET
 *   MPESA_SHORTCODE        — Lipa Na M-Pesa shortcode
 *   MPESA_PASSKEY          — from Daraja portal
 *   MPESA_CALLBACK_URL     - your /exec?hook=mpesa&secret=<MPESA_CALLBACK_SECRET> URL
 *   MPESA_CALLBACK_SECRET  - shared secret doPost checks against the ?secret= param
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure so the job runner can retry.
 */

var MpesaInteg = (function () {
  var _SANDBOX_BASE_ = 'https://sandbox.safaricom.co.ke';
  var _PROD_BASE_    = 'https://api.safaricom.co.ke';

  function _base_() {
    var env = PropertiesService.getScriptProperties().getProperty('MPESA_ENV') || 'sandbox';
    return env === 'production' ? _PROD_BASE_ : _SANDBOX_BASE_;
  }

  function _token_() {
    var props = PropertiesService.getScriptProperties();
    var key   = props.getProperty('MPESA_CONSUMER_KEY')    || '';
    var sec   = props.getProperty('MPESA_CONSUMER_SECRET') || '';
    if (!key || !sec) throw new Errors.Integration('MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET not configured.');
    var cred = Utilities.base64Encode(key + ':' + sec);
    var resp = UrlFetchApp.fetch(_base_() + '/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: 'Basic ' + cred }, muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Errors.Integration('M-Pesa token request failed: ' + resp.getContentText().substring(0, 200));
    return JSON.parse(resp.getContentText()).access_token;
  }

  function _timestamp_() {
    return Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yyyyMMddHHmmss');
  }

  function _logInteg_(action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'mpesa', action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  /**
   * params: { phone, amount, account_ref, description, upload_id }
   */
  function initiate(params) {
    var props       = PropertiesService.getScriptProperties();
    var shortcode   = props.getProperty('MPESA_SHORTCODE')    || '';
    var passkey     = props.getProperty('MPESA_PASSKEY')      || '';
    var callbackUrl = props.getProperty('MPESA_CALLBACK_URL') || '';
    if (!shortcode || !passkey) throw new Errors.Integration('MPESA_SHORTCODE / MPESA_PASSKEY not configured.');

    var ts       = _timestamp_();
    var password = Utilities.base64Encode(shortcode + passkey + ts);
    var token    = _token_();

    var body = {
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         ts,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(parseFloat(params.amount) || 0),
      PartyA:            String(params.phone).replace(/^\+/, ''),
      PartyB:            shortcode,
      PhoneNumber:       String(params.phone).replace(/^\+/, ''),
      CallBackURL:       callbackUrl,
      AccountReference:  String(params.account_ref || 'HASS').substring(0, 12),
      TransactionDesc:   String(params.description || 'Payment').substring(0, 13),
    };

    var resp = UrlFetchApp.fetch(_base_() + '/mpesa/stkpush/v1/processrequest', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });

    var code   = resp.getResponseCode();
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}

    if (code !== 200 || result.ResponseCode !== '0') {
      _logInteg_('initiate', 'FAILED', 'phone=' + params.phone + ' amount=' + params.amount,
                 JSON.stringify(result).substring(0, 300), 'HTTP ' + code + ' RC=' + result.ResponseCode);
      throw new Errors.Integration('STK push failed: ' + (result.ResponseDescription || result.errorMessage || String(code)));
    }

    _logInteg_('initiate', 'SUCCESS', 'phone=' + params.phone + ' amount=' + params.amount,
               'CheckoutRequestID=' + result.CheckoutRequestID, null);

    // Record CheckoutRequestID against the upload for callback matching. INTG-1:
    // this match-key write is NOT swallowed - losing it silently would leave a
    // charged payment unmatchable. The CheckoutRequestID is also captured in the
    // integration_log SUCCESS row above, so even a failure here leaves a trail
    // the reconcile job can recover from.
    if (params.upload_id && result.CheckoutRequestID) {
      TursoClient.write(
        "UPDATE payment_uploads SET reference=?, updated_at=? WHERE upload_id=?",
        [result.CheckoutRequestID, nowIso(), params.upload_id]
      );
    }

    return result;
  }

  function callback(payload) {
    var data    = typeof payload === 'string' ? JSON.parse(payload) : payload;
    var stk     = (data.Body || {}).stkCallback || {};
    var code    = stk.ResultCode;
    var checkId = stk.CheckoutRequestID || '';
    var metaArr = ((stk.CallbackMetadata || {}).Item) || [];
    var meta    = {};
    metaArr.forEach(function (item) { meta[item.Name] = item.Value; });

    var success = code === 0 || code === '0';
    Audit.log({
      actor: 'MPESA', action: success ? 'MPESA_PAYMENT_SUCCESS' : 'MPESA_PAYMENT_FAILED',
      entity: 'payment_uploads', entityId: checkId,
      after: { result_code: code, amount: meta.Amount, receipt: meta.MpesaReceiptNumber, phone: meta.PhoneNumber },
    });
    _logInteg_('callback', success ? 'SUCCESS' : 'FAILED',
               'CheckoutRequestID=' + checkId,
               'receipt=' + (meta.MpesaReceiptNumber || '') + ' amount=' + (meta.Amount || ''),
               success ? null : 'ResultCode=' + code);

    // Match the upload by its stored CheckoutRequestID (the reference key set at
    // initiate) and record the result. The webhook writes ONLY the payment table
    // (payment_uploads); invoice/order settlement is the reconcile JOB's job, so
    // the boundary "the webhook touches only payment tables" holds. Idempotent:
    // an already-APPROVED upload is left untouched, so a Daraja retry is a no-op.
    var matched = false;
    if (success && checkId) {
      var matchRows = TursoClient.select(
        "SELECT upload_id, status FROM payment_uploads WHERE reference=? LIMIT 1", [checkId]
      );
      if (matchRows.length) {
        matched = true;
        if (matchRows[0].status !== 'APPROVED') {
          var now = nowIso();
          TursoClient.write(
            "UPDATE payment_uploads SET status='APPROVED',reviewed_by='MPESA',reviewed_at=?,updated_at=? WHERE upload_id=?",
            [now, now, matchRows[0].upload_id]
          );
        }
      }
    }
    return { success: success, matched: matched, result_code: code };
  }

  function reconcile() {
    var props     = PropertiesService.getScriptProperties();
    var shortcode = props.getProperty('MPESA_SHORTCODE') || '';
    var passkey   = props.getProperty('MPESA_PASSKEY')   || '';
    if (!shortcode || !passkey) { _logInteg_('reconcile', 'SKIPPED', '', '', 'MPESA not configured'); return; }

    // Uploads are created with status PENDING_REVIEW (the real upload status), so
    // match that (plus legacy 'PENDING') and require a stored reference (the
    // CheckoutRequestID set at initiate). The previous 'PENDING'-only filter
    // never matched, so charged-but-unmatched payments were never recovered.
    var pending = TursoClient.select(
      "SELECT upload_id, invoice_id, reference FROM payment_uploads " +
      "WHERE status IN ('PENDING_REVIEW','PENDING') AND reference IS NOT NULL AND reference != '' " +
      "ORDER BY created_at LIMIT 50"
    );

    var ts       = _timestamp_();
    var password = Utilities.base64Encode(shortcode + passkey + ts);
    var token    = _token_();
    var reconciled = 0;
    var toSettle   = {};   // invoice_id -> 1 (dedupe the settlement pass)

    pending.forEach(function (row) {
      try {
        var resp = UrlFetchApp.fetch(_base_() + '/mpesa/stkpushquery/v1/query', {
          method: 'post', contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify({ BusinessShortCode: shortcode, Password: password, Timestamp: ts,
                                    CheckoutRequestID: row.reference }),
          muteHttpExceptions: true,
        });
        var result = {};
        try { result = JSON.parse(resp.getContentText()); } catch (_) {}
        if (result.ResultCode === '0' || result.ResultCode === 0) {
          var now = nowIso();
          TursoClient.write(
            "UPDATE payment_uploads SET status='APPROVED',reviewed_by='MPESA_RECON',reviewed_at=?,updated_at=? WHERE upload_id=?",
            [now, now, row.upload_id]
          );
          if (row.invoice_id) toSettle[row.invoice_id] = 1;
          reconciled++;
        }
      } catch (_) {}
    });

    // Recovery: also settle invoices for M-Pesa uploads already APPROVED (by the
    // callback webhook or by this job) but whose invoice has not yet reached PAID.
    // This is the JOB path, so updating invoices/orders here is in bounds (the
    // webhook itself never touches those tables). Settlement is idempotent.
    try {
      var approved = TursoClient.select(
        "SELECT DISTINCT pu.invoice_id AS invoice_id FROM payment_uploads pu " +
        "JOIN invoices i ON i.invoice_id = pu.invoice_id " +
        "WHERE pu.status='APPROVED' AND pu.reviewed_by IN ('MPESA','MPESA_RECON') " +
        "AND pu.invoice_id IS NOT NULL AND COALESCE(i.payment_status,'') != 'PAID' LIMIT 100"
      );
      approved.forEach(function (r) { if (r.invoice_id) toSettle[r.invoice_id] = 1; });
    } catch (_) {}

    var settled = 0;
    Object.keys(toSettle).forEach(function (invoiceId) {
      try {
        if (typeof _settleInvoiceFromApprovedUploads_ === 'function') {
          _settleInvoiceFromApprovedUploads_(invoiceId, 'MPESA_RECON');
          settled++;
        }
      } catch (e) {
        _logInteg_('reconcile', 'FAILED', 'settle invoice=' + invoiceId, '', e && e.message ? e.message : String(e));
      }
    });

    _logInteg_('reconcile', 'SUCCESS', 'checked=' + pending.length,
               'reconciled=' + reconciled + ' settled=' + settled, null);
    Logger.log('MpesaInteg.reconcile: checked=' + pending.length + ' reconciled=' + reconciled + ' settled=' + settled);
  }

  return { initiate: initiate, callback: callback, reconcile: reconcile };
})();
