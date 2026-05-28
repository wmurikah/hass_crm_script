/**
 * 40_svc_dashboard.gs  —  Hass CMS rebuild  (Stage 5F)
 *
 * Read-only aggregation service. No new tables — queries existing domain tables.
 *
 * dashboard.{summary, activityFeed, ordersPulse, ticketsPulse}
 *
 * Country scope enforced via session.
 */

// ── Scope helper ───────────────────────────────────────────────────────────────

function _dashScopeData_(session) {
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

function _dashScopeClause_(scope, tableAlias) {
  var alias = tableAlias ? tableAlias + '.' : '';
  if (scope.isGlobal) return { clause: '', args: [] };
  if (!scope.countries.length) return { clause: ' AND 1=0', args: [] };
  var ph = scope.countries.map(function () { return '?'; }).join(',');
  return { clause: ' AND ' + alias + 'country_code IN (' + ph + ')', args: scope.countries.slice() };
}

// ── dashboard.summary ─────────────────────────────────────────────────────────

function _dashSummary_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  var sc    = _dashScopeClause_(scope, '');

  function count(sql, args) {
    var r = TursoClient.select(sql, args);
    return (r.length && r[0].n !== undefined) ? parseInt(r[0].n, 10) : 0;
  }
  function sum(sql, args) {
    var r = TursoClient.select(sql, args);
    return (r.length && r[0].s !== undefined) ? parseFloat(r[0].s) || 0 : 0;
  }

  var openTickets = count(
    "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('NEW','OPEN')" + sc.clause, sc.args
  );
  var pendingOrders = count(
    "SELECT COUNT(*) AS n FROM orders WHERE status IN ('SUBMITTED','APPROVED')" + sc.clause, sc.args
  );
  var unpaidInvoices = count(
    "SELECT COUNT(*) AS n FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, sc.args
  );
  var unpaidAmount = sum(
    "SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, sc.args
  );
  var pendingApprovals = count(
    "SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'PENDING'" + sc.clause, sc.args
  );
  var activeCustomers = count(
    "SELECT COUNT(*) AS n FROM customers WHERE status = 'ACTIVE'" + sc.clause, sc.args
  );

  return {
    open_tickets:       openTickets,
    pending_orders:     pendingOrders,
    unpaid_invoices:    unpaidInvoices,
    unpaid_amount:      unpaidAmount,
    pending_approvals:  pendingApprovals,
    active_customers:   activeCustomers,
  };
}

// ── dashboard.activityFeed ────────────────────────────────────────────────────

function _dashActivityFeed_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope  = _dashScopeData_(ctx.session);
  var limit  = Math.min(parseInt(params.limit, 10) || 30, 100);
  var sql    = 'SELECT * FROM audit_log WHERE 1=1';
  var args   = [];

  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += " AND (country_code IN (" + ph + ") OR country_code = '' OR country_code IS NULL)";
    args = args.concat(scope.countries);
  }
  if (params.entity_type) { sql += ' AND entity_type = ?'; args.push(params.entity_type); }
  if (params.actor_id)    { sql += ' AND actor_id = ?';    args.push(params.actor_id); }

  sql += ' ORDER BY created_at DESC LIMIT ' + limit;
  return TursoClient.select(sql, args);
}

// ── dashboard.ordersPulse  —  last-N-days order volumes ──────────────────────

function _dashOrdersPulse_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  var days  = Math.min(parseInt(params.days, 10) || 30, 90);
  var sc    = _dashScopeClause_(scope, '');
  var sql   = "SELECT date(created_at) AS day, " +
              "COUNT(*) AS total_orders, " +
              "SUM(CASE WHEN status='DELIVERED' THEN 1 ELSE 0 END) AS delivered, " +
              "COALESCE(SUM(total_amount),0) AS revenue " +
              "FROM orders " +
              "WHERE date(created_at) >= date('now','-" + days + " days')" +
              sc.clause +
              " GROUP BY day ORDER BY day";
  return TursoClient.select(sql, sc.args);
}

// ── dashboard.ticketsPulse  —  last-N-days ticket volumes ────────────────────

function _dashTicketsPulse_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  var days  = Math.min(parseInt(params.days, 10) || 30, 90);
  var sc    = _dashScopeClause_(scope, '');
  var sql   = "SELECT date(created_at) AS day, " +
              "COUNT(*) AS total_tickets, " +
              "SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed, " +
              "SUM(CASE WHEN priority='CRITICAL' THEN 1 ELSE 0 END) AS critical " +
              "FROM tickets " +
              "WHERE date(created_at) >= date('now','-" + days + " days')" +
              sc.clause +
              " GROUP BY day ORDER BY day";
  return TursoClient.select(sql, sc.args);
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerDashboard_() {
  register({ service: 'dashboard', action: 'summary',       permission: 'order.view', handler: _dashSummary_ });
  register({ service: 'dashboard', action: 'activityFeed',  permission: 'order.view', handler: _dashActivityFeed_ });
  register({ service: 'dashboard', action: 'ordersPulse',   permission: 'order.view', handler: _dashOrdersPulse_ });
  register({ service: 'dashboard', action: 'ticketsPulse',  permission: 'order.view', handler: _dashTicketsPulse_ });
})();
