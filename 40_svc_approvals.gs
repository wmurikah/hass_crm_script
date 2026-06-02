/**
 * 40_svc_approvals.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Approval inbox and action endpoints.
 * Reads approval_requests rows (created by workflow engine or by order/credit submit flows).
 *
 * approvals.{inbox,get,approve,reject,list}
 *
 * Country scope enforced: GLOBAL roles see all; COUNTRY roles see their scope.
 * SoD: approver must not equal the created_by field of the approval_request.
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

// ── inbox: pending approvals for the caller ───────────────────────────────────

function _approvalsInbox_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.approve_low');
  var scope = _approvalScopeData_(ctx.session);
  var sql   = "SELECT ar.*, aw.name AS workflow_name, aw.entity_type AS workflow_entity_type " +
              "FROM approval_requests ar " +
              "LEFT JOIN approval_workflows aw ON aw.workflow_id = ar.workflow_id " +
              "WHERE ar.status = 'PENDING' " +
              "AND (ar.required_role_codes = ? OR ar.assigned_to = ?)";
  var args  = [ctx.session.role || '', ctx.session.userId];

  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND ar.country_code IN (' + ph + ')';
    args = args.concat(scope.countries);
  }
  sql += ' ORDER BY ar.created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 50);
  return TursoClient.select(sql, args);
}

// ── list: all approval_requests (for managers/auditors) ──────────────────────

function _approvalsList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _approvalScopeData_(ctx.session);
  var sql   = 'SELECT ar.*, aw.name AS workflow_name FROM approval_requests ar ' +
              'LEFT JOIN approval_workflows aw ON aw.workflow_id = ar.workflow_id WHERE 1=1';
  var args  = [];
  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND ar.country_code IN (' + ph + ')';
    args = args.concat(scope.countries);
  }
  if (params.status)      { sql += ' AND ar.status = ?';      args.push(params.status); }
  if (params.entity_type) { sql += ' AND ar.entity_type = ?'; args.push(params.entity_type); }
  if (params.entity_id)   { sql += ' AND ar.entity_id = ?';   args.push(params.entity_id); }
  sql += ' ORDER BY ar.created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

// ── get ───────────────────────────────────────────────────────────────────────

function _approvalsGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var requestId = String(params.requestId || '');
  if (!requestId) throw new Errors.Validation('requestId required.');
  var rows = TursoClient.select(
    'SELECT ar.*, aw.name AS workflow_name FROM approval_requests ar ' +
    'LEFT JOIN approval_workflows aw ON aw.workflow_id = ar.workflow_id ' +
    'WHERE ar.request_id = ? LIMIT 1',
    [requestId]
  );
  if (!rows.length) throw new Errors.NotFound('Approval request not found.');
  var ar    = rows[0];
  var scope = _approvalScopeData_(ctx.session);
  if (!scope.isGlobal && ar.country_code && scope.countries.indexOf(ar.country_code) === -1) {
    throw new Errors.NotFound('Approval request not found.');
  }
  return ar;
}

// ── approve ───────────────────────────────────────────────────────────────────

function _approvalsApprove_(ctx, params) {
  var requestId = String(params.requestId || '');
  var comment   = String(params.comment   || '').trim();
  if (!requestId) throw new Errors.Validation('requestId required.');
  var rows = TursoClient.select(
    'SELECT * FROM approval_requests WHERE request_id = ? LIMIT 1', [requestId]
  );
  if (!rows.length) throw new Errors.NotFound('Approval request not found.');
  var ar    = rows[0];
  var scope = _approvalScopeData_(ctx.session);
  if (!scope.isGlobal && ar.country_code && scope.countries.indexOf(ar.country_code) === -1) {
    throw new Errors.NotFound('Approval request not found.');
  }
  if (ar.status !== 'PENDING') throw new Errors.Validation('Approval request is not PENDING.');

  // Check caller is an eligible approver.
  var eligible = (ar.assigned_to === ctx.session.userId) ||
                 Rbac.userHasPermission(ctx.session.userId, ar.required_role_codes);
  if (!eligible) throw new Errors.PermissionDenied('Not an eligible approver for this request.');

  // SoD: approver must not be the creator.
  if (ar.submitted_by && ar.submitted_by === ctx.session.userId) {
    throw new Errors.PermissionDenied('Approval creator cannot approve their own request.');
  }

  var now = nowIso();
  TursoClient.write(
    'UPDATE approval_requests SET status = ?, approved_by = ?, approved_at = ?, ' +
    'comments = ?, updated_at = ? WHERE request_id = ?',
    ['APPROVED', ctx.session.userId, now, comment, now, requestId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'APPROVAL_APPROVED',
    entity: 'approval_requests', entityId: requestId,
    before: { status: ar.status }, after: { status: 'APPROVED', approver: ctx.session.userId },
  });
  return { success: true, status: 'APPROVED' };
}

// ── reject ────────────────────────────────────────────────────────────────────

function _approvalsReject_(ctx, params) {
  var requestId = String(params.requestId || '');
  var reason    = String(params.reason    || '').trim();
  if (!requestId) throw new Errors.Validation('requestId required.');
  if (!reason)    throw new Errors.Validation('reason required.');
  var rows = TursoClient.select(
    'SELECT * FROM approval_requests WHERE request_id = ? LIMIT 1', [requestId]
  );
  if (!rows.length) throw new Errors.NotFound('Approval request not found.');
  var ar    = rows[0];
  var scope = _approvalScopeData_(ctx.session);
  if (!scope.isGlobal && ar.country_code && scope.countries.indexOf(ar.country_code) === -1) {
    throw new Errors.NotFound('Approval request not found.');
  }
  if (ar.status !== 'PENDING') throw new Errors.Validation('Approval request is not PENDING.');

  var eligible = (ar.assigned_to === ctx.session.userId) ||
                 Rbac.userHasPermission(ctx.session.userId, ar.required_role_codes);
  if (!eligible) throw new Errors.PermissionDenied('Not an eligible approver for this request.');
  if (ar.submitted_by && ar.submitted_by === ctx.session.userId) {
    throw new Errors.PermissionDenied('Approval creator cannot reject their own request.');
  }

  var now = nowIso();
  TursoClient.write(
    'UPDATE approval_requests SET status = ?, rejected_by = ?, rejected_at = ?, ' +
    'rejection_reason = ?, comments = ?, updated_at = ? WHERE request_id = ?',
    ['REJECTED', ctx.session.userId, now, reason, String(params.comment || ''), now, requestId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'APPROVAL_REJECTED',
    entity: 'approval_requests', entityId: requestId,
    before: { status: ar.status }, after: { status: 'REJECTED', reason: reason },
  });
  return { success: true, status: 'REJECTED' };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerApprovals_() {
  register({ service: 'approvals', action: 'inbox',   permission: 'order.approve_low', handler: _approvalsInbox_ });
  register({ service: 'approvals', action: 'list',    permission: 'order.view',        handler: _approvalsList_ });
  register({ service: 'approvals', action: 'get',     permission: 'order.view',        handler: _approvalsGet_ });
  register({ service: 'approvals', action: 'approve', permission: 'order.approve_low', handler: _approvalsApprove_ });
  register({ service: 'approvals', action: 'reject',  permission: 'order.approve_low', handler: _approvalsReject_ });
})();
