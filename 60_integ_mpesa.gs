/**
 * 60_integ_mpesa.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * M-Pesa Daraja API integration.
 *
 * Exposed surface (called from 40_svc_invoices.gs or job layer):
 *   MpesaInteg.stkPush(phone, amount, accountRef, description)
 *   MpesaInteg.queryStatus(checkoutRequestId)
 *   MpesaInteg.handleCallback(body)   — called from doPost when source=mpesa
 *
 * Script Properties required:
 *   MPESA_ENV            — 'sandbox' | 'production'
 *   MPESA_CONSUMER_KEY
 *   MPESA_CONSUMER_SECRET
 *   MPESA_SHORTCODE      — Lipa Na M-Pesa shortcode
 *   MPESA_PASSKEY        — from Daraja portal
 *   MPESA_CALLBACK_URL   — your /exec?source=mpesa URL
 */

var MpesaInteg = (function () {
  var _SANDBOX_BASE_   = 'https://sandbox.safaricom.co.ke';
  var _PROD_BASE_      = 'https://api.safaricom.co.ke';

  function _base_() {
    var env = PropertiesService.getScriptProperties().getProperty('MPESA_ENV') || 'sandbox';
    return env === 'production' ? _PROD_BASE_ : _SANDBOX_BASE_;
  }

  function _token_() {
    var props = PropertiesService.getScriptProperties();
    var key   = props.getProperty('MPESA_CONSUMER_KEY')    || '';
    var sec   = props.getProperty('MPESA_CONSUMER_SECRET') || '';
    if (!key || !sec) throw new Error('MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET not configured.');
    var cred  = Utilities.base64Encode(key + ':' + sec);
    var resp  = UrlFetchApp.fetch(_base_() + '/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: 'Basic ' + cred },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('M-Pesa token request failed: ' + resp.getContentText().substring(0, 200));
    return JSON.parse(resp.getContentText()).access_token;
  }

  function _timestamp_() {
    return Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yyyyMMddHHmmss');
  }

  function stkPush(phone, amount, accountRef, description) {
    var props      = PropertiesService.getScriptProperties();
    var shortcode  = props.getProperty('MPESA_SHORTCODE')    || '';
    var passkey    = props.getProperty('MPESA_PASSKEY')      || '';
    var callbackUrl= props.getProperty('MPESA_CALLBACK_URL') || '';
    if (!shortcode || !passkey) throw new Error('MPESA_SHORTCODE / MPESA_PASSKEY not configured.');

    var ts      = _timestamp_();
    var password = Utilities.base64Encode(shortcode + passkey + ts);
    var token   = _token_();

    var payload = {
      BusinessShortCode: shortcode,
      Password:          password,
      Timestamp:         ts,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(parseFloat(amount) || 0),
      PartyA:            String(phone).replace(/^\+/, ''),
      PartyB:            shortcode,
      PhoneNumber:       String(phone).replace(/^\+/, ''),
      CallBackURL:       callbackUrl,
      AccountReference:  String(accountRef || 'HASS').substring(0, 12),
      TransactionDesc:   String(description || 'Payment').substring(0, 13),
    };

    var resp = UrlFetchApp.fetch(_base_() + '/mpesa/stkpush/v1/processrequest', {
      method:             'post',
      contentType:        'application/json',
      headers:            { Authorization: 'Bearer ' + token },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var result = JSON.parse(resp.getContentText());
    if (resp.getResponseCode() !== 200 || result.ResponseCode !== '0') {
      throw new Error('STK push failed: ' + (result.ResponseDescription || result.errorMessage || resp.getContentText().substring(0, 200)));
    }
    return result; // { CheckoutRequestID, MerchantRequestID, ResponseCode, CustomerMessage }
  }

  function queryStatus(checkoutRequestId) {
    var props     = PropertiesService.getScriptProperties();
    var shortcode = props.getProperty('MPESA_SHORTCODE') || '';
    var passkey   = props.getProperty('MPESA_PASSKEY')   || '';
    var ts        = _timestamp_();
    var password  = Utilities.base64Encode(shortcode + passkey + ts);
    var token     = _token_();

    var resp = UrlFetchApp.fetch(_base_() + '/mpesa/stkpushquery/v1/query', {
      method:             'post',
      contentType:        'application/json',
      headers:            { Authorization: 'Bearer ' + token },
      payload:            JSON.stringify({
        BusinessShortCode: shortcode, Password: password, Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
      muteHttpExceptions: true,
    });
    return JSON.parse(resp.getContentText());
  }

  function handleCallback(body) {
    try {
      var data     = JSON.parse(body);
      var stk      = data.Body && data.Body.stkCallback;
      var code     = stk && stk.ResultCode;
      var checkId  = stk && stk.CheckoutRequestID;
      var metaArr  = (stk && stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
      var meta     = {};
      metaArr.forEach(function (item) { meta[item.Name] = item.Value; });

      Audit.log({
        actor: 'MPESA', action: code === 0 ? 'MPESA_PAYMENT_SUCCESS' : 'MPESA_PAYMENT_FAILED',
        entity: 'payment_uploads', entityId: checkId || '',
        after: { result_code: code, amount: meta.Amount, receipt: meta.MpesaReceiptNumber, phone: meta.PhoneNumber },
      });

      if (code === 0 && meta.MpesaReceiptNumber) {
        // Auto-record payment upload for matching invoice.
        var matchRows = TursoClient.select(
          "SELECT pu.upload_id FROM payment_uploads pu WHERE pu.reference = ? LIMIT 1",
          [String(checkId || '')]
        );
        if (matchRows.length) {
          var now = nowIso();
          TursoClient.write(
            "UPDATE payment_uploads SET status='APPROVED', reviewed_by='MPESA', reviewed_at=?, updated_at=? WHERE upload_id=?",
            [now, now, matchRows[0].upload_id]
          );
        }
      }
    } catch (e) {
      Log.error({ service: 'integ_mpesa', action: 'callback', msg: e.message });
    }
  }

  return { stkPush: stkPush, queryStatus: queryStatus, handleCallback: handleCallback };
})();
