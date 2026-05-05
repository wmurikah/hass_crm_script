// ================================================================
// HASS PETROLEUM CMS - AuditService.gs
// Centralised audit logging (G-005).
//
// All business-significant actions write a row to the audit_log table
// through one of the helpers below. Direct callers should NOT call
// logAudit() in DatabaseSetup.gs anymore - use these wrappers so the
// shape stays consistent (resolved actor_email, actor_ip, actor_user_agent,
// ISO timestamp, properly-stringified changes/metadata).
//
// Helpers
//   audit_log(entry)                                  - low-level writer
//   auditLogCreate(entityType, id, actorId, newVals, country)
//   auditLogUpdate(entityType, id, actorId, oldVals, newVals, country)
//   auditLogDelete(entityType, id, actorId, deletedVals, country)
//   auditLogCustom(entityType, id, actorId, action, metadata, country)
//   withAudit(spec, fn)                               - wraps a method
//
// Request context (set by doPost in Code.gs):
//   setAuditRequestContext({ actorIp, actorUserAgent, actorUserId })
// ================================================================

// Module-scope request context, refreshed on every doPost(). Apps Script
// runs each request in a fresh script execution so this stays per-request.
var _AUDIT_REQUEST_CTX_ = { actorIp: '', actorUserAgent: '', actorUserId: '' };

function setAuditRequestContext(ctx) {
  _AUDIT_REQUEST_CTX_ = {
    actorIp:        String((ctx && ctx.actorIp)        || ''),
    actorUserAgent: String((ctx && ctx.actorUserAgent) || ''),
    actorUserId:    String((ctx && ctx.actorUserId)    || ''),
  };
}

function getAuditRequestContext() {
  return _AUDIT_REQUEST_CTX_;
}

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

function _resolveActor_(actorUserId) {
  var id = String(actorUserId || '').trim();
  if (!id) return { type: 'SYSTEM', id: '', email: '' };

  // Match well-known synthetic actor IDs first.
  if (id === 'SYSTEM' || id === 'CRON' || id === 'RECURRING_SCHEDULER' ||
      id === 'EMAIL_INBOUND' || id === 'STAFF_UI') {
    return { type: 'SYSTEM', id: id, email: '' };
  }

  try {
    var u = findRow('Users', 'user_id', id);
    if (u) return { type: 'STAFF', id: id, email: String(u.email || '') };
  } catch(e) {}

  try {
    var c = findRow('Contacts', 'contact_id', id);
    if (c) return { type: 'CUSTOMER', id: id, email: String(c.email || '') };
  } catch(e) {}

  return { type: 'UNKNOWN', id: id, email: '' };
}

function _diffValues_(oldVals, newVals) {
  var diff = {};
  oldVals = oldVals || {};
  newVals = newVals || {};
  Object.keys(newVals).forEach(function(k) {
    var ov = oldVals[k];
    var nv = newVals[k];
    // Coerce dates to ISO strings before comparing so tests are stable.
    if (ov instanceof Date) ov = ov.toISOString();
    if (nv instanceof Date) nv = nv.toISOString();
    if (String(ov == null ? '' : ov) !== String(nv == null ? '' : nv)) {
      diff[k] = { from: oldVals[k] == null ? null : oldVals[k],
                  to:   newVals[k] == null ? null : newVals[k] };
    }
  });
  return diff;
}

function _safeJson_(o) {
  try { return JSON.stringify(o == null ? {} : o); }
  catch(e) { return JSON.stringify({ _serializeError: e.message }); }
}

// ----------------------------------------------------------------
// Public: low-level writer
// ----------------------------------------------------------------

/**
 * Write a single audit row.
 * @param {Object} entry
 *   entity_type   string  (required)
 *   entity_id     string  (required)
 *   action        string  (required)
 *   actor_user_id string  (optional - resolves to type/email)
 *   actor_type    string  (optional override - else resolved)
 *   actor_email   string  (optional override - else resolved)
 *   changes       object  (optional)
 *   metadata      object  (optional)
 *   country_code  string  (optional)
 */
function audit_log(entry) {
  try {
    entry = entry || {};
    var ctx   = getAuditRequestContext();
    var actor = _resolveActor_(entry.actor_user_id || ctx.actorUserId);

    var row = {
      log_id:           generateUUID(),
      entity_type:      String(entry.entity_type || ''),
      entity_id:        String(entry.entity_id   || ''),
      action:           String(entry.action      || ''),
      actor_type:       String(entry.actor_type  || actor.type),
      actor_id:         String(entry.actor_user_id || actor.id),
      actor_email:      String(entry.actor_email || actor.email),
      actor_ip:         String((entry.metadata && entry.metadata.ip)        || ctx.actorIp        || ''),
      actor_user_agent: String((entry.metadata && entry.metadata.userAgent) || ctx.actorUserAgent || ''),
      changes:          _safeJson_(entry.changes  || {}),
      metadata:         _safeJson_(entry.metadata || {}),
      country_code:     String(entry.country_code || (entry.metadata && entry.metadata.countryCode) || ''),
      created_at:       new Date().toISOString(),
    };
    appendRow('AuditLog', row);
  } catch(e) {
    Logger.log('[AuditService] audit_log error: ' + e.message);
  }
}

// Convenience wrappers ------------------------------------------------------

function auditLogCreate(entityType, entityId, actorId, newValues, countryCode) {
  audit_log({
    entity_type: entityType,
    entity_id:   entityId,
    action:      'CREATE',
    actor_user_id: actorId,
    changes:     { after: newValues || {} },
    country_code: countryCode || '',
  });
}

function auditLogUpdate(entityType, entityId, actorId, oldValues, newValues, countryCode) {
  var diff = _diffValues_(oldValues, newValues);
  audit_log({
    entity_type: entityType,
    entity_id:   entityId,
    action:      'UPDATE',
    actor_user_id: actorId,
    changes:     diff,
    country_code: countryCode || '',
  });
}

function auditLogDelete(entityType, entityId, actorId, deletedValues, countryCode) {
  audit_log({
    entity_type: entityType,
    entity_id:   entityId,
    action:      'DELETE',
    actor_user_id: actorId,
    changes:     { before: deletedValues || {} },
    country_code: countryCode || '',
  });
}

function auditLogCustom(entityType, entityId, actorId, action, metadata, countryCode) {
  audit_log({
    entity_type: entityType,
    entity_id:   entityId,
    action:      String(action || 'CUSTOM'),
    actor_user_id: actorId,
    metadata:    metadata || {},
    country_code: countryCode || '',
  });
}

// ----------------------------------------------------------------
// withAudit - method wrapper
// ----------------------------------------------------------------

/**
 * Runs `fn` and writes one audit row regardless of success or failure.
 * On thrown error: logs with metadata.error = error.message, then rethrows.
 *
 *   return withAudit(
 *     { entity_type:'order', entity_id:orderId, action:'APPROVE',
 *       actor: userId, country_code:'KE',
 *       metadata: { reason:'auto' } },
 *     function() {
 *       // ... mutation ...
 *       return result;
 *     }
 *   );
 */
function withAudit(spec, fn) {
  spec = spec || {};
  var startedAt = new Date();
  try {
    var result = fn();
    audit_log({
      entity_type:   spec.entity_type,
      entity_id:     spec.entity_id,
      action:        spec.action,
      actor_user_id: spec.actor || spec.actor_user_id,
      changes:       spec.changes  || {},
      metadata:      Object.assign({}, spec.metadata || {}, {
        success:    true,
        durationMs: new Date() - startedAt,
      }),
      country_code:  spec.country_code || '',
    });
    return result;
  } catch(err) {
    audit_log({
      entity_type:   spec.entity_type,
      entity_id:     spec.entity_id,
      action:        spec.action,
      actor_user_id: spec.actor || spec.actor_user_id,
      changes:       spec.changes  || {},
      metadata:      Object.assign({}, spec.metadata || {}, {
        success:    false,
        error:      err && err.message ? err.message : String(err),
        durationMs: new Date() - startedAt,
      }),
      country_code:  spec.country_code || '',
    });
    throw err;
  }
}

// ================================================================
// AUDIT VIEWER (?page=audit) - server-side data API
// ================================================================

/**
 * Reads audit rows for the viewer. Read-only. Caller must hold
 * `audit_log.view`. Pagination: 100 rows / page.
 *
 * @param {Object} filters  { entity_type, actor_email, actor_id,
 *                            country_code, action, from, to,
 *                            page (1-based), pageSize }
 */
function listAuditLog(filters, sessionUserId) {
  filters = filters || {};
  try {
    if (typeof userHasPermission === 'function' &&
        !userHasPermission(sessionUserId, 'audit_log.view')) {
      return { success: false, error: 'Permission denied', code: 'PERMISSION_DENIED' };
    }

    var where = ' WHERE 1=1';
    var args  = [];

    if (filters.entity_type)  { where += ' AND entity_type = ?';     args.push(filters.entity_type); }
    if (filters.action)       { where += ' AND action = ?';          args.push(filters.action); }
    if (filters.actor_email)  { where += ' AND LOWER(actor_email) LIKE ?';
                                args.push('%' + String(filters.actor_email).toLowerCase() + '%'); }
    if (filters.actor_id)     { where += ' AND actor_id = ?';        args.push(filters.actor_id); }
    if (filters.country_code) { where += ' AND country_code = ?';    args.push(filters.country_code); }
    if (filters.from)         { where += ' AND created_at >= ?';     args.push(filters.from); }
    if (filters.to)           { where += ' AND created_at <= ?';     args.push(filters.to); }

    var pageSize = Math.min(parseInt(filters.pageSize || 100, 10) || 100, 500);
    var page     = Math.max(parseInt(filters.page || 1, 10) || 1, 1);
    var offset   = (page - 1) * pageSize;

    var countRows = tursoSelect('SELECT COUNT(*) AS n FROM audit_log' + where, args.slice());
    var total = (countRows && countRows[0] && parseInt(countRows[0].n, 10)) || 0;

    var pageArgs = args.slice();
    pageArgs.push(pageSize, offset);
    var rows = tursoSelect(
      'SELECT * FROM audit_log' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
      pageArgs
    ).map(function(r) {
      var changes = {}, metadata = {};
      try { changes  = r.changes  ? JSON.parse(r.changes)  : {}; } catch(e) {}
      try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch(e) {}
      return {
        log_id:        r.log_id,
        entity_type:   r.entity_type,
        entity_id:     r.entity_id,
        action:        r.action,
        actor_type:    r.actor_type,
        actor_id:      r.actor_id,
        actor_email:   r.actor_email,
        actor_ip:      r.actor_ip,
        actor_user_agent: r.actor_user_agent,
        country_code:  r.country_code,
        created_at:    r.created_at,
        changes:       changes,
        metadata:      metadata,
      };
    });

    return {
      success:  true,
      rows:     rows,
      page:     page,
      pageSize: pageSize,
      total:    total,
    };
  } catch(e) {
    Logger.log('[AuditService] listAuditLog error: ' + e.message);
    return { success: false, error: e.message };
  }
}

function handleAuditRequest(params) {
  try {
    var session = params && params._session;
    var userId  = (session && session.userId) || '';
    switch (params.action) {
      case 'list': return listAuditLog(params.filters || {}, userId);
      default:
        return { success: false, error: 'Unknown audit action: ' + params.action };
    }
  } catch(e) {
    Logger.log('[AuditService] handleAuditRequest error: ' + e.message);
    return { success: false, error: 'Audit service error' };
  }
}
