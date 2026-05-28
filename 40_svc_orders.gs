/**
 * 40_svc_orders.gs  —  Hass CMS rebuild  (Stage 6)
 *
 * Exposes global Orders = { ... } for handler functions.
 * Registers orders.* actions with the Dispatcher.
 *
 * Status flow:
 *   DRAFT → SUBMITTED → APPROVED → PROCESSING → DISPATCHED → DELIVERED
 *                    ↘ REJECTED (from SUBMITTED)
 *   Any → CANCELLED (by CS_MANAGER or above, from DRAFT/SUBMITTED)
 *
 * Row-level scope: GLOBAL roles see all; COUNTRY roles see countryCode + countries_access.
 * SoD: approver ≠ creator for any approve action.
 * Audit: every mutation logs before/after.
 */

var Orders = (function () {

  // ── Status flow ──────────────────────────────────────────────────────────────

  var _STATUS_FLOW_ = {
    DRAFT:      ['SUBMITTED', 'CANCELLED'],
    SUBMITTED:  ['APPROVED', 'REJECTED', 'CANCELLED'],
    APPROVED:   ['PROCESSING', 'CANCELLED'],
    PROCESSING: ['DISPATCHED', 'CANCELLED'],
    DISPATCHED: ['DELIVERED'],
    DELIVERED:  [],
    REJECTED:   [],
    CANCELLED:  [],
  };

  // ── Scope helpers ─────────────────────────────────────────────────────────────

  function _scopeData_(session) {
    if (!session) return { isGlobal: false, countries: [] };
    var isGlobal = false;
    try {
      var r = TursoClient.select(
        'SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [session.role || '']
      );
      isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
    } catch (_) {}
    if (isGlobal) return { isGlobal: true, countries: [] };
    var countries = [];
    var cc = String(session.countryCode || '').trim();
    if (cc) countries.push(cc);
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

  function _countryFilter_(scope) {
    if (scope.isGlobal) return { clause: '', args: [] };
    if (!scope.countries.length) return { clause: 'AND 1=0', args: [] };
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    return { clause: 'AND o.country_code IN (' + ph + ')', args: scope.countries.slice() };
  }

  function _assertOrderScope_(row, session, scope) {
    if (!row) throw new Errors.NotFound('Order not found.');
    if (scope.isGlobal) return;
    if (scope.countries.indexOf(row.country_code) === -1) {
      Audit.log({
        actor: session.userId, action: 'ORDER_SCOPE_REJECTED',
        entity: 'orders', entityId: row.order_id,
        metadata: { country_code: row.country_code, session_country: session.countryCode },
      });
      throw new Errors.NotFound('Order not found.');
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────────────

  function _recalculateTotals_(orderId) {
    var lines = TursoClient.select(
      'SELECT line_subtotal FROM order_lines WHERE order_id = ?', [orderId]
    );
    var subtotal = lines.reduce(function (s, l) {
      return s + (parseFloat(l.line_subtotal) || 0);
    }, 0);
    var taxRate = 0.16; // VAT
    var tax     = Math.round(subtotal * taxRate * 100) / 100;
    var total   = Math.round((subtotal + tax) * 100) / 100;
    TursoClient.write(
      'UPDATE orders SET subtotal = ?, tax_amount = ?, total_amount = ?, updated_at = ? WHERE order_id = ?',
      [subtotal, tax, total, nowIso(), orderId]
    );
  }

  // ── list ──────────────────────────────────────────────────────────────────────

  function _listHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.view');
    var scope  = _scopeData_(ctx.session);
    var cf     = _countryFilter_(scope);
    var sql    = 'SELECT o.*, c.company_name FROM orders o ' +
                 'LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE 1=1 ' + cf.clause;
    var args   = cf.args.slice();
    if (params.status)       { sql += ' AND o.status = ?';       args.push(params.status); }
    if (params.customer_id)  { sql += ' AND o.customer_id = ?';  args.push(params.customer_id); }
    if (params.country_code) { sql += ' AND o.country_code = ?'; args.push(params.country_code); }
    if (params.from_date)    { sql += ' AND o.created_at >= ?';  args.push(params.from_date); }
    if (params.to_date)      { sql += ' AND o.created_at <= ?';  args.push(params.to_date); }
    sql += ' ORDER BY o.created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
    if (params.offset) sql += ' OFFSET ' + parseInt(params.offset, 10);
    return TursoClient.select(sql, args);
  }

  // ── get ───────────────────────────────────────────────────────────────────────

  function _getHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.view');
    var orderId = String(params.orderId || '');
    if (!orderId) throw new Errors.Validation('orderId required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    order.lines = TursoClient.select(
      'SELECT ol.*, p.name AS product_name FROM order_lines ol ' +
      'LEFT JOIN products p ON p.product_id = ol.product_id ' +
      'WHERE ol.order_id = ? ORDER BY ol.created_at',
      [orderId]
    );
    order.history = TursoClient.select(
      'SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at DESC',
      [orderId]
    );
    return order;
  }

  // ── create ────────────────────────────────────────────────────────────────────

  function _createHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.create');

    var customerId = String(params.customer_id || '');
    if (!customerId) throw new Errors.Validation('customer_id required.');

    var custRows = TursoClient.select(
      'SELECT customer_id, company_name, country_code, currency_code, status FROM customers WHERE customer_id = ? LIMIT 1',
      [customerId]
    );
    if (!custRows.length) throw new Errors.NotFound('Customer not found.');
    var customer = custRows[0];
    if (String(customer.status || '').toUpperCase() !== 'ACTIVE') {
      throw new Errors.Validation('Customer is not active.');
    }

    var scope = _scopeData_(ctx.session);
    if (!scope.isGlobal && scope.countries.indexOf(customer.country_code) === -1) {
      throw new Errors.NotFound('Customer not found.');
    }

    var orderId     = genId('ORD');
    var orderNumber = 'ORD-' + String(customer.country_code).toUpperCase() +
                      '-' + Date.now().toString(36).toUpperCase();
    var now         = nowIso();

    TursoClient.write(
      'INSERT INTO orders ' +
      '(order_id, order_number, oracle_order_id, customer_id, contact_id, ' +
      'delivery_location_id, source_depot_id, price_list_id, ' +
      'requested_date, confirmed_date, status, payment_status, ' +
      'subtotal, tax_amount, delivery_fee, discount_amount, total_amount, currency_code, ' +
      'special_instructions, po_number, is_recurring, recurring_schedule_id, ' +
      'created_by_type, created_by_id, country_code, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,0,0,?,?,?,?,?,?,?,?,?,?)',
      [
        orderId, orderNumber, '',
        customerId,
        String(params.contact_id           || ''),
        String(params.delivery_location_id  || ''),
        String(params.source_depot_id       || ''),
        String(params.price_list_id         || ''),
        params.requested_date || null,
        null, // confirmed_date
        'DRAFT', 'PENDING',
        parseFloat(params.delivery_fee) || 0,
        String(customer.currency_code   || 'KES'),
        String(params.special_instructions || ''),
        String(params.po_number            || ''),
        params.is_recurring ? 1 : 0,
        String(params.recurring_schedule_id || ''),
        ctx.session.userType,
        ctx.session.userId,
        customer.country_code,
        now, now,
      ]
    );

    // Add lines if provided.
    if (Array.isArray(params.lines) && params.lines.length) {
      params.lines.forEach(function (line) {
        _addLine_(orderId, line, ctx.session.userId);
      });
      _recalculateTotals_(orderId);
    }

    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_CREATED',
      entity: 'orders', entityId: orderId,
      after: { order_number: orderNumber, customer_id: customerId,
               country_code: customer.country_code },
    });
    return { order_id: orderId, order_number: orderNumber, status: 'DRAFT' };
  }

  function _addLine_(orderId, line, actorId) {
    var lineId    = genId('LIN');
    var quantity  = parseFloat(line.quantity)   || 0;
    var unitPrice = parseFloat(line.unit_price) || 0;
    var discount  = parseFloat(line.discount_percent) || 0;
    var subtotal  = Math.round(quantity * unitPrice * (1 - discount / 100) * 100) / 100;
    var now       = nowIso();
    TursoClient.write(
      'INSERT INTO order_lines ' +
      '(line_id, order_id, product_id, product_name, quantity, unit_price, ' +
      'discount_percent, line_subtotal, delivered_quantity, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,0,?,?)',
      [
        lineId, orderId,
        String(line.product_id   || ''),
        String(line.product_name || ''),
        quantity, unitPrice, discount, subtotal,
        now, now,
      ]
    );
    return lineId;
  }

  // ── addLine ───────────────────────────────────────────────────────────────────

  function _addLineHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.create');
    var orderId = String(params.orderId || '');
    if (!orderId) throw new Errors.Validation('orderId required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (['DELIVERED', 'CANCELLED', 'REJECTED'].indexOf(order.status) !== -1) {
      throw new Errors.Validation('Cannot add lines to an order in status ' + order.status + '.');
    }
    var lineId = _addLine_(orderId, params, ctx.session.userId);
    _recalculateTotals_(orderId);
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_LINE_ADDED',
      entity: 'orders', entityId: orderId,
      after: { line_id: lineId, product_id: params.product_id },
    });
    return { line_id: lineId };
  }

  // ── submit ────────────────────────────────────────────────────────────────────

  function _submitHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.create');
    var orderId = String(params.orderId || '');
    if (!orderId) throw new Errors.Validation('orderId required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (order.status !== 'DRAFT') throw new Errors.Validation('Only DRAFT orders can be submitted.');

    var lineCount = TursoClient.select(
      'SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?', [orderId]
    );
    if (!lineCount.length || parseInt(lineCount[0].n, 10) === 0) {
      throw new Errors.Validation('Order must have at least one line before submission.');
    }

    var now = nowIso();
    TursoClient.write(
      'UPDATE orders SET status = ?, submitted_at = ?, updated_at = ? WHERE order_id = ?',
      ['SUBMITTED', now, now, orderId]
    );
    _recordStatusHistory_(orderId, 'DRAFT', 'SUBMITTED', ctx.session.userId, '');
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_SUBMITTED',
      entity: 'orders', entityId: orderId,
      before: { status: 'DRAFT' }, after: { status: 'SUBMITTED' },
    });
    return { success: true, status: 'SUBMITTED' };
  }

  // ── approve ───────────────────────────────────────────────────────────────────

  function _approveHandler_(ctx, params) {
    var orderId = String(params.orderId || '');
    if (!orderId) throw new Errors.Validation('orderId required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (order.status !== 'SUBMITTED') throw new Errors.Validation('Only SUBMITTED orders can be approved.');

    // SoD: approver must not be the creator.
    if (order.created_by_id === ctx.session.userId) {
      throw new Errors.PermissionDenied('Order creator cannot approve their own order.');
    }

    // Amount-tiered permission check.
    var amount   = parseFloat(order.total_amount) || 0;
    var currency = String(order.currency_code || 'KES').toUpperCase();
    // Simple KES threshold; expand with FX rates for non-KES currencies if needed.
    var perm;
    if (amount <= 100000)       perm = 'order.approve_low';
    else if (amount <= 1000000) perm = 'order.approve_mid';
    else                        perm = 'order.approve_high';
    Rbac.requirePermission(ctx.session, perm);

    var now = nowIso();
    TursoClient.write(
      'UPDATE orders SET status = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE order_id = ?',
      ['APPROVED', now, ctx.session.userId, now, orderId]
    );
    _recordStatusHistory_(orderId, 'SUBMITTED', 'APPROVED', ctx.session.userId, String(params.notes || ''));
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_APPROVED',
      entity: 'orders', entityId: orderId,
      before: { status: 'SUBMITTED' }, after: { status: 'APPROVED', approved_by: ctx.session.userId },
    });
    return { success: true, status: 'APPROVED' };
  }

  // ── reject ────────────────────────────────────────────────────────────────────

  function _rejectHandler_(ctx, params) {
    var orderId = String(params.orderId || '');
    var reason  = String(params.reason  || '').trim();
    if (!orderId) throw new Errors.Validation('orderId required.');
    if (!reason)  throw new Errors.Validation('reason required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (order.status !== 'SUBMITTED') throw new Errors.Validation('Only SUBMITTED orders can be rejected.');
    if (order.created_by_id === ctx.session.userId) {
      throw new Errors.PermissionDenied('Order creator cannot reject their own order.');
    }
    Rbac.requirePermission(ctx.session, 'order.approve_low');

    var now = nowIso();
    TursoClient.write(
      'UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?',
      ['REJECTED', now, orderId]
    );
    _recordStatusHistory_(orderId, 'SUBMITTED', 'REJECTED', ctx.session.userId, reason);
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_REJECTED',
      entity: 'orders', entityId: orderId,
      before: { status: 'SUBMITTED' }, after: { status: 'REJECTED', reason: reason },
    });
    return { success: true, status: 'REJECTED' };
  }

  // ── cancel ─────────────────────────────────────────────────────────────────────

  function _cancelHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.cancel');
    var orderId = String(params.orderId || '');
    var reason  = String(params.reason  || '').trim();
    if (!orderId) throw new Errors.Validation('orderId required.');
    if (!reason)  throw new Errors.Validation('reason required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (['DELIVERED', 'CANCELLED', 'REJECTED'].indexOf(order.status) !== -1) {
      throw new Errors.Validation('Cannot cancel order in status ' + order.status + '.');
    }

    var now = nowIso();
    TursoClient.write(
      'UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?',
      ['CANCELLED', now, orderId]
    );
    _recordStatusHistory_(orderId, order.status, 'CANCELLED', ctx.session.userId, reason);
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_CANCELLED',
      entity: 'orders', entityId: orderId,
      before: { status: order.status }, after: { status: 'CANCELLED', reason: reason },
    });
    return { success: true, status: 'CANCELLED' };
  }

  // ── dispatch ──────────────────────────────────────────────────────────────────

  function _dispatchHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.dispatch');
    var orderId = String(params.orderId || '');
    if (!orderId) throw new Errors.Validation('orderId required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (order.status !== 'APPROVED') throw new Errors.Validation('Only APPROVED orders can be dispatched.');

    var now = nowIso();
    TursoClient.write(
      'UPDATE orders SET status = ?, dispatched_at = ?, updated_at = ? WHERE order_id = ?',
      ['DISPATCHED', now, now, orderId]
    );
    _recordStatusHistory_(orderId, 'APPROVED', 'DISPATCHED', ctx.session.userId, String(params.notes || ''));
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_DISPATCHED',
      entity: 'orders', entityId: orderId,
      before: { status: 'APPROVED' }, after: { status: 'DISPATCHED' },
    });
    return { success: true, status: 'DISPATCHED' };
  }

  // ── confirmDelivery ────────────────────────────────────────────────────────────

  function _confirmDeliveryHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.confirm_delivery');
    var orderId = String(params.orderId || '');
    if (!orderId) throw new Errors.Validation('orderId required.');
    var rows = TursoClient.select(
      'SELECT * FROM orders WHERE order_id = ? LIMIT 1', [orderId]
    );
    var scope = _scopeData_(ctx.session);
    _assertOrderScope_(rows[0] || null, ctx.session, scope);
    var order = rows[0];
    if (order.status !== 'DISPATCHED') throw new Errors.Validation('Only DISPATCHED orders can be confirmed.');

    var now = nowIso();
    TursoClient.write(
      'UPDATE orders SET status = ?, delivered_at = ?, updated_at = ? WHERE order_id = ?',
      ['DELIVERED', now, now, orderId]
    );
    _recordStatusHistory_(orderId, 'DISPATCHED', 'DELIVERED', ctx.session.userId, String(params.notes || ''));
    Audit.log({
      actor: ctx.session.userId, action: 'ORDER_DELIVERED',
      entity: 'orders', entityId: orderId,
      before: { status: 'DISPATCHED' }, after: { status: 'DELIVERED' },
    });
    return { success: true, status: 'DELIVERED' };
  }

  // ── status history helper ──────────────────────────────────────────────────────

  function _recordStatusHistory_(orderId, fromStatus, toStatus, actorId, notes) {
    try {
      TursoClient.write(
        'INSERT INTO order_status_history ' +
        '(history_id, order_id, from_status, to_status, changed_by, notes, created_at) ' +
        'VALUES (?,?,?,?,?,?,?)',
        [genId('OSH'), orderId, fromStatus, toStatus, actorId, notes || '', nowIso()]
      );
    } catch (_) {}
  }

  return {
    _listHandler_:           _listHandler_,
    _getHandler_:            _getHandler_,
    _createHandler_:         _createHandler_,
    _addLineHandler_:        _addLineHandler_,
    _submitHandler_:         _submitHandler_,
    _approveHandler_:        _approveHandler_,
    _rejectHandler_:         _rejectHandler_,
    _cancelHandler_:         _cancelHandler_,
    _dispatchHandler_:       _dispatchHandler_,
    _confirmDeliveryHandler_: _confirmDeliveryHandler_,
  };

})();

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerOrders_() {
  register({ service: 'orders', action: 'list',            permission: 'order.view',             handler: Orders._listHandler_ });
  register({ service: 'orders', action: 'get',             permission: 'order.view',             handler: Orders._getHandler_ });
  register({ service: 'orders', action: 'create',          permission: 'order.create',           handler: Orders._createHandler_ });
  register({ service: 'orders', action: 'addLine',         permission: 'order.create',           handler: Orders._addLineHandler_ });
  register({ service: 'orders', action: 'submit',          permission: 'order.create',           handler: Orders._submitHandler_ });
  register({ service: 'orders', action: 'approve',         permission: 'order.approve_low',      handler: Orders._approveHandler_ });
  register({ service: 'orders', action: 'reject',          permission: 'order.approve_low',      handler: Orders._rejectHandler_ });
  register({ service: 'orders', action: 'cancel',          permission: 'order.cancel',           handler: Orders._cancelHandler_ });
  register({ service: 'orders', action: 'dispatch',        permission: 'order.dispatch',         handler: Orders._dispatchHandler_ });
  register({ service: 'orders', action: 'confirmDelivery', permission: 'order.confirm_delivery', handler: Orders._confirmDeliveryHandler_ });
})();
