/**
 * 40_svc_notifications.gs  —  Hass CMS rebuild  (Stage 5E)
 *
 * Notification queue and template management.
 *
 * notifications.{list, get, send, markRead}
 * notificationTemplates.{list, upsert}
 *
 * Tables:
 *   notifications          (notification_id, recipient_id, recipient_type,
 *                           channel, subject, body, status, entity_type,
 *                           entity_id, country_code, error_message,
 *                           sent_at, read_at, created_at, updated_at)
 *   notification_templates (template_code, channel, subject_template,
 *                           body_template, is_active, created_at, updated_at)
 *
 * The actual dispatch (email/SMS) is handled by 60_integ_notifications.gs.
 * This service only manages the queue and templates.
 * Country scope enforced.
 */

// ── Scope helper ───────────────────────────────────────────────────────────────

function _notifScopeData_(session) {
  if (!session) return { isGlobal: false, countries: [] };
  var isGlobal = false;
  try {
    var r = TursoClient.select(
      'SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [session.role || '']
    );
    isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
  } catch (_) {}
  if (isGlobal) return { isGlobal: true, countries: [] };
  var countries = [String(session.countryCode || '').trim()].filter(Boolean);
  try {
    var u = TursoClient.select(
      'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1', [session.userId]
    );
    if (u.length && u[0].countries_access) {
      String(u[0].countries_access).split(',').forEach(function (c) {
        var t = c.trim();
        if (t && countries.indexOf(t) === -1) countries.push(t);
      });
    }
  } catch (_) {}
  return { isGlobal: false, countries: countries };
}

// ── Shared: enqueue a notification (internal helper, no auth required) ────────

function _enqueueNotification_(opts) {
  var notifId = genId('NTF');
  var now     = nowIso();
  TursoClient.write(
    'INSERT INTO notifications ' +
    '(notification_id, recipient_id, recipient_type, channel, subject, body, ' +
    'status, entity_type, entity_id, country_code, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      notifId,
      String(opts.recipient_id   || ''),
      String(opts.recipient_type || 'STAFF'),
      String(opts.channel        || 'IN_APP').toUpperCase(),
      String(opts.subject        || ''),
      String(opts.body           || ''),
      'PENDING',
      String(opts.entity_type    || ''),
      String(opts.entity_id      || ''),
      String(opts.country_code   || ''),
      now, now,
    ]
  );
  return notifId;
}

// ── notifications.list ────────────────────────────────────────────────────────

function _notifList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _notifScopeData_(ctx.session);
  var sql   = 'SELECT * FROM notifications WHERE 1=1';
  var args  = [];
  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND country_code IN (' + ph + ')';
    args = args.concat(scope.countries);
  }
  // Callers can view their own notifications regardless of scope.
  if (params.recipient_id)   { sql += ' AND recipient_id = ?';   args.push(params.recipient_id); }
  if (params.status)         { sql += ' AND status = ?';         args.push(params.status); }
  if (params.channel)        { sql += ' AND channel = ?';        args.push(params.channel); }
  if (params.entity_type)    { sql += ' AND entity_type = ?';    args.push(params.entity_type); }
  if (params.entity_id)      { sql += ' AND entity_id = ?';      args.push(params.entity_id); }
  sql += ' ORDER BY created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

// ── notifications.get ─────────────────────────────────────────────────────────

function _notifGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var notifId = String(params.notifId || '');
  if (!notifId) throw new Errors.Validation('notifId required.');
  var rows = TursoClient.select('SELECT * FROM notifications WHERE notification_id = ? LIMIT 1', [notifId]);
  if (!rows.length) throw new Errors.NotFound('Notification not found.');
  var n     = rows[0];
  var scope = _notifScopeData_(ctx.session);
  if (!scope.isGlobal && n.country_code && scope.countries.indexOf(n.country_code) === -1) {
    throw new Errors.NotFound('Notification not found.');
  }
  return n;
}

// ── notifications.send  —  enqueue a notification ─────────────────────────────

function _notifSend_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var recipientId   = String(params.recipient_id   || '').trim();
  var recipientType = String(params.recipient_type || 'STAFF').trim().toUpperCase();
  var channel       = String(params.channel        || 'IN_APP').trim().toUpperCase();
  var subject       = String(params.subject        || '').trim();
  var body          = String(params.body           || '').trim();
  if (!recipientId) throw new Errors.Validation('recipient_id required.');
  if (!body)        throw new Errors.Validation('body required.');

  var scope = _notifScopeData_(ctx.session);

  var notifId = _enqueueNotification_({
    recipient_id:   recipientId,
    recipient_type: recipientType,
    channel:        channel,
    subject:        subject,
    body:           body,
    entity_type:    String(params.entity_type  || ''),
    entity_id:      String(params.entity_id    || ''),
    country_code:   scope.isGlobal ? String(params.country_code || '') : (scope.countries[0] || ''),
  });
  Audit.log({
    actor: ctx.session.userId, action: 'NOTIFICATION_ENQUEUED',
    entity: 'notifications', entityId: notifId,
    after: { recipient_id: recipientId, channel: channel },
  });
  return { notification_id: notifId, status: 'PENDING' };
}

// ── notifications.markRead ────────────────────────────────────────────────────

function _notifMarkRead_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var notifId = String(params.notifId || '');
  if (!notifId) throw new Errors.Validation('notifId required.');
  var rows = TursoClient.select('SELECT * FROM notifications WHERE notification_id = ? LIMIT 1', [notifId]);
  if (!rows.length) throw new Errors.NotFound('Notification not found.');
  var n = rows[0];
  if (n.recipient_id !== ctx.session.userId) {
    Rbac.requirePermission(ctx.session, 'order.manage');
  }
  var now = nowIso();
  TursoClient.write(
    'UPDATE notifications SET status = ?, read_at = ?, updated_at = ? WHERE notification_id = ?',
    ['READ', now, now, notifId]
  );
  return { success: true, status: 'READ' };
}

// ── notificationTemplates.list ────────────────────────────────────────────────

function _ntplList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql  = 'SELECT * FROM notification_templates WHERE 1=1';
  var args = [];
  if (params.channel)   { sql += ' AND channel = ?';  args.push(params.channel); }
  if (params.is_active !== undefined) {
    sql += ' AND is_active = ?'; args.push(params.is_active ? 1 : 0);
  }
  sql += ' ORDER BY template_code';
  return TursoClient.select(sql, args);
}

// ── notificationTemplates.upsert ──────────────────────────────────────────────

function _ntplUpsert_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var code    = String(params.template_code    || '').trim().toUpperCase();
  var channel = String(params.channel          || '').trim().toUpperCase();
  var subject = String(params.subject_template || '').trim();
  var body    = String(params.body_template    || '').trim();
  if (!code)    throw new Errors.Validation('template_code required.');
  if (!channel) throw new Errors.Validation('channel required.');
  if (!body)    throw new Errors.Validation('body_template required.');

  var existing = TursoClient.select(
    'SELECT template_code FROM notification_templates WHERE template_code = ? LIMIT 1', [code]
  );
  var now = nowIso();
  if (existing.length) {
    TursoClient.write(
      'UPDATE notification_templates SET channel = ?, subject_template = ?, body_template = ?, ' +
      'is_active = 1, updated_at = ? WHERE template_code = ?',
      [channel, subject, body, now, code]
    );
  } else {
    TursoClient.write(
      'INSERT INTO notification_templates ' +
      '(template_code, channel, subject_template, body_template, is_active, created_at, updated_at) ' +
      'VALUES (?,?,?,?,1,?,?)',
      [code, channel, subject, body, now, now]
    );
  }
  Audit.log({
    actor: ctx.session.userId, action: 'NOTIF_TEMPLATE_UPSERTED',
    entity: 'notification_templates', entityId: code,
    after: { template_code: code, channel: channel },
  });
  return { success: true, template_code: code };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerNotifications_() {
  register({ service: 'notifications',         action: 'list',     permission: 'order.view',   handler: _notifList_ });
  register({ service: 'notifications',         action: 'get',      permission: 'order.view',   handler: _notifGet_ });
  register({ service: 'notifications',         action: 'send',     permission: 'order.view',   handler: _notifSend_ });
  register({ service: 'notifications',         action: 'markRead', permission: 'order.view',   handler: _notifMarkRead_ });
  register({ service: 'notificationTemplates', action: 'list',     permission: 'order.view',   handler: _ntplList_ });
  register({ service: 'notificationTemplates', action: 'upsert',   permission: 'order.manage', handler: _ntplUpsert_ });
})();
