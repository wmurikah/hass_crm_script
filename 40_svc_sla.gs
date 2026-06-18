/**
 * 40_svc_sla.gs  (Hass CMS rebuild, Stage 5E, SLA-1/SLA-4 rework)
 *
 * SLA threshold management and breach detection, pointed at the REAL model.
 *
 * sla.{listPolicies, createPolicy, updatePolicy, listBreaches, checkEntity}
 *
 * Real model (confirmed by introspection, see reportSlaSchema() below and the
 * working dashboard read in 40_svc_dashboard.gs:_dashSlaCompute_):
 *   sla_config  (sla_id PK, priority, response_minutes, resolve_minutes,
 *                name?, is_active?, country_code?, ...)  one row per priority,
 *                optionally per country. There is NO sla_policies table and NO
 *                entity_type column; thresholds are keyed on priority.
 *   tickets     SLA state lives on the ticket itself:
 *                sla_response_by, sla_resolve_by        (deadlines, stamped at create)
 *                sla_response_breached, sla_resolve_breached (0/1 flags)
 *
 * A breach is recorded as a flag on the ticket (sla_*_breached), never in a
 * separate table. There is NO sla_breaches table.
 *
 * The column names response_minutes / resolve_minutes are resolved ONCE through
 * SchemaIntrospect (_slaCols_), so read and write always agree on the real
 * on-disk spelling. This permanently closes the old resolve_minutes versus
 * resolution_minutes split.
 *
 * Country scope enforced: GLOBAL roles see all; COUNTRY roles see their scope.
 */

// --- Column resolution (introspection driven) -------------------------------

function _slaCols_() {
  // Canonical name first; legacy spellings tolerated so the code adapts to
  // whatever the live table actually has without ever guessing wrong.
  return {
    id:        SchemaIntrospect.pick('sla_config', ['sla_id', 'id']) || 'sla_id',
    priority:  SchemaIntrospect.pick('sla_config', ['priority']) || 'priority',
    response:  SchemaIntrospect.pick('sla_config', ['response_minutes', 'respond_minutes']) || 'response_minutes',
    resolve:   SchemaIntrospect.pick('sla_config', ['resolve_minutes', 'resolution_minutes']) || 'resolve_minutes',
    name:      SchemaIntrospect.pick('sla_config', ['name', 'label']),
    active:    SchemaIntrospect.pick('sla_config', ['is_active']),
    country:   SchemaIntrospect.pick('sla_config', ['country_code']),
    entity:    SchemaIntrospect.pick('sla_config', ['entity_type']),
    createdAt: SchemaIntrospect.pick('sla_config', ['created_at']),
    updatedAt: SchemaIntrospect.pick('sla_config', ['updated_at']),
  };
}

// --- Scope helper -----------------------------------------------------------

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

// --- Match a policy for a priority (+ country) ------------------------------
//
// Reads sla_config only. Returns the matched row aliased to canonical keys
// { sla_id, priority, response_minutes, resolve_minutes } or null. The match
// prefers an exact priority then an exact country over the wildcard rows.

function _matchSlaPolicy_(priority, countryCode) {
  var c  = _slaCols_();
  var pr = String(priority || '').toUpperCase();
  var cc = String(countryCode || '').trim();

  var sel = c.id + ' AS sla_id, ' + c.priority + ' AS priority, ' +
            c.response + ' AS response_minutes, ' + c.resolve + ' AS resolve_minutes';
  var sql = 'SELECT ' + sel + ' FROM sla_config WHERE 1=1';
  var args = [];

  sql += ' AND (' + c.priority + ' = ? OR ' + c.priority + " = 'ALL')";
  args.push(pr);
  if (c.active) sql += ' AND ' + c.active + ' = 1';
  if (c.country) {
    sql += ' AND (' + c.country + ' = ? OR ' + c.country + " = '' OR " + c.country + ' IS NULL)';
    args.push(cc);
  }

  sql += ' ORDER BY CASE WHEN ' + c.priority + ' = ? THEN 0 ELSE 1 END';
  args.push(pr);
  if (c.country) {
    sql += ', CASE WHEN ' + c.country + ' = ? THEN 0 ELSE 1 END';
    args.push(cc);
  }
  sql += ' LIMIT 1';

  var rows = TursoClient.select(sql, args);
  return rows.length ? rows[0] : null;
}

// --- Compute deadlines from the matching policy (shared, reused at create) ---
//
// Global helper reused by ticket create (TKT-1) so the SLA clock starts at
// create. Returns ISO deadline strings (or nulls when no policy matches or a
// minute value is absent). Never throws.

function _slaComputeDeadlines_(priority, countryCode, fromIso) {
  var out = { response_by: null, resolve_by: null, sla_id: null };
  try {
    var p = _matchSlaPolicy_(priority, countryCode);
    if (!p) return out;
    out.sla_id = p.sla_id || null;
    var base = fromIso ? new Date(fromIso) : new Date();
    var rm = parseInt(p.response_minutes, 10);
    var vm = parseInt(p.resolve_minutes, 10);
    if (!isNaN(rm) && rm > 0) out.response_by = addMinutes(base, rm).toISOString();
    if (!isNaN(vm) && vm > 0) out.resolve_by  = addMinutes(base, vm).toISOString();
  } catch (e) {
    try { Log.warn({ service: 'sla', action: 'computeDeadlines', msg: (e && e.message) || String(e) }); } catch (_) {}
  }
  return out;
}

// --- sla.listPolicies -------------------------------------------------------

function _slaListPolicies_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var c     = _slaCols_();
  var scope = _slaScopeData_(ctx.session);

  var sel = [c.id + ' AS sla_id', c.priority + ' AS priority',
             c.response + ' AS response_minutes', c.resolve + ' AS resolve_minutes'];
  if (c.name)    sel.push(c.name + ' AS name');
  if (c.active)  sel.push(c.active + ' AS is_active');
  if (c.country) sel.push(c.country + ' AS country_code');

  var sql  = 'SELECT ' + sel.join(', ') + ' FROM sla_config WHERE 1=1';
  var args = [];
  if (c.country && !scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND (' + c.country + ' IN (' + ph + ') OR ' + c.country + " = '' OR " + c.country + ' IS NULL)';
    args = args.concat(scope.countries);
  }
  if (c.active && params.is_active !== undefined) {
    sql += ' AND ' + c.active + ' = ?'; args.push(params.is_active ? 1 : 0);
  }
  sql += ' ORDER BY ' + c.priority;
  return TursoClient.select(sql, args);
}

// --- sla.createPolicy (upsert by priority + country) ------------------------

function _slaCreatePolicy_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var c = _slaCols_();

  var priority        = String(params.priority || 'ALL').toUpperCase();
  var responseMinutes = parseInt(params.response_minutes, 10);
  // Accept either param spelling from older callers; always store the real column.
  var resolveRaw      = (params.resolve_minutes !== undefined) ? params.resolve_minutes : params.resolution_minutes;
  var resolveMinutes  = parseInt(resolveRaw, 10);
  var countryCode     = (params.country_code && String(params.country_code).trim()) || '';
  var name            = String(params.name || ('SLA ' + priority)).trim();

  if (!priority)                                          throw new Errors.Validation('priority required.');
  if (isNaN(responseMinutes) || responseMinutes < 0)     throw new Errors.Validation('response_minutes must be >= 0.');
  if (isNaN(resolveMinutes)  || resolveMinutes  < 0)     throw new Errors.Validation('resolve_minutes must be >= 0.');

  // If a row for this priority (+ country) already exists, update it instead of
  // inserting a duplicate, so repeated saves from the admin page stay idempotent.
  var existing = _matchSlaPolicyExact_(priority, countryCode);
  if (existing) {
    _slaUpdatePolicy_(ctx, {
      sla_id:           existing.sla_id,
      response_minutes: responseMinutes,
      resolve_minutes:  resolveMinutes,
    });
    return { sla_id: existing.sla_id, priority: priority,
             response_minutes: responseMinutes, resolve_minutes: resolveMinutes, updated: true };
  }

  var slaId = genId('SLA');
  var now   = nowIso();

  var cols = [c.id, c.priority, c.response, c.resolve];
  var ph   = ['?', '?', '?', '?'];
  var vals = [slaId, priority, responseMinutes, resolveMinutes];
  if (c.name)      { cols.push(c.name);      ph.push('?'); vals.push(name); }
  if (c.active)    { cols.push(c.active);    ph.push('?'); vals.push(1); }
  if (c.country)   { cols.push(c.country);   ph.push('?'); vals.push(countryCode); }
  if (c.entity)    { cols.push(c.entity);    ph.push('?'); vals.push('TICKET'); }
  if (c.createdAt) { cols.push(c.createdAt); ph.push('?'); vals.push(now); }
  if (c.updatedAt) { cols.push(c.updatedAt); ph.push('?'); vals.push(now); }

  TursoClient.write(
    'INSERT INTO sla_config (' + cols.join(', ') + ') VALUES (' + ph.join(',') + ')',
    vals
  );
  Audit.log({
    actor: ctx.session.userId, action: 'SLA_POLICY_CREATED',
    entity: 'sla_config', entityId: slaId,
    after: { priority: priority, country_code: countryCode,
             response_minutes: responseMinutes, resolve_minutes: resolveMinutes },
  });
  return { sla_id: slaId, priority: priority,
           response_minutes: responseMinutes, resolve_minutes: resolveMinutes };
}

// Exact-match lookup (no wildcard fallback) used by the upsert path.
function _matchSlaPolicyExact_(priority, countryCode) {
  var c  = _slaCols_();
  var pr = String(priority || '').toUpperCase();
  var cc = String(countryCode || '').trim();
  var sql = 'SELECT ' + c.id + ' AS sla_id FROM sla_config WHERE ' + c.priority + ' = ?';
  var args = [pr];
  if (c.country) {
    sql += ' AND (' + c.country + ' = ? OR (' + c.country + " = '' AND ? = '') OR (" + c.country + ' IS NULL AND ? = \'\'))';
    args.push(cc, cc, cc);
  }
  sql += ' LIMIT 1';
  var rows = TursoClient.select(sql, args);
  return rows.length ? rows[0] : null;
}

// --- sla.updatePolicy -------------------------------------------------------

function _slaUpdatePolicy_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var c     = _slaCols_();
  var slaId = String(params.sla_id || params.policyId || '');
  if (!slaId) throw new Errors.Validation('sla_id required.');

  var rows = TursoClient.select(
    'SELECT ' + c.id + ' AS sla_id FROM sla_config WHERE ' + c.id + ' = ? LIMIT 1', [slaId]
  );
  if (!rows.length) throw new Errors.NotFound('SLA policy not found.');

  // Map incoming logical fields to the real physical columns.
  var setParts = [];
  var args     = [];
  function setCol(col, val) { if (col) { setParts.push(col + ' = ?'); args.push(val); } }

  if (params.response_minutes !== undefined) setCol(c.response, parseInt(params.response_minutes, 10));
  var resolveRaw = (params.resolve_minutes !== undefined) ? params.resolve_minutes
                 : (params.resolution_minutes !== undefined ? params.resolution_minutes : undefined);
  if (resolveRaw !== undefined)              setCol(c.resolve, parseInt(resolveRaw, 10));
  if (params.priority !== undefined)         setCol(c.priority, String(params.priority).toUpperCase());
  if (params.is_active !== undefined)        setCol(c.active, params.is_active ? 1 : 0);
  if (params.country_code !== undefined)     setCol(c.country, String(params.country_code || ''));
  if (params.name !== undefined)             setCol(c.name, String(params.name || ''));

  if (!setParts.length) throw new Errors.Validation('No updatable fields provided.');
  if (c.updatedAt) { setParts.push(c.updatedAt + ' = ?'); args.push(nowIso()); }
  args.push(slaId);

  TursoClient.write('UPDATE sla_config SET ' + setParts.join(', ') + ' WHERE ' + c.id + ' = ?', args);
  Audit.log({
    actor: ctx.session.userId, action: 'SLA_POLICY_UPDATED',
    entity: 'sla_config', entityId: slaId, after: params,
  });
  return { success: true, sla_id: slaId };
}

// --- sla.listBreaches (reads ticket flags; no sla_breaches table) -----------

function _slaListBreaches_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scope = _slaScopeData_(ctx.session);
  var sql   = 'SELECT ticket_id, ticket_number, subject, priority, status, country_code, ' +
              'sla_response_by, sla_resolve_by, sla_response_breached, sla_resolve_breached, ' +
              'created_at FROM tickets WHERE (sla_response_breached = 1 OR sla_resolve_breached = 1)';
  var args  = [];
  if (!scope.isGlobal && scope.countries.length) {
    var ph = scope.countries.map(function () { return '?'; }).join(',');
    sql += ' AND country_code IN (' + ph + ')';
    args = args.concat(scope.countries);
  } else if (!scope.isGlobal) {
    return [];
  }
  if (params.priority) { sql += ' AND priority = ?'; args.push(params.priority); }
  sql += ' ORDER BY created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
  return TursoClient.select(sql, args);
}

// --- sla.checkEntity (flag the breach on the entity, never a side table) ----

function _slaCheckEntity_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var entityType = String(params.entity_type || '').toUpperCase();
  var entityId   = String(params.entity_id   || '');
  if (!entityType || !entityId) throw new Errors.Validation('entity_type and entity_id required.');

  var table, idCol;
  if (entityType === 'TICKET')     { table = 'tickets'; idCol = 'ticket_id'; }
  else if (entityType === 'ORDER') { table = 'orders';  idCol = 'order_id';  }
  else throw new Errors.Validation('entity_type must be TICKET or ORDER.');

  var rows = TursoClient.select('SELECT * FROM ' + table + ' WHERE ' + idCol + ' = ? LIMIT 1', [entityId]);
  if (!rows.length) throw new Errors.NotFound('Entity not found.');
  var row = rows[0];

  var scope = _slaScopeData_(ctx.session);
  if (!scope.isGlobal && row.country_code && scope.countries.indexOf(row.country_code) === -1) {
    throw new Errors.NotFound('Entity not found.');
  }

  var policy = _matchSlaPolicy_(row.priority || 'MEDIUM', row.country_code);
  if (!policy) return { breaches: [], policy_found: false };

  // Resolve the SLA columns that actually exist on this entity's table.
  var respByCol = SchemaIntrospect.pick(table, ['sla_response_by']);
  var respBrCol = SchemaIntrospect.pick(table, ['sla_response_breached']);
  var resByCol  = SchemaIntrospect.pick(table, ['sla_resolve_by']);
  var resBrCol  = SchemaIntrospect.pick(table, ['sla_resolve_breached']);
  var updCol    = SchemaIntrospect.pick(table, ['updated_at']);

  var now      = new Date();
  var created  = new Date(row.created_at);
  var breaches = [];

  function flag(kind, minutes, byCol, brCol) {
    if (!brCol) return;                                   // table cannot record this breach
    if (parseInt(row[brCol], 10) === 1) return;           // already flagged
    var dueIso = (byCol && row[byCol]) ? row[byCol]
               : (minutes && minutes > 0 ? addMinutes(created, minutes).toISOString() : null);
    if (!dueIso) return;
    if (now <= new Date(dueIso)) return;                  // not yet due
    var sets = [brCol + ' = 1'];
    var args = [];
    if (updCol) { sets.push(updCol + ' = ?'); args.push(nowIso()); }
    args.push(entityId);
    TursoClient.write('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE ' + idCol + ' = ?', args);
    Audit.log({
      actor: ctx.session.userId, action: 'SLA_BREACH_FLAGGED',
      entity: table, entityId: entityId,
      after: { breach_type: kind, due_at: dueIso, sla_id: policy.sla_id },
    });
    breaches.push({ breach_type: kind, due_at: dueIso });
  }

  flag('RESPONSE',   parseInt(policy.response_minutes, 10), respByCol, respBrCol);
  flag('RESOLUTION', parseInt(policy.resolve_minutes,  10), resByCol,  resBrCol);

  return { breaches: breaches, policy_found: true, sla_id: policy.sla_id };
}

// --- Introspection report (read only; run from the IDE to capture results) --
//
// reportSlaSchema() returns and logs the live schema this service depends on:
// the columns of sla_config / tickets / ticket_comments and proof that the
// phantom sla_policies / sla_breaches tables do not exist. Used to produce the
// "introspection results" for the PR without guessing column names.

function reportSlaSchema() {
  function tbl(name) {
    try { return SchemaIntrospect.columns(name); } catch (e) { return ['<error: ' + e.message + '>']; }
  }
  function exists(name) {
    try {
      var r = TursoClient.select("SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1", [name]);
      return r.length > 0;
    } catch (e) { return null; }
  }
  var report = {
    sla_config:      tbl('sla_config'),
    tickets:         tbl('tickets'),
    ticket_comments: tbl('ticket_comments'),
    sla_policies_exists: exists('sla_policies'),
    sla_breaches_exists: exists('sla_breaches'),
    resolved_sla_columns: _slaCols_(),
  };
  try { Logger.log(JSON.stringify(report, null, 2)); } catch (_) {}
  return report;
}

// --- Registration -----------------------------------------------------------

(function _registerSla_() {
  register({ service: 'sla', action: 'listPolicies', permission: 'order.view',   handler: _slaListPolicies_ });
  register({ service: 'sla', action: 'createPolicy', permission: 'order.manage', handler: _slaCreatePolicy_ });
  register({ service: 'sla', action: 'updatePolicy', permission: 'order.manage', handler: _slaUpdatePolicy_ });
  register({ service: 'sla', action: 'listBreaches', permission: 'order.view',   handler: _slaListBreaches_ });
  register({ service: 'sla', action: 'checkEntity',  permission: 'order.view',   handler: _slaCheckEntity_ });
})();
