// ================================================================
// HASS PETROLEUM CMS - ApprovalEngine.gs (G-002)
// Runtime engine that interprets `approval_workflows.rules` JSON,
// routes approvals, enforces SoD, and tracks state through completion
// or rejection.
//
// Public API
//   submitForApproval(entityType, entityId, context)
//   approve(requestId, approverUserId, comment)
//   rejectApproval(requestId, approverUserId, reason)
//   escalateApproval(requestId, reason)
//   getPendingApprovals(userId, options)
//   listEntityApprovals(entityType, entityId)
//   handleApprovalRequest(params)            -- doPost dispatcher
//
// Schedulable
//   runApprovalTimeoutCheck()                -- enqueued by JobProcessor
//
// Workflow rules JSON shape (per row of `approval_workflows`):
//   {
//     "amount_field":   "amount",       // optional
//     "currency_field": "currency",     // optional, defaults KES
//     "sla_minutes":    1440,           // optional, default 1440 (24h)
//     "thresholds": [
//       { "max_amount": 100000,  "approvers": ["CS_MANAGER"] },
//       { "max_amount": 1000000, "approvers": ["COUNTRY_MANAGER"] },
//       { "max_amount": null,    "approvers": ["CFO"] }   // catch-all
//     ]
//   }
// ================================================================

var APPROVAL_REQUEST_TABLE_   = 'approval_requests';
var APPROVAL_WORKFLOW_TABLE_  = 'approval_workflows';
var APPROVAL_DEFAULT_SLA_MIN_ = 1440;          // 24h
var APPROVAL_TERMINAL_STATES_ = ['APPROVED','REJECTED','EXPIRED','CANCELLED'];

// ----------------------------------------------------------------
// Workflow lookup + rule evaluation
// ----------------------------------------------------------------

function _approvalLoadWorkflow_(entityType) {
  var rows = tursoSelect(
    'SELECT * FROM ' + APPROVAL_WORKFLOW_TABLE_ +
    ' WHERE entity_type = ? AND is_active = 1 ' +
    ' ORDER BY created_at DESC LIMIT 1',
    [entityType]
  );
  if (!rows.length) {
    throw new Error('No active approval workflow for entity_type: ' + entityType);
  }
  var wf = rows[0];
  try {
    wf.rules_parsed = JSON.parse(wf.rules || '{}');
  } catch (e) {
    throw new Error('Workflow ' + wf.workflow_id + ' has invalid rules JSON: ' + e.message);
  }
  return wf;
}

function _approvalPickThreshold_(rules, context) {
  var thresholds = (rules && rules.thresholds) || [];
  if (!thresholds.length) {
    throw new Error('Workflow has no thresholds defined');
  }
  var amount = 0;
  if (rules.amount_field && context && context[rules.amount_field] != null) {
    amount = parseFloat(context[rules.amount_field]) || 0;
  } else if (context && context.amount != null) {
    amount = parseFloat(context.amount) || 0;
  }
  // Currency normalisation (mirrors PermissionService._exchangeRateToKES_).
  var currency = (rules.currency_field && context && context[rules.currency_field])
                 || (context && context.currency) || 'KES';
  var kesAmount = amount;
  if (typeof _exchangeRateToKES_ === 'function' && currency && String(currency).toUpperCase() !== 'KES') {
    try { kesAmount = amount * (_exchangeRateToKES_(currency).rate || 1); } catch(e) {}
  }
  for (var i = 0; i < thresholds.length; i++) {
    var t = thresholds[i];
    var max = (t.max_amount === null || t.max_amount === undefined) ? Infinity : parseFloat(t.max_amount);
    if (kesAmount <= max) {
      return { tier: t, index: i, kesAmount: kesAmount };
    }
  }
  // Fall back to last tier (catch-all).
  return { tier: thresholds[thresholds.length - 1], index: thresholds.length - 1, kesAmount: kesAmount };
}

// ----------------------------------------------------------------
// SoD enforcement
// ----------------------------------------------------------------

function _approvalDomainSoD_(entityType, entityId, approverUserId, context) {
  // Refund: approver != original payment receiver.
  if (entityType === 'payment_refund' && context && context.payment_receiver_id) {
    if (String(context.payment_receiver_id) === String(approverUserId)) {
      throw _approvalSoDError_('Refund approver cannot be the original payment receiver.');
    }
  }
  // KYC document: approver != document collector.
  if ((entityType === 'document' || entityType === 'customer_kyc') && context && context.collected_by) {
    if (String(context.collected_by) === String(approverUserId)) {
      throw _approvalSoDError_('KYC approver cannot be the same person who collected the document.');
    }
  }
  // Customer credit limit: approver != requester.
  if (entityType === 'customer_credit_limit' && context && context.requested_by) {
    if (String(context.requested_by) === String(approverUserId)) {
      throw _approvalSoDError_('Credit limit approver cannot be the user who requested the change.');
    }
  }
}

function _approvalSoDError_(msg) {
  if (typeof SoDViolationError === 'function') return SoDViolationError(msg);
  var e = new Error(msg);
  e.name = 'SoDViolationError';
  e.code = 'SOD_VIOLATION';
  return e;
}

function _approvalUserHasRole_(userId, roleCode) {
  if (!userId || !roleCode) return false;
  try {
    var rows = tursoSelect(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ? LIMIT 1',
      [userId, roleCode]
    );
    return rows.length > 0;
  } catch (e) {
    // Fall back to legacy users.role column.
    try {
      var u = findRow('Users', 'user_id', userId);
      return !!(u && String(u.role || '').toUpperCase() === String(roleCode).toUpperCase());
    } catch (ee) { return false; }
  }
}

function _approvalUserRoles_(userId) {
  try {
    var rows = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [userId]);
    var codes = rows.map(function(r) { return r.role_code; }).filter(Boolean);
    if (codes.length) return codes;
  } catch (e) {}
  try {
    var u = findRow('Users', 'user_id', userId);
    if (u && u.role) return [String(u.role)];
  } catch (e) {}
  return [];
}

// ----------------------------------------------------------------
// Internal request helpers
// ----------------------------------------------------------------

function _approvalSibling_(requestId) {
  var row = findRow('ApprovalRequests', 'request_id', requestId);
  if (!row) throw new Error('Approval request not found: ' + requestId);
  return row;
}

function _approvalFindSiblings_(entityType, entityId) {
  return tursoSelect(
    'SELECT * FROM ' + APPROVAL_REQUEST_TABLE_ +
    ' WHERE entity_type = ? AND entity_id = ?' +
    ' ORDER BY created_at ASC',
    [entityType, entityId]
  );
}

function _approvalContext_(row) {
  if (!row.context) return {};
  try { return JSON.parse(row.context); } catch (e) { return {}; }
}

function _approvalUpdate_(requestId, updates) {
  if (typeof updateRow === 'function') {
    return updateRow('ApprovalRequests', 'request_id', requestId, updates);
  }
  var stmt = _buildUpdate(APPROVAL_REQUEST_TABLE_, 'request_id', requestId,
    Object.assign({ updated_at: new Date().toISOString() }, updates));
  if (stmt) tursoWrite(stmt.sql, stmt.args);
  return true;
}

// ----------------------------------------------------------------
// Public: submitForApproval
// ----------------------------------------------------------------

/**
 * Looks up the matching workflow, evaluates thresholds, and creates one
 * approval_requests row per required approver in the chosen tier.
 *
 * @param {string} entityType  e.g. 'order', 'payment_refund'
 * @param {string} entityId    primary key of the entity
 * @param {Object} context     { amount, currency, country_code, created_by, ... }
 * @returns {{success:boolean, request_ids:string[], workflow_id:string,
 *            approvers:string[], expires_at:string, error?:string}}
 */
function submitForApproval(entityType, entityId, context) {
  context = context || {};
  try {
    var wf = _approvalLoadWorkflow_(entityType);
    var pick = _approvalPickThreshold_(wf.rules_parsed, context);
    var approvers = (pick.tier && pick.tier.approvers) || [];
    if (!approvers.length) {
      return { success: false, error: 'Workflow tier has no approvers.' };
    }

    var slaMinutes = parseInt(wf.rules_parsed.sla_minutes || APPROVAL_DEFAULT_SLA_MIN_, 10);
    if (!slaMinutes || slaMinutes <= 0) slaMinutes = APPROVAL_DEFAULT_SLA_MIN_;
    var now = new Date();
    var expiresAt = new Date(now.getTime() + slaMinutes * 60 * 1000);
    var contextJson = '';
    try { contextJson = JSON.stringify(context); } catch (e) { contextJson = '{}'; }
    var creator = String(context.created_by || context.requested_by || '').trim();
    var country = String(context.country_code || '').trim();

    var requestIds = [];
    approvers.forEach(function(roleCode) {
      var requestId = generateId('AR');
      var nowIso = new Date().toISOString();
      appendRow('ApprovalRequests', {
        request_id:                requestId,
        workflow_id:               wf.workflow_id,
        entity_type:               entityType,
        entity_id:                 entityId,
        status:                    'PENDING',
        required_approver_role:    roleCode,
        required_approver_user_id: '',
        approver_user_id:          '',
        approved_at:               '',
        comment:                   '',
        reason:                    '',
        escalation_level:          0,
        expires_at:                expiresAt.toISOString(),
        context:                   contextJson,
        country_code:              country,
        created_by:                creator,
        created_at:                nowIso,
        updated_at:                nowIso,
      });
      requestIds.push(requestId);
    });

    // Audit trail.
    try {
      auditLogCustom(entityType, entityId, creator, 'APPROVAL_SUBMIT', {
        workflow_id:  wf.workflow_id,
        approvers:    approvers,
        kes_amount:   pick.kesAmount,
        request_ids:  requestIds,
        expires_at:   expiresAt.toISOString(),
      }, country);
    } catch (e) {}

    // Notify approvers.
    requestIds.forEach(function(rid, i) {
      try {
        _approvalNotifyApprovers_(rid, approvers[i], entityType, entityId, context);
      } catch (e) { Logger.log('[ApprovalEngine] notify error: ' + e.message); }
    });

    return {
      success:     true,
      request_ids: requestIds,
      workflow_id: wf.workflow_id,
      approvers:   approvers,
      expires_at:  expiresAt.toISOString(),
    };
  } catch (e) {
    Logger.log('[ApprovalEngine] submitForApproval error: ' + e.message);
    return { success: false, error: e.message, code: e.code || 'APPROVAL_SUBMIT_FAILED' };
  }
}

// ----------------------------------------------------------------
// Public: approve
// ----------------------------------------------------------------

function approve(requestId, approverUserId, comment) {
  try {
    if (!approverUserId) throw new Error('approverUserId required');
    var row = _approvalSibling_(requestId);
    if (row.status !== 'PENDING') {
      return { success: false, error: 'Request is not pending (status=' + row.status + ')' };
    }

    // Role / user gating.
    if (row.required_approver_user_id) {
      if (String(row.required_approver_user_id) !== String(approverUserId)) {
        throw _approvalSoDError_('You are not the designated approver for this request.');
      }
    } else if (row.required_approver_role) {
      if (!_approvalUserHasRole_(approverUserId, row.required_approver_role)) {
        throw (typeof PermissionDeniedError === 'function')
          ? PermissionDeniedError('You do not have the required role: ' + row.required_approver_role)
          : new Error('Required role missing: ' + row.required_approver_role);
      }
    }

    // SoD: approver != creator.
    if (row.created_by && String(row.created_by) === String(approverUserId)) {
      throw _approvalSoDError_('Cannot approve your own request. Approver must be different from the creator.');
    }

    // Country scope check (if available).
    if (typeof requireScope === 'function' && row.country_code) {
      try { requireScope(approverUserId, row.country_code, null); }
      catch (e) { return { success: false, error: e.message, code: e.code || 'SCOPE_DENIED' }; }
    }

    // Domain-specific SoD checks.
    var ctx = _approvalContext_(row);
    _approvalDomainSoD_(row.entity_type, row.entity_id, approverUserId, ctx);

    // Record approval.
    var nowIso = new Date().toISOString();
    _approvalUpdate_(requestId, {
      status:            'APPROVED',
      approver_user_id:  approverUserId,
      approved_at:       nowIso,
      comment:           String(comment || ''),
    });

    try {
      auditLogCustom(row.entity_type, row.entity_id, approverUserId, 'APPROVE', {
        request_id:  requestId,
        workflow_id: row.workflow_id,
        role:        row.required_approver_role,
        comment:     String(comment || ''),
      }, row.country_code || '');
    } catch (e) {}

    // Are all sibling requests for this entity now APPROVED?
    var siblings = _approvalFindSiblings_(row.entity_type, row.entity_id);
    var pending  = siblings.filter(function(s) { return s.status === 'PENDING'; });
    var approved = siblings.filter(function(s) { return s.status === 'APPROVED'; });
    var allDone  = pending.length === 0 && approved.length === siblings.length;

    if (allDone) {
      _approvalAdvanceEntity_(row.entity_type, row.entity_id, ctx, approverUserId);
      _approvalNotifyCreator_(row, 'APPROVED', '');
    }

    return {
      success:           true,
      request_id:        requestId,
      entity_status:     allDone ? 'APPROVED' : 'PENDING_APPROVAL',
      remaining_pending: pending.length,
    };
  } catch (e) {
    Logger.log('[ApprovalEngine] approve error: ' + e.message);
    return { success: false, error: e.message, code: e.code || 'APPROVAL_FAILED' };
  }
}

// ----------------------------------------------------------------
// Public: rejectApproval
// ----------------------------------------------------------------

function rejectApproval(requestId, approverUserId, reason) {
  try {
    if (!approverUserId) throw new Error('approverUserId required');
    if (!reason || !String(reason).trim()) {
      return { success: false, error: 'Rejection reason is required' };
    }
    var row = _approvalSibling_(requestId);
    if (row.status !== 'PENDING') {
      return { success: false, error: 'Request is not pending (status=' + row.status + ')' };
    }
    if (row.required_approver_role && !_approvalUserHasRole_(approverUserId, row.required_approver_role)) {
      throw (typeof PermissionDeniedError === 'function')
        ? PermissionDeniedError('You do not have the required role: ' + row.required_approver_role)
        : new Error('Required role missing: ' + row.required_approver_role);
    }
    if (row.created_by && String(row.created_by) === String(approverUserId)) {
      throw _approvalSoDError_('Cannot reject your own request.');
    }

    var nowIso = new Date().toISOString();
    _approvalUpdate_(requestId, {
      status:           'REJECTED',
      approver_user_id: approverUserId,
      approved_at:      nowIso,
      reason:           String(reason),
    });

    // Cancel any sibling pending rows - one rejection rejects the entity.
    var siblings = _approvalFindSiblings_(row.entity_type, row.entity_id);
    siblings.forEach(function(s) {
      if (s.request_id !== requestId && s.status === 'PENDING') {
        _approvalUpdate_(s.request_id, {
          status:      'CANCELLED',
          reason:      'Cancelled because sibling request was rejected.',
          approved_at: nowIso,
        });
      }
    });

    try {
      auditLogCustom(row.entity_type, row.entity_id, approverUserId, 'REJECT', {
        request_id:  requestId,
        workflow_id: row.workflow_id,
        role:        row.required_approver_role,
        reason:      String(reason),
      }, row.country_code || '');
    } catch (e) {}

    var ctx = _approvalContext_(row);
    _approvalRejectEntity_(row.entity_type, row.entity_id, ctx, approverUserId, reason);
    _approvalNotifyCreator_(row, 'REJECTED', reason);

    return { success: true, request_id: requestId, entity_status: 'REJECTED' };
  } catch (e) {
    Logger.log('[ApprovalEngine] rejectApproval error: ' + e.message);
    return { success: false, error: e.message, code: e.code || 'APPROVAL_REJECT_FAILED' };
  }
}

// ----------------------------------------------------------------
// Public: escalateApproval
// ----------------------------------------------------------------

function escalateApproval(requestId, reason) {
  try {
    var row = _approvalSibling_(requestId);
    if (row.status !== 'PENDING') {
      return { success: false, error: 'Only PENDING requests can be escalated' };
    }
    var wf = findRow('ApprovalWorkflows', 'workflow_id', row.workflow_id);
    if (!wf) throw new Error('Workflow not found: ' + row.workflow_id);
    var rules = {};
    try { rules = JSON.parse(wf.rules || '{}'); } catch (e) {}
    var thresholds = (rules && rules.thresholds) || [];
    if (!thresholds.length) throw new Error('Workflow has no thresholds');

    // Find current tier index (by role) and step up to next tier.
    var currentIdx = -1;
    for (var i = 0; i < thresholds.length; i++) {
      if ((thresholds[i].approvers || []).indexOf(row.required_approver_role) !== -1) {
        currentIdx = i; break;
      }
    }
    var nextIdx = (currentIdx === -1 ? 0 : currentIdx + 1);
    if (nextIdx >= thresholds.length) {
      // Already at top tier - just bump escalation level + extend SLA.
      var slaMinutes = parseInt(rules.sla_minutes || APPROVAL_DEFAULT_SLA_MIN_, 10);
      var newExpires = new Date(Date.now() + slaMinutes * 60 * 1000).toISOString();
      _approvalUpdate_(requestId, {
        escalation_level: parseInt(row.escalation_level || 0, 10) + 1,
        expires_at:       newExpires,
        reason:           String(reason || row.reason || ''),
      });
      try {
        auditLogCustom(row.entity_type, row.entity_id, 'SYSTEM', 'APPROVAL_ESCALATE', {
          request_id: requestId, reason: reason || '', tier: 'TOP',
        }, row.country_code || '');
      } catch (e) {}
      return { success: true, request_id: requestId, escalated_to: row.required_approver_role, top_tier: true };
    }

    // Cancel current row and create new rows for the next tier's approvers.
    var nowIso = new Date().toISOString();
    _approvalUpdate_(requestId, {
      status:      'CANCELLED',
      approved_at: nowIso,
      reason:      'Escalated: ' + (reason || 'SLA timeout'),
    });

    var nextApprovers = thresholds[nextIdx].approvers || [];
    var ctx = _approvalContext_(row);
    var newIds = [];
    var slaMinutes = parseInt(rules.sla_minutes || APPROVAL_DEFAULT_SLA_MIN_, 10);
    var newExpiresAt = new Date(Date.now() + slaMinutes * 60 * 1000).toISOString();

    nextApprovers.forEach(function(roleCode) {
      var newId = generateId('AR');
      appendRow('ApprovalRequests', {
        request_id:                newId,
        workflow_id:               row.workflow_id,
        entity_type:               row.entity_type,
        entity_id:                 row.entity_id,
        status:                    'PENDING',
        required_approver_role:    roleCode,
        required_approver_user_id: '',
        approver_user_id:          '',
        approved_at:               '',
        comment:                   '',
        reason:                    '',
        escalation_level:          parseInt(row.escalation_level || 0, 10) + 1,
        expires_at:                newExpiresAt,
        context:                   row.context || '{}',
        country_code:              row.country_code || '',
        created_by:                row.created_by || '',
        created_at:                nowIso,
        updated_at:                nowIso,
      });
      newIds.push(newId);
      try { _approvalNotifyApprovers_(newId, roleCode, row.entity_type, row.entity_id, ctx); } catch (e) {}
    });

    try {
      auditLogCustom(row.entity_type, row.entity_id, 'SYSTEM', 'APPROVAL_ESCALATE', {
        request_id:    requestId,
        new_request_ids: newIds,
        from_role:     row.required_approver_role,
        to_roles:      nextApprovers,
        reason:        reason || '',
      }, row.country_code || '');
    } catch (e) {}

    return { success: true, request_id: requestId, escalated_to: nextApprovers, new_request_ids: newIds };
  } catch (e) {
    Logger.log('[ApprovalEngine] escalateApproval error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ----------------------------------------------------------------
// Public: getPendingApprovals
// ----------------------------------------------------------------

/**
 * Returns approval requests where the user is a required approver, either
 * by direct user_id assignment or by holding the required role.
 *
 * @param {string} userId
 * @param {Object} [options]  { includeSubordinates?: bool }
 */
function getPendingApprovals(userId, options) {
  options = options || {};
  if (!userId) return { success: false, error: 'userId required', requests: [] };
  try {
    var roles = _approvalUserRoles_(userId);
    var rows  = [];

    // User-targeted requests.
    rows = rows.concat(tursoSelect(
      'SELECT * FROM ' + APPROVAL_REQUEST_TABLE_ +
      ' WHERE status = ? AND required_approver_user_id = ?' +
      ' ORDER BY created_at ASC',
      ['PENDING', userId]
    ));

    // Role-targeted requests.
    if (roles.length) {
      var placeholders = roles.map(function() { return '?'; }).join(',');
      var args = ['PENDING'].concat(roles);
      rows = rows.concat(tursoSelect(
        'SELECT * FROM ' + APPROVAL_REQUEST_TABLE_ +
        ' WHERE status = ?' +
        ' AND (required_approver_user_id IS NULL OR required_approver_user_id = "")' +
        ' AND required_approver_role IN (' + placeholders + ')' +
        ' ORDER BY created_at ASC',
        args
      ));
    }

    // Dedup by request_id (a user could match by both user_id and role).
    var seen = {};
    var unique = [];
    rows.forEach(function(r) {
      if (seen[r.request_id]) return;
      seen[r.request_id] = true;
      // SoD: drop rows where the requester is the same user.
      if (r.created_by && String(r.created_by) === String(userId)) return;
      r.context_parsed = _approvalContext_(r);
      unique.push(r);
    });

    return { success: true, requests: unique, count: unique.length };
  } catch (e) {
    Logger.log('[ApprovalEngine] getPendingApprovals error: ' + e.message);
    return { success: false, error: e.message, requests: [] };
  }
}

/**
 * Returns every approval row for the given entity (status timeline).
 */
function listEntityApprovals(entityType, entityId) {
  try {
    var rows = _approvalFindSiblings_(entityType, entityId);
    rows.forEach(function(r) { r.context_parsed = _approvalContext_(r); });
    return { success: true, requests: rows };
  } catch (e) {
    return { success: false, error: e.message, requests: [] };
  }
}

// ----------------------------------------------------------------
// Entity advance / reject callbacks
// ----------------------------------------------------------------

function _approvalAdvanceEntity_(entityType, entityId, context, actorId) {
  try {
    if (entityType === 'order') {
      // Move order to APPROVED through the OrderService (handles credit, audit).
      if (typeof updateOrderStatus === 'function') {
        updateOrderStatus(entityId, 'APPROVED', { actorId: actorId, actorType: 'STAFF' }, {
          approval_engine: true,
        });
      }
    } else if (entityType === 'customer_credit_limit') {
      // Apply the new credit limit on the customer.
      if (context && context.new_limit != null) {
        try {
          updateRow('Customers', 'customer_id', entityId, {
            credit_limit: parseFloat(context.new_limit) || 0,
          });
          clearSheetCache('Customers');
        } catch (e) {}
      }
    } else if (entityType === 'payment_refund') {
      // Mark the upload as APPROVED for refund. Downstream payout is manual.
      try {
        updateRow('PaymentUploads', 'upload_id', entityId, {
          status: 'REFUND_APPROVED',
        });
      } catch (e) {}
    } else if (entityType === 'customer_kyc') {
      try {
        updateRow('Customers', 'customer_id', entityId, {
          status:           'ACTIVE',
          onboarding_status:'COMPLETED',
        });
        clearSheetCache('Customers');
      } catch (e) {}
    } else if (entityType === 'document') {
      try {
        updateRow('Documents', 'document_id', entityId, {
          status:      'APPROVED',
          verified_by: actorId,
          verified_at: new Date().toISOString(),
        });
        clearSheetCache('Documents');
      } catch (e) {}
    }
  } catch (e) {
    Logger.log('[ApprovalEngine] advance entity error (' + entityType + '): ' + e.message);
  }
}

function _approvalRejectEntity_(entityType, entityId, context, actorId, reason) {
  try {
    if (entityType === 'order') {
      if (typeof updateOrderStatus === 'function') {
        updateOrderStatus(entityId, 'REJECTED', { actorId: actorId, actorType: 'STAFF' }, {
          rejection_reason: reason || '',
        });
      }
    } else if (entityType === 'payment_refund') {
      try { updateRow('PaymentUploads', 'upload_id', entityId, { status: 'REFUND_REJECTED' }); } catch (e) {}
    } else if (entityType === 'document') {
      try { updateRow('Documents', 'document_id', entityId, {
        status:             'REJECTED',
        verification_notes: reason || '',
        verified_by:        actorId,
        verified_at:        new Date().toISOString(),
      }); clearSheetCache('Documents'); } catch (e) {}
    } else if (entityType === 'customer_kyc') {
      try { updateRow('Customers', 'customer_id', entityId, {
        onboarding_status: 'KYC_REJECTED',
      }); clearSheetCache('Customers'); } catch (e) {}
    }
  } catch (e) {
    Logger.log('[ApprovalEngine] reject entity error (' + entityType + '): ' + e.message);
  }
}

// ----------------------------------------------------------------
// Notifications
// ----------------------------------------------------------------

function _approvalNotifyApprovers_(requestId, roleCode, entityType, entityId, context) {
  if (typeof createNotification !== 'function') return;
  // Notify every active user holding the role within the request country.
  var users = [];
  try {
    var args = [roleCode];
    var sql = 'SELECT DISTINCT u.user_id, u.email, u.first_name, u.country_code ' +
              'FROM users u JOIN user_roles ur ON ur.user_id = u.user_id ' +
              'WHERE ur.role_code = ? AND COALESCE(u.status,"ACTIVE") = "ACTIVE"';
    if (context && context.country_code) {
      sql += ' AND (u.country_code = ? OR u.country_code IS NULL OR u.country_code = "")';
      args.push(context.country_code);
    }
    users = tursoSelect(sql, args);
  } catch (e) {
    Logger.log('[ApprovalEngine] approver lookup error: ' + e.message);
  }
  var summary = entityType.toUpperCase() + ' ' + entityId;
  if (context && context.amount) {
    summary += ' (' + (context.currency || 'KES') + ' ' + Number(context.amount).toLocaleString() + ')';
  }
  users.forEach(function(u) {
    try {
      createNotification({
        recipient_type:    'STAFF',
        recipient_id:      u.user_id,
        notification_type: 'APPROVAL_REQUEST',
        reference_type:    entityType,
        reference_id:      entityId,
        title:             'Approval needed: ' + summary,
        message:           'A ' + entityType + ' is pending your approval. Open the Approvals inbox to review.',
        priority:          'HIGH',
        action_url:        '?page=approvals',
        data:              { request_id: requestId, role: roleCode },
      });
    } catch (e) {
      Logger.log('[ApprovalEngine] createNotification error for ' + u.user_id + ': ' + e.message);
    }
  });
}

function _approvalNotifyCreator_(row, outcome, reason) {
  if (typeof createNotification !== 'function') return;
  if (!row.created_by) return;
  try {
    createNotification({
      recipient_type:    'STAFF',
      recipient_id:      row.created_by,
      notification_type: outcome === 'APPROVED' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
      reference_type:    row.entity_type,
      reference_id:      row.entity_id,
      title:             outcome === 'APPROVED'
                            ? 'Your ' + row.entity_type + ' was approved'
                            : 'Your ' + row.entity_type + ' was rejected',
      message:           outcome === 'APPROVED'
                            ? 'Your request for ' + row.entity_type + ' ' + row.entity_id + ' has been approved.'
                            : 'Your request for ' + row.entity_type + ' ' + row.entity_id + ' was rejected. Reason: ' + (reason || ''),
      priority:          'NORMAL',
      action_url:        '?page=approvals',
    });
  } catch (e) {
    Logger.log('[ApprovalEngine] notify creator error: ' + e.message);
  }
}

// ----------------------------------------------------------------
// Timeout / escalation job
// ----------------------------------------------------------------

/**
 * Finds expired pending approvals and escalates them. Enqueue from the
 * JobProcessor under type 'APPROVAL_TIMEOUT_CHECK' (see JobProcessor.gs).
 */
function runApprovalTimeoutCheck() {
  var nowIso = new Date().toISOString();
  var expired;
  try {
    expired = tursoSelect(
      'SELECT * FROM ' + APPROVAL_REQUEST_TABLE_ +
      ' WHERE status = ? AND expires_at IS NOT NULL AND expires_at != "" AND expires_at <= ?' +
      ' ORDER BY expires_at ASC LIMIT 100',
      ['PENDING', nowIso]
    );
  } catch (e) {
    return { success: false, error: e.message, escalated: 0 };
  }
  var escalated = 0, errors = 0;
  expired.forEach(function(r) {
    var res = escalateApproval(r.request_id, 'SLA timeout');
    if (res && res.success) escalated++;
    else errors++;
  });
  return { success: true, scanned: expired.length, escalated: escalated, errors: errors };
}

// ----------------------------------------------------------------
// doPost dispatcher
// ----------------------------------------------------------------

function handleApprovalRequest(params) {
  try {
    var session = params && params._session;
    var userId  = (session && session.userId) || '';
    var action  = params.action;
    switch (action) {
      case 'pending':
        return getPendingApprovals(userId, params.options || {});
      case 'listForEntity':
        return listEntityApprovals(params.entityType, params.entityId);
      case 'submit':
        return submitForApproval(params.entityType, params.entityId,
          Object.assign({}, params.context || {}, { created_by: userId }));
      case 'approve':
        return approve(params.requestId, userId, params.comment || '');
      case 'reject':
        return rejectApproval(params.requestId, userId, params.reason || '');
      case 'escalate':
        if (typeof userHasPermission === 'function' &&
            !userHasPermission(userId, 'roles.manage') &&
            !userHasPermission(userId, 'audit_log.view')) {
          return { success: false, error: 'Permission denied', code: 'PERMISSION_DENIED' };
        }
        return escalateApproval(params.requestId, params.reason || 'Manual escalation');
      case 'runTimeoutCheck':
        return runApprovalTimeoutCheck();
      default:
        return { success: false, error: 'Unknown approvals action: ' + action };
    }
  } catch (e) {
    Logger.log('[ApprovalEngine] handleApprovalRequest error: ' + e.message);
    return { success: false, error: e.message };
  }
}
