/**
 * 40_svc_invoices.gs  —  Hass CMS rebuild  (Stage 8)
 *
 * Invoice and payment lifecycle:
 *   invoices.{list,get,generate,cancel}
 *   payments.{list,upload,approve,reject}
 *
 * invoice.generate creates an invoice from a DELIVERED order.
 * payment.upload records a payment proof (pending finance review).
 * Country scope enforced on all handlers.
 */

// ── Scope helper (shared pattern) ────────────────────────────────────────────

function _invoiceScopeData_(session) {
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

// ── invoice handlers ──────────────────────────────────────────────────────────

function _invoiceList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');
  var scope = _invoiceScopeData_(ctx.session);
  var sql   = 'SELECT i.*, c.company_name FROM invoices i ' +
              'LEFT JOIN customers c ON c.customer_id = i.customer_id WHERE 1=1';
  var args  = [];
  if (!scope.isGlobal) {
    if (!scope.countries.length) return [];
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND i.country_code IN (' + ph + ')';
    args = args.concat(scope.countries);
  }
  if (params.status)      { sql += ' AND i.status = ?';      args.push(params.status); }
  if (params.customer_id) { sql += ' AND i.customer_id = ?'; args.push(params.customer_id); }
  if (params.order_id)    { sql += ' AND i.order_id = ?';    args.push(params.order_id); }
  sql += ' ORDER BY i.issue_date DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

function _invoiceGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');
  var invoiceId = String(params.invoiceId || '');
  if (!invoiceId) throw new Errors.Validation('invoiceId required.');
  var rows = TursoClient.select(
    'SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1', [invoiceId]
  );
  if (!rows.length) throw new Errors.NotFound('Invoice not found.');
  var invoice = rows[0];
  var scope   = _invoiceScopeData_(ctx.session);
  if (!scope.isGlobal && scope.countries.indexOf(invoice.country_code) === -1) {
    throw new Errors.NotFound('Invoice not found.');
  }
  invoice.payments = TursoClient.select(
    'SELECT * FROM payment_uploads WHERE invoice_id = ? ORDER BY uploaded_at DESC',
    [invoiceId]
  );
  return invoice;
}

function _invoiceGenerate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.generate');
  var orderId = String(params.orderId || '');
  if (!orderId) throw new Errors.Validation('orderId required.');

  var orderRows = TursoClient.select(
    'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
  );
  if (!orderRows.length) throw new Errors.NotFound('Order not found.');
  var order = orderRows[0];

  var scope = _invoiceScopeData_(ctx.session);
  if (!scope.isGlobal && scope.countries.indexOf(order.country_code) === -1) {
    throw new Errors.NotFound('Order not found.');
  }
  if (order.status !== 'DELIVERED') {
    throw new Errors.Validation('Can only generate invoice for DELIVERED orders.');
  }

  // Prevent duplicate invoices.
  var existing = TursoClient.select(
    "SELECT invoice_id FROM invoices WHERE order_id = ? AND status != 'CANCELLED' LIMIT 1",
    [orderId]
  );
  if (existing.length) throw new Errors.Validation('Invoice already exists for this order.');

  var invoiceId     = genId('INV');
  var invoiceNumber = 'INV-' + String(order.country_code).toUpperCase() +
                      '-' + Date.now().toString(36).toUpperCase();
  var now           = nowIso();
  var dueDate       = addMinutes(new Date(), 30 * 24 * 60).toISOString().substring(0, 10); // 30 days

  // Compute amounts from the resolved order lines (the per-line rates set by
  // Pricing.resolve at order time) so the invoice always matches what was priced.
  var totals = Pricing.sumOrderLineTotals(orderId);
  // Safety net for any order created before per-line tax was stored: if the lines
  // carry no tax but the order header (kept in sync by the totals recompute) shows
  // tax above the subtotal, trust the header so legacy invoices are not understated.
  var headerTotal = parseFloat(order.total_amount || 0);
  if (totals.tax === 0 && totals.subtotal > 0 && headerTotal - totals.subtotal > 0.005) {
    totals = {
      subtotal: parseFloat(order.subtotal    || 0),
      tax:      parseFloat(order.tax_amount   || 0),
      total:    headerTotal,
    };
  }

  TursoClient.write(
    'INSERT INTO invoices ' +
    '(invoice_id, invoice_number, order_id, customer_id, country_code, ' +
    'subtotal, tax_amount, total_amount, currency_code, ' +
    'status, payment_status, due_date, issue_date, generated_by, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      invoiceId, invoiceNumber, orderId, order.customer_id, order.country_code,
      totals.subtotal,
      totals.tax,
      totals.total,
      String(order.currency_code   || 'KES'),
      'ISSUED', 'UNPAID',
      dueDate, now,
      ctx.session.userId,
      now, now,
    ]
  );

  // Mark order as invoiced.
  TursoClient.write(
    'UPDATE orders SET payment_status = ?, updated_at = ? WHERE order_id = ?',
    ['INVOICED', now, orderId]
  );

  Audit.log({
    actor: ctx.session.userId, action: 'INVOICE_GENERATED',
    entity: 'invoices', entityId: invoiceId,
    after: { invoice_number: invoiceNumber, order_id: orderId,
             total_amount: order.total_amount },
  });
  return { invoice_id: invoiceId, invoice_number: invoiceNumber, status: 'ISSUED', due_date: dueDate };
}

function _invoiceCancel_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.cancel');
  var invoiceId = String(params.invoiceId || '');
  var reason    = String(params.reason    || '').trim();
  if (!invoiceId) throw new Errors.Validation('invoiceId required.');
  if (!reason)    throw new Errors.Validation('reason required.');
  var rows = TursoClient.select(
    'SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1', [invoiceId]
  );
  if (!rows.length) throw new Errors.NotFound('Invoice not found.');
  var before = rows[0];
  var scope  = _invoiceScopeData_(ctx.session);
  if (!scope.isGlobal && scope.countries.indexOf(before.country_code) === -1) {
    throw new Errors.NotFound('Invoice not found.');
  }
  if (before.status === 'CANCELLED') throw new Errors.Validation('Invoice is already cancelled.');
  if (before.payment_status === 'PAID') throw new Errors.Validation('Cannot cancel a paid invoice.');

  var now = nowIso();
  TursoClient.write(
    'UPDATE invoices SET status = ?, cancelled_at = ?, cancelled_by = ?, ' +
    'cancellation_reason = ?, updated_at = ? WHERE invoice_id = ?',
    ['CANCELLED', now, ctx.session.userId, reason, now, invoiceId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'INVOICE_CANCELLED',
    entity: 'invoices', entityId: invoiceId,
    before: before, after: { status: 'CANCELLED', reason: reason },
  });
  return { success: true, status: 'CANCELLED' };
}

// ── payment handlers ──────────────────────────────────────────────────────────

function _paymentUpload_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.view');
  var invoiceId  = String(params.invoiceId   || '');
  var amount     = parseFloat(params.amount);
  var method     = String(params.payment_method || '').trim().toUpperCase();
  var reference  = String(params.reference      || '').trim();
  if (!invoiceId)         throw new Errors.Validation('invoiceId required.');
  if (isNaN(amount) || amount <= 0) throw new Errors.Validation('amount must be > 0.');
  if (!method)            throw new Errors.Validation('payment_method required.');
  if (!reference)         throw new Errors.Validation('reference required.');

  var rows = TursoClient.select(
    'SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1', [invoiceId]
  );
  if (!rows.length) throw new Errors.NotFound('Invoice not found.');
  var invoice = rows[0];
  var scope   = _invoiceScopeData_(ctx.session);
  if (!scope.isGlobal && scope.countries.indexOf(invoice.country_code) === -1) {
    throw new Errors.NotFound('Invoice not found.');
  }
  if (invoice.status === 'CANCELLED') throw new Errors.Validation('Cannot record payment for cancelled invoice.');

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
      method, reference,
      String(params.proof_url || ''),
      'PENDING_REVIEW',
      ctx.session.userId, now, now, now,
    ]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'PAYMENT_UPLOADED',
    entity: 'payment_uploads', entityId: uploadId,
    after: { invoice_id: invoiceId, amount: amount, payment_method: method },
  });
  return { upload_id: uploadId, status: 'PENDING_REVIEW' };
}

// INV-2 / INV-3 / INV-4: shared settlement. Sum every APPROVED upload for an
// invoice and move the invoice payment_status to PAID (the approved total covers
// the invoice total) or PARTIAL (some but not all), then move the linked order's
// payment_status in step so order-side reporting reflects the payment. The writes
// are HARD writes: a failed PAID write must SURFACE, never be swallowed into a
// false success (INV-4 preserved). The recompute is idempotent, so both the
// manual approve path and the M-Pesa reconcile JOB can call it safely. A missing
// invoice is a no-op (nothing to settle); only real write failures propagate.
function _settleInvoiceFromApprovedUploads_(invoiceId, actor) {
  if (!invoiceId) return null;
  var invRows = TursoClient.select(
    'SELECT invoice_id, order_id, total_amount FROM invoices WHERE invoice_id = ? LIMIT 1',
    [invoiceId]
  );
  if (!invRows.length) return null;
  var inv   = invRows[0];
  var total = parseFloat(inv.total_amount || 0);

  var sumRows = TursoClient.select(
    "SELECT COALESCE(SUM(amount), 0) AS paid FROM payment_uploads WHERE invoice_id = ? AND status = 'APPROVED'",
    [invoiceId]
  );
  var paid = parseFloat((sumRows.length && sumRows[0].paid) || 0);

  var now       = nowIso();
  var newStatus = (total > 0 && paid >= total) ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID');

  // Invoice write surfaces on failure (INV-4). PAID also stamps paid_at.
  if (newStatus === 'PAID') {
    TursoClient.write(
      'UPDATE invoices SET payment_status = ?, paid_at = ?, updated_at = ? WHERE invoice_id = ?',
      ['PAID', now, now, invoiceId]
    );
  } else {
    TursoClient.write(
      'UPDATE invoices SET payment_status = ?, updated_at = ? WHERE invoice_id = ?',
      [newStatus, now, invoiceId]
    );
  }

  // INV-3: reflect the payment on the linked order. Only advance it for a real
  // payment (PAID/PARTIAL); never downgrade an INVOICED order when nothing is
  // approved yet.
  if (inv.order_id && (newStatus === 'PAID' || newStatus === 'PARTIAL')) {
    TursoClient.write(
      'UPDATE orders SET payment_status = ?, updated_at = ? WHERE order_id = ?',
      [newStatus, now, inv.order_id]
    );
  }

  return { invoice_id: invoiceId, order_id: inv.order_id || null,
           paid: paid, total: total, payment_status: newStatus };
}

function _paymentApprove_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.generate');
  var uploadId = String(params.uploadId || '');
  if (!uploadId) throw new Errors.Validation('uploadId required.');
  var rows = TursoClient.select(
    'SELECT * FROM payment_uploads WHERE upload_id = ? LIMIT 1', [uploadId]
  );
  if (!rows.length) throw new Errors.NotFound('Payment not found.');
  var before = rows[0];
  if (before.status !== 'PENDING_REVIEW') throw new Errors.Validation('Only PENDING_REVIEW payments can be approved.');

  var now = nowIso();
  TursoClient.write(
    'UPDATE payment_uploads SET status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE upload_id = ?',
    ['APPROVED', ctx.session.userId, now, now, uploadId]
  );

  // INV-2 / INV-3 / INV-4: sum ALL approved uploads against the invoice total so
  // an invoice paid in two parts becomes PAID, move the linked order, and let any
  // write failure SURFACE so the money path can never report a false success.
  var settle = _settleInvoiceFromApprovedUploads_(before.invoice_id, ctx.session.userId);

  Audit.log({
    actor: ctx.session.userId, action: 'PAYMENT_APPROVED',
    entity: 'payment_uploads', entityId: uploadId,
    before: before,
    after: { status: 'APPROVED', reviewed_by: ctx.session.userId,
             invoice_payment_status: settle && settle.payment_status },
  });
  // NOT-2 / INV-3: notify the customer contact and the uploader through the
  // step-1 emit path (Notify.emit -> notifications queue -> flush job).
  // Best-effort: the payment is already approved and the invoice/order already
  // settled, so a notification failure can never undo or block that.
  try {
    var payVars = { amount: before.amount, currency_code: before.currency_code,
                    invoice_id: before.invoice_id, upload_id: uploadId,
                    payment_status: settle && settle.payment_status };
    Notify.emit({
      recipient_id: before.customer_id, recipient_type: 'CUSTOMER',
      channel: 'EMAIL', event_key: 'PAYMENT_APPROVED', vars: payVars,
      subject: 'Payment approved',
      body:    'Your payment of ' + before.amount + ' ' + (before.currency_code || '') + ' has been approved.',
      entity_type: 'payment_uploads', entity_id: uploadId,
    });
    Notify.emit({
      recipient_id: before.uploaded_by, recipient_type: 'STAFF',
      channel: 'EMAIL', event_key: 'PAYMENT_APPROVED', vars: payVars,
      subject: 'Payment approved: ' + uploadId,
      body:    'Payment ' + uploadId + ' (' + before.amount + ' ' + (before.currency_code || '') + ') has been approved.',
      entity_type: 'payment_uploads', entity_id: uploadId,
    });
  } catch (_) {}
  return { success: true, status: 'APPROVED',
           invoice_payment_status: settle && settle.payment_status };
}

function _paymentReject_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.generate');
  var uploadId = String(params.uploadId || '');
  var reason   = String(params.reason   || '').trim();
  if (!uploadId) throw new Errors.Validation('uploadId required.');
  if (!reason)   throw new Errors.Validation('reason required.');
  var rows = TursoClient.select(
    'SELECT * FROM payment_uploads WHERE upload_id = ? LIMIT 1', [uploadId]
  );
  if (!rows.length) throw new Errors.NotFound('Payment not found.');
  var before = rows[0];
  if (before.status !== 'PENDING_REVIEW') throw new Errors.Validation('Only PENDING_REVIEW payments can be rejected.');

  var now = nowIso();
  TursoClient.write(
    'UPDATE payment_uploads SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE upload_id = ?',
    ['REJECTED', reason, ctx.session.userId, now, now, uploadId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'PAYMENT_REJECTED',
    entity: 'payment_uploads', entityId: uploadId,
    before: before, after: { status: 'REJECTED', reason: reason },
  });
  return { success: true, status: 'REJECTED' };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerInvoices_() {
  register({ service: 'invoices', action: 'list',     permission: 'invoice.view',     handler: _invoiceList_ });
  register({ service: 'invoices', action: 'get',      permission: 'invoice.view',     handler: _invoiceGet_ });
  register({ service: 'invoices', action: 'generate', permission: 'invoice.generate', handler: _invoiceGenerate_ });
  register({ service: 'invoices', action: 'cancel',   permission: 'invoice.cancel',   handler: _invoiceCancel_ });

  register({ service: 'payments', action: 'upload',  permission: 'invoice.view',     handler: _paymentUpload_ });
  register({ service: 'payments', action: 'approve', permission: 'invoice.generate', handler: _paymentApprove_ });
  register({ service: 'payments', action: 'reject',  permission: 'invoice.generate', handler: _paymentReject_ });
})();
