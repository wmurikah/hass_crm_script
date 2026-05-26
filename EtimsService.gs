// ================================================================
// HASS PETROLEUM CMS - EtimsService.gs
// KRA eTIMS OSDC (Online Sales Data Controller) integration.
//
// Credentials (Script Properties):
//   ETIMS_API_URL     - base URL (default: KRA sandbox)
//   ETIMS_BRANCH_ID   - 2-char branch code (e.g. '00')
//   ETIMS_DEVICE_SERIAL - OSDC device serial number
//   ETIMS_PIN         - taxpayer PIN (company KRA PIN)
//   ETIMS_PIN_KEY     - OSDC communication key
//   ETIMS_ENV         - 'production' | 'sandbox'
//
// Column additions required on Invoices table:
//   etims_status                 TEXT  (NULL | PENDING | TRANSMITTED | FAILED | SKIPPED)
//   etims_cu_invoice_number      TEXT  (control unit invoice number from KRA)
//   etims_qr_data                TEXT  (QR code data string)
//   etims_transmitted_at         TEXT  (ISO timestamp)
//   etims_retry_count            INTEGER (default 0)
//   etims_last_error             TEXT
//
// Entry points:
//   submitInvoiceToEtims(invoiceId)      - called after invoice generation
//   retryFailedEtimsTransmissions()      - hourly retry job
//   installEtimsRetryTrigger()           - one-time trigger installation
//
// PRODUCTION NOTE:
//   KRA credentials, branch/device configuration, and eTIMS OSDC
//   registration are required from the Finance and IT teams before
//   this runs against production. Test in sandbox first.
// ================================================================

var ETIMS_INTEGRATION_NAME_ = 'KRA_ETIMS';
var ETIMS_MAX_RETRIES_       = 5;

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------

function _etimsConfig_() {
  var props = PropertiesService.getScriptProperties();
  var env   = (props.getProperty('ETIMS_ENV') || 'sandbox').toLowerCase();
  var apiUrl = props.getProperty('ETIMS_API_URL') ||
    (env === 'production'
      ? 'https://etims-api.kra.go.ke/etims-api'
      : 'https://etims-sbx.kra.go.ke/etims-api');
  return {
    apiUrl:       apiUrl,
    branchId:     props.getProperty('ETIMS_BRANCH_ID')      || '00',
    deviceSerial: props.getProperty('ETIMS_DEVICE_SERIAL')  || '',
    pin:          props.getProperty('ETIMS_PIN')             || '',
    pinKey:       props.getProperty('ETIMS_PIN_KEY')         || '',
    env:          env,
  };
}

// ----------------------------------------------------------------
// Public entry point - called after invoice is saved to DB
// ----------------------------------------------------------------

/**
 * Transmits an invoice to KRA eTIMS.
 * Non-throwing: on failure, flags the invoice and logs the error.
 *
 * @param {string} invoiceId
 * @returns {Object} { success, etimsCuInvoiceNumber, etimsQrData, error }
 */
function submitInvoiceToEtims(invoiceId) {
  if (!invoiceId) return { success: false, error: 'Missing invoiceId' };

  var cfg = _etimsConfig_();
  if (!cfg.pin || !cfg.deviceSerial || !cfg.pinKey) {
    Logger.log('[EtimsService] eTIMS credentials not configured - skipping transmission for ' + invoiceId);
    _etimsFlagSkipped_(invoiceId, 'eTIMS credentials not configured');
    return { success: false, skipped: true, error: 'eTIMS credentials not configured' };
  }

  // Idempotency: do not re-transmit a successfully transmitted invoice.
  try {
    var existingInv = getById('Invoices', invoiceId);
    if (!existingInv) return { success: false, error: 'Invoice not found: ' + invoiceId };
    var existingStatus = String(existingInv.etims_status || '').toUpperCase();
    if (existingStatus === 'TRANSMITTED') {
      Logger.log('[EtimsService] Invoice ' + invoiceId + ' already transmitted, skipping.');
      return {
        success:              true,
        alreadyTransmitted:   true,
        etimsCuInvoiceNumber: existingInv.etims_cu_invoice_number || '',
        etimsQrData:          existingInv.etims_qr_data || '',
      };
    }
  } catch(e) {
    Logger.log('[EtimsService] idempotency check error: ' + e.message);
  }

  return _doSubmit_(invoiceId, cfg);
}

/**
 * Inner function that performs the actual submission. Separated so
 * retryFailedEtimsTransmissions() can call it directly.
 */
function _doSubmit_(invoiceId, cfg) {
  var invoice, lines, customer;
  try {
    invoice  = getById('Invoices', invoiceId);
    if (!invoice) return { success: false, error: 'Invoice not found: ' + invoiceId };
    var linesRes = findWhere('InvoiceLines', { invoice_id: invoiceId }, { limit: 500 });
    lines    = (linesRes && linesRes.data) || [];
    customer = invoice.customer_id ? getById('Customers', invoice.customer_id) : null;
  } catch(e) {
    _etimsFlagFailed_(invoiceId, 'DB read error: ' + e.message);
    return { success: false, error: 'DB read error: ' + e.message };
  }

  var payload = _buildEtimsPayload_(invoice, lines, customer, cfg);
  var callResult = _callEtimsApi_(cfg, '/trnsSales/saveTrnsSalesOsdc', payload);

  if (callResult.success) {
    var cuInvNo = callResult.data && (callResult.data.rcptNo || callResult.data.cuInvoiceNumber || '');
    var qrData  = callResult.data && (callResult.data.qrCode || callResult.data.qrData || '');
    var now     = new Date().toISOString();
    try {
      updateRow('Invoices', 'invoice_id', invoiceId, {
        etims_status:           'TRANSMITTED',
        etims_cu_invoice_number: cuInvNo,
        etims_qr_data:          qrData,
        etims_transmitted_at:   now,
        etims_last_error:       '',
        updated_at:             now,
      });
      clearSheetCache('Invoices');
    } catch(e) {
      Logger.log('[EtimsService] DB update after transmission error: ' + e.message);
    }

    try {
      auditLogCustom('Invoice', invoiceId, ETIMS_INTEGRATION_NAME_, 'ETIMS_TRANSMITTED', {
        cu_invoice_number: cuInvNo,
        invoice_number:    invoice.invoice_number || '',
        env:               cfg.env,
      }, invoice.country_code || '');
    } catch(e) {}

    return { success: true, etimsCuInvoiceNumber: cuInvNo, etimsQrData: qrData };
  } else {
    _etimsFlagFailed_(invoiceId, callResult.error || 'Unknown eTIMS error');
    return { success: false, error: callResult.error };
  }
}

// ----------------------------------------------------------------
// Payload builder (KRA OSDC v1.0 spec)
// ----------------------------------------------------------------

function _buildEtimsPayload_(invoice, lines, customer, cfg) {
  var now      = new Date();
  var salesDt  = _etimsDate_(invoice.invoice_date || invoice.created_at || now);
  var cfmDt    = _etimsDateTime_(now);

  // Tax classification: petroleum products are typically VAT exempt (E) or
  // standard rated (B = 16%). Adjust taxCd per product SKU if needed.
  var totalAmount  = parseFloat(invoice.total_amount)  || 0;
  var taxAmount    = parseFloat(invoice.tax_amount)    || (totalAmount * 16 / 116);
  var taxableAmt   = totalAmount - taxAmount;

  var itemList = lines.map(function(line, idx) {
    var lineAmt     = parseFloat(line.line_total || line.amount) || 0;
    var lineTax     = parseFloat(line.tax_amount) || (lineAmt * 16 / 116);
    var lineTaxable = lineAmt - lineTax;
    return {
      itemSeq:    idx + 1,
      itemCd:     String(line.product_code || line.sku || 'ITEM' + (idx + 1)).substring(0, 20),
      itemClsCd:  String(line.etims_class_code || '85101500'),
      itemNm:     String(line.description || line.product_name || 'Item').substring(0, 200),
      bcd:        '',
      pkgUnitCd:  String(line.unit_of_measure || 'LTR').toUpperCase().substring(0, 5),
      pkg:        parseFloat(line.quantity) || 1,
      qtyUnitCd:  String(line.unit_of_measure || 'LTR').toUpperCase().substring(0, 5),
      qty:        parseFloat(line.quantity) || 1,
      prc:        parseFloat(line.unit_price || line.price) || 0,
      splyAmt:    lineAmt,
      dcRt:       parseFloat(line.discount_percent) || 0,
      dcAmt:      parseFloat(line.discount_amount)  || 0,
      isrccCd:    '',
      isrccNm:    '',
      isrcRt:     0,
      isrcAmt:    0,
      taxTyCd:    String(line.tax_type_code || 'B'),
      taxblAmt:   lineTaxable,
      taxAmt:     lineTax,
      totAmt:     lineAmt,
    };
  });

  // If no lines were provided, create a summary line from the invoice header.
  if (itemList.length === 0) {
    itemList.push({
      itemSeq:    1,
      itemCd:     'SVC001',
      itemClsCd:  '85101500',
      itemNm:     String(invoice.description || 'Petroleum Products').substring(0, 200),
      bcd:        '',
      pkgUnitCd:  'LTR',
      pkg:        1,
      qtyUnitCd:  'LTR',
      qty:        1,
      prc:        totalAmount,
      splyAmt:    totalAmount,
      dcRt:       0,
      dcAmt:      0,
      isrccCd:    '',
      isrccNm:    '',
      isrcRt:     0,
      isrcAmt:    0,
      taxTyCd:    'B',
      taxblAmt:   taxableAmt,
      taxAmt:     taxAmount,
      totAmt:     totalAmount,
    });
  }

  return {
    tin:           cfg.pin,
    bhfId:         cfg.branchId,
    dvcSrlNo:      cfg.deviceSerial,
    invcNo:        String(invoice.invoice_number || invoiceId).substring(0, 50),
    rcptTyCd:      'S',
    pmtTyCd:       _mapPaymentType_(invoice.payment_method),
    salesSttsCd:   '02',
    cfmDt:         cfmDt,
    salesDt:       salesDt,
    stockRlsDt:    salesDt,
    cnclReqDt:     '',
    cnclDt:        '',
    prchrAcptcYn:  'N',
    remark:        String(invoice.notes || '').substring(0, 200),
    regrId:        cfg.pin,
    regrNm:        'Hass Petroleum',
    modrId:        cfg.pin,
    modrNm:        'Hass Petroleum',
    custTin:       String((customer && customer.kra_pin) || '').substring(0, 11),
    custNm:        String((customer && (customer.company_name || customer.trading_name)) || 'Walk-in').substring(0, 100),
    adrs:          String((customer && customer.address) || '').substring(0, 200),
    totItemCnt:    itemList.length,
    taxblAmtA:     0,
    taxblAmtB:     taxableAmt,
    taxblAmtC:     0,
    taxblAmtD:     0,
    taxRtA:        0,
    taxRtB:        16,
    taxRtC:        0,
    taxRtD:        0,
    taxAmtA:       0,
    taxAmtB:       taxAmount,
    taxAmtC:       0,
    taxAmtD:       0,
    totTaxblAmt:   taxableAmt,
    totTaxAmt:     taxAmount,
    totAmt:        totalAmount,
    itemList:      itemList,
  };
}

function _mapPaymentType_(method) {
  var m = String(method || '').toUpperCase();
  if (m.indexOf('MPESA') !== -1 || m.indexOf('MOBILE') !== -1) return '04';
  if (m.indexOf('CASH')  !== -1)                                return '01';
  if (m.indexOf('CARD')  !== -1 || m.indexOf('CREDIT') !== -1) return '02';
  if (m.indexOf('CHEQUE')!== -1 || m.indexOf('CHECK')  !== -1) return '03';
  return '01'; // default CASH
}

function _etimsDate_(val) {
  var d = val instanceof Date ? val : new Date(val || Date.now());
  return d.getFullYear().toString() +
    _pad2_(d.getMonth() + 1) +
    _pad2_(d.getDate());
}

function _etimsDateTime_(val) {
  var d = val instanceof Date ? val : new Date(val || Date.now());
  return d.getFullYear().toString() +
    _pad2_(d.getMonth() + 1) +
    _pad2_(d.getDate()) +
    _pad2_(d.getHours()) +
    _pad2_(d.getMinutes()) +
    _pad2_(d.getSeconds());
}

function _pad2_(n) { return n < 10 ? '0' + n : String(n); }

// ----------------------------------------------------------------
// HTTP layer
// ----------------------------------------------------------------

/**
 * Calls the eTIMS OSDC API.
 * @param {Object} cfg
 * @param {string} endpoint  e.g. '/trnsSales/saveTrnsSalesOsdc'
 * @param {Object} payload
 * @returns {Object} { success, data, error, httpStatus }
 */
function _callEtimsApi_(cfg, endpoint, payload) {
  var url = cfg.apiUrl + endpoint;
  var start = Date.now();
  var httpStatus = 0;
  var responseText = '';
  var result = { success: false, error: 'Not started' };

  try {
    var resp = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
      headers:            {
        'cmcKey': cfg.pinKey,
        'tin':    cfg.pin,
        'bhfId':  cfg.branchId,
      },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    httpStatus    = resp.getResponseCode();
    responseText  = resp.getContentText();
    var body = {};
    try { body = JSON.parse(responseText); } catch(pe) {}

    // KRA returns resultCd = '000' for success.
    if (httpStatus === 200 && (body.resultCd === '000' || body.resultCd === 0 || body.result === 'SUCCESS')) {
      result = { success: true, data: body.data || body, httpStatus: httpStatus };
    } else {
      var errMsg = body.resultMsg || body.message || ('HTTP ' + httpStatus);
      result = { success: false, error: errMsg, httpStatus: httpStatus, data: body };
    }
  } catch(e) {
    result = { success: false, error: e.message, httpStatus: 0 };
  }

  // Log every call.
  try {
    appendRow('IntegrationLog', {
      log_id:         generateId('ETM'),
      integration:    ETIMS_INTEGRATION_NAME_,
      direction:      'OUTBOUND',
      endpoint:       endpoint,
      method:         'POST',
      request_body:   JSON.stringify(payload || {}).substring(0, 2000),
      response_body:  responseText.substring(0, 2000),
      status_code:    httpStatus,
      error_message:  result.success ? '' : (result.error || ''),
      duration_ms:    Date.now() - start,
      reference_type: 'Invoice',
      reference_id:   String((payload && payload.invcNo) || ''),
      created_at:     new Date().toISOString(),
    });
  } catch(le) {
    Logger.log('[EtimsService] log error: ' + le.message);
  }

  return result;
}

// ----------------------------------------------------------------
// Status flag helpers
// ----------------------------------------------------------------

function _etimsFlagFailed_(invoiceId, reason) {
  if (!invoiceId) return;
  var now = new Date().toISOString();
  try {
    var inv = getById('Invoices', invoiceId);
    var retries = parseInt((inv && inv.etims_retry_count) || 0, 10) + 1;
    updateRow('Invoices', 'invoice_id', invoiceId, {
      etims_status:      'FAILED',
      etims_last_error:  String(reason || '').substring(0, 1000),
      etims_retry_count: retries,
      updated_at:        now,
    });
    clearSheetCache('Invoices');
    Logger.log('[EtimsService] flagged invoice ' + invoiceId + ' as FAILED (attempt ' + retries + '): ' + reason);
  } catch(e) {
    Logger.log('[EtimsService] _etimsFlagFailed_ DB error: ' + e.message);
  }
}

function _etimsFlagSkipped_(invoiceId, reason) {
  if (!invoiceId) return;
  try {
    updateRow('Invoices', 'invoice_id', invoiceId, {
      etims_status:     'SKIPPED',
      etims_last_error: String(reason || '').substring(0, 500),
      updated_at:       new Date().toISOString(),
    });
    clearSheetCache('Invoices');
  } catch(e) {
    Logger.log('[EtimsService] _etimsFlagSkipped_ DB error: ' + e.message);
  }
}

// ----------------------------------------------------------------
// Retry sweep
// ----------------------------------------------------------------

/**
 * Re-attempts transmission for invoices in FAILED status up to
 * ETIMS_MAX_RETRIES_ attempts. Run hourly via trigger.
 *
 * @returns {Object} { success, total, transmitted, skipped, errors }
 */
function retryFailedEtimsTransmissions() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return { success: false, error: 'eTIMS retry sweep already running' };
  }
  try {
    var cfg = _etimsConfig_();
    if (!cfg.pin || !cfg.deviceSerial || !cfg.pinKey) {
      return { success: false, error: 'eTIMS credentials not configured' };
    }

    var res  = findWhere('Invoices', { etims_status: 'FAILED' }, { limit: 200 });
    var rows = (res && res.data) || [];

    var stats = { total: rows.length, transmitted: 0, skipped: 0, errors: 0 };

    rows.forEach(function(inv) {
      var retries = parseInt(inv.etims_retry_count || 0, 10);
      if (retries >= ETIMS_MAX_RETRIES_) {
        Logger.log('[EtimsService] invoice ' + inv.invoice_id + ' exceeded max retries, skipping');
        try {
          updateRow('Invoices', 'invoice_id', inv.invoice_id, { etims_status: 'FAILED_FINAL', updated_at: new Date().toISOString() });
        } catch(e) {}
        stats.skipped++;
        return;
      }
      try {
        var r = _doSubmit_(inv.invoice_id, cfg);
        if (r.success) stats.transmitted++;
        else           stats.errors++;
      } catch(e) {
        stats.errors++;
        Logger.log('[EtimsService] retry error for ' + inv.invoice_id + ': ' + e.message);
      }
    });

    if (stats.transmitted > 0 || stats.skipped > 0) {
      try { clearSheetCache('Invoices'); } catch(e) {}
    }

    return Object.assign({ success: true }, stats);
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------
// Non-transmitted invoice report
// ----------------------------------------------------------------

/**
 * Returns invoices that were generated but not yet transmitted to eTIMS.
 * Used by Finance for follow-up. Includes FAILED and NULL status.
 *
 * @param {Object} options - { limit, since }
 * @returns {Array} invoice rows
 */
function getNonTransmittedInvoices(options) {
  options = options || {};
  try {
    var since = options.since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    var rows = tursoSelect(
      "SELECT invoice_id, invoice_number, customer_id, total_amount, created_at, " +
      "etims_status, etims_retry_count, etims_last_error " +
      "FROM invoices " +
      "WHERE (etims_status IS NULL OR etims_status IN ('FAILED','FAILED_FINAL','PENDING')) " +
      "AND created_at >= ? " +
      "ORDER BY created_at DESC LIMIT ?",
      [since, options.limit || 500]
    );
    return { success: true, data: rows, total: rows.length };
  } catch(e) {
    Logger.log('[EtimsService] getNonTransmittedInvoices error: ' + e.message);
    return { success: false, error: e.message, data: [] };
  }
}

// ----------------------------------------------------------------
// Trigger management
// ----------------------------------------------------------------

/**
 * Installs an hourly time-driven trigger for the eTIMS retry sweep.
 * Idempotent - safe to call multiple times.
 */
function installEtimsRetryTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'retryFailedEtimsTransmissions') {
      Logger.log('[EtimsService] eTIMS retry trigger already installed');
      return;
    }
  }
  ScriptApp.newTrigger('retryFailedEtimsTransmissions')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('[EtimsService] hourly eTIMS retry trigger installed');
}

function uninstallEtimsRetryTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'retryFailedEtimsTransmissions') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('[EtimsService] eTIMS retry trigger removed');
      return;
    }
  }
}
