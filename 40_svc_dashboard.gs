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

  // All six aggregates in ONE Turso round-trip (was six separate selects).
  // Mirrors the tursoPipeline_ batch pattern: multiple statements, single HTTP
  // call. The SQL and the returned shape are byte-for-byte unchanged.
  var res = TursoClient.batch([
    { sql: "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('NEW','OPEN')" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM orders WHERE status IN ('SUBMITTED','APPROVED')" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, args: sc.args },
    { sql: "SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'PENDING'" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM customers WHERE status = 'ACTIVE'" + sc.clause, args: sc.args }
  ]);

  function asInt(rows)   { return (rows.length && rows[0].n !== undefined) ? (parseInt(rows[0].n, 10) || 0) : 0; }
  function asFloat(rows) { return (rows.length && rows[0].s !== undefined) ? (parseFloat(rows[0].s) || 0) : 0; }

  return {
    open_tickets:       asInt(res[0].rows),
    pending_orders:     asInt(res[1].rows),
    unpaid_invoices:    asInt(res[2].rows),
    unpaid_amount:      asFloat(res[3].rows),
    pending_approvals:  asInt(res[4].rows),
    active_customers:   asInt(res[5].rows),
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

// ── dashboard.slaMetrics  —  SLA performance feed (4 datasets, 1 call) ───────
//
// All datasets are country-scoped via the session (same RBAC as the other
// dashboard actions). Reads REAL columns only:
//   tickets:    sla_response_breached, sla_resolve_breached, sla_response_by,
//               sla_resolve_by, priority, status, created_at
//   sla_config: priority, response_minutes, resolve_minutes
//
// Returns:
//   { breachTrend:[{date,count}],                 // 30-day continuous series
//     breachesByPriority:[{priority,count}],       // CRITICAL/HIGH/MEDIUM/LOW
//     compliance:{responseMet,responseBreached,resolveMet,resolveBreached},
//     approaching:[{ticket_number,subject,priority,due_at}] }  // open, <24h, unbreached

function _dashSlaMetrics_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  var sc    = _dashScopeClause_(scope, '');

  // ── sla_config map: priority → { response, resolve } minutes (fallback) ──
  // Kept as its own read: the table can be absent on older schemas, and a single
  // failing statement would abort an entire batch.
  var cfg = {};
  try {
    var cfgRows = TursoClient.select(
      'SELECT priority, response_minutes, resolve_minutes FROM sla_config', []
    );
    cfgRows.forEach(function (c) {
      var p = String(c.priority || '').toUpperCase();
      if (!p) return;
      cfg[p] = {
        response: parseInt(c.response_minutes, 10) || 0,
        resolve:  parseInt(c.resolve_minutes,  10) || 0,
      };
    });
  } catch (_) {}

  var BREACHED = '(sla_response_breached = 1 OR sla_resolve_breached = 1)';

  // The trend, by-priority, four compliance counts, and open-ticket scan in ONE
  // Turso round-trip (was seven separate selects). Mirrors the tursoPipeline_
  // batch pattern; each statement's SQL is identical to before.
  var rs = TursoClient.batch([
    // 0: breach trend (last 30 days) — daily breached-ticket count
    { sql: "SELECT date(created_at) AS d, COUNT(*) AS n FROM tickets " +
           "WHERE " + BREACHED + " AND date(created_at) >= date('now','-29 days')" + sc.clause +
           " GROUP BY d", args: sc.args },
    // 1: breaches by priority
    { sql: "SELECT priority AS p, COUNT(*) AS n FROM tickets WHERE " + BREACHED + sc.clause +
           " GROUP BY priority", args: sc.args },
    // 2: responseMet  3: responseBreached  4: resolveMet  5: resolveBreached
    { sql: "SELECT COUNT(*) AS n FROM tickets WHERE sla_response_by IS NOT NULL AND sla_response_breached = 0" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM tickets WHERE sla_response_breached = 1" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM tickets WHERE sla_resolve_by IS NOT NULL AND sla_resolve_breached = 0" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM tickets WHERE sla_resolve_breached = 1" + sc.clause, args: sc.args },
    // 6: open tickets approaching breach (candidates)
    { sql: "SELECT ticket_number, subject, priority, created_at, " +
           "sla_response_by, sla_resolve_by, sla_response_breached, sla_resolve_breached " +
           "FROM tickets WHERE status IN ('NEW','OPEN') " +
           "AND (sla_response_breached = 0 OR sla_resolve_breached = 0)" + sc.clause, args: sc.args }
  ]);

  function asN(rows) { return (rows.length && rows[0].n !== undefined) ? (parseInt(rows[0].n, 10) || 0) : 0; }

  // ── 1. Breach trend (last 30 days) — daily breached-ticket count ──────────
  var trendRows = rs[0].rows;
  var trendMap = {};
  trendRows.forEach(function (r) { trendMap[r.d] = parseInt(r.n, 10) || 0; });
  var breachTrend = [];
  var todayMs = Date.now();
  for (var i = 29; i >= 0; i--) {
    var key = new Date(todayMs - i * 86400000).toISOString().slice(0, 10);
    breachTrend.push({ date: key, count: trendMap[key] || 0 });
  }

  // ── 2. Breaches by priority ───────────────────────────────────────────────
  var prRows = rs[1].rows;
  var prMap = {};
  prRows.forEach(function (r) { prMap[String(r.p || '').toUpperCase()] = parseInt(r.n, 10) || 0; });
  var breachesByPriority = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(function (p) {
    return { priority: p, count: prMap[p] || 0 };
  });

  // ── 3. Response vs Resolve compliance ─────────────────────────────────────
  // "Met" counts tickets that had an SLA target and were not breached on it.
  var compliance = {
    responseMet:      asN(rs[2].rows),
    responseBreached: asN(rs[3].rows),
    resolveMet:       asN(rs[4].rows),
    resolveBreached:  asN(rs[5].rows),
  };

  // ── 4. Open tickets approaching breach (next 24h, not yet breached) ────────
  var WINDOW_MS = 24 * 3600 * 1000;
  var nowMs     = Date.now();
  var horizon   = nowMs + WINDOW_MS;
  var openRows  = rs[6].rows;

  function parseMs(v) { if (!v) return NaN; var t = new Date(v).getTime(); return isNaN(t) ? NaN : t; }
  function derive(createdAt, prio, kind) {
    var c = cfg[String(prio || '').toUpperCase()];
    if (!c) return NaN;
    var mins = (kind === 'response') ? c.response : c.resolve;
    if (!mins) return NaN;
    var base = parseMs(createdAt);
    return isNaN(base) ? NaN : base + mins * 60000;
  }

  var approaching = [];
  openRows.forEach(function (r) {
    var soonest = Infinity;
    // Response deadline (only if not already breached on response).
    if (parseInt(r.sla_response_breached, 10) !== 1) {
      var rby = parseMs(r.sla_response_by);
      if (isNaN(rby)) rby = derive(r.created_at, r.priority, 'response');
      if (!isNaN(rby) && rby >= nowMs && rby <= horizon) soonest = Math.min(soonest, rby);
    }
    // Resolve deadline (only if not already breached on resolve).
    if (parseInt(r.sla_resolve_breached, 10) !== 1) {
      var vby = parseMs(r.sla_resolve_by);
      if (isNaN(vby)) vby = derive(r.created_at, r.priority, 'resolve');
      if (!isNaN(vby) && vby >= nowMs && vby <= horizon) soonest = Math.min(soonest, vby);
    }
    if (soonest !== Infinity) {
      approaching.push({
        ticket_number: r.ticket_number,
        subject:       r.subject,
        priority:      r.priority,
        due_at:        new Date(soonest).toISOString(),
      });
    }
  });
  approaching.sort(function (a, b) { return a.due_at < b.due_at ? -1 : (a.due_at > b.due_at ? 1 : 0); });
  approaching = approaching.slice(0, 8);

  return {
    breachTrend:        breachTrend,
    breachesByPriority: breachesByPriority,
    compliance:         compliance,
    approaching:        approaching,
  };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerDashboard_() {
  register({ service: 'dashboard', action: 'summary',       permission: 'order.view', handler: _dashSummary_ });
  register({ service: 'dashboard', action: 'activityFeed',  permission: 'order.view', handler: _dashActivityFeed_ });
  register({ service: 'dashboard', action: 'ordersPulse',   permission: 'order.view', handler: _dashOrdersPulse_ });
  register({ service: 'dashboard', action: 'ticketsPulse',  permission: 'order.view', handler: _dashTicketsPulse_ });
  register({ service: 'dashboard', action: 'slaMetrics',    permission: 'order.view', handler: _dashSlaMetrics_ });
})();
