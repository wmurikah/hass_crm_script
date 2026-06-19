/**
 * 60_integ_notifications.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Notification delivery: the flush job core plus the per-channel senders it uses.
 *
 *   jobNotifFlush(opts)        → { claimed, sent, failed, skipped }   (NOT-1)
 *   _dispatchEmail_(notif)     → boolean   (email via EmailInteg: Graph + MailApp)
 *   _dispatchSms_(notif)       → boolean   (configurable SMS HTTP gateway)
 *   _dispatchWhatsapp_(notif)  → boolean   (WhatsApp Cloud API, if configured)
 *
 * jobNotifFlush is the single sender. It is invoked from the NOTIF_FLUSH job type
 * (50_jobs.gs) which is scheduled by the runNotifFlush trigger. Email always
 * works (EmailInteg falls back to MailApp); SMS and WhatsApp send only when their
 * integration is actually configured, otherwise they are a clean no-op and are
 * never selected for delivery.
 *
 * Configuration via Script Properties:
 *   NOTIF_EMAIL_SENDER_NAME - display name (email path; see 60_integ_email.gs)
 *   SMS_API_URL / SMS_API_KEY / SMS_SENDER_ID            - SMS gateway
 *   WHATSAPP_API_URL / WHATSAPP_ACCESS_TOKEN / ...        - WhatsApp Cloud API
 */

// ── Flush job core (NOT-1) ────────────────────────────────────────────────────
//
// Drain notifications that still need delivery. Each row is CLAIMED atomically
// (its status flips PENDING -> SENDING under a guarded UPDATE) so a second
// concurrent flush can never double-send the same notification: only the writer
// whose UPDATE affects exactly one row proceeds to dispatch. After dispatch the
// row is marked SENT (with a timestamp) or FAILED (with an attempt count and the
// error). FAILED rows are retried up to a small cap and then left FAILED for
// inspection rather than looping forever. A flush that dies mid-send leaves a row
// in SENDING; those are reclaimed once they go stale. In-app notifications are
// not a delivery channel, so they are left for the in-app reader and never sent.

function jobNotifFlush(opts) {
  opts = opts || {};
  // Conservative bounds for the GAS execution limit: each send is an HTTP call,
  // so a run drains at most batchSize * maxBatches notifications and the rest are
  // picked up by the next scheduled run. A timeout mid-run is safe: claimed rows
  // sit in SENDING and are reclaimed once stale.
  var batchSize   = parseInt(opts.batch_size, 10)    || 25;
  var maxAttempts = parseInt(opts.max_attempts, 10)  || 3;
  var maxBatches  = parseInt(opts.max_batches, 10)   || 4;
  var staleMin    = parseInt(opts.stale_minutes, 10) || 15;

  var channels = _notifFlushSendableChannels_();
  var cols     = _notifFlushColumns_();
  var summary  = { claimed: 0, sent: 0, failed: 0, skipped: 0 };

  for (var b = 0; b < maxBatches; b++) {
    var rows = _notifFlushSelect_(channels, cols, maxAttempts, staleMin, batchSize);
    if (!rows.length) break;

    for (var i = 0; i < rows.length; i++) {
      var n = rows[i];
      if (!_notifFlushClaim_(n, cols)) { summary.skipped++; continue; }   // lost the race
      summary.claimed++;

      var ok = false;
      try { ok = _notifDispatch_(n); } catch (_) { ok = false; }

      if (ok) { _notifFlushMarkSent_(n, cols);   summary.sent++; }
      else    { _notifFlushMarkFailed_(n, cols, 'send failed (' + n.channel + ')'); summary.failed++; }
    }

    if (rows.length < batchSize) break;   // last partial batch drained
  }

  Log.info({ service: 'integ_notif', action: 'flush', msg: 'Notification flush complete', data: summary });
  return summary;
}

// Channels we are allowed to send on right now. Email is always available
// (EmailInteg has a MailApp fallback). SMS and WhatsApp are added only when their
// integration is configured, so an unconfigured channel is never selected.
function _notifFlushSendableChannels_() {
  var props    = PropertiesService.getScriptProperties();
  var channels = ['EMAIL'];
  if (props.getProperty('SMS_API_URL')) channels.push('SMS');
  if (props.getProperty('WHATSAPP_API_URL') && props.getProperty('WHATSAPP_ACCESS_TOKEN')) channels.push('WHATSAPP');
  return channels;
}

// Discover the optional bookkeeping columns the flush adapts to. The canonical
// schema lives in Turso, so the real spelling is resolved at runtime. If no
// attempt counter exists, add one (best-effort, idempotent) so FAILED rows can be
// capped; if that cannot be added, FAILED rows are simply left for inspection.
function _notifFlushColumns_() {
  var attempts = SchemaIntrospect.pick('notifications', ['attempts', 'attempt_count', 'retry_count']);
  if (!attempts) {
    try {
      TursoClient.write('ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      attempts = 'attempts';
    } catch (_) { attempts = null; }
  }
  return {
    attempts: attempts,
    error:    SchemaIntrospect.pick('notifications', ['error_message', 'error', 'last_error']),
    sent:     SchemaIntrospect.pick('notifications', ['sent_at', 'sent_time', 'delivered_at']),
  };
}

// Select the next batch of claimable rows: fresh PENDING, stale SENDING (to be
// reclaimed), and FAILED still under the retry cap. PENDING is preferred.
function _notifFlushSelect_(channels, cols, maxAttempts, staleMin, limit) {
  var chPh = channels.map(function () { return '?'; }).join(',');
  var args = channels.slice();

  var clauses = ["status = 'PENDING'", "(status = 'SENDING' AND updated_at < ?)"];
  var stale   = addMinutes(new Date(), -Math.abs(staleMin)).toISOString();
  if (cols.attempts) clauses.push("(status = 'FAILED' AND " + cols.attempts + ' < ?)');

  var sql = 'SELECT notification_id, recipient_id, recipient_type, channel, subject, body, status, updated_at ' +
            'FROM notifications WHERE channel IN (' + chPh + ') AND (' + clauses.join(' OR ') + ') ' +
            "ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'SENDING' THEN 1 ELSE 2 END, created_at ASC " +
            'LIMIT ' + (parseInt(limit, 10) || 50);

  args.push(stale);
  if (cols.attempts) args.push(maxAttempts);

  try {
    return TursoClient.select(sql, args);
  } catch (e) {
    Log.error({ service: 'integ_notif', action: 'flushSelect', msg: (e && e.message) || String(e) });
    return [];
  }
}

// Atomically claim a row for sending. The guarded UPDATE only affects the row if
// it is still in the status we observed (and, for a stale SENDING reclaim, still
// carries the same updated_at), so exactly one flush can ever win a given row.
// The attempt counter is bumped at claim time so it caps total send attempts.
function _notifFlushClaim_(n, cols) {
  var now = nowIso();
  var bump = cols.attempts ? (', ' + cols.attempts + ' = ' + cols.attempts + ' + 1') : '';
  var sql, args;
  if (n.status === 'SENDING') {
    sql  = 'UPDATE notifications SET status = ?, updated_at = ?' + bump +
           " WHERE notification_id = ? AND status = 'SENDING' AND updated_at = ?";
    args = ['SENDING', now, n.notification_id, n.updated_at];
  } else {
    sql  = 'UPDATE notifications SET status = ?, updated_at = ?' + bump +
           ' WHERE notification_id = ? AND status = ?';
    args = ['SENDING', now, n.notification_id, n.status];
  }
  try {
    var res = TursoClient.write(sql, args);
    return !!(res && res.rowsAffected === 1);
  } catch (e) {
    Log.warn({ service: 'integ_notif', action: 'flushClaim', msg: (e && e.message) || String(e) });
    return false;
  }
}

function _notifFlushMarkSent_(n, cols) {
  var now  = nowIso();
  var sets = "status = 'SENT', updated_at = ?";
  var args = [now];
  if (cols.sent)  { sets += ', ' + cols.sent + ' = ?'; args.push(now); }
  if (cols.error) { sets += ', ' + cols.error + ' = NULL'; }
  args.push(n.notification_id);
  try { TursoClient.write('UPDATE notifications SET ' + sets + ' WHERE notification_id = ?', args); }
  catch (e) { Log.warn({ service: 'integ_notif', action: 'markSent', msg: (e && e.message) || String(e) }); }
}

function _notifFlushMarkFailed_(n, cols, errMsg) {
  var now  = nowIso();
  var sets = "status = 'FAILED', updated_at = ?";
  var args = [now];
  if (cols.error) { sets += ', ' + cols.error + ' = ?'; args.push(String(errMsg || '').substring(0, 300)); }
  args.push(n.notification_id);
  try { TursoClient.write('UPDATE notifications SET ' + sets + ' WHERE notification_id = ?', args); }
  catch (e) { Log.warn({ service: 'integ_notif', action: 'markFailed', msg: (e && e.message) || String(e) }); }
}

// ── Channel router ─────────────────────────────────────────────────────────────

function _notifDispatch_(notif) {
  var ch = String(notif.channel || '').toUpperCase();
  if (ch === 'SMS')      return _dispatchSms_(notif);
  if (ch === 'WHATSAPP') return _dispatchWhatsapp_(notif);
  return _dispatchEmail_(notif);   // EMAIL (and any other selected channel)
}

// ── Email dispatch ─────────────────────────────────────────────────────────────
//
// Routes through EmailInteg.send (Microsoft Graph with a MailApp fallback, the
// working path used elsewhere) rather than calling MailApp directly, and logs to
// integration_log via EmailInteg. Returns false on any failure so the flush marks
// the row FAILED rather than throwing.

function _dispatchEmail_(notif) {
  try {
    var email = _resolveRecipientEmail_(notif.recipient_id, notif.recipient_type);
    if (!email) { Log.warn({ service: 'integ_notif', msg: 'No email for recipient', data: { id: notif.notification_id } }); return false; }

    var props      = PropertiesService.getScriptProperties();
    var senderName = props.getProperty('NOTIF_EMAIL_SENDER_NAME') || 'Hass Petroleum';
    var subject    = String(notif.subject || '(No subject)');
    var body       = String(notif.body    || '');

    var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
               '<div style="background:#1e293b;padding:16px 20px;color:#fff;font-size:16px;font-weight:bold">' + senderName + '</div>' +
               '<div style="padding:24px;color:#1a1a1a;line-height:1.6">' + body.replace(/\n/g, '<br>') + '</div>' +
               '<div style="padding:12px 20px;background:#f8f8f8;font-size:11px;color:#999">This is an automated message from Hass CMS. Do not reply.</div>' +
               '</div>';

    return EmailInteg.send(email, subject, html, body) === true;
  } catch (e) {
    Log.error({ service: 'integ_notif', action: 'dispatchEmail', msg: (e && e.message) || String(e) });
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
    Log.error({ service: 'integ_notif', action: 'dispatchSms', msg: (e && e.message) || String(e) });
    return false;
  }
}

// ── WhatsApp dispatch (optional) ─────────────────────────────────────────────
//
// Sends only when WhatsappInteg is configured. WhatsappInteg.send returns
// { skipped:true } when the channel is not configured, which we treat as a clean
// no-op (not a delivery), so an unconfigured channel never marks a row SENT.

function _dispatchWhatsapp_(notif) {
  try {
    if (typeof WhatsappInteg === 'undefined' || !WhatsappInteg.send) return false;
    var phone = _resolveRecipientPhone_(notif.recipient_id, notif.recipient_type);
    if (!phone) { Log.warn({ service: 'integ_notif', msg: 'No phone for recipient', data: { id: notif.notification_id } }); return false; }
    var res = WhatsappInteg.send(phone, String(notif.body || ''));
    if (res && res.skipped) return false;
    return true;
  } catch (e) {
    Log.error({ service: 'integ_notif', action: 'dispatchWhatsapp', msg: (e && e.message) || String(e) });
    return false;
  }
}

// ── Recipient lookup helpers ───────────────────────────────────────────────────
//
// Fix 4 (NOT-4): a CUSTOMER recipient carries a customer_id, not a contact_id.
// The customers table has no email column in this schema (confirmed by
// introspection: 40_svc_customers.gs reads company_name/country_code but never an
// email), so a customer email is resolved through the customer's primary (or
// earliest active) contact, falling back to a customers email column only if one
// actually exists in the live schema. A recipient that cannot be resolved yields
// null, which the flush records as FAILED rather than silently dropping.

function _resolveRecipientEmail_(recipientId, recipientType) {
  try {
    if (!recipientId) return null;
    var type = String(recipientType || 'STAFF').toUpperCase();

    if (type === 'STAFF' || type === 'USER' || type === 'SYSTEM') {
      var u = TursoClient.select('SELECT email FROM users WHERE user_id = ? LIMIT 1', [recipientId]);
      return (u.length && u[0].email) ? u[0].email : null;
    }
    if (type === 'CONTACT') {
      var ct = TursoClient.select('SELECT email FROM contacts WHERE contact_id = ? LIMIT 1', [recipientId]);
      return (ct.length && ct[0].email) ? ct[0].email : null;
    }
    if (type === 'CUSTOMER') {
      return _resolveCustomerEmail_(recipientId);
    }
    if (type === 'SIGNUP') {
      // A rejected sign-up applicant has no user/contact yet; resolve their email
      // straight from the signup_requests row so the step-1 emit can deliver it.
      var sr = TursoClient.select('SELECT email FROM signup_requests WHERE request_id = ? LIMIT 1', [recipientId]);
      return (sr.length && sr[0].email) ? sr[0].email : null;
    }

    // Unknown type: try a user, then a contact, before giving up.
    var anyU = TursoClient.select('SELECT email FROM users WHERE user_id = ? LIMIT 1', [recipientId]);
    if (anyU.length && anyU[0].email) return anyU[0].email;
    var anyC = TursoClient.select('SELECT email FROM contacts WHERE contact_id = ? LIMIT 1', [recipientId]);
    return (anyC.length && anyC[0].email) ? anyC[0].email : null;
  } catch (e) {
    try { Log.warn({ service: 'integ_notif', action: 'resolveEmail', msg: (e && e.message) || String(e) }); } catch (_) {}
    return null;
  }
}

function _resolveCustomerEmail_(customerId) {
  // 1) A real email column on customers, if the live schema has one.
  var emailCol = SchemaIntrospect.pick('customers', ['email', 'primary_email', 'contact_email', 'billing_email']);
  if (emailCol) {
    try {
      var cr = TursoClient.select('SELECT ' + emailCol + ' AS email FROM customers WHERE customer_id = ? LIMIT 1', [customerId]);
      if (cr.length && cr[0].email) return cr[0].email;
    } catch (_) {}
  }
  // 2) The customer's primary contact (if a primary flag exists in the live
  //    schema), else the earliest active contact that has an email.
  try {
    var primaryCol = SchemaIntrospect.pick('contacts', ['is_primary', 'primary', 'is_primary_contact']);
    if (primaryCol) {
      var pc = TursoClient.select(
        'SELECT email FROM contacts WHERE customer_id = ? AND ' + primaryCol + ' = 1 ' +
        "AND email IS NOT NULL AND email != '' AND COALESCE(status,'') != 'DELETED' " +
        'ORDER BY created_at ASC LIMIT 1',
        [customerId]
      );
      if (pc.length && pc[0].email) return pc[0].email;
    }
    var ec = TursoClient.select(
      "SELECT email FROM contacts WHERE customer_id = ? AND email IS NOT NULL AND email != '' " +
      "AND COALESCE(status,'') != 'DELETED' ORDER BY created_at ASC LIMIT 1",
      [customerId]
    );
    return (ec.length && ec[0].email) ? ec[0].email : null;
  } catch (_) {
    return null;
  }
}

function _resolveRecipientPhone_(recipientId, recipientType) {
  try {
    if (!recipientId) return null;
    var type = String(recipientType || 'STAFF').toUpperCase();

    if (type === 'STAFF' || type === 'USER' || type === 'SYSTEM') {
      var u = TursoClient.select('SELECT phone FROM users WHERE user_id = ? LIMIT 1', [recipientId]);
      return (u.length && u[0].phone) ? u[0].phone : null;
    }
    if (type === 'CONTACT') {
      var ct = TursoClient.select('SELECT phone FROM contacts WHERE contact_id = ? LIMIT 1', [recipientId]);
      return (ct.length && ct[0].phone) ? ct[0].phone : null;
    }
    if (type === 'CUSTOMER') {
      var phoneCol = SchemaIntrospect.pick('customers', ['phone', 'phone_number', 'telephone', 'mobile']);
      if (phoneCol) {
        var cr = TursoClient.select('SELECT ' + phoneCol + ' AS phone FROM customers WHERE customer_id = ? LIMIT 1', [recipientId]);
        if (cr.length && cr[0].phone) return cr[0].phone;
      }
      var ec = TursoClient.select(
        "SELECT phone FROM contacts WHERE customer_id = ? AND phone IS NOT NULL AND phone != '' " +
        "AND COALESCE(status,'') != 'DELETED' ORDER BY created_at ASC LIMIT 1",
        [recipientId]
      );
      return (ec.length && ec[0].phone) ? ec[0].phone : null;
    }
    return null;
  } catch (_) { return null; }
}
