/**
 * 60_integ_twilio.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Twilio voice call integration (Text-to-Speech via TwiML).
 *
 * TwilioInteg.call(to, message)
 *
 * Script Properties required:
 *   TWILIO_ACCOUNT_SID   — Twilio Account SID
 *   TWILIO_AUTH_TOKEN    — Twilio Auth Token
 *   TWILIO_FROM_NUMBER   — Twilio phone number (E.164, e.g. +12025551234)
 *   TWILIO_TWIML_URL     — URL to a TwiML Bin or endpoint that speaks `message`,
 *                          OR leave blank to use a dynamic TwiML approach via Twilio's Say verb.
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure so the job runner can retry.
 */

var TwilioInteg = (function () {

  function _logInteg_(action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'twilio', action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  /**
   * to      — destination phone number in E.164 format (e.g. +254712345678)
   * message — text to be spoken (used as TwiML Say body)
   */
  function call(to, message) {
    var props      = PropertiesService.getScriptProperties();
    var accountSid = props.getProperty('TWILIO_ACCOUNT_SID')  || '';
    var authToken  = props.getProperty('TWILIO_AUTH_TOKEN')   || '';
    var fromNumber = props.getProperty('TWILIO_FROM_NUMBER')  || '';
    var twimlUrl   = props.getProperty('TWILIO_TWIML_URL')    || '';

    if (!accountSid || !authToken || !fromNumber) {
      _logInteg_('call', 'SKIPPED', 'to=' + to, '', 'Twilio credentials not configured');
      Log.warn({ service: 'integ_twilio', msg: 'Twilio not configured — call skipped', data: { to: to } });
      return { skipped: true };
    }

    // Build TwiML URL. If no explicit URL provided, use Twilio's echo endpoint with Say.
    var callUrl = twimlUrl || ('https://handler.twilio.com/twiml/' +
      encodeURIComponent('<Response><Say>' + String(message || '').replace(/[<>&'"]/g, '') + '</Say></Response>'));

    var credentials = Utilities.base64Encode(accountSid + ':' + authToken);
    var endpoint    = 'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Calls.json';

    var form = 'To='   + encodeURIComponent(to) +
               '&From='+ encodeURIComponent(fromNumber) +
               '&Url=' + encodeURIComponent(callUrl);

    var resp = UrlFetchApp.fetch(endpoint, {
      method:             'post',
      contentType:        'application/x-www-form-urlencoded',
      headers:            { Authorization: 'Basic ' + credentials },
      payload:            form,
      muteHttpExceptions: true,
    });

    var code   = resp.getResponseCode();
    var result = {};
    try { result = JSON.parse(resp.getContentText()); } catch (_) {}

    if (code >= 200 && code < 300) {
      _logInteg_('call', 'SUCCESS', 'to=' + to, 'sid=' + (result.sid || ''), null);
      return result;
    }

    _logInteg_('call', 'FAILED', 'to=' + to, JSON.stringify(result).substring(0, 300), 'HTTP ' + code);
    throw new Errors.Integration('Twilio call failed (' + code + '): ' + (result.message || JSON.stringify(result).substring(0, 200)));
  }

  return { call: call };
})();
