/**
 * 40_svc_audit_log.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Read access to the audit_log table.
 *
 * auditLog.{list, get, export}
 *
 * audit_log columns (from 20_audit.gs):
 *   log_id, entity_type, entity_id, action, actor_type, actor_id,
 *   actor_email, actor_ip, actor_user_agent, before_json, after_json,
 *   metadata, country_code, created_at
 *
 * Country scope: GLOBAL roles see all; COUNTRY roles see their scope.
 */

// ── Scope helper ───────────────────────────────────────────────────────────────

function _auditLogScopeData_(session) {
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

// ── auditLog.list ─────────────────────────────────────────────────────────────

function _auditLogList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope  = _auditLogScopeData_(ctx.session);
  var sql    = 'SELECT * FROM audit_log WHERE 1=1';
  var args   = [];

  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += " AND (country_code IN (" + ph + ") OR country_code = '' OR country_code IS NULL)";
    args = args.concat(scope.countries);
  }
  if (params.entity_type)  { sql += ' AND entity_type = ?';  args.push(params.entity_type); }
  if (params.entity_id)    { sql += ' AND entity_id = ?';    args.push(params.entity_id); }
  if (params.action)       { sql += ' AND action = ?';       args.push(params.action); }
  if (params.actor_id)     { sql += ' AND actor_id = ?';     args.push(params.actor_id); }
  if (params.date_from)    { sql += ' AND created_at >= ?';  args.push(params.date_from); }
  if (params.date_to)      { sql += ' AND created_at <= ?';  args.push(params.date_to); }

  sql += ' ORDER BY created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

// ── auditLog.get ──────────────────────────────────────────────────────────────

function _auditLogGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var logId = String(params.logId || '');
  if (!logId) throw new Errors.Validation('logId required.');
  var rows = TursoClient.select('SELECT * FROM audit_log WHERE log_id = ? LIMIT 1', [logId]);
  if (!rows.length) throw new Errors.NotFound('Audit log entry not found.');
  var entry = rows[0];
  var scope = _auditLogScopeData_(ctx.session);
  if (!scope.isGlobal && entry.country_code && scope.countries.indexOf(entry.country_code) === -1) {
    throw new Errors.NotFound('Audit log entry not found.');
  }
  return entry;
}

// ── auditLog.export  —  returns up to 1000 rows as CSV-friendly array ─────────

function _auditLogExport_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope  = _auditLogScopeData_(ctx.session);
  var sql    = 'SELECT log_id, entity_type, entity_id, action, actor_type, actor_id, ' +
               'actor_email, actor_ip, country_code, created_at FROM audit_log WHERE 1=1';
  var args   = [];

  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += " AND (country_code IN (" + ph + ") OR country_code = '' OR country_code IS NULL)";
    args = args.concat(scope.countries);
  }
  if (params.entity_type) { sql += ' AND entity_type = ?'; args.push(params.entity_type); }
  if (params.date_from)   { sql += ' AND created_at >= ?'; args.push(params.date_from); }
  if (params.date_to)     { sql += ' AND created_at <= ?'; args.push(params.date_to); }
  sql += ' ORDER BY created_at DESC LIMIT 1000';
  return TursoClient.select(sql, args);
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerAuditLog_() {
  register({ service: 'auditLog', action: 'list',   permission: 'order.view', handler: _auditLogList_ });
  register({ service: 'auditLog', action: 'get',    permission: 'order.view', handler: _auditLogGet_ });
  register({ service: 'auditLog', action: 'export', permission: 'order.view', handler: _auditLogExport_ });
})();
