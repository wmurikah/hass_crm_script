/**
 * 40_svc_dashboard.gs  —  Hass CMS rebuild  (Stage 5F)
 *
 * Read-only aggregation service. No new tables — queries existing domain tables.
 *
 * dashboard.{summary, activityFeed, ordersPulse, ticketsPulse, charts, slaMetrics}
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

// The current calendar month as a single 'YYYY-MM' bucket, built in UTC so the
// label lines up with SQLite's strftime('%Y-%m', created_at), which also
// evaluates the ISO-UTC timestamps in UTC. Computed server-side; rolls over into
// the next month automatically with no code change.
function _dashCurrentMonth_() {
  var now = new Date();
  return [ now.getUTCFullYear() + '-' + ('0' + (now.getUTCMonth() + 1)).slice(-2) ];
}

// ── Aggregate-cache helpers (Layer 7) ───────────────────────────────────────
// The summary/charts/sla aggregates are pure functions of the country scope, so
// they are cached by a scope signature and shared across users with the same
// scope. RBAC is enforced in each handler BEFORE the cache is consulted, and the
// cache is invalidated on every data mutation (via Audit.log -> AggCache.onAudit)
// with a short TTL backstop, so a read after a write never serves stale numbers.
var _DASH_SUMMARY_TTL_ = 30;    // seconds; counts, kept very fresh
var _DASH_CHARTS_TTL_  = 180;   // seconds; six-month trends move slowly
var _DASH_SLA_TTL_     = 120;   // seconds

function _dashSig_(scope) {
  if (scope && scope.isGlobal) return 'G';
  var cs = (scope && scope.countries) ? scope.countries.slice().sort() : [];
  return 'C:' + cs.join(',');
}

// ── dashboard.summary ─────────────────────────────────────────────────────────

function _dashSummary_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  return AggCache.getOrSet('dash.summary', _dashSig_(scope), _DASH_SUMMARY_TTL_, function () {
    return _dashSummaryCompute_(scope);
  });
}

// The aggregation itself, byte-for-byte unchanged; only its execution moved
// behind the cache. Callable directly by the trigger warmer with a GLOBAL scope.
function _dashSummaryCompute_(scope) {
  var sc = _dashScopeClause_(scope, '');

  // All six aggregates in ONE Turso round-trip (was six separate selects).
  // Mirrors the tursoPipeline_ batch pattern: multiple statements, single HTTP
  // call. The SQL and the returned shape are byte-for-byte unchanged.
  var res = TursoClient.batch([
    { sql: "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('NEW','OPEN')" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM orders WHERE status IN ('SUBMITTED','APPROVED')" + sc.clause, args: sc.args },
    { sql: "SELECT COUNT(*) AS n FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, args: sc.args },
    { sql: "SELECT COALESCE(SUM(total_amount),0) AS s FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, args: sc.args },
    // APR-3: the real approval backlog is orders awaiting their tier decision
    // (status SUBMITTED), the same set the unified approvals inbox surfaces. The
    // legacy approval_requests table had no producer and always read 0.
    { sql: "SELECT COUNT(*) AS n FROM orders WHERE status = 'SUBMITTED'" + sc.clause, args: sc.args },
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

// ── dashboard.charts: four aggregated series for the dashboard charts ────────
//
// One Turso round-trip (batch) returns FOUR small, pre-aggregated series. The
// browser never sees raw rows, only counts/sums grouped in SQL. Every query is
// country-scoped via the session (same RBAC as the rest of the dashboard);
// GLOBAL roles see all, COUNTRY roles see only countryCode + countries_access.
//
// Every series is bound to the CURRENT CALENDAR MONTH (server-side; see MONTH
// below). Returns:
//   ordersByMonth:   [{ month:'YYYY-MM', count }]              // current month, line
//   revenueByMonth:  { months:[...], currencies:[...],          // current month, bar
//                      series:{ CCY:[..numbers..] } }           //   grouped PER currency
//   ordersByCountry: [{ country, label, count }]                // active countries, h-bar
//   ticketsByStatus: [{ status, count }]                        // five statuses, doughnut
//
// CURRENCY RULE: revenue is grouped by (month, currency_code) and returned as a
// separate series per currency. Amounts are NEVER summed across currencies (there
// is no exchange_rates table and "no schema change" is a hard constraint). The
// client charts one currency at a time via a selector.
function _dashCharts_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  // Charts are bound to the current calendar month. Fold the month into the
  // cache signature so the cached series flips cleanly at the month boundary
  // (rolls over with no code change), not only when the short TTL lapses.
  var monthKey = _dashCurrentMonth_()[0];
  return AggCache.getOrSet('dash.charts', _dashSig_(scope) + '|m=' + monthKey, _DASH_CHARTS_TTL_, function () {
    return _dashChartsCompute_(scope);
  });
}

function _dashChartsCompute_(scope) {
  var sc     = _dashScopeClause_(scope, '');          // orders & tickets both carry country_code
  var months = _dashCurrentMonth_();
  // Confirmed revenue only: exclude draft/cancelled/rejected so the bar reflects
  // booked order value, not abandoned or voided orders.
  var REV_EXCLUDE = "status NOT IN ('DRAFT','CANCELLED','REJECTED')";
  // Every chart is bound to the current calendar month (first of the month at
  // 00:00 to now), computed server-side in SQL so it rolls over automatically.
  // date('now','start of month') is the first of the current month in UTC,
  // matching strftime('%Y-%m', created_at). The detail lists and the stored
  // rows are NOT bound here; only these chart aggregates are.
  var MONTH = "date(created_at) >= date('now','start of month')";

  var res = TursoClient.batch([
    // 0: orders created this month (all statuses = order activity)
    { sql: "SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS n FROM orders " +
           "WHERE " + MONTH + sc.clause +
           " GROUP BY ym", args: sc.args },
    // 1: confirmed revenue this month PER currency (never summed across currencies)
    { sql: "SELECT strftime('%Y-%m', created_at) AS ym, UPPER(COALESCE(currency_code,'')) AS ccy, " +
           "COALESCE(SUM(total_amount),0) AS revenue FROM orders " +
           "WHERE " + MONTH + " AND " + REV_EXCLUDE + sc.clause +
           " GROUP BY ym, ccy", args: sc.args },
    // 2: orders by country (this month)
    { sql: "SELECT UPPER(COALESCE(country_code,'')) AS cc, COUNT(*) AS n FROM orders " +
           "WHERE " + MONTH + sc.clause + " GROUP BY cc", args: sc.args },
    // 3: tickets by status (created this month)
    { sql: "SELECT UPPER(COALESCE(status,'')) AS st, COUNT(*) AS n FROM tickets " +
           "WHERE " + MONTH + sc.clause + " GROUP BY st", args: sc.args }
  ]);

  // Country code -> display name, read defensively from the reference table so an
  // unknown name-column does not break the chart (we fall back to the code). This
  // is reference data (labels only); the per-country COUNTS above are scoped.
  var nameByCode = {};
  try {
    var cRows = TursoClient.select('SELECT * FROM countries', []);
    cRows.forEach(function (r) {
      var code = String(r.country_code || r.code || '').toUpperCase();
      if (!code) return;
      nameByCode[code] = String(r.country_name || r.name || r.label || r.title || code);
    });
  } catch (_) {}

  function toInt(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  function toNum(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ── 0. Orders per month (continuous 6-month series, gaps filled with 0) ──
  var omMap = {};
  res[0].rows.forEach(function (r) { omMap[r.ym] = toInt(r.n); });
  var ordersByMonth = months.map(function (m) { return { month: m, count: omMap[m] || 0 }; });

  // ── 1. Revenue per month per currency (highest-total currency first) ──
  var revMap = {}, ccyTotals = {};
  res[1].rows.forEach(function (r) {
    var ccy = r.ccy || 'NA';
    var rev = toNum(r.revenue);
    if (!revMap[ccy]) revMap[ccy] = {};
    revMap[ccy][r.ym] = rev;
    ccyTotals[ccy] = (ccyTotals[ccy] || 0) + rev;
  });
  var currencies = Object.keys(revMap).sort(function (a, b) { return ccyTotals[b] - ccyTotals[a]; });
  var revenueSeries = {};
  currencies.forEach(function (ccy) {
    revenueSeries[ccy] = months.map(function (m) { return revMap[ccy][m] || 0; });
  });

  // ── 2. Orders by country (most orders first) ──
  var ordersByCountry = res[2].rows.map(function (r) {
    var code = r.cc || '';
    return { country: code, label: nameByCode[code] || code || 'Unknown', count: toInt(r.n) };
  }).filter(function (r) { return r.country; });
  ordersByCountry.sort(function (a, b) { return b.count - a.count; });

  // ── 3. Tickets by the five lifecycle statuses (gaps filled with 0) ──
  var TICKET_STATUSES = ['NEW', 'OPEN', 'PENDING', 'RESOLVED', 'CLOSED'];
  var tsMap = {};
  res[3].rows.forEach(function (r) { tsMap[r.st] = toInt(r.n); });
  var ticketsByStatus = TICKET_STATUSES.map(function (s) { return { status: s, count: tsMap[s] || 0 }; });

  return {
    ordersByMonth:   ordersByMonth,
    revenueByMonth:  { months: months, currencies: currencies, series: revenueSeries },
    ordersByCountry: ordersByCountry,
    ticketsByStatus: ticketsByStatus,
  };
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
  return AggCache.getOrSet('dash.sla', _dashSig_(scope), _DASH_SLA_TTL_, function () {
    return _dashSlaCompute_(scope);
  });
}

function _dashSlaCompute_(scope) {
  var sc = _dashScopeClause_(scope, '');

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
  register({ service: 'dashboard', action: 'charts',        permission: 'order.view', handler: _dashCharts_ });
  register({ service: 'dashboard', action: 'slaMetrics',    permission: 'order.view', handler: _dashSlaMetrics_ });
})();
