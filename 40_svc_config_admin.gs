/**
 * 40_svc_config_admin.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Admin surface for the config table. Wraps the low-level Config module
 * with RBAC + audit, and exposes list/set/delete through the dispatcher.
 *
 * configAdmin.{list, set, delete}
 *
 * config table columns (from 20_config.gs):
 *   config_key, config_value, country_code, updated_by, updated_at
 */

// ── configAdmin.list ──────────────────────────────────────────────────────────

function _configAdminList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var sql  = 'SELECT * FROM config WHERE 1=1';
  var args = [];
  if (params.country_code !== undefined) {
    sql += ' AND country_code = ?'; args.push(params.country_code || '');
  }
  if (params.prefix) {
    sql += ' AND config_key LIKE ?'; args.push(params.prefix + '%');
  }
  sql += ' ORDER BY config_key';
  return TursoClient.select(sql, args);
}

// ── configAdmin.set ───────────────────────────────────────────────────────────

function _configAdminSet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var key         = String(params.config_key   || '').trim();
  var value       = String(params.config_value !== undefined ? params.config_value : '');
  var countryCode = String(params.country_code || '').trim();
  if (!key) throw new Errors.Validation('config_key required.');

  var before = Config.get(key, countryCode || undefined);
  Config.set(key, value, countryCode || undefined);
  // Config.set does the upsert; update updated_by separately.
  TursoClient.write(
    'UPDATE config SET updated_by = ? WHERE config_key = ? AND (country_code = ? OR (country_code IS NULL AND ? = \'\'))',
    [ctx.session.userId, key, countryCode, countryCode]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'CONFIG_SET',
    entity: 'config', entityId: key,
    before: { value: before }, after: { value: value, country_code: countryCode },
  });
  return { success: true, config_key: key };
}

// ── configAdmin.delete ────────────────────────────────────────────────────────

function _configAdminDelete_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var key         = String(params.config_key   || '').trim();
  var countryCode = String(params.country_code || '').trim();
  if (!key) throw new Errors.Validation('config_key required.');
  var before = Config.get(key, countryCode || undefined);
  TursoClient.write(
    'DELETE FROM config WHERE config_key = ? AND (country_code = ? OR (country_code IS NULL AND ? = \'\'))',
    [key, countryCode, countryCode]
  );
  AppCache.invalidate('cfg:' + key + (countryCode ? ':' + countryCode : ''));
  Audit.log({
    actor: ctx.session.userId, action: 'CONFIG_DELETED',
    entity: 'config', entityId: key,
    before: { value: before }, after: null,
  });
  return { success: true, config_key: key };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerConfigAdmin_() {
  register({ service: 'configAdmin', action: 'list',   permission: 'order.manage', handler: _configAdminList_ });
  register({ service: 'configAdmin', action: 'set',    permission: 'order.manage', handler: _configAdminSet_ });
  register({ service: 'configAdmin', action: 'delete', permission: 'order.manage', handler: _configAdminDelete_ });
})();
