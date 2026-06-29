/**
 * 60_integ_email.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Email dispatch via Microsoft Graph API (primary) with MailApp fallback.
 *
 * EmailInteg.send(to, subject, htmlBody, textBody)
 *
 * Script Properties required (Graph API):
 *   GRAPH_TENANT_ID       — Azure AD tenant ID
 *   GRAPH_CLIENT_ID       — Azure AD app client ID
 *   GRAPH_CLIENT_SECRET   — Azure AD app client secret
 *   GRAPH_SENDER_EMAIL    — sender mailbox (e.g. noreply@hasspetroleum.com)
 *   NOTIF_EMAIL_SENDER_NAME — display name (e.g. "Hass Petroleum")
 *
 * Every call writes one row to integration_log.
 * Throws Errors.Integration on failure (after MailApp fallback also fails).
 */

var EmailInteg = (function () {

  function _graphToken_() {
    var props    = PropertiesService.getScriptProperties();
    var tenantId = props.getProperty('GRAPH_TENANT_ID')     || '';
    var clientId = props.getProperty('GRAPH_CLIENT_ID')     || '';
    var secret   = props.getProperty('GRAPH_CLIENT_SECRET') || '';
    if (!tenantId || !clientId || !secret) return null;

    var tokenUrl = 'https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token';
    var resp = UrlFetchApp.fetch(tokenUrl, {
      method:             'post',
      contentType:        'application/x-www-form-urlencoded',
      payload:            'grant_type=client_credentials' +
                          '&client_id='     + encodeURIComponent(clientId) +
                          '&client_secret=' + encodeURIComponent(secret) +
                          '&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default',
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText()).access_token || null;
  }

  function _logInteg_(action, status, requestSummary, responseSummary, errorMessage) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'email', action, status,
         (requestSummary  || '').substring(0, 500),
         (responseSummary || '').substring(0, 500),
         (errorMessage    || null), nowIso()]
      );
    } catch (_) {}
  }

  function send(to, subject, htmlBody, textBody) {
    var props      = PropertiesService.getScriptProperties();
    var senderName = props.getProperty('NOTIF_EMAIL_SENDER_NAME') || 'Hass Petroleum';
    var senderMail = props.getProperty('GRAPH_SENDER_EMAIL')      || '';

    // Attempt Microsoft Graph.
    var graphToken = _graphToken_();
    if (graphToken && senderMail) {
      try {
        var messagePayload = {
          message: {
            subject: subject,
            body:    { contentType: 'HTML', content: htmlBody || textBody || '' },
            toRecipients: [{ emailAddress: { address: to } }],
            from: { emailAddress: { address: senderMail, name: senderName } },
          },
          saveToSentItems: false,
        };
        var resp = UrlFetchApp.fetch(
          'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(senderMail) + '/sendMail', {
            method:             'post',
            contentType:        'application/json',
            headers:            { Authorization: 'Bearer ' + graphToken },
            payload:            JSON.stringify(messagePayload),
            muteHttpExceptions: true,
          }
        );
        var code = resp.getResponseCode();
        if (code === 202) {
          _logInteg_('send', 'SUCCESS', 'to=' + to + ' subject=' + subject.substring(0, 80), 'Graph API 202', null);
          return true;
        }
        Log.warn({ service: 'integ_email', msg: 'Graph API returned ' + code + ', falling back to MailApp' });
      } catch (e) {
        Log.warn({ service: 'integ_email', msg: 'Graph API exception: ' + e.message + ', falling back to MailApp' });
      }
    }

    // Fallback: GAS MailApp.
    try {
      MailApp.sendEmail({
        to:       to,
        subject:  subject,
        htmlBody: htmlBody || textBody || '',
        name:     senderName,
      });
      _logInteg_('send', 'SUCCESS', 'to=' + to + ' subject=' + subject.substring(0, 80), 'MailApp fallback', null);
      return true;
    } catch (e) {
      _logInteg_('send', 'FAILED', 'to=' + to + ' subject=' + subject.substring(0, 80), '', e.message);
      throw new Errors.Integration('Email send failed: ' + e.message);
    }
  }

  // graphToken exposed so the email-intake scanner can READ the support mailbox
  // through the same Microsoft Graph app credentials this module already uses to
  // send. Returns a bearer token string or null when Graph is not configured.
  return { send: send, graphToken: _graphToken_ };
})();
