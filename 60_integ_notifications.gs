/**
 * 60_integ_notifications.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Email and SMS dispatch helpers used by 50_jobs.gs jobNotifFlush().
 *
 * _dispatchEmail_(notif)   → boolean
 * _dispatchSms_(notif)     → boolean
 *
 * Email uses GAS MailApp (or Microsoft Graph if configured).
 * SMS uses a configurable HTTP API endpoint (Africa's Talking or Twilio).
 *
 * Configuration via Script Properties:
 *   NOTIF_EMAIL_SENDER     — from address (default: noreply@hasspetroleum.com)
 *   NOTIF_EMAIL_SENDER_NAME— display name
 *   SMS_API_URL            — SMS gateway endpoint
 *   SMS_API_KEY            — API key
 *   SMS_SENDER_ID          — alphanumeric sender ID (e.g. HASSPETRO)
 */

// ── Email dispatch ─────────────────────────────────────────────────────────────

function _dispatchEmail_(notif) {
  try {
    // Resolve recipient email address.
    var email = _resolveRecipientEmail_(notif.recipient_id, notif.recipient_type);
    if (!email) { Log.warn({ service: 'integ_notif', msg: 'No email for recipient', data: { id: notif.notification_id } }); return false; }

    var props       = PropertiesService.getScriptProperties();
    var senderName  = props.getProperty('NOTIF_EMAIL_SENDER_NAME') || 'Hass Petroleum';
    var subject     = String(notif.subject || '(No subject)');
    var body        = String(notif.body    || '');

    // Render simple HTML wrapper.
    var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
               '<div style="background:#1e293b;padding:16px 20px;color:#fff;font-size:16px;font-weight:bold">' + senderName + '</div>' +
               '<div style="padding:24px;color:#1a1a1a;line-height:1.6">' + body.replace(/\n/g, '<br>') + '</div>' +
               '<div style="padding:12px 20px;background:#f8f8f8;font-size:11px;color:#999">This is an automated message from Hass CMS. Do not reply.</div>' +
               '</div>';

    MailApp.sendEmail({ to: email, subject: subject, htmlBody: html, name: senderName });
    return true;
  } catch (e) {
    Log.error({ service: 'integ_notif', action: 'dispatchEmail', msg: e.message });
    return false;
  }
}

// ── SMS dispatch ───────────────────────────────────────────────────────────────

function _dispatchSms_(notif) {
  try {
    var phone = _resolveRecipientPhone_(notif.recipient_id, notif.recipient_type);
    if (!phone) { Log.warn({ service: 'integ_notif', msg: 'No phone for recipient', data: { id: notif.notification_id } }); return false; }

    var props    = PropertiesService.getScriptProperties();
    var apiUrl   = props.getProperty('SMS_API_URL')   || '';
    var apiKey   = props.getProperty('SMS_API_KEY')   || '';
    var senderId = props.getProperty('SMS_SENDER_ID') || 'HASSPETRO';

    if (!apiUrl) { Log.warn({ service: 'integ_notif', msg: 'SMS_API_URL not configured' }); return false; }

    var payload = JSON.stringify({
      username: 'hass',
      to:       phone,
      message:  String(notif.body || ''),
      from:     senderId,
    });

    var resp = UrlFetchApp.fetch(apiUrl, {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'apiKey': apiKey, 'Accept': 'application/json' },
      payload:            payload,
      muteHttpExceptions: true,
    });

    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) return true;
    Log.warn({ service: 'integ_notif', msg: 'SMS API returned ' + code, data: { body: resp.getContentText().substring(0, 200) } });
    return false;
  } catch (e) {
    Log.error({ service: 'integ_notif', action: 'dispatchSms', msg: e.message });
    return false;
  }
}

// ── Recipient lookup helpers ───────────────────────────────────────────────────

function _resolveRecipientEmail_(recipientId, recipientType) {
  try {
    if (!recipientType || recipientType === 'STAFF') {
      var r = TursoClient.select('SELECT email FROM users WHERE user_id = ? LIMIT 1', [recipientId]);
      return r.length ? r[0].email : null;
    }
    // CUSTOMER — look up via contacts.
    var r = TursoClient.select('SELECT email FROM contacts WHERE contact_id = ? LIMIT 1', [recipientId]);
    if (r.length) return r[0].email;
    var c = TursoClient.select('SELECT email FROM customers WHERE customer_id = ? LIMIT 1', [recipientId]);
    return c.length ? c[0].email : null;
  } catch (_) { return null; }
}

function _resolveRecipientPhone_(recipientId, recipientType) {
  try {
    if (!recipientType || recipientType === 'STAFF') {
      var r = TursoClient.select('SELECT phone FROM users WHERE user_id = ? LIMIT 1', [recipientId]);
      return r.length ? r[0].phone : null;
    }
    var r = TursoClient.select('SELECT phone FROM contacts WHERE contact_id = ? LIMIT 1', [recipientId]);
    return r.length ? r[0].phone : null;
  } catch (_) { return null; }
}
