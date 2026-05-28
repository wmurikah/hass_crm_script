/**
 * 60_integ_teams.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Microsoft Teams webhook integration (Incoming Webhook connector).
 *
 * TeamsInteg.notify(webhookUrl, message)
 *
 * No Script Properties needed — webhook URL is passed per call (stored in config or
 * per-team settings). If a default is desired:
 *   TEAMS_DEFAULT_WEBHOOK — fallback webhook URL
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure so the job runner can retry.
 */

var TeamsInteg = (function () {

  function _logInteg_(action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'teams', action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  /**
   * webhookUrl — Teams incoming webhook URL (null/empty → use TEAMS_DEFAULT_WEBHOOK property)
   * message    — plain text or markdown string
   */
  function notify(webhookUrl, message) {
    var url = webhookUrl || PropertiesService.getScriptProperties().getProperty('TEAMS_DEFAULT_WEBHOOK') || '';
    if (!url) {
      _logInteg_('notify', 'SKIPPED', message && message.substring(0, 100), '', 'No Teams webhook URL configured');
      Log.warn({ service: 'integ_teams', msg: 'No Teams webhook URL — notification skipped' });
      return { skipped: true };
    }

    var payload = JSON.stringify({
      '@type':    'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary:    'Hass CMS Notification',
      sections:   [{ text: String(message || '') }],
    });

    var resp = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
      payload:            payload,
      muteHttpExceptions: true,
    });

    var code    = resp.getResponseCode();
    var bodyTxt = resp.getContentText().substring(0, 200);

    if (code >= 200 && code < 300) {
      _logInteg_('notify', 'SUCCESS', message && message.substring(0, 100), bodyTxt, null);
      return { sent: true };
    }

    _logInteg_('notify', 'FAILED', message && message.substring(0, 100), bodyTxt, 'HTTP ' + code);
    throw new Errors.Integration('Teams notify failed (' + code + '): ' + bodyTxt);
  }

  return { notify: notify };
})();
