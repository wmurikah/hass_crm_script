/**
 * 40_svc_system.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * System health and diagnostics endpoints.
 *
 * system.{ping, health, dbStats, version}
 *
 * All handlers require order.view except ping (public via dispatcher).
 */

// ── system.ping  —  liveness check, no auth ───────────────────────────────────

function _systemPing_(ctx, params) {
  return { pong: true, ts: nowIso() };
}

// ── system.health ─────────────────────────────────────────────────────────────

function _systemHealth_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var checks = {};

  // DB connectivity
  try {
    var r = TursoClient.select('SELECT 1 AS ok');
    checks.db = (r.length && r[0].ok === '1') ? 'OK' : 'DEGRADED';
  } catch (e) {
    checks.db = 'FAIL:' + e.message;
  }

  // Config read
  try {
    Config.getNumber('SESSION.IDLE_TIMEOUT_MIN', 30);
    checks.config = 'OK';
  } catch (e) {
    checks.config = 'FAIL:' + e.message;
  }

  // Cache
  try {
    AppCache.set('health_check_ping', 'ok', 60);
    var v = AppCache.get('health_check_ping');
    checks.cache = (v === 'ok') ? 'OK' : 'DEGRADED';
  } catch (e) {
    checks.cache = 'FAIL:' + e.message;
  }

  var allOk = Object.keys(checks).every(function (k) { return checks[k] === 'OK'; });
  return { status: allOk ? 'OK' : 'DEGRADED', checks: checks, ts: nowIso() };
}

// ── system.dbStats ────────────────────────────────────────────────────────────

function _systemDbStats_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var tables = [
    'users', 'customers', 'contacts', 'orders', 'order_lines',
    'tickets', 'ticket_comments', 'invoices', 'payment_uploads',
    'approval_requests', 'audit_log', 'sessions',
    'sla_policies', 'sla_breaches', 'notifications',
    'knowledge_articles', 'knowledge_categories',
  ];
  var stats = {};
  tables.forEach(function (t) {
    try {
      var r = TursoClient.select('SELECT COUNT(*) AS n FROM ' + t);
      stats[t] = parseInt(r[0].n, 10);
    } catch (_) {
      stats[t] = null;
    }
  });
  return { stats: stats, ts: nowIso() };
}

// ── system.version ────────────────────────────────────────────────────────────

function _systemVersion_(ctx, params) {
  return {
    app:     'Hass CMS',
    version: ENV.APP_VERSION || '3.0.0',
    stage:   'rebuild',
    ts:      nowIso(),
  };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerSystem_() {
  register({ service: 'system', action: 'ping',     permission: null,           handler: _systemPing_ });
  register({ service: 'system', action: 'health',   permission: 'order.view',   handler: _systemHealth_ });
  register({ service: 'system', action: 'dbStats',  permission: 'order.manage', handler: _systemDbStats_ });
  register({ service: 'system', action: 'version',  permission: null,           handler: _systemVersion_ });
})();
