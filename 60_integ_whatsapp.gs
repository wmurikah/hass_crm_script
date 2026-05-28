/**
 * 60_integ_whatsapp.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * WhatsApp Business API integration (Meta Cloud API).
 *
 * WhatsappInteg.send(phone, message)
 *
 * Script Properties required:
 *   WHATSAPP_API_URL      — e.g. https://graph.facebook.com/v18.0/<phone_number_id>/messages
 *   WHATSAPP_ACCESS_TOKEN — permanent or system-user token from Meta Business Suite
 *   WHATSAPP_FROM_NUMBER  — WhatsApp sender phone number ID
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure so the job runner can retry.
 */

var WhatsappInteg = (function () {

  function _logInteg_(action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'whatsapp', action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  /**
   * phone — international format without '+', e.g. '254712345678'
   * message — plain text message body
   */
  function send(phone, message) {
    var props       = PropertiesService.getScriptProperties();
    var apiUrl      = props.getProperty('WHATSAPP_API_URL')      || '';
    var accessToken = props.getProperty('WHATSAPP_ACCESS_TOKEN') || '';
    var fromNumber  = props.getProperty('WHATSAPP_FROM_NUMBER')  || '';

    if (!apiUrl || !accessToken) {
      _logInteg_('send', 'SKIPPED', 'phone=' + phone, '', 'WHATSAPP_API_URL or WHATSAPP_ACCESS_TOKEN not configured');
      Log.warn({ service: 'integ_whatsapp', msg: 'WhatsApp not configured — message skipped', data: { phone: phone } });
      return { skipped: true };
    }

    var payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to:                String(phone).replace(/^\+/, ''),
      type:              'text',
      text:              { preview_url: false, body: String(message || '') },
    });

    var resp = UrlFetchApp.fetch(apiUrl, {
      method:             'post',
      contentType:        'application/json',
      headers:            { Authorization: 'Bearer ' + accessToken },
      payload:            payload,
      muteHttpExceptions: true,
    });

    var code   = resp.getResponseCode();
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}

    if (code >= 200 && code < 300) {
      _logInteg_('send', 'SUCCESS', 'phone=' + phone, JSON.stringify(result).substring(0, 300), null);
      return result;
    }

    _logInteg_('send', 'FAILED', 'phone=' + phone, JSON.stringify(result).substring(0, 300), 'HTTP ' + code);
    throw new Errors.Integration('WhatsApp send failed (' + code + '): ' + JSON.stringify(result).substring(0, 200));
  }

  return { send: send };
})();
