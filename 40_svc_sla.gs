/**
 * 40_svc_sla.gs  —  Hass CMS rebuild  (Stage 5E)
 *
 * SLA policy management and breach detection.
 *
 * sla.{listPolicies, createPolicy, updatePolicy, listBreaches, checkEntity}
 *
 * Tables:
 *   sla_policies   (policy_id, entity_type, priority, country_code,
 *                   response_minutes, resolution_minutes, is_active,
 *                   created_at, updated_at)
 *   sla_breaches   (breach_id, entity_type, entity_id, policy_id,
 *                   breach_type, due_at, breached_at, country_code, created_at)
 *
 * Country scope enforced: GLOBAL roles see all; COUNTRY roles see their scope.
 */

// ── Scope helper ───────────────────────────────────────────────────────────────

function _slaScopeData_(session) {
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

// ── Match a policy for entity + priority ─────────────────────────────────────

function _matchSlaPolicy_(entityType, priority, countryCode) {
  var cc = String(countryCode || '').trim();
  var rows = TursoClient.select(
    "SELECT * FROM sla_policies WHERE entity_type = ? AND is_active = 1 " +
    "AND (country_code = ? OR country_code = '' OR country_code IS NULL) " +
    "AND (priority = ? OR priority = 'ALL') " +
    "ORDER BY CASE WHEN country_code = ? THEN 0 ELSE 1 END, " +
    "         CASE WHEN priority = ? THEN 0 ELSE 1 END " +
    "LIMIT 1",
    [entityType, cc, priority, cc, priority]
  );
  return rows.length ? rows[0] : null;
}

// ── sla.listPolicies ──────────────────────────────────────────────────────────

function _slaListPolicies_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _slaScopeData_(ctx.session);
  var sql   = 'SELECT * FROM sla_policies WHERE 1=1';
  var args  = [];
  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += " AND (country_code IN (" + ph + ") OR country_code = '' OR country_code IS NULL)";
    args = args.concat(scope.countries);
  }
  if (params.entity_type) { sql += ' AND entity_type = ?'; args.push(params.entity_type); }
  if (params.is_active !== undefined) {
    sql += ' AND is_active = ?'; args.push(params.is_active ? 1 : 0);
  }
  sql += ' ORDER BY entity_type, priority';
  return TursoClient.select(sql, args);
}

// ── sla.createPolicy ──────────────────────────────────────────────────────────

function _slaCreatePolicy_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var entityType        = String(params.entity_type        || '').toUpperCase();
  var priority          = String(params.priority           || 'ALL').toUpperCase();
  var responseMinutes   = parseInt(params.response_minutes,   10);
  var resolutionMinutes = parseInt(params.resolution_minutes, 10);
  var countryCode       = String(params.country_code || '').trim();

  if (!entityType) throw new Errors.Validation('entity_type required.');
  if (isNaN(responseMinutes)   || responseMinutes < 0)   throw new Errors.Validation('response_minutes must be >= 0.');
  if (isNaN(resolutionMinutes) || resolutionMinutes < 0) throw new Errors.Validation('resolution_minutes must be >= 0.');

  var policyId = genId('SLA');
  var now      = nowIso();
  TursoClient.write(
    'INSERT INTO sla_policies ' +
    '(policy_id, entity_type, priority, country_code, response_minutes, resolution_minutes, ' +
    'is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)',
    [policyId, entityType, priority, countryCode, responseMinutes, resolutionMinutes, now, now]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'SLA_POLICY_CREATED',
    entity: 'sla_policies', entityId: policyId,
    after: { entity_type: entityType, priority: priority, country_code: countryCode },
  });
  return { policy_id: policyId, entity_type: entityType, priority: priority };
}

// ── sla.updatePolicy ──────────────────────────────────────────────────────────

function _slaUpdatePolicy_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var policyId = String(params.policyId || '');
  if (!policyId) throw new Errors.Validation('policyId required.');
  var rows = TursoClient.select('SELECT * FROM sla_policies WHERE policy_id = ? LIMIT 1', [policyId]);
  if (!rows.length) throw new Errors.NotFound('SLA policy not found.');
  var before = rows[0];

  var allowed = ['response_minutes', 'resolution_minutes', 'is_active', 'priority', 'country_code'];
  var setParts = []; var args = [];
  allowed.forEach(function (col) {
    if (params[col] !== undefined) {
      setParts.push(col + ' = ?');
      args.push(col === 'is_active' ? (params[col] ? 1 : 0) : params[col]);
    }
  });
  if (!setParts.length) throw new Errors.Validation('No updatable fields provided.');
  var now = nowIso();
  setParts.push('updated_at = ?'); args.push(now); args.push(policyId);
  TursoClient.write('UPDATE sla_policies SET ' + setParts.join(', ') + ' WHERE policy_id = ?', args);
  Audit.log({
    actor: ctx.session.userId, action: 'SLA_POLICY_UPDATED',
    entity: 'sla_policies', entityId: policyId,
    before: before, after: params,
  });
  return { success: true, policy_id: policyId };
}

// ── sla.listBreaches ──────────────────────────────────────────────────────────

function _slaListBreaches_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _slaScopeData_(ctx.session);
  var sql   = 'SELECT * FROM sla_breaches WHERE 1=1';
  var args  = [];
  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND country_code IN (' + ph + ')';
    args = args.concat(scope.countries);
  }
  if (params.entity_type) { sql += ' AND entity_type = ?'; args.push(params.entity_type); }
  if (params.entity_id)   { sql += ' AND entity_id = ?';   args.push(params.entity_id); }
  if (params.breach_type) { sql += ' AND breach_type = ?'; args.push(params.breach_type); }
  sql += ' ORDER BY created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

// ── sla.checkEntity  —  record breach if SLA exceeded ────────────────────────

function _slaCheckEntity_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var entityType = String(params.entity_type || '');
  var entityId   = String(params.entity_id   || '');
  if (!entityType || !entityId) throw new Errors.Validation('entity_type and entity_id required.');

  // Load entity (tickets only for MVP; extend for orders).
  var row = null;
  if (entityType === 'TICKET') {
    var rows = TursoClient.select('SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [entityId]);
    if (!rows.length) throw new Errors.NotFound('Entity not found.');
    row = rows[0];
  } else if (entityType === 'ORDER') {
    var rows = TursoClient.select('SELECT * FROM orders WHERE order_id = ? LIMIT 1', [entityId]);
    if (!rows.length) throw new Errors.NotFound('Entity not found.');
    row = rows[0];
  } else {
    throw new Errors.Validation('entity_type must be TICKET or ORDER.');
  }

  var scope = _slaScopeData_(ctx.session);
  if (!scope.isGlobal && row.country_code && scope.countries.indexOf(row.country_code) === -1) {
    throw new Errors.NotFound('Entity not found.');
  }

  var policy = _matchSlaPolicy_(entityType, row.priority || 'MEDIUM', row.country_code);
  if (!policy) return { breaches: [], policy_found: false };

  var now       = new Date();
  var createdAt = new Date(row.created_at);
  var breaches  = [];

  function _checkBreachType_(breachType, minutes) {
    if (!minutes || minutes <= 0) return;
    var dueAt  = new Date(createdAt.getTime() + minutes * 60000);
    if (now <= dueAt) return;
    // Already logged?
    var existing = TursoClient.select(
      'SELECT breach_id FROM sla_breaches WHERE entity_type = ? AND entity_id = ? AND breach_type = ? LIMIT 1',
      [entityType, entityId, breachType]
    );
    if (existing.length) return;
    var breachId = genId('BRH');
    var ts       = nowIso();
    TursoClient.write(
      'INSERT INTO sla_breaches (breach_id, entity_type, entity_id, policy_id, breach_type, ' +
      'due_at, breached_at, country_code, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [breachId, entityType, entityId, policy.policy_id, breachType,
       dueAt.toISOString(), ts, row.country_code || '', ts]
    );
    Audit.log({
      actor: ctx.session.userId, action: 'SLA_BREACH_RECORDED',
      entity: 'sla_breaches', entityId: breachId,
      after: { entity_type: entityType, entity_id: entityId, breach_type: breachType },
    });
    breaches.push({ breach_type: breachType, due_at: dueAt.toISOString(), breach_id: breachId });
  }

  _checkBreachType_('RESPONSE',   policy.response_minutes);
  _checkBreachType_('RESOLUTION', policy.resolution_minutes);

  return { breaches: breaches, policy_found: true, policy_id: policy.policy_id };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerSla_() {
  register({ service: 'sla', action: 'listPolicies',  permission: 'order.view',   handler: _slaListPolicies_ });
  register({ service: 'sla', action: 'createPolicy',  permission: 'order.manage', handler: _slaCreatePolicy_ });
  register({ service: 'sla', action: 'updatePolicy',  permission: 'order.manage', handler: _slaUpdatePolicy_ });
  register({ service: 'sla', action: 'listBreaches',  permission: 'order.view',   handler: _slaListBreaches_ });
  register({ service: 'sla', action: 'checkEntity',   permission: 'order.view',   handler: _slaCheckEntity_ });
})();
