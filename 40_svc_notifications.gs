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
//
// Fix 3 (NOT-3): when the caller supplies an event_key, the subject and body are
// rendered from the matching notification_templates row (resolved by template
// code) and the caller-supplied subject/body are used only as a fallback when no
// active template matches. Authoring a template therefore changes the message
// with no code change.

function _enqueueNotification_(opts) {
  opts = opts || {};
  var channel = String(opts.channel || 'IN_APP').toUpperCase();

  var subject = String(opts.subject || '');
  var body    = String(opts.body    || '');
  var tpl = _notifResolveTemplate_(opts.event_key);
  if (tpl) {
    if (tpl.subject_template) subject = _notifRenderTemplate_(tpl.subject_template, opts.vars);
    if (tpl.body_template)    body    = _notifRenderTemplate_(tpl.body_template,    opts.vars);
  }

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
      channel,
      subject,
      body,
      'PENDING',
      String(opts.entity_type    || ''),
      String(opts.entity_id      || ''),
      String(opts.country_code   || ''),
      now, now,
    ]
  );
  return notifId;
}

// ── Template resolution (NOT-3) ───────────────────────────────────────────────
//
// The event key IS the template_code: the live notification_templates table keys
// on template_code and has no separate event column (confirmed by introspection),
// so an event such as ORDER_APPROVED resolves the template whose template_code is
// 'ORDER_APPROVED'. A missing or inactive template resolves to null and the
// caller subject/body are used unchanged.
//
// Canonical event keys emitted by the business paths (author a template under any
// of these codes to override its message):
//   ORDER_SUBMITTED, ORDER_APPROVED, ORDER_REJECTED, PAYMENT_APPROVED,
//   TICKET_ASSIGNED, TICKET_RESOLVED, DOCUMENT_EXPIRING

function _notifResolveTemplate_(eventKey) {
  var code = String(eventKey || '').trim().toUpperCase();
  if (!code) return null;
  try {
    var rows = TursoClient.select(
      'SELECT subject_template, body_template, channel FROM notification_templates ' +
      'WHERE template_code = ? AND is_active = 1 LIMIT 1',
      [code]
    );
    return rows.length ? rows[0] : null;
  } catch (_) { return null; }
}

// Render a {{var}} template against a flat vars map. Unknown placeholders render
// as empty so a partially-populated vars map can never leak '{{...}}' to a user.
function _notifRenderTemplate_(tplStr, vars) {
  var v = vars || {};
  return String(tplStr || '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, function (m, key) {
    return (v[key] !== undefined && v[key] !== null) ? String(v[key]) : '';
  });
}

// ── Reusable emit helpers (NOT-2) ─────────────────────────────────────────────
//
// Every emit is best-effort: a notification failure can never block, delay, or
// fail the business action it accompanies. These thin, uniform helpers are the
// single surface the order/ticket/payment/document paths call today, and the one
// the later SLA, approvals and signup work should reuse. Nothing here sends; the
// flush job (jobNotifFlush, 60_integ_notifications.gs) is the only sender.

function _notifyEmit_(opts) {
  try {
    opts = opts || {};
    if (!opts.recipient_id) return null;
    return _enqueueNotification_({
      recipient_id:   opts.recipient_id,
      recipient_type: opts.recipient_type || 'STAFF',
      channel:        opts.channel || 'EMAIL',
      event_key:      opts.event_key || '',
      vars:           opts.vars || {},
      subject:        opts.subject || '',
      body:           opts.body || '',
      entity_type:    opts.entity_type || '',
      entity_id:      opts.entity_id || '',
      country_code:   opts.country_code || '',
    });
  } catch (e) {
    try { Log.warn({ service: 'notify', action: 'emit', msg: (e && e.message) || String(e) }); } catch (_) {}
    return null;
  }
}

// Emit one notification per recipient. `recipients` is an array of either plain
// ids or { recipient_id, recipient_type } objects; `opts` carries the shared
// channel/event_key/vars/subject/body. Returns the ids actually enqueued.
function _notifyEmitMany_(recipients, opts) {
  var ids = [];
  try {
    (recipients || []).forEach(function (r) {
      var rid = (r && (r.recipient_id || r.user_id)) || (typeof r === 'string' ? r : null);
      if (!rid) return;
      var rtype = (r && r.recipient_type) || (opts && opts.recipient_type) || 'STAFF';
      var merged = Object.assign({}, opts || {}, { recipient_id: rid, recipient_type: rtype });
      var id = _notifyEmit_(merged);
      if (id) ids.push(id);
    });
  } catch (e) {
    try { Log.warn({ service: 'notify', action: 'emitMany', msg: (e && e.message) || String(e) }); } catch (_) {}
  }
  return ids;
}

// Resolve the staff who can approve an order, scoped to the order's country and
// excluding the creator (separation of duties mirrors _approveHandler_). The
// approval permission tier matches the amount thresholds the approve handler
// enforces. Best-effort: returns [] on any error so a submit can never be blocked
// by approver lookup.
function _notifyResolveOrderApprovers_(order) {
  try {
    if (!order) return [];
    var amount = parseFloat(order.total_amount) || 0;
    var perm = amount <= 100000 ? 'order.approve_low'
             : (amount <= 1000000 ? 'order.approve_mid' : 'order.approve_high');
    var cc = String(order.country_code || '');
    var rows = TursoClient.select(
      'SELECT DISTINCT u.user_id FROM users u ' +
      'JOIN user_roles ur ON ur.user_id = u.user_id ' +
      'JOIN role_permissions rp ON rp.role_code = ur.role_code ' +
      'LEFT JOIN roles r ON r.role_code = ur.role_code ' +
      'WHERE rp.permission_code IN (?, ?) ' +
      "AND UPPER(COALESCE(u.status,'ACTIVE')) = 'ACTIVE' " +
      'AND u.user_id != ? ' +
      "AND (UPPER(COALESCE(r.scope,'')) = 'GLOBAL' OR u.country_code = ? " +
      "OR (',' || COALESCE(u.countries_access,'') || ',') LIKE ?) " +
      'LIMIT 25',
      [perm, '*', String(order.created_by_id || ''), cc, '%,' + cc + ',%']
    );
    return rows.map(function (r) { return { recipient_id: r.user_id, recipient_type: 'STAFF' }; });
  } catch (e) {
    try { Log.warn({ service: 'notify', action: 'resolveApprovers', msg: (e && e.message) || String(e) }); } catch (_) {}
    return [];
  }
}

// Single reusable surface for the cross-cutting emit helpers.
var Notify = {
  emit:                  _notifyEmit_,
  emitMany:              _notifyEmitMany_,
  resolveOrderApprovers: _notifyResolveOrderApprovers_,
  enqueue:               _enqueueNotification_,
};

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
