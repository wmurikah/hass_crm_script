/**
 * 40_svc_approvals.gs  -  Hass CMS rebuild  (Stage 9, unified)
 *
 * Unified approvals inbox and action endpoints.
 *
 * UNIFICATION (APR-1/APR-2/APR-3): orders already approve through an inline path
 * (orders.approve / orders.reject) that is the single source of truth for an
 * order's status and the only place the amount tiers + SoD are enforced. This
 * service therefore does NOT maintain a parallel approval_requests decision
 * path (which had no producer and always read empty). Instead it:
 *   - surfaces the REAL pending backlog: orders in SUBMITTED awaiting their tier
 *     approval, scoped to the caller's country; and
 *   - routes approve/reject straight to the SAME order handlers the inline path
 *     uses, so there is exactly one decision point and the decision updates the
 *     order (APPROVED / REJECTED), never just a request row.
 *
 * The approval_requests / approval_workflows tables are intentionally left
 * unused here: the order state machine is the driver and audit_log is the
 * decision log. Introspection (documented in the PR) found no other
 * approval-bearing pending state to surface: credit-limit change, customer
 * onboarding and price overrides are all direct, immediately-applied actions in
 * this codebase, not gated work items, so there is nothing pending to queue for
 * them. If such a gated path is added later, surface it here too and route it
 * through its own inline handler the same way.
 *
 * Registered under the `approvalRequests.*` service (client route id `approvals`
 * in partial_approvals.html). Service keys and permissions are unchanged.
 *
 * Country scope enforced: GLOBAL roles see all; COUNTRY roles see their scope.
 * SoD and the amount tiers are enforced by the order handlers, unchanged.
 */

// ── Scope helper ──────────────────────────────────────────────────────────────

function _approvalScopeData_(session) {
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

// Country clause for the orders table (alias `o`), mirroring the orders service.
function _approvalOrderScopeClause_(scope) {
  if (scope.isGlobal) return { clause: '', args: [] };
  if (!scope.countries.length) return { clause: ' AND 1=0', args: [] };
  var ph = scope.countries.map(function () { return '?'; }).join(',');
  return { clause: ' AND o.country_code IN (' + ph + ')', args: scope.countries.slice() };
}

// The amount-tier permission an order needs, identical to _approveHandler_'s
// thresholds in 40_svc_orders.gs. Tiers are NOT changed here, only read so the
// inbox can show which items the caller can act on.
function _approvalOrderTierPerm_(order) {
  var amount = parseFloat(order.total_amount) || 0;
  if (amount <= 100000)       return 'order.approve_low';
  else if (amount <= 1000000) return 'order.approve_mid';
  else                        return 'order.approve_high';
}

// Shape a raw order row into the approval-item the UI expects. request_id maps to
// the order_id so the existing approve/reject/get calls act on the order.
function _approvalOrderToItem_(o, callerPerms) {
  var perm       = _approvalOrderTierPerm_(o);
  var actionable = callerPerms.indexOf('*') !== -1 || callerPerms.indexOf(perm) !== -1;
  return {
    request_id:             o.order_id,
    entity_type:            'ORDER',
    entity_id:              o.order_id,
    order_number:           o.order_number || o.order_id,
    amount:                 parseFloat(o.total_amount) || 0,
    currency_code:          o.currency_code || 'KES',
    country_code:           o.country_code || '',
    company_name:           o.company_name || '',
    required_approver_role: perm,
    status:                 o.status,
    submitted_by:           o.created_by_id || '',
    actionable:             actionable,
    created_at:             o.submitted_at || o.created_at || '',
  };
}

// ── inbox: real pending approvals actionable by the caller ────────────────────
//
// SUBMITTED orders in the caller's scope, excluding the caller's own orders
// (SoD: an approver may not approve what they created) and limited to the tiers
// the caller is actually permitted to approve. This is the actionable queue.

function _approvalsInbox_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.approve_low');
  var scope = _approvalScopeData_(ctx.session);
  var sc    = _approvalOrderScopeClause_(scope);
  var sql   = 'SELECT o.*, c.company_name FROM orders o ' +
              'LEFT JOIN customers c ON c.customer_id = o.customer_id ' +
              "WHERE o.status = 'SUBMITTED'" + sc.clause +
              ' AND (o.created_by_id IS NULL OR o.created_by_id != ?)' +
              ' ORDER BY COALESCE(o.submitted_at, o.created_at) ASC LIMIT ' +
              (parseInt(params.limit, 10) || 50);
  var args  = sc.args.concat([ctx.session.userId]);
  var rows  = TursoClient.select(sql, args);
  var perms = Rbac.userPermissions(ctx.session.userId) || [];
  return rows
    .map(function (o) { return _approvalOrderToItem_(o, perms); })
    .filter(function (it) { return it.actionable; });
}

// ── list: the broader approval backlog/history for managers and auditors ──────

function _approvalsList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _approvalScopeData_(ctx.session);
  var sc    = _approvalOrderScopeClause_(scope);
  var sql   = 'SELECT o.*, c.company_name FROM orders o ' +
              'LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE 1=1' + sc.clause;
  var args  = sc.args.slice();
  if (params.status) {
    sql += ' AND o.status = ?';
    args.push(String(params.status).toUpperCase());
  } else {
    sql += " AND o.status IN ('SUBMITTED','APPROVED','REJECTED')";
  }
  sql += ' ORDER BY COALESCE(o.submitted_at, o.created_at) DESC LIMIT ' +
         (parseInt(params.limit, 10) || 100);
  var rows  = TursoClient.select(sql, args);
  var perms = Rbac.userPermissions(ctx.session.userId) || [];
  return rows.map(function (o) { return _approvalOrderToItem_(o, perms); });
}

// ── get: one approval item (an order) by id ───────────────────────────────────

function _approvalsGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var requestId = String(params.requestId || params.orderId || '');
  if (!requestId) throw new Errors.Validation('requestId required.');
  var rows = TursoClient.select(
    'SELECT o.*, c.company_name FROM orders o ' +
    'LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE o.order_id = ? LIMIT 1',
    [requestId]
  );
  if (!rows.length) throw new Errors.NotFound('Approval item not found.');
  var o     = rows[0];
  var scope = _approvalScopeData_(ctx.session);
  if (!scope.isGlobal && o.country_code && scope.countries.indexOf(o.country_code) === -1) {
    throw new Errors.NotFound('Approval item not found.');
  }
  var perms = Rbac.userPermissions(ctx.session.userId) || [];
  return _approvalOrderToItem_(o, perms);
}

// ── approve: route to the SAME inline order handler (single decision point) ────

function _approvalsApprove_(ctx, params) {
  var requestId = String(params.requestId || params.orderId || '');
  if (!requestId) throw new Errors.Validation('requestId required.');
  // Delegate to the inline order approve handler: it enforces SoD, the amount
  // tier, the SUBMITTED guard and the notifications, and it updates the order to
  // APPROVED. No parallel approval state is written.
  return Orders._approveHandler_(ctx, {
    orderId: requestId,
    notes:   String(params.comment || params.notes || ''),
  });
}

// ── reject: route to the SAME inline order handler ────────────────────────────

function _approvalsReject_(ctx, params) {
  var requestId = String(params.requestId || params.orderId || '');
  var reason    = String(params.reason || '').trim();
  if (!requestId) throw new Errors.Validation('requestId required.');
  if (!reason)    throw new Errors.Validation('reason required.');
  return Orders._rejectHandler_(ctx, { orderId: requestId, reason: reason });
}

// ── Registration (service keys and permissions unchanged) ─────────────────────

(function _registerApprovals_() {
  register({ service: 'approvalRequests', action: 'inbox',   permission: 'order.approve_low', handler: _approvalsInbox_ });
  register({ service: 'approvalRequests', action: 'list',    permission: 'order.view',        handler: _approvalsList_ });
  register({ service: 'approvalRequests', action: 'get',     permission: 'order.view',        handler: _approvalsGet_ });
  register({ service: 'approvalRequests', action: 'approve', permission: 'order.approve_low', handler: Idempotency.wrap(_approvalsApprove_) });
  register({ service: 'approvalRequests', action: 'reject',  permission: 'order.approve_low', handler: Idempotency.wrap(_approvalsReject_) });
})();
