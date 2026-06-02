/**
 * 40_svc_payments.gs  —  Hass CMS rebuild
 *
 * Payments list endpoint for the Payments dashboard page. The upload/approve/
 * reject actions live in 40_svc_invoices.gs; this adds the missing list action
 * that reads the real payment_uploads table.
 *
 *   payments.list → recent payment uploads (country-scoped via the linked invoice)
 */

function _paymentsList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');

  // payment_uploads has no country_code of its own; scope through the invoice.
  var isGlobal = false;
  try {
    var r = TursoClient.select(
      'SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [ (ctx.session && ctx.session.role) || '' ]
    );
    isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
  } catch (_) {}

  var countries = [];
  if (!isGlobal) {
    countries = [String((ctx.session && ctx.session.countryCode) || '').trim()].filter(Boolean);
    try {
      var u = TursoClient.select(
        'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1', [ctx.session.userId]
      );
      if (u.length && u[0].countries_access) {
        String(u[0].countries_access).split(',').forEach(function (c) {
          var t = c.trim();
          if (t && countries.indexOf(t) === -1) countries.push(t);
        });
      }
    } catch (_) {}
  }

  var sql  = 'SELECT pu.upload_id, pu.invoice_id, pu.amount, pu.payment_method, ' +
             'pu.reference_number, pu.status, pu.created_at ' +
             'FROM payment_uploads pu ' +
             'LEFT JOIN invoices i ON i.invoice_id = pu.invoice_id WHERE 1=1';
  var args = [];
  if (!isGlobal) {
    if (!countries.length) return [];
    var ph = countries.map(function () { return '?'; }).join(',');
    sql += ' AND i.country_code IN (' + ph + ')';
    args = args.concat(countries);
  }
  if (params.status) { sql += ' AND pu.status = ?'; args.push(params.status); }
  sql += ' ORDER BY pu.created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerPaymentsList_() {
  register({ service: 'payments', action: 'list', permission: 'invoice.view', handler: _paymentsList_ });
})();
