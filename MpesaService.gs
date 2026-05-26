// ================================================================
// HASS PETROLEUM CMS - MpesaService.gs
// Production M-Pesa Daraja C2B integration.
//
// Credentials (Script Properties):
//   MPESA_CONSUMER_KEY      - Daraja OAuth consumer key
//   MPESA_CONSUMER_SECRET   - Daraja OAuth consumer secret
//   MPESA_SHORTCODE         - Paybill / till shortcode
//   MPESA_ENV               - 'production' | 'sandbox'
//
// Callback registration (one-time, from IDE):
//   registerMpesaCallbackUrls()
//
// Public API:
//   handleMpesaValidation(body)   - Daraja validation callback
//   handleMpesaConfirmation(body) - Daraja confirmation callback
//   isMpesaDarajaCallback(params) - sniff for Daraja body in doPost
//   registerMpesaCallbackUrls()   - register URLs with Daraja
//   retryUnmatchedMpesaPayments() - manual reconciliation sweep
//
// PRODUCTION NOTE:
//   Daraja production credentials and a publicly-accessible web-app
//   callback URL are required before this runs against production.
//   See the README / PR description for the full provisioning checklist.
// ================================================================

var MPESA_INTEGRATION_NAME_ = 'MPESA_DARAJA';

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------

function _mpesaConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    consumerKey:    props.getProperty('MPESA_CONSUMER_KEY')    || '',
    consumerSecret: props.getProperty('MPESA_CONSUMER_SECRET') || '',
    shortcode:      props.getProperty('MPESA_SHORTCODE')       || '',
    env:            (props.getProperty('MPESA_ENV') || 'sandbox').toLowerCase(),
  };
}

function _mpesaBaseUrl_(env) {
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

// ----------------------------------------------------------------
// Daraja body sniffer (called by Code.gs doPost before service routing)
// ----------------------------------------------------------------

/**
 * Returns true if the parsed POST body looks like a Daraja C2B callback.
 * Daraja bodies always include TransID and BusinessShortCode.
 */
function isMpesaDarajaCallback(params) {
  return !!(params && typeof params.TransID === 'string' && params.TransID.length > 0 &&
            typeof params.BusinessShortCode === 'string');
}

/**
 * Route a Daraja callback from doPost / doGet.
 * @param {Object} params    - parsed JSON body
 * @param {Object} urlParams - e.parameter (URL query params)
 * @returns {string} JSON string ready to return directly
 */
function handleMpesaCallback(params, urlParams) {
  var mode = String((urlParams && urlParams.mpesa) || '').toLowerCase();
  if (mode === 'validate') return handleMpesaValidation(params);
  return handleMpesaConfirmation(params);
}

// ----------------------------------------------------------------
// Validation callback
// ----------------------------------------------------------------

/**
 * Handles the Daraja C2B validation callback.
 * Must respond within ~5 s. Accepts all references - unknown refs
 * are resolved in the confirmation handler or flagged as UNMATCHED.
 *
 * @param {Object} body - Daraja JSON body
 * @returns {string}   JSON response string
 */
function handleMpesaValidation(body) {
  var trans = _parseDarajaBody_(body);
  _mpesaLog_('VALIDATION', trans, { ResultCode: '0' }, 200);
  return JSON.stringify({ ResultCode: '0', ResultDesc: 'Accepted' });
}

// ----------------------------------------------------------------
// Confirmation callback
// ----------------------------------------------------------------

/**
 * Handles the Daraja C2B confirmation callback. Idempotent: a TransID
 * that has already been reconciled returns success without re-processing.
 *
 * @param {Object} body - Daraja JSON body
 * @returns {string}   JSON response string
 */
function handleMpesaConfirmation(body) {
  var trans = _parseDarajaBody_(body);
  var start = new Date();

  // Idempotency guard
  if (_mpesaAlreadyProcessed_(trans.TransID)) {
    Logger.log('[MpesaService] Duplicate confirmation: ' + trans.TransID);
    return JSON.stringify({ ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
  }

  var result = { success: false, error: 'Processing error' };
  try {
    result = reconcileMpesaPayment(trans);
    var ms = new Date() - start;
    _mpesaLog_('CONFIRMATION', trans, result, result.success ? 200 : 400);

    if (result.success && result.entityType !== 'Unmatched') {
      try {
        auditLogCustom(
          result.entityType || 'Payment',
          result.entityId   || trans.TransID,
          MPESA_INTEGRATION_NAME_,
          'PAYMENT_CONFIRMED',
          {
            trans_id:   trans.TransID,
            amount:     trans.TransAmount,
            reference:  trans.BillRefNumber,
            msisdn:     trans.MSISDN,
            matched_to: result.entityId || '',
          },
          ''
        );
      } catch(e) {}
    }
  } catch(e) {
    Logger.log('[MpesaService] handleMpesaConfirmation error: ' + e.message);
    _mpesaLog_('CONFIRMATION', trans, { error: e.message }, 500);
  }

  // Always ACK to Daraja to prevent retries.
  return JSON.stringify({ ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
}

// ----------------------------------------------------------------
// Reconciliation
// ----------------------------------------------------------------

/**
 * Matches a Daraja transaction to a PaymentUpload or Invoice and
 * updates the record to PAID.
 *
 * Match order:
 *   1. PaymentUploads.reference_number = BillRefNumber
 *   2. Invoices.invoice_number         = BillRefNumber
 *   3. Invoices.po_number              = BillRefNumber
 *   4. Unmatched log
 *
 * @param {Object} trans - parsed Daraja body
 * @returns {Object} { success, entityType, entityId, ... }
 */
function reconcileMpesaPayment(trans) {
  var ref     = String(trans.BillRefNumber || '').trim();
  var amount  = parseFloat(trans.TransAmount) || 0;
  var transId = String(trans.TransID         || '').trim();
  var now     = new Date().toISOString();

  if (!transId) return { success: false, error: 'Missing TransID' };

  // 1. PaymentUploads
  var upload = null;
  try {
    if (ref) upload = findRow('PaymentUploads', 'reference_number', ref);
  } catch(e) {}

  if (upload) {
    var oldUploadStatus = upload.status;
    updateRow('PaymentUploads', 'upload_id', upload.upload_id, {
      status:      'RECONCILED',
      paid_at:     now,
      trans_id:    transId,
      updated_at:  now,
    });
    clearSheetCache('PaymentUploads');
    if (upload.invoice_id) _markInvoicePaid_(upload.invoice_id, transId, amount, now);
    return { success: true, entityType: 'PaymentUpload', entityId: upload.upload_id,
             from: oldUploadStatus, to: 'RECONCILED' };
  }

  // 2. Invoices by invoice_number
  var invoice = null;
  try {
    if (ref) invoice = findRow('Invoices', 'invoice_number', ref);
    if (!invoice && ref) invoice = findRow('Invoices', 'po_number', ref);
  } catch(e) {}

  if (invoice) {
    var prevStatus = invoice.status;
    _markInvoicePaid_(invoice.invoice_id, transId, amount, now);
    return { success: true, entityType: 'Invoice', entityId: invoice.invoice_id,
             from: prevStatus, to: 'PAID' };
  }

  // 3. Unmatched
  Logger.log('[MpesaService] Unmatched: TransID=' + transId + ' Ref=' + ref + ' Amt=' + amount);
  try {
    appendRow('UnmatchedPayments', {
      unmatched_id: generateId('UMP'),
      trans_id:     transId,
      amount:       amount,
      reference:    ref,
      msisdn:       trans.MSISDN  || '',
      trans_time:   trans.TransTime || '',
      raw_body:     JSON.stringify(trans).substring(0, 1000),
      status:       'UNMATCHED',
      created_at:   now,
    });
  } catch(e) {}
  return { success: true, entityType: 'Unmatched', entityId: transId };
}

/**
 * Marks an invoice as PAID and reduces the customer's credit_used.
 * Idempotent: skips if already PAID.
 */
function _markInvoicePaid_(invoiceId, transId, amount, now) {
  if (!invoiceId) return;
  try {
    var inv = getById('Invoices', invoiceId);
    if (!inv || String(inv.payment_status || '').toUpperCase() === 'PAID') return;
    updateRow('Invoices', 'invoice_id', invoiceId, {
      payment_status:  'PAID',
      paid_at:         now,
      mpesa_trans_id:  transId,
      amount_paid:     amount,
      updated_at:      now,
    });
    clearSheetCache('Invoices');
    // Release credit used
    if (inv.customer_id) {
      try {
        var cust = getById('Customers', inv.customer_id);
        if (cust) {
          var invAmt  = parseFloat(inv.total_amount) || 0;
          var newUsed = Math.max(0, (parseFloat(cust.credit_used) || 0) - invAmt);
          updateRow('Customers', 'customer_id', inv.customer_id, { credit_used: newUsed, updated_at: now });
          clearSheetCache('Customers');
        }
      } catch(e) {}
    }
  } catch(e) {
    Logger.log('[MpesaService] _markInvoicePaid_ error: ' + e.message);
  }
}

// ----------------------------------------------------------------
// Idempotency check
// ----------------------------------------------------------------

function _mpesaAlreadyProcessed_(transId) {
  if (!transId) return false;
  try {
    var rows = tursoSelect(
      'SELECT 1 FROM integration_log WHERE integration = ? AND endpoint = ? AND reference_id = ? AND status_code = 200 LIMIT 1',
      [MPESA_INTEGRATION_NAME_, 'CONFIRMATION', transId]
    );
    return rows.length > 0;
  } catch(e) {
    // Fallback: check request_body (old log entries without reference_id)
    try {
      var r2 = tursoSelect(
        "SELECT 1 FROM integration_log WHERE integration = ? AND endpoint = ? AND request_body LIKE ? AND status_code = 200 LIMIT 1",
        [MPESA_INTEGRATION_NAME_, 'CONFIRMATION', '%' + transId + '%']
      );
      return r2.length > 0;
    } catch(e2) { return false; }
  }
}

// ----------------------------------------------------------------
// Body parser
// ----------------------------------------------------------------

function _parseDarajaBody_(body) {
  if (!body || typeof body !== 'object') return {};
  return {
    TransactionType:   String(body.TransactionType   || ''),
    TransID:           String(body.TransID           || ''),
    TransTime:         String(body.TransTime         || ''),
    TransAmount:       String(body.TransAmount       || '0'),
    BusinessShortCode: String(body.BusinessShortCode || ''),
    BillRefNumber:     String(body.BillRefNumber     || ''),
    InvoiceNumber:     String(body.InvoiceNumber     || ''),
    OrgAccountBalance: String(body.OrgAccountBalance || ''),
    MSISDN:            String(body.MSISDN            || ''),
    FirstName:         String(body.FirstName         || ''),
    MiddleName:        String(body.MiddleName        || ''),
    LastName:          String(body.LastName          || ''),
  };
}

// ----------------------------------------------------------------
// Integration log
// ----------------------------------------------------------------

function _mpesaLog_(endpoint, request, response, statusCode) {
  try {
    appendRow('IntegrationLog', {
      log_id:         generateId('MPE'),
      integration:    MPESA_INTEGRATION_NAME_,
      direction:      'INBOUND',
      endpoint:       endpoint,
      method:         'POST',
      request_body:   JSON.stringify(request  || {}).substring(0, 2000),
      response_body:  JSON.stringify(response || {}).substring(0, 2000),
      status_code:    statusCode || 0,
      error_message:  statusCode >= 400 ? ((response && response.error) || '') : '',
      duration_ms:    0,
      reference_type: 'Payment',
      reference_id:   (request && request.TransID) || '',
      created_at:     new Date().toISOString(),
    });
  } catch(e) {
    Logger.log('[MpesaService] _mpesaLog_ error: ' + e.message);
  }
}

// ----------------------------------------------------------------
// Callback URL registration (run once from IDE after web-app deploy)
// ----------------------------------------------------------------

/**
 * Registers the C2B validation and confirmation URLs with Daraja.
 *
 * Prerequisites:
 *   1. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE in Script Properties.
 *   2. Set MPESA_ENV to 'production' (default 'sandbox').
 *   3. Deploy as web app: Execute as "Me", Access "Anyone".
 *   4. Run this function from the Apps Script IDE.
 *
 * Production note: Daraja production credentials and a registered
 * callback URL are required. Contact the Finance IT team for provisioning.
 */
function registerMpesaCallbackUrls() {
  var cfg = _mpesaConfig_();
  if (!cfg.consumerKey || !cfg.consumerSecret || !cfg.shortcode) {
    return { success: false, error: 'MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE must be set in Script Properties.' };
  }
  var scriptUrl = '';
  try { scriptUrl = ScriptApp.getService().getUrl(); } catch(e) {}
  if (!scriptUrl) return { success: false, error: 'Could not get script URL. Ensure the script is deployed as a web app.' };

  try {
    var token = _mpesaGetOAuthToken_(cfg);
    if (!token) return { success: false, error: 'Could not get M-Pesa OAuth token. Check credentials.' };

    var baseUrl = _mpesaBaseUrl_(cfg.env);
    var payload = {
      ShortCode:       cfg.shortcode,
      ResponseType:    'Completed',
      ConfirmationURL: scriptUrl + '?mpesa=confirm',
      ValidationURL:   scriptUrl + '?mpesa=validate',
    };

    var response = UrlFetchApp.fetch(baseUrl + '/mpesa/c2b/v1/registerurl', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    var body = {};
    try { body = JSON.parse(response.getContentText()); } catch(e) {}

    return code === 200
      ? { success: true,  message: 'Callback URLs registered.',  response: body }
      : { success: false, error:   'HTTP ' + code + ': ' + JSON.stringify(body) };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function _mpesaGetOAuthToken_(cfg) {
  var baseUrl = _mpesaBaseUrl_(cfg.env);
  try {
    var resp = UrlFetchApp.fetch(baseUrl + '/oauth/v1/generate?grant_type=client_credentials', {
      method:             'get',
      headers:            {
        'Authorization': 'Basic ' + Utilities.base64Encode(cfg.consumerKey + ':' + cfg.consumerSecret),
      },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return null;
    var body = JSON.parse(resp.getContentText());
    return body.access_token || null;
  } catch(e) {
    Logger.log('[MpesaService] OAuth token error: ' + e.message);
    return null;
  }
}

// ----------------------------------------------------------------
// Manual reconciliation sweep
// ----------------------------------------------------------------

/**
 * Re-attempts reconciliation of UNMATCHED payments. Run manually or
 * via a scheduled trigger after manual reference matching.
 */
function retryUnmatchedMpesaPayments() {
  var rows = [];
  try { rows = getSheetData('UnmatchedPayments') || []; } catch(e) { return { success: false, error: e.message }; }

  var pending = rows.filter(function(r) { return String(r.status || '').toUpperCase() === 'UNMATCHED'; });
  var reconciled = 0, errors = 0;

  pending.forEach(function(row) {
    try {
      var result = reconcileMpesaPayment({
        TransID:         row.trans_id,
        TransAmount:     String(row.amount || '0'),
        BillRefNumber:   row.reference || '',
        MSISDN:          row.msisdn || '',
        TransTime:       row.trans_time || '',
      });
      if (result.success && result.entityType !== 'Unmatched') {
        updateRow('UnmatchedPayments', 'trans_id', row.trans_id, {
          status:     'RECONCILED',
          updated_at: new Date().toISOString(),
        });
        reconciled++;
      }
    } catch(e) {
      errors++;
      Logger.log('[MpesaService] retryUnmatched error: ' + e.message);
    }
  });

  return { success: true, total: pending.length, reconciled: reconciled, errors: errors };
}
