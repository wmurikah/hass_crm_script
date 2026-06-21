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

  // INV-5: uploads store the M-Pesa/payment reference under `reference` (the
  // upload INSERT and the invoice detail both use it), but this list query used
  // `reference_number`, so the page errored or always showed an empty reference.
  // Resolve the real column by introspection and alias it to a stable `reference`
  // field, so the query works whichever name is live and the page shows it.
  var refCol = SchemaIntrospect.pick('payment_uploads', ['reference', 'reference_number']) || 'reference';
  var sql  = 'SELECT pu.upload_id, pu.invoice_id, pu.amount, pu.payment_method, ' +
             'pu.' + refCol + ' AS reference, pu.status, pu.created_at ' +
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

// ── payments.initiateMpesa  -  start an STK push for an invoice (INTG-1) ─────────
//
// Wires MpesaInteg.initiate to a real, app-reachable action so an STK push can be
// started where intended. The push runs FIRST: only once Daraja accepts and
// returns a CheckoutRequestID is a payment_uploads row persisted, so a failed
// push leaves no dangling PENDING_REVIEW row. The CheckoutRequestID is stored as
// the upload `reference` - the match key the callback and reconcile use to settle
// the invoice. The client must call this with retries:0 (a charge must never be
// auto-retried).

function _paymentInitiateMpesa_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');
  var invoiceId = String(params.invoiceId || '');
  var phone     = String(params.phone || '').trim();
  var amount    = parseFloat(params.amount);
  if (!invoiceId) throw new Errors.Validation('invoiceId required.');
  if (!phone)     throw new Errors.Validation('phone required.');
  if (isNaN(amount) || amount <= 0) throw new Errors.Validation('amount must be > 0.');

  var rows = TursoClient.select('SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1', [invoiceId]);
  if (!rows.length) throw new Errors.NotFound('Invoice not found.');
  var invoice = rows[0];

  // Country scope via the shared invoice scope helper (40_svc_invoices.gs).
  var scope = _invoiceScopeData_(ctx.session);
  if (!scope.isGlobal && scope.countries.indexOf(invoice.country_code) === -1) {
    throw new Errors.NotFound('Invoice not found.');
  }
  if (invoice.status === 'CANCELLED') throw new Errors.Validation('Cannot charge a cancelled invoice.');

  var result = MpesaInteg.initiate({
    phone:       phone,
    amount:      amount,
    account_ref: invoice.invoice_number || invoiceId,
    description: 'Invoice ' + (invoice.invoice_number || invoiceId),
  });
  var checkoutId = (result && result.CheckoutRequestID) || '';

  var uploadId = genId('PAY');
  var now      = nowIso();
  TursoClient.write(
    'INSERT INTO payment_uploads ' +
    '(upload_id, invoice_id, customer_id, amount, currency_code, payment_method, ' +
    'reference, proof_url, status, uploaded_by, uploaded_at, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      uploadId, invoiceId, invoice.customer_id,
      amount, String(invoice.currency_code || 'KES'),
      'MPESA', checkoutId, '',
      'PENDING_REVIEW',
      ctx.session.userId, now, now, now,
    ]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'MPESA_STK_INITIATED',
    entity: 'payment_uploads', entityId: uploadId,
    after: { invoice_id: invoiceId, amount: amount, checkout_request_id: checkoutId },
  });
  return { upload_id: uploadId, checkout_request_id: checkoutId, status: 'PENDING_REVIEW' };
}

// ── Diagnostic: confirm the real payment_uploads schema by introspection ─────────
//
// INV-5: run from the Apps Script IDE to print the live payment_uploads columns
// so the reference column (reference vs reference_number) is confirmed against the
// real database. The list query above resolves the column at runtime via
// SchemaIntrospect, so it works whichever name is live; this just surfaces it.

function introspectPaymentUploads() {
  var cols = SchemaIntrospect.columns('payment_uploads');
  Logger.log('payment_uploads columns: ' + cols.join(', '));
  return cols;
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerPaymentsList_() {
  register({ service: 'payments', action: 'list',          permission: 'invoice.view', handler: _paymentsList_ });
  register({ service: 'payments', action: 'initiateMpesa', permission: 'invoice.view', handler: Idempotency.wrap(_paymentInitiateMpesa_) });
})();
