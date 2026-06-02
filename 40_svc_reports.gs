/**
 * 40_svc_reports.gs  —  Hass CMS rebuild
 *
 * Minimal aggregate report for the Reports dashboard page.
 *
 *   reports.summary → headline counts across the main domain tables.
 *
 * Reuses the country-scope helpers defined in 40_svc_dashboard.gs.
 */

function _reportsSummary_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _dashScopeData_(ctx.session);
  var sc    = _dashScopeClause_(scope, '');

  function count(sql, args) {
    var r = TursoClient.select(sql, args || []);
    return (r.length && r[0].n !== undefined && r[0].n !== null) ? parseInt(r[0].n, 10) : 0;
  }

  var customers = count(
    'SELECT COUNT(*) AS n FROM customers WHERE 1=1' + sc.clause, sc.args
  );
  var openTickets = count(
    "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('NEW','OPEN')" + sc.clause, sc.args
  );
  var pendingApprovals = count(
    "SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'PENDING'" + sc.clause, sc.args
  );
  var unpaidInvoices = count(
    "SELECT COUNT(*) AS n FROM invoices WHERE payment_status = 'UNPAID' AND status != 'CANCELLED'" + sc.clause, sc.args
  );
  // payment_uploads has no country_code; count globally for pending review.
  var pendingPayments = count(
    "SELECT COUNT(*) AS n FROM payment_uploads WHERE status IN ('PENDING','PENDING_REVIEW')", []
  );

  return {
    customers:         customers,
    open_tickets:      openTickets,
    pending_approvals: pendingApprovals,
    unpaid_invoices:   unpaidInvoices,
    pending_payments:  pendingPayments,
  };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerReports_() {
  register({ service: 'reports', action: 'summary', permission: 'order.view', handler: _reportsSummary_ });
})();
