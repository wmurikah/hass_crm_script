/**
 * 40_svc_bot_reports.gs  -  Hass CMS  (assistant report catalog)
 *
 * A curated, parameterised report catalog registered on the `reports` service.
 * Each report is a SAFE read backed by a server-side query. The assistant calls
 * these as tools (selected from bot_tools, never as free SQL); the Reports page
 * runs the same actions directly. Every handler:
 *
 *   - re-checks the caller's RBAC permission (defense in depth on top of the
 *     dispatcher gate), so the bot never acts with more access than the user;
 *   - applies the same country scoping the rest of the app uses (GLOBAL roles
 *     see all, COUNTRY roles see countryCode + countries_access);
 *   - returns ONE consistent shape: { report, title, columns, rows, totals,
 *     summary, currency_note, deepLink } so the client can render a titled
 *     table, a totals line, an "Open in {section}" deep link and CSV export.
 *
 * CURRENCY RULE: any report that touches money groups by currency and reports
 * totals PER currency (a by_currency map). It never sums amounts across more
 * than one currency into a single figure. There is no exchange_rates table in
 * this schema and "no schema change" is a hard constraint, so cross-currency
 * conversion is deliberately not attempted; callers filter to one currency when
 * they need a single number.
 *
 * No new tables. Columns whose presence varies by deployment (documents
 * is_mandatory, approval tier, churn/retention shapes, price_list tier/status)
 * are discovered at runtime via SchemaIntrospect and degrade gracefully.
 */

// ════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS (local copies, matching the per-service scope pattern used
// across customers/orders/tickets/invoices/dashboard)
// ════════════════════════════════════════════════════════════════════════════

function _repScope_(session) {
  if (!session) return { isGlobal: false, countries: [] };
  var isGlobal = false;
  try {
    var r = TursoClient.select('SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [session.role || '']);
    isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
  } catch (_) {}
  if (isGlobal) return { isGlobal: true, countries: [] };
  var countries = [String(session.countryCode || '').trim()].filter(Boolean);
  try {
    var u = TursoClient.select('SELECT countries_access FROM users WHERE user_id = ? LIMIT 1', [session.userId]);
    if (u.length && u[0].countries_access) {
      String(u[0].countries_access).split(',').forEach(function (c) {
        var t = c.trim();
        if (t && countries.indexOf(t) === -1) countries.push(t);
      });
    }
  } catch (_) {}
  return { isGlobal: false, countries: countries };
}

/** Build " AND alias.country_code IN (?,?)" (alias '' for a bare column). */
function _repClause_(scope, alias) {
  var col = (alias ? alias + '.' : '') + 'country_code';
  if (scope.isGlobal) return { clause: '', args: [] };
  if (!scope.countries.length) return { clause: ' AND 1=0', args: [] };
  var ph = scope.countries.map(function () { return '?'; }).join(',');
  return { clause: ' AND ' + col + ' IN (' + ph + ')', args: scope.countries.slice() };
}

function _repInt_(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
function _repNum_(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
function _repLimit_(params) { return Math.min(Math.max(parseInt(params && params.limit, 10) || 500, 1), 2000); }
function _repCcy_(v) { return String(v || '').toUpperCase() || 'NA'; }

function _repFmtMoney_(n, ccy) {
  var x = _repNum_(n);
  var s = x.toLocaleString ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                           : String(Math.round(x * 100) / 100);
  return (ccy || '') + ' ' + s;
}

/** Render a by_currency map into "KES 1,000.00; USD 20.00" for summary lines. */
function _repCcyLine_(byCcy, field) {
  var parts = [];
  Object.keys(byCcy || {}).forEach(function (ccy) {
    var v = field ? byCcy[ccy][field] : byCcy[ccy];
    parts.push(_repFmtMoney_(v, ccy));
  });
  return parts.length ? parts.join('; ') : 'none';
}

function _repResult_(o) {
  return {
    report:        o.report,
    title:         o.title,
    columns:       o.columns || [],
    rows:          o.rows || [],
    totals:        o.totals || null,
    summary:       o.summary || '',
    currency_note: o.currency_note || null,
    deepLink:      o.deepLink || null,
    generated_at:  nowIso(),
  };
}

/** Days between an ISO/date string and now (positive = in the past). */
function _repDaysAgo_(dateStr) {
  if (!dateStr) return null;
  var t = new Date(String(dateStr)).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/** A name lookup map { id: label } built defensively from a reference table. */
function _repNameMap_(table, idCol, nameCandidates) {
  var map = {};
  try {
    var nameCol = SchemaIntrospect.pick(table, nameCandidates) || idCol;
    var rows = TursoClient.select('SELECT ' + idCol + ' AS id, ' + nameCol + ' AS nm FROM ' + table, []);
    rows.forEach(function (r) { if (r.id != null) map[String(r.id)] = String(r.nm == null ? r.id : r.nm); });
  } catch (_) {}
  return map;
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: KYC and compliance
// ════════════════════════════════════════════════════════════════════════════

function _repKyc_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'customer.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 'c');
  var limit = _repLimit_(params);

  // Customers in scope (optionally filtered by country / segment).
  var csql = 'SELECT c.customer_id, c.company_name, c.country_code, c.segment_id ' +
             'FROM customers c WHERE 1=1' + sc.clause;
  var cargs = sc.args.slice();
  if (params.country_code) { csql += ' AND c.country_code = ?'; cargs.push(String(params.country_code)); }
  if (params.segment_id)   { csql += ' AND c.segment_id = ?';   cargs.push(String(params.segment_id)); }
  csql += " AND COALESCE(c.status,'') != 'INACTIVE' ORDER BY c.company_name LIMIT " + limit;
  var customers = TursoClient.select(csql, cargs);

  if (!customers.length) {
    return _repResult_({ report: 'kyc_compliance', title: 'KYC and compliance',
      columns: _repKycCols_(), rows: [], summary: 'No customers in scope.' });
  }

  // Documents for those customers in one pass.
  var ids = customers.map(function (c) { return c.customer_id; });
  var ph   = ids.map(function () { return '?'; }).join(',');
  var docs = [];
  try {
    docs = TursoClient.select(
      'SELECT customer_id, status, expiry_date FROM documents WHERE customer_id IN (' + ph + ')', ids);
  } catch (_) {}

  var stat = {};
  ids.forEach(function (id) { stat[id] = { total: 0, pending: 0, approved: 0, rejected: 0, expired: 0 }; });
  docs.forEach(function (d) {
    var s = stat[d.customer_id]; if (!s) return;
    s.total++;
    var st = String(d.status || '').toUpperCase();
    if (st === 'PENDING_REVIEW' || st === 'PENDING') s.pending++;
    else if (st === 'APPROVED') s.approved++;
    else if (st === 'REJECTED') s.rejected++;
    var da = _repDaysAgo_(d.expiry_date);
    if (da != null && da > 0) s.expired++;
  });

  var issue = String(params.issue || 'any').toLowerCase(); // any|missing|pending|expired|rejected|all
  var rows = [];
  var counts = { missing: 0, pending: 0, expired: 0, rejected: 0 };
  customers.forEach(function (c) {
    var s = stat[c.customer_id];
    var missing = s.total === 0;
    if (missing) counts.missing++;
    if (s.pending) counts.pending++;
    if (s.expired) counts.expired++;
    if (s.rejected) counts.rejected++;
    var hasIssue = missing || s.pending > 0 || s.expired > 0 || s.rejected > 0;
    var keep =
      issue === 'all' ? true :
      issue === 'missing' ? missing :
      issue === 'pending' ? s.pending > 0 :
      issue === 'expired' ? s.expired > 0 :
      issue === 'rejected' ? s.rejected > 0 :
      hasIssue; // 'any'
    if (!keep) return;
    rows.push({
      company_name: c.company_name || c.customer_id,
      country_code: c.country_code || '',
      segment_id:   c.segment_id || '',
      total_docs:   s.total,
      pending:      s.pending,
      approved:     s.approved,
      rejected:     s.rejected,
      expired:      s.expired,
      flag:         missing ? 'NO DOCUMENTS' : (s.expired ? 'EXPIRED' : (s.rejected ? 'REJECTED' : (s.pending ? 'PENDING' : 'OK'))),
    });
  });

  return _repResult_({
    report:  'kyc_compliance',
    title:   'KYC and compliance',
    columns: _repKycCols_(),
    rows:    rows,
    totals:  { customers_with_issues: rows.length, no_documents: counts.missing,
               pending: counts.pending, expired: counts.expired, rejected: counts.rejected },
    summary: rows.length + ' customers flagged. No documents: ' + counts.missing +
             ', pending review: ' + counts.pending + ', expired: ' + counts.expired +
             ', rejected: ' + counts.rejected + '.',
    deepLink: { route: 'documents', params: {} },
  });
}
function _repKycCols_() {
  return [
    { key: 'company_name', label: 'Customer',     type: 'text' },
    { key: 'country_code', label: 'Country',      type: 'text' },
    { key: 'segment_id',   label: 'Segment',      type: 'text' },
    { key: 'total_docs',   label: 'Docs',         type: 'number' },
    { key: 'pending',      label: 'Pending',      type: 'number' },
    { key: 'approved',     label: 'Approved',     type: 'number' },
    { key: 'rejected',     label: 'Rejected',     type: 'number' },
    { key: 'expired',      label: 'Expired',      type: 'number' },
    { key: 'flag',         label: 'Flag',         type: 'text' },
  ];
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Orders by criteria
// ════════════════════════════════════════════════════════════════════════════

function _repOrders_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 'o');
  var limit = _repLimit_(params);

  var sql = 'SELECT o.order_number, o.customer_id, c.company_name, o.country_code, o.status, ' +
            'o.currency_code, o.total_amount, o.created_at FROM orders o ' +
            'LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE 1=1' + sc.clause;
  var args = sc.args.slice();
  if (params.status)       { sql += ' AND UPPER(o.status) = ?';   args.push(String(params.status).toUpperCase()); }
  if (params.country_code) { sql += ' AND o.country_code = ?';    args.push(String(params.country_code)); }
  if (params.customer_id)  { sql += ' AND o.customer_id = ?';     args.push(String(params.customer_id)); }
  if (params.currency_code){ sql += ' AND UPPER(COALESCE(o.currency_code,\'\')) = ?'; args.push(_repCcy_(params.currency_code)); }
  if (params.from_date)    { sql += ' AND date(o.created_at) >= date(?)'; args.push(String(params.from_date)); }
  if (params.to_date)      { sql += ' AND date(o.created_at) <= date(?)'; args.push(String(params.to_date)); }
  if (params.min_value)    { sql += ' AND COALESCE(o.total_amount,0) >= ?'; args.push(_repNum_(params.min_value)); }
  if (params.product_id)   { sql += ' AND EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id = o.order_id AND ol.product_id = ?)'; args.push(String(params.product_id)); }
  sql += ' ORDER BY o.created_at DESC LIMIT ' + limit;

  var rows = TursoClient.select(sql, args);
  var byCcy = {};
  rows.forEach(function (r) {
    var ccy = _repCcy_(r.currency_code);
    if (!byCcy[ccy]) byCcy[ccy] = { count: 0, amount: 0 };
    byCcy[ccy].count++;
    byCcy[ccy].amount += _repNum_(r.total_amount);
  });

  return _repResult_({
    report:  'orders_by_criteria',
    title:   'Orders report',
    columns: [
      { key: 'order_number', label: 'Order',    type: 'text' },
      { key: 'company_name', label: 'Customer', type: 'text' },
      { key: 'country_code', label: 'Country',  type: 'text' },
      { key: 'status',       label: 'Status',   type: 'text' },
      { key: 'currency_code',label: 'Currency', type: 'text' },
      { key: 'total_amount', label: 'Total',    type: 'money' },
      { key: 'created_at',   label: 'Created',  type: 'date' },
    ],
    rows:    rows,
    totals:  { count: rows.length, by_currency: byCcy },
    summary: rows.length + ' orders. Value by currency: ' + _repCcyLine_(byCcy, 'amount') + '.',
    currency_note: 'Totals are reported per currency and are never summed across currencies.',
    deepLink: { route: 'orders', params: _repPassFilters_(params, ['status', 'country_code', 'customer_id', 'currency_code']) },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Receivables aging
// ════════════════════════════════════════════════════════════════════════════

function _repReceivables_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 'i');
  var limit = _repLimit_(params);

  var sql = 'SELECT i.invoice_number, i.customer_id, c.company_name, i.country_code, ' +
            'i.currency_code, i.total_amount, i.due_date FROM invoices i ' +
            'LEFT JOIN customers c ON c.customer_id = i.customer_id ' +
            "WHERE COALESCE(i.status,'') != 'CANCELLED' AND UPPER(COALESCE(i.payment_status,'')) != 'PAID'" + sc.clause;
  var args = sc.args.slice();
  if (params.country_code)  { sql += ' AND i.country_code = ?';  args.push(String(params.country_code)); }
  if (params.customer_id)   { sql += ' AND i.customer_id = ?';   args.push(String(params.customer_id)); }
  if (params.currency_code) { sql += ' AND UPPER(COALESCE(i.currency_code,\'\')) = ?'; args.push(_repCcy_(params.currency_code)); }
  sql += ' ORDER BY i.due_date ASC LIMIT ' + limit;

  var invs = TursoClient.select(sql, args);

  // Aggregate per (customer + currency) into aging buckets.
  var agg = {}, byCcy = {}, custSet = {};
  invs.forEach(function (inv) {
    var ccy = _repCcy_(inv.currency_code);
    var key = (inv.customer_id || '') + '|' + ccy;
    if (!agg[key]) {
      agg[key] = { company_name: inv.company_name || inv.customer_id, country_code: inv.country_code || '',
                   currency_code: ccy, b0_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0, total: 0 };
    }
    if (!byCcy[ccy]) byCcy[ccy] = { b0_30: 0, b31_60: 0, b61_90: 0, b90_plus: 0, total: 0 };
    custSet[inv.customer_id || ''] = 1;
    var amt  = _repNum_(inv.total_amount);
    var days = _repDaysAgo_(inv.due_date);
    var bucket = (days == null || days <= 30) ? 'b0_30' : (days <= 60 ? 'b31_60' : (days <= 90 ? 'b61_90' : 'b90_plus'));
    agg[key][bucket]  += amt; agg[key].total  += amt;
    byCcy[ccy][bucket] += amt; byCcy[ccy].total += amt;
  });

  var rows = Object.keys(agg).map(function (k) { return agg[k]; })
    .sort(function (a, b) { return b.total - a.total; });

  return _repResult_({
    report:  'receivables_aging',
    title:   'Receivables aging',
    columns: [
      { key: 'company_name', label: 'Customer', type: 'text' },
      { key: 'country_code', label: 'Country',  type: 'text' },
      { key: 'currency_code',label: 'Currency', type: 'text' },
      { key: 'b0_30',        label: '0-30',     type: 'money' },
      { key: 'b31_60',       label: '31-60',    type: 'money' },
      { key: 'b61_90',       label: '61-90',    type: 'money' },
      { key: 'b90_plus',     label: '90+',      type: 'money' },
      { key: 'total',        label: 'Total',    type: 'money' },
    ],
    rows:    rows,
    totals:  { invoices: invs.length, customers: Object.keys(custSet).length, by_currency: byCcy },
    summary: invs.length + ' unpaid invoices across ' + Object.keys(custSet).length +
             ' customers. Outstanding by currency: ' + _repCcyLine_(byCcy, 'total') + '.',
    currency_note: 'Aging totals are kept per currency and are never summed across currencies.',
    deepLink: { route: 'invoices', params: { payment_status: 'UNPAID' } },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Sales and revenue (per currency, never summed across currencies)
// ════════════════════════════════════════════════════════════════════════════

function _repSales_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 'o');
  var groupBy = String(params.group_by || 'month').toLowerCase();
  var REV_EXCLUDE = "UPPER(COALESCE(o.status,'')) NOT IN ('DRAFT','CANCELLED','REJECTED')";

  var dimExpr, dimLabel, joinSql = '', revExpr = 'COALESCE(o.total_amount,0)';
  if (groupBy === 'country')      { dimExpr = "UPPER(COALESCE(o.country_code,''))"; dimLabel = 'Country'; }
  else if (groupBy === 'segment') { dimExpr = "COALESCE(c.segment_id,'')"; dimLabel = 'Segment'; joinSql = ' LEFT JOIN customers c ON c.customer_id = o.customer_id'; }
  else if (groupBy === 'product') {
    dimExpr = "COALESCE(ol.product_id,'')"; dimLabel = 'Product';
    joinSql = ' JOIN order_lines ol ON ol.order_id = o.order_id';
    // line_total is a conditionally-present column; fall back to line_subtotal.
    revExpr = SchemaIntrospect.has('order_lines', 'line_total')
      ? 'COALESCE(ol.line_total, ol.line_subtotal, 0)' : 'COALESCE(ol.line_subtotal, 0)';
  } else { groupBy = 'month'; dimExpr = "strftime('%Y-%m', o.created_at)"; dimLabel = 'Month'; }

  var sql = 'SELECT ' + dimExpr + " AS dim, UPPER(COALESCE(o.currency_code,'')) AS ccy, " +
            'COUNT(DISTINCT o.order_id) AS n, SUM(' + revExpr + ') AS revenue ' +
            'FROM orders o' + joinSql + ' WHERE ' + REV_EXCLUDE + sc.clause;
  var args = sc.args.slice();
  if (params.country_code) { sql += ' AND o.country_code = ?'; args.push(String(params.country_code)); }
  if (params.from_date)    { sql += ' AND date(o.created_at) >= date(?)'; args.push(String(params.from_date)); }
  if (params.to_date)      { sql += ' AND date(o.created_at) <= date(?)'; args.push(String(params.to_date)); }
  sql += ' GROUP BY dim, ccy ORDER BY revenue DESC LIMIT ' + _repLimit_(params);

  var raw = TursoClient.select(sql, args);

  var labels = {};
  if (groupBy === 'segment') labels = _repNameMap_('segments', 'segment_id', ['name', 'segment_name', 'title']);
  if (groupBy === 'product') labels = _repNameMap_('products', 'product_id', ['name', 'product_name', 'title']);

  var byCcy = {};
  var rows = raw.map(function (r) {
    var ccy = _repCcy_(r.ccy);
    if (!byCcy[ccy]) byCcy[ccy] = { order_count: 0, revenue: 0 };
    byCcy[ccy].order_count += _repInt_(r.n);
    byCcy[ccy].revenue     += _repNum_(r.revenue);
    return {
      dimension:     labels[String(r.dim)] || r.dim || '(none)',
      currency_code: ccy,
      order_count:   _repInt_(r.n),
      revenue:       _repNum_(r.revenue),
    };
  });

  return _repResult_({
    report:  'sales_revenue',
    title:   'Sales and revenue by ' + groupBy,
    columns: [
      { key: 'dimension',    label: dimLabel,   type: 'text' },
      { key: 'currency_code',label: 'Currency', type: 'text' },
      { key: 'order_count',  label: 'Orders',   type: 'number' },
      { key: 'revenue',      label: 'Revenue',  type: 'money' },
    ],
    rows:    rows,
    totals:  { by_currency: byCcy },
    summary: 'Confirmed revenue by currency: ' + _repCcyLine_(byCcy, 'revenue') + '.',
    currency_note: 'Revenue is grouped and totalled per currency. Amounts are never summed across currencies.',
    deepLink: { route: 'orders', params: _repPassFilters_(params, ['country_code']) },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Ticket and SLA
// ════════════════════════════════════════════════════════════════════════════

function _repTicketSla_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'ticket.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 't');
  var groupBy = String(params.group_by || 'status').toLowerCase();

  var dimExpr, dimLabel;
  if (groupBy === 'priority')    { dimExpr = "UPPER(COALESCE(t.priority,''))"; dimLabel = 'Priority'; }
  else if (groupBy === 'team')   { dimExpr = "COALESCE(t.assigned_team_id,'')"; dimLabel = 'Team'; }
  else if (groupBy === 'agent')  { dimExpr = "COALESCE(t.assigned_to,'')"; dimLabel = 'Agent'; }
  else { groupBy = 'status'; dimExpr = "UPPER(COALESCE(t.status,''))"; dimLabel = 'Status'; }

  var sql = 'SELECT ' + dimExpr + ' AS dim, COUNT(*) AS total, ' +
            "SUM(CASE WHEN UPPER(COALESCE(t.status,'')) IN ('NEW','OPEN','PENDING') THEN 1 ELSE 0 END) AS open_count, " +
            "SUM(CASE WHEN UPPER(COALESCE(t.status,'')) IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS resolved_count, " +
            'SUM(CASE WHEN t.sla_response_breached = 1 THEN 1 ELSE 0 END) AS breached_response, ' +
            'SUM(CASE WHEN t.sla_resolve_breached = 1 THEN 1 ELSE 0 END) AS breached_resolve, ' +
            'AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 END) AS avg_hours ' +
            'FROM tickets t WHERE 1=1' + sc.clause;
  var args = sc.args.slice();
  if (params.country_code) { sql += ' AND t.country_code = ?'; args.push(String(params.country_code)); }
  if (params.from_date)    { sql += ' AND date(t.created_at) >= date(?)'; args.push(String(params.from_date)); }
  if (params.to_date)      { sql += ' AND date(t.created_at) <= date(?)'; args.push(String(params.to_date)); }
  sql += ' GROUP BY dim ORDER BY total DESC LIMIT ' + _repLimit_(params);

  var raw = TursoClient.select(sql, args);

  var labels = {};
  if (groupBy === 'agent') labels = _repNameMap_('users', 'user_id', ['first_name']); // approximate; replaced below
  if (groupBy === 'agent') {
    // Build a "First Last" label map for agents.
    labels = {};
    try {
      TursoClient.select('SELECT user_id, first_name, last_name FROM users', []).forEach(function (u) {
        labels[String(u.user_id)] = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.user_id;
      });
    } catch (_) {}
  }
  if (groupBy === 'team') labels = _repNameMap_('teams', 'team_id', ['name', 'team_name', 'title']);

  var tot = { total: 0, open_count: 0, resolved_count: 0, breached_response: 0, breached_resolve: 0 };
  var rows = raw.map(function (r) {
    tot.total += _repInt_(r.total); tot.open_count += _repInt_(r.open_count);
    tot.resolved_count += _repInt_(r.resolved_count);
    tot.breached_response += _repInt_(r.breached_response); tot.breached_resolve += _repInt_(r.breached_resolve);
    return {
      dimension:        labels[String(r.dim)] || r.dim || '(none)',
      total:            _repInt_(r.total),
      open_count:       _repInt_(r.open_count),
      resolved_count:   _repInt_(r.resolved_count),
      breached_response:_repInt_(r.breached_response),
      breached_resolve: _repInt_(r.breached_resolve),
      avg_resolution_hours: r.avg_hours == null ? null : Math.round(_repNum_(r.avg_hours) * 10) / 10,
    };
  });

  return _repResult_({
    report:  'ticket_sla',
    title:   'Tickets and SLA by ' + groupBy,
    columns: [
      { key: 'dimension',            label: dimLabel,        type: 'text' },
      { key: 'total',                label: 'Total',         type: 'number' },
      { key: 'open_count',           label: 'Open',          type: 'number' },
      { key: 'resolved_count',       label: 'Resolved',      type: 'number' },
      { key: 'breached_response',    label: 'Resp. breach',  type: 'number' },
      { key: 'breached_resolve',     label: 'Resolve breach',type: 'number' },
      { key: 'avg_resolution_hours', label: 'Avg hrs',       type: 'number' },
    ],
    rows:    rows,
    totals:  tot,
    summary: tot.total + ' tickets. Open: ' + tot.open_count + ', resolved: ' + tot.resolved_count +
             ', SLA breaches (response/resolve): ' + tot.breached_response + '/' + tot.breached_resolve + '.',
    deepLink: { route: 'tickets', params: _repPassFilters_(params, ['status', 'priority', 'country_code']) },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Customer statement (financial). 360 reuse stays via customers.customer360.
// ════════════════════════════════════════════════════════════════════════════

function _repCustomerStatement_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'customers.view');
  var customerId = String(params.customerId || params.customer_id || '').trim();
  if (!customerId) throw new Errors.Validation('customerId is required.');

  var crows = TursoClient.select('SELECT * FROM customers WHERE customer_id = ? LIMIT 1', [customerId]);
  if (!crows.length) throw new Errors.NotFound('Customer not found.');
  var customer = crows[0];
  var scope = _repScope_(ctx.session);
  if (!scope.isGlobal && scope.countries.indexOf(String(customer.country_code || '')) === -1) {
    throw new Errors.NotFound('Customer not found.');
  }

  var invs = TursoClient.select(
    "SELECT invoice_number, issue_date, due_date, currency_code, total_amount, payment_status " +
    "FROM invoices WHERE customer_id = ? AND COALESCE(status,'') != 'CANCELLED' " +
    "AND UPPER(COALESCE(payment_status,'')) != 'PAID' ORDER BY due_date ASC LIMIT " + _repLimit_(params),
    [customerId]);

  var byCcy = {};
  invs.forEach(function (i) {
    var ccy = _repCcy_(i.currency_code);
    if (!byCcy[ccy]) byCcy[ccy] = { count: 0, amount: 0 };
    byCcy[ccy].count++; byCcy[ccy].amount += _repNum_(i.total_amount);
  });

  var limit = _repNum_(customer.credit_limit), used = _repNum_(customer.credit_used);
  var ccy   = _repCcy_(customer.currency_code);

  return _repResult_({
    report:  'customer_statement',
    title:   'Statement: ' + (customer.company_name || customerId),
    columns: [
      { key: 'invoice_number', label: 'Invoice',  type: 'text' },
      { key: 'issue_date',     label: 'Issued',   type: 'date' },
      { key: 'due_date',       label: 'Due',      type: 'date' },
      { key: 'currency_code',  label: 'Currency', type: 'text' },
      { key: 'total_amount',   label: 'Amount',   type: 'money' },
      { key: 'payment_status', label: 'Status',   type: 'text' },
    ],
    rows:    invs,
    totals:  { outstanding_invoices: invs.length, by_currency: byCcy,
               credit_limit: limit, credit_used: used, credit_available: Math.max(0, limit - used) },
    summary: (customer.company_name || customerId) + '. Credit ' + _repFmtMoney_(used, ccy) + ' of ' +
             _repFmtMoney_(limit, ccy) + ' used. Outstanding by currency: ' + _repCcyLine_(byCcy, 'amount') + '.',
    currency_note: 'Outstanding balances are reported per currency.',
    deepLink: { route: 'customers', params: {} },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Approvals (pending and overdue by tier)
// ════════════════════════════════════════════════════════════════════════════

function _repApprovals_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 'ar');
  var overdueDays = parseInt(params.overdue_days, 10) || 3;

  var tierCol = SchemaIntrospect.pick('approval_requests', ['tier', 'approval_tier', 'level', 'escalation_level']);
  var dimExpr = tierCol ? ('ar.' + tierCol) : "COALESCE(ar.entity_type,'')";
  var dimLabel = tierCol ? 'Tier' : 'Type';

  var sql = 'SELECT ' + dimExpr + ' AS dim, ' +
            "SUM(CASE WHEN UPPER(COALESCE(ar.status,'')) = 'PENDING' THEN 1 ELSE 0 END) AS pending, " +
            "SUM(CASE WHEN UPPER(COALESCE(ar.status,'')) = 'PENDING' AND julianday('now') - julianday(ar.created_at) > ? THEN 1 ELSE 0 END) AS overdue, " +
            'COUNT(*) AS total FROM approval_requests ar WHERE 1=1' + sc.clause + ' GROUP BY dim ORDER BY pending DESC LIMIT ' + _repLimit_(params);
  var args = [overdueDays].concat(sc.args);
  var raw = TursoClient.select(sql, args);

  var tot = { pending: 0, overdue: 0, total: 0 };
  var rows = raw.map(function (r) {
    tot.pending += _repInt_(r.pending); tot.overdue += _repInt_(r.overdue); tot.total += _repInt_(r.total);
    return { dimension: r.dim || '(none)', pending: _repInt_(r.pending), overdue: _repInt_(r.overdue), total: _repInt_(r.total) };
  });

  return _repResult_({
    report:  'approvals',
    title:   'Approvals by ' + dimLabel.toLowerCase(),
    columns: [
      { key: 'dimension', label: dimLabel,            type: 'text' },
      { key: 'pending',   label: 'Pending',           type: 'number' },
      { key: 'overdue',   label: 'Overdue (' + overdueDays + 'd+)', type: 'number' },
      { key: 'total',     label: 'Total',             type: 'number' },
    ],
    rows:    rows,
    totals:  tot,
    summary: tot.pending + ' pending approvals (' + tot.overdue + ' overdue past ' + overdueDays + ' days).',
    deepLink: { route: 'approvals', params: {} },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Payments (uploads pending review by status)
// ════════════════════════════════════════════════════════════════════════════

function _repPayments_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, 'c'); // payment_uploads has no country_code; scope via customer

  var sql = "SELECT UPPER(COALESCE(pu.status,'')) AS st, UPPER(COALESCE(pu.currency_code,'')) AS ccy, " +
            'COUNT(*) AS n, SUM(COALESCE(pu.amount,0)) AS amt FROM payment_uploads pu ' +
            'LEFT JOIN customers c ON c.customer_id = pu.customer_id WHERE 1=1' + sc.clause;
  var args = sc.args.slice();
  if (params.status) { sql += ' AND UPPER(COALESCE(pu.status,\'\')) = ?'; args.push(String(params.status).toUpperCase()); }
  sql += ' GROUP BY st, ccy ORDER BY n DESC LIMIT ' + _repLimit_(params);

  var raw = TursoClient.select(sql, args);
  var byCcy = {}, total = 0;
  var rows = raw.map(function (r) {
    var ccy = _repCcy_(r.ccy);
    if (!byCcy[ccy]) byCcy[ccy] = { count: 0, amount: 0 };
    byCcy[ccy].count += _repInt_(r.n); byCcy[ccy].amount += _repNum_(r.amt); total += _repInt_(r.n);
    return { status: r.st || '(none)', currency_code: ccy, count: _repInt_(r.n), amount: _repNum_(r.amt) };
  });

  return _repResult_({
    report:  'payments',
    title:   'Payments by status',
    columns: [
      { key: 'status',        label: 'Status',   type: 'text' },
      { key: 'currency_code', label: 'Currency', type: 'text' },
      { key: 'count',         label: 'Count',    type: 'number' },
      { key: 'amount',        label: 'Amount',   type: 'money' },
    ],
    rows:    rows,
    totals:  { count: total, by_currency: byCcy },
    summary: total + ' payment uploads. Value by currency: ' + _repCcyLine_(byCcy, 'amount') + '.',
    currency_note: 'Amounts are reported per currency and are never summed across currencies.',
    deepLink: { route: 'payments', params: _repPassFilters_(params, ['status']) },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Credit exposure (at or over credit limit)
// ════════════════════════════════════════════════════════════════════════════

function _repCreditExposure_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'customers.view');
  var scope = _repScope_(ctx.session);
  var sc    = _repClause_(scope, '');
  var threshold = parseFloat(params.threshold_percent);
  if (isNaN(threshold) || threshold <= 0) threshold = 100;

  var sql = 'SELECT customer_id, company_name, country_code, currency_code, credit_limit, credit_used ' +
            "FROM customers WHERE COALESCE(status,'') != 'INACTIVE' AND COALESCE(credit_limit,0) > 0 " +
            'AND COALESCE(credit_used,0) >= COALESCE(credit_limit,0) * ? / 100.0' + sc.clause;
  var args = [threshold].concat(sc.args);
  if (params.country_code) { sql += ' AND country_code = ?'; args.push(String(params.country_code)); }
  sql += ' ORDER BY (COALESCE(credit_used,0) / COALESCE(credit_limit,1)) DESC LIMIT ' + _repLimit_(params);

  var raw = TursoClient.select(sql, args);
  var byCcy = {};
  var rows = raw.map(function (r) {
    var limit = _repNum_(r.credit_limit), used = _repNum_(r.credit_used), ccy = _repCcy_(r.currency_code);
    var util = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;
    var over = Math.max(0, used - limit);
    if (!byCcy[ccy]) byCcy[ccy] = { count: 0, credit_used: 0, over_by: 0 };
    byCcy[ccy].count++; byCcy[ccy].credit_used += used; byCcy[ccy].over_by += over;
    return { company_name: r.company_name || r.customer_id, country_code: r.country_code || '',
             currency_code: ccy, credit_limit: limit, credit_used: used, utilization: util, over_by: over };
  });

  return _repResult_({
    report:  'credit_exposure',
    title:   'Credit exposure',
    columns: [
      { key: 'company_name', label: 'Customer',    type: 'text' },
      { key: 'country_code', label: 'Country',     type: 'text' },
      { key: 'currency_code',label: 'Currency',    type: 'text' },
      { key: 'credit_limit', label: 'Limit',       type: 'money' },
      { key: 'credit_used',  label: 'Used',        type: 'money' },
      { key: 'utilization',  label: 'Utilization', type: 'percent' },
      { key: 'over_by',      label: 'Over by',     type: 'money' },
    ],
    rows:    rows,
    totals:  { customers: rows.length, by_currency: byCcy },
    summary: rows.length + ' customers at or over ' + threshold + '% of limit. Exposure by currency: ' +
             _repCcyLine_(byCcy, 'credit_used') + '.',
    currency_note: 'Exposure is reported per currency and is never summed across currencies.',
    deepLink: { route: 'customers', params: {} },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Retention and churn (best effort over CRM tables)
// ════════════════════════════════════════════════════════════════════════════

function _repRetentionChurn_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'customers.view');
  var scope = _repScope_(ctx.session);

  var rows = [], total = 0;
  try {
    var dimCol = SchemaIntrospect.pick('churn_risk_factors',
      ['risk_level', 'severity', 'level', 'factor_type', 'category', 'risk_category']);
    var hasCust = SchemaIntrospect.has('churn_risk_factors', 'customer_id');
    var dimExpr = dimCol ? ('cf.' + dimCol) : "'All factors'";
    var sql = 'SELECT ' + dimExpr + ' AS dim, COUNT(*) AS n FROM churn_risk_factors cf';
    var args = [];
    if (hasCust && !scope.isGlobal && scope.countries.length) {
      var ph = scope.countries.map(function () { return '?'; }).join(',');
      sql += ' JOIN customers c ON c.customer_id = cf.customer_id WHERE c.country_code IN (' + ph + ')';
      args = scope.countries.slice();
    } else { sql += ' WHERE 1=1'; }
    sql += ' GROUP BY dim ORDER BY n DESC LIMIT ' + _repLimit_(params);
    var raw = TursoClient.select(sql, args);
    rows = raw.map(function (r) { total += _repInt_(r.n); return { dimension: r.dim || '(none)', count: _repInt_(r.n) }; });
  } catch (_) {}

  var retentionCount = 0;
  try {
    var dateCol = SchemaIntrospect.pick('retention_activities', ['created_at', 'activity_date', 'date']);
    if (dateCol) {
      var rc = TursoClient.select(
        "SELECT COUNT(*) AS n FROM retention_activities WHERE date(" + dateCol + ") >= date('now','-90 days')", []);
      retentionCount = rc.length ? _repInt_(rc[0].n) : 0;
    }
  } catch (_) {}

  return _repResult_({
    report:  'retention_churn',
    title:   'Retention and churn',
    columns: [
      { key: 'dimension', label: 'Risk factor', type: 'text' },
      { key: 'count',     label: 'Count',       type: 'number' },
    ],
    rows:    rows,
    totals:  { churn_factors: total, retention_activities_90d: retentionCount },
    summary: total + ' churn risk factors recorded. ' + retentionCount + ' retention activities in the last 90 days.',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT: Pricing (active price lists and items by tier)
// ════════════════════════════════════════════════════════════════════════════

function _repPricing_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');

  var nameCol  = SchemaIntrospect.pick('price_list', ['name', 'label', 'price_list_name', 'title']) || 'price_id';
  var statusCol= SchemaIntrospect.pick('price_list', ['status', 'is_active']);
  var ccyCol   = SchemaIntrospect.pick('price_list', ['currency_code', 'currency']);
  var countryCol = SchemaIntrospect.pick('price_list', ['country_code', 'country']);
  var hasDefault = SchemaIntrospect.has('price_list', 'is_default');
  var hasSegment = SchemaIntrospect.has('price_list', 'segment_id');
  var hasCustomer= SchemaIntrospect.has('price_list', 'customer_id');

  var sel = ['pl.price_id AS price_id', 'pl.' + nameCol + ' AS nm'];
  if (statusCol)  sel.push('pl.' + statusCol + ' AS status_val');
  if (ccyCol)     sel.push('pl.' + ccyCol + ' AS ccy');
  if (countryCol) sel.push('pl.' + countryCol + ' AS country');
  if (hasDefault) sel.push('pl.is_default AS is_default');
  if (hasSegment) sel.push('pl.segment_id AS segment_id');
  if (hasCustomer)sel.push('pl.customer_id AS customer_id');

  var sql = 'SELECT ' + sel.join(', ') +
            ', (SELECT COUNT(*) FROM price_list_items pli WHERE pli.price_list_id = pl.price_id) AS items ' +
            'FROM price_list pl ORDER BY items DESC LIMIT ' + _repLimit_(params);
  var raw = TursoClient.select(sql, []);

  function tierOf(r) {
    if (hasCustomer && r.customer_id) return 'customer';
    if (hasSegment && r.segment_id)   return 'segment';
    if (hasDefault && (String(r.is_default) === '1' || r.is_default === true)) return 'default';
    return 'default';
  }
  function statusOf(r) {
    if (!statusCol) return '';
    var v = r.status_val;
    if (statusCol === 'is_active') return (String(v) === '1' || v === true) ? 'ACTIVE' : 'INACTIVE';
    return String(v || '');
  }

  var byTier = { default: 0, segment: 0, customer: 0 };
  var rows = raw.map(function (r) {
    var tier = tierOf(r); byTier[tier] = (byTier[tier] || 0) + 1;
    return { name: r.nm || r.price_id, tier: tier, country_code: r.country || '',
             currency_code: _repCcy_(r.ccy), items: _repInt_(r.items), status: statusOf(r) };
  });

  return _repResult_({
    report:  'pricing',
    title:   'Price lists by tier',
    columns: [
      { key: 'name',          label: 'Price list', type: 'text' },
      { key: 'tier',          label: 'Tier',       type: 'text' },
      { key: 'country_code',  label: 'Country',    type: 'text' },
      { key: 'currency_code', label: 'Currency',   type: 'text' },
      { key: 'items',         label: 'Items',      type: 'number' },
      { key: 'status',        label: 'Status',     type: 'text' },
    ],
    rows:    rows,
    totals:  { lists: rows.length, by_tier: byTier },
    summary: rows.length + ' price lists. By tier - default: ' + (byTier.default || 0) +
             ', segment: ' + (byTier.segment || 0) + ', customer: ' + (byTier.customer || 0) + '.',
    deepLink: { route: 'pricing', params: {} },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CATALOG METADATA + reports.catalog (for the Reports page runner)
// ════════════════════════════════════════════════════════════════════════════

var _BOT_REPORTS_ = [
  { id: 'kyc',               title: 'KYC and compliance',  permission: 'customer.view',  handler: _repKyc_,
    params: [ { key: 'country_code', label: 'Country', type: 'text' },
              { key: 'segment_id', label: 'Segment', type: 'text' },
              { key: 'issue', label: 'Issue', type: 'select', options: ['any', 'missing', 'pending', 'expired', 'rejected', 'all'] } ] },
  { id: 'ordersByCriteria',  title: 'Orders report',       permission: 'order.view',     handler: _repOrders_,
    params: [ { key: 'status', label: 'Status', type: 'text' }, { key: 'country_code', label: 'Country', type: 'text' },
              { key: 'customer_id', label: 'Customer ID', type: 'text' }, { key: 'currency_code', label: 'Currency', type: 'text' },
              { key: 'from_date', label: 'From', type: 'date' }, { key: 'to_date', label: 'To', type: 'date' },
              { key: 'min_value', label: 'Min value', type: 'number' } ] },
  { id: 'receivablesAging',  title: 'Receivables aging',   permission: 'invoice.view',   handler: _repReceivables_,
    params: [ { key: 'country_code', label: 'Country', type: 'text' }, { key: 'customer_id', label: 'Customer ID', type: 'text' },
              { key: 'currency_code', label: 'Currency', type: 'text' } ] },
  { id: 'salesRevenue',      title: 'Sales and revenue',   permission: 'order.view',     handler: _repSales_,
    params: [ { key: 'group_by', label: 'Group by', type: 'select', options: ['month', 'country', 'segment', 'product'] },
              { key: 'country_code', label: 'Country', type: 'text' },
              { key: 'from_date', label: 'From', type: 'date' }, { key: 'to_date', label: 'To', type: 'date' } ] },
  { id: 'ticketSla',         title: 'Tickets and SLA',     permission: 'ticket.view',    handler: _repTicketSla_,
    params: [ { key: 'group_by', label: 'Group by', type: 'select', options: ['status', 'priority', 'team', 'agent'] },
              { key: 'country_code', label: 'Country', type: 'text' },
              { key: 'from_date', label: 'From', type: 'date' }, { key: 'to_date', label: 'To', type: 'date' } ] },
  { id: 'customerStatement', title: 'Customer statement',  permission: 'customers.view', handler: _repCustomerStatement_,
    params: [ { key: 'customerId', label: 'Customer ID', type: 'text', required: true } ] },
  { id: 'approvals',         title: 'Approvals',           permission: 'order.view',     handler: _repApprovals_,
    params: [ { key: 'overdue_days', label: 'Overdue days', type: 'number' } ] },
  { id: 'payments',          title: 'Payments',            permission: 'invoice.view',   handler: _repPayments_,
    params: [ { key: 'status', label: 'Status', type: 'text' } ] },
  { id: 'creditExposure',    title: 'Credit exposure',     permission: 'customers.view', handler: _repCreditExposure_,
    params: [ { key: 'country_code', label: 'Country', type: 'text' }, { key: 'threshold_percent', label: 'Threshold %', type: 'number' } ] },
  { id: 'retentionChurn',    title: 'Retention and churn', permission: 'customers.view', handler: _repRetentionChurn_,
    params: [] },
  { id: 'pricing',           title: 'Pricing',             permission: 'order.view',     handler: _repPricing_,
    params: [] },
];

/** Pass through only the named filter params (drop empties) for deep links. */
function _repPassFilters_(params, keys) {
  var out = {};
  (keys || []).forEach(function (k) {
    if (params && params[k] !== undefined && params[k] !== null && String(params[k]).length) out[k] = params[k];
  });
  return out;
}

/** reports.catalog -> the report definitions this caller is permitted to run. */
function _repCatalog_(ctx, params) {
  var userId = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || '';
  return _BOT_REPORTS_.filter(function (r) {
    return !r.permission || Rbac.userHasPermission(userId, r.permission);
  }).map(function (r) {
    return { id: r.id, title: r.title, permission: r.permission, params: r.params || [] };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════════════════════

(function _registerBotReports_() {
  register({ service: 'reports', action: 'catalog', permission: null, handler: _repCatalog_ });
  _BOT_REPORTS_.forEach(function (r) {
    register({ service: 'reports', action: r.id, permission: r.permission, handler: r.handler });
  });
})();
