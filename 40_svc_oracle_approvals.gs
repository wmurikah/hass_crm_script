/**
 * 40_svc_oracle_approvals.gs  -  Hass CMS  (Oracle PO / SO / LA timing)
 *
 * App facing surface for the approval-timing feature. Every aggregation runs in
 * Turso; the client only renders. All actions flow through processRequest and
 * are permission gated by the dispatcher.
 *
 * Reads  (order.view):  charts, leaderboard, list, getDoc, stuck, listTargets
 * Writes (order.manage): upload, addComment, upsertTarget, deactivateTarget,
 *                        getIntegrationConfig, saveIntegrationConfig, syncNow
 *
 * Country scope mirrors the dashboard: GLOBAL roles see all; COUNTRY roles see
 * their countries. Rows with no country (PO has none in the source) are visible
 * to everyone, matching the existing activity-feed convention.
 */

var T_OA_HEAD     = 'oracle_approvals';
var T_OA_STEP     = 'oracle_approval_steps';
var T_OA_COMMENTS = 'oracle_approval_comments';
var T_OA_TARGETS  = 'oracle_approval_targets';

// ── Scope ───────────────────────────────────────────────────────────────────

function _oaScope_(session) {
  if (!session) return { isGlobal: false, countries: [] };
  var isGlobal = false;
  try {
    var r = TursoClient.select('SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [session.role || '']);
    isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
  } catch (_) {}
  if (isGlobal) return { isGlobal: true, countries: [] };
  var countries = [String(session.countryCode || '').trim()].filter(Boolean);
  try {
    var u = TursoClient.select('SELECT countries_access FROM users WHERE user_id = ? LIMIT 1', [session.userId]);
    if (u.length && u[0].countries_access) {
      String(u[0].countries_access).split(',').forEach(function (c) {
        var t = c.trim();
        if (t && countries.indexOf(t) === -1) countries.push(t);
      });
    }
  } catch (_) {}
  return { isGlobal: false, countries: countries };
}

// ── Resolved real column names (introspected, memoised) ─────────────────────

var _oaQcache_ = null;
function _oaQ_() {
  if (_oaQcache_) return _oaQcache_;
  function pk(table) {
    var col = null, auto = false;
    try {
      TursoClient.select('PRAGMA table_info(' + table + ')').forEach(function (r) {
        if (parseInt(r.pk, 10) >= 1 && !col) { col = String(r.name); auto = String(r.type || '').toUpperCase().indexOf('INT') !== -1; }
      });
    } catch (_) {}
    return { col: col, auto: auto };
  }
  var head = {
    pk: pk(T_OA_HEAD).col,
    doc_type: SchemaIntrospect.pick(T_OA_HEAD, ['doc_type']),
    doc_number: SchemaIntrospect.pick(T_OA_HEAD, ['doc_number']),
    description: SchemaIntrospect.pick(T_OA_HEAD, ['description']),
    nature: SchemaIntrospect.pick(T_OA_HEAD, ['nature']),
    affiliate: SchemaIntrospect.pick(T_OA_HEAD, ['affiliate']),
    country_code: SchemaIntrospect.pick(T_OA_HEAD, ['country_code']),
    customer_code: SchemaIntrospect.pick(T_OA_HEAD, ['customer_code']),
    customer_name: SchemaIntrospect.pick(T_OA_HEAD, ['customer_name']),
    created_by: SchemaIntrospect.pick(T_OA_HEAD, ['created_by']),
    original_creation_date: SchemaIntrospect.pick(T_OA_HEAD, ['original_creation_date']),
    submission_date: SchemaIntrospect.pick(T_OA_HEAD, ['submission_date']),
    final_status: SchemaIntrospect.pick(T_OA_HEAD, ['final_status']),
    source: SchemaIntrospect.pick(T_OA_HEAD, ['source']),
    source_batch_id: SchemaIntrospect.pick(T_OA_HEAD, ['source_batch_id'])
  };
  var step = {
    pk: pk(T_OA_STEP),
    approval_id: SchemaIntrospect.pick(T_OA_STEP, ['approval_id']),
    doc_type: SchemaIntrospect.pick(T_OA_STEP, ['doc_type']),
    doc_number: SchemaIntrospect.pick(T_OA_STEP, ['doc_number']),
    step_no: SchemaIntrospect.pick(T_OA_STEP, ['step_no', 'step_number']),
    step_type: SchemaIntrospect.pick(T_OA_STEP, ['step_type']),
    stage_label: SchemaIntrospect.pick(T_OA_STEP, ['stage_label', 'stage']),
    approver_name: SchemaIntrospect.pick(T_OA_STEP, ['approver_name', 'approver']),
    step_date: SchemaIntrospect.pick(T_OA_STEP, ['step_date']),
    prior_date: SchemaIntrospect.pick(T_OA_STEP, ['prior_date']),
    duration_minutes: SchemaIntrospect.pick(T_OA_STEP, ['duration_minutes', 'duration_mins', 'duration']),
    source_variance: SchemaIntrospect.pick(T_OA_STEP, ['source_variance', 'variance']),
    is_pending: SchemaIntrospect.pick(T_OA_STEP, ['is_pending'])
  };
  _oaQcache_ = { head: head, step: step };
  return _oaQcache_;
}

// Join steps (s) to header (h): prefer the denormalised doc keys, else approval_id.
function _oaJoinOn_(Q) {
  if (Q.head.doc_type && Q.head.doc_number && Q.step.doc_type && Q.step.doc_number) {
    return 'h.' + Q.head.doc_type + ' = s.' + Q.step.doc_type + ' AND h.' + Q.head.doc_number + ' = s.' + Q.step.doc_number;
  }
  if (Q.head.pk && Q.step.approval_id) return 'h.' + Q.head.pk + ' = s.' + Q.step.approval_id;
  return null;
}

// Country scope predicate on header alias h (null country stays visible to all).
function _oaScopeClause_(Q, scope) {
  var cc = Q.head.country_code;
  if (!cc || scope.isGlobal) return { clause: '', args: [] };
  if (!scope.countries.length) return { clause: ' AND (h.' + cc + ' IS NULL OR h.' + cc + " = '')", args: [] };
  var ph = scope.countries.map(function () { return '?'; }).join(',');
  return { clause: ' AND (h.' + cc + ' IN (' + ph + ') OR h.' + cc + ' IS NULL OR h.' + cc + " = '')", args: scope.countries.slice() };
}

// Completed, usable step predicate (non pending, real positive duration).
function _oaDone_(Q) {
  var d = Q.step.duration_minutes;
  var p = Q.step.is_pending;
  return (p ? 's.' + p + ' = 0 AND ' : '') + 's.' + d + ' IS NOT NULL AND s.' + d + ' >= 0';
}

// ── upload ──────────────────────────────────────────────────────────────────

function _oaUpload_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var file = {
    filename:      String(params.filename || ''),
    mimeType:      String(params.mimeType || ''),
    contentBase64: params.contentBase64 || params.content || ''
  };
  if (!file.contentBase64) throw new Errors.Validation('Choose a CSV or Excel file to upload.');

  var batchId = genId('OAUP');
  var summary = OracleApprovalsLoader.loadFromFile(file, { source: 'UPLOAD', batchId: batchId });
  _oaQcache_ = null;   // schema may have just been touched; drop the per-request resolve

  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_UPLOAD',
    entity: T_OA_HEAD, entityId: summary.batchId || batchId,
    metadata: { filename: file.filename, docType: summary.docType,
                documents: summary.documents, steps: summary.steps, skipped: (summary.skipped || []).length }
  });
  return summary;
}

// ── charts ──────────────────────────────────────────────────────────────────
//
// Three backend aggregations, calculation entirely in SQL:
//   poByApprover  - avg APPROVAL time per approver (PO), optional stage filter
//   soByApprover  - avg APPROVAL time per approver (SO)
//   laOverTime    - avg LA cycle time per month (line)
//   laByAffiliate - avg LA cycle time per affiliate/country (bar)
// LA carries no officer in the extract, so it is a cycle-time metric only.
function _oaCharts_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var Q = _oaQ_();
  var join = _oaJoinOn_(Q);
  if (!join || !Q.step.duration_minutes || !Q.step.step_type) {
    return { poByApprover: [], soByApprover: [], laOverTime: [], laByAffiliate: [], poStages: [], note: 'No approval data loaded yet.' };
  }
  var scope = _oaScope_(ctx.session);
  var sc    = _oaScopeClause_(Q, scope);
  var done  = _oaDone_(Q);
  var appr  = Q.step.approver_name, dur = Q.step.duration_minutes, st = Q.step.step_type, dt = Q.step.doc_type;

  // Optional PO stage filter (step_no 1..7).
  var stageNo = parseInt(params.stage, 10);
  var stageClause = '', stageArgs = [];
  if (Q.step.step_no && !isNaN(stageNo) && stageNo >= 1 && stageNo <= 7) {
    stageClause = ' AND s.' + Q.step.step_no + ' = ?'; stageArgs = [stageNo];
  }

  function approverSeries(docType, extraClause, extraArgs) {
    var sql = 'SELECT s.' + appr + ' AS approver, AVG(s.' + dur + ') AS avg_min, COUNT(*) AS cnt ' +
              'FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
              " WHERE s." + st + " = 'APPROVAL' AND s." + dt + " = ? AND " + done +
              ' AND s.' + appr + " IS NOT NULL AND s." + appr + " <> ''" + (extraClause || '') + sc.clause +
              ' GROUP BY s.' + appr + ' ORDER BY avg_min ASC';
    var rows = TursoClient.select(sql, [docType].concat(extraArgs || []).concat(sc.args));
    return rows.map(function (r) { return { approver: r.approver, avg_minutes: Math.round(parseFloat(r.avg_min) || 0), count: parseInt(r.cnt, 10) || 0 }; });
  }

  // Per-approver series need the approver and doc_type columns; degrade to empty
  // (rather than emit invalid SQL) if either is absent on the physical table.
  var canApprover = !!(appr && dt);
  var poByApprover = canApprover ? approverSeries('PO', stageClause, stageArgs) : [];
  var soByApprover = canApprover ? approverSeries('SO', '', []) : [];

  // LA over time (line) and by affiliate/country (bar). Cycle time only.
  var laOverTime = [], laByAffiliate = [];
  if (Q.step.step_date) {
    var laT = TursoClient.select(
      "SELECT strftime('%Y-%m', s." + Q.step.step_date + ") AS ym, AVG(s." + dur + ") AS avg_min, COUNT(*) AS cnt " +
      'FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
      " WHERE s." + st + " = 'LA' AND " + done + ' AND s.' + Q.step.step_date + ' IS NOT NULL' + sc.clause +
      ' GROUP BY ym ORDER BY ym', sc.args);
    laOverTime = laT.map(function (r) { return { month: r.ym, avg_minutes: Math.round(parseFloat(r.avg_min) || 0), count: parseInt(r.cnt, 10) || 0 }; });
  }
  var dimExpr = Q.head.affiliate
    ? "COALESCE(NULLIF(h." + Q.head.affiliate + ", ''), " + (Q.head.country_code ? 'h.' + Q.head.country_code : "''") + ", 'Unknown')"
    : (Q.head.country_code ? "COALESCE(NULLIF(h." + Q.head.country_code + ", ''), 'Unknown')" : "'All'");
  var laA = TursoClient.select(
    'SELECT ' + dimExpr + ' AS label, AVG(s.' + dur + ') AS avg_min, COUNT(*) AS cnt ' +
    'FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
    " WHERE s." + st + " = 'LA' AND " + done + sc.clause +
    ' GROUP BY label ORDER BY avg_min ASC', sc.args);
  laByAffiliate = laA.map(function (r) { return { label: r.label || 'Unknown', avg_minutes: Math.round(parseFloat(r.avg_min) || 0), count: parseInt(r.cnt, 10) || 0 }; });

  // Which PO stages are present (drives the stage filter options).
  var poStages = [];
  if (Q.step.step_no) {
    var ps = TursoClient.select(
      'SELECT DISTINCT s.' + Q.step.step_no + ' AS n FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
      " WHERE s." + dt + " = 'PO' AND s." + st + " = 'APPROVAL'" + sc.clause + ' ORDER BY n', sc.args);
    poStages = ps.map(function (r) { return parseInt(r.n, 10); }).filter(function (n) { return n >= 1 && n <= 7; });
  }

  return { poByApprover: poByApprover, soByApprover: soByApprover, laOverTime: laOverTime, laByAffiliate: laByAffiliate, poStages: poStages };
}

// ── leaderboard ─────────────────────────────────────────────────────────────
//
// Ranks approvers across PO + SO APPROVAL steps by average duration and on-time
// rate against the editable targets. LA is excluded (no officer) and returned
// separately as a cycle-time tile.
function _oaLeaderboard_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var Q = _oaQ_();
  var join = _oaJoinOn_(Q);
  if (!join || !Q.step.duration_minutes || !Q.step.approver_name) {
    return { rows: [], la: { avg_minutes: null, count: 0 }, targetsCount: 0, note: 'No approval data loaded yet.' };
  }
  var scope = _oaScope_(ctx.session);
  var sc    = _oaScopeClause_(Q, scope);
  var done  = _oaDone_(Q);
  var appr  = Q.step.approver_name, dur = Q.step.duration_minutes, st = Q.step.step_type, dt = Q.step.doc_type;

  // Per-row matched target (prefer a target keyed by stage_label, else step_type),
  // taken as MIN target minutes so multiple rows never double count.
  var stageKeys = [Q.step.stage_label, Q.step.step_type].filter(Boolean).map(function (c) { return 's.' + c; });
  var tgtSub = 'NULL';
  var tCols = SchemaIntrospect.columns(T_OA_TARGETS);
  var tHas  = function (c) { return tCols.some(function (x) { return x.toLowerCase() === c; }); };
  if (tHas('doc_type') && tHas('stage') && (tHas('target_minutes') || tHas('minutes')) && stageKeys.length) {
    var tMin = tHas('target_minutes') ? 'target_minutes' : 'minutes';
    var tActive = tHas('is_active') ? ' AND t.is_active = 1' : '';
    tgtSub = '(SELECT MIN(t.' + tMin + ') FROM ' + T_OA_TARGETS + ' t WHERE t.doc_type = s.' + dt +
             ' AND t.stage IN (' + stageKeys.join(', ') + ')' + tActive + ')';
  }

  var sql =
    'SELECT approver, COUNT(*) AS cnt, AVG(dur) AS avg_min, ' +
    'SUM(CASE WHEN tmin IS NOT NULL THEN 1 ELSE 0 END) AS with_target, ' +
    'SUM(CASE WHEN tmin IS NOT NULL AND dur <= tmin THEN 1 ELSE 0 END) AS on_time FROM (' +
      'SELECT s.' + appr + ' AS approver, s.' + dur + ' AS dur, ' + tgtSub + ' AS tmin ' +
      'FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
      " WHERE s." + st + " = 'APPROVAL' AND " + done +
      ' AND s.' + appr + " IS NOT NULL AND s." + appr + " <> ''" + sc.clause +
    ') GROUP BY approver';
  var rows = TursoClient.select(sql, sc.args);

  var out = rows.map(function (r) {
    var withT = parseInt(r.with_target, 10) || 0;
    var onT   = parseInt(r.on_time, 10) || 0;
    return {
      approver:     r.approver,
      count:        parseInt(r.cnt, 10) || 0,
      avg_minutes:  Math.round(parseFloat(r.avg_min) || 0),
      with_target:  withT,
      on_time:      onT,
      on_time_rate: withT ? Math.round(onT * 100 / withT) : null
    };
  });
  // Lower average and higher on-time rate rank higher. Rows with a measured
  // on-time rate sort by it first; ties and untargeted rows fall back to avg asc.
  out.sort(function (a, b) {
    var ar = a.on_time_rate, br = b.on_time_rate;
    if (ar == null && br == null) return a.avg_minutes - b.avg_minutes;
    if (ar == null) return 1;
    if (br == null) return -1;
    if (br !== ar) return br - ar;
    return a.avg_minutes - b.avg_minutes;
  });
  out.forEach(function (r, i) { r.rank = i + 1; });

  // LA cycle-time tile (separate; not a per-person metric).
  var la = { avg_minutes: null, count: 0 };
  var laRows = TursoClient.select(
    'SELECT AVG(s.' + dur + ') AS avg_min, COUNT(*) AS cnt FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
    " WHERE s." + st + " = 'LA' AND " + done + sc.clause, sc.args);
  if (laRows.length) {
    la.count = parseInt(laRows[0].cnt, 10) || 0;
    la.avg_minutes = la.count ? Math.round(parseFloat(laRows[0].avg_min) || 0) : null;
  }

  var targetsCount = 0;
  try { targetsCount = TursoClient.select('SELECT COUNT(*) AS n FROM ' + T_OA_TARGETS + (tHas('is_active') ? ' WHERE is_active = 1' : ''))[0].n; } catch (_) {}
  return { rows: out, la: la, targetsCount: parseInt(targetsCount, 10) || 0 };
}

// ── list (drill-down) ───────────────────────────────────────────────────────

function _oaList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var Q = _oaQ_();
  var join = _oaJoinOn_(Q);
  var scope = _oaScope_(ctx.session);
  var sc    = _oaScopeClause_(Q, scope);
  var limit  = Math.min(parseInt(params.limit, 10) || 25, 200);
  var offset = parseInt(params.offset, 10) || 0;

  var stepFilters = ['approver_name', 'stage', 'step_type', 'pending', 'month'].some(function (k) {
    return params[k] !== undefined && params[k] !== null && params[k] !== '';
  });

  if (stepFilters && join && Q.step.step_type) {
    // Guard every projected column so a missing one becomes NULL rather than
    // invalid SQL (s.null). The reference schema has all of these.
    function sCol(c, alias) { return (c ? 's.' + c : 'NULL') + ' AS ' + alias; }
    var sel = 'SELECT h.*, ' + sCol(Q.step.stage_label, 'm_stage') + ', ' + sCol(Q.step.step_type, 'm_step_type') + ', ' +
              sCol(Q.step.duration_minutes, 'm_duration') + ', ' + sCol(Q.step.approver_name, 'm_approver') + ', ' +
              sCol(Q.step.is_pending, 'm_pending') + ', ' + sCol(Q.step.step_date, 'm_step_date') + ' ' +
              'FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join + ' WHERE 1=1';
    var args = [];
    if (params.doc_type && Q.step.doc_type)           { sel += ' AND s.' + Q.step.doc_type + ' = ?'; args.push(String(params.doc_type)); }
    if (params.approver_name && Q.step.approver_name) { sel += ' AND s.' + Q.step.approver_name + ' = ?'; args.push(String(params.approver_name)); }
    if (params.step_type && Q.step.step_type)         { sel += ' AND s.' + Q.step.step_type + ' = ?'; args.push(String(params.step_type)); }
    if (params.stage && Q.step.step_no && !isNaN(parseInt(params.stage, 10))) { sel += ' AND s.' + Q.step.step_no + ' = ?'; args.push(parseInt(params.stage, 10)); }
    else if (params.stage && Q.step.stage_label)      { sel += ' AND s.' + Q.step.stage_label + ' = ?'; args.push(String(params.stage)); }
    if (params.pending !== undefined && params.pending !== '' && Q.step.is_pending) { sel += ' AND s.' + Q.step.is_pending + ' = ?'; args.push(parseInt(params.pending, 10) ? 1 : 0); }
    if (params.month && Q.step.step_date) { sel += " AND strftime('%Y-%m', s." + Q.step.step_date + ') = ?'; args.push(String(params.month)); }
    if (params.country_code && Q.head.country_code) { sel += ' AND h.' + Q.head.country_code + ' = ?'; args.push(String(params.country_code)); }
    sel += sc.clause; args = args.concat(sc.args);
    sel += ' ORDER BY ' + (Q.step.step_date ? 's.' + Q.step.step_date : 'h.' + (Q.head.original_creation_date || Q.head.doc_number)) + ' DESC';
    sel += ' LIMIT ' + limit + ' OFFSET ' + offset;
    return TursoClient.select(sel, args);
  }

  // Header-only filters: one row per document.
  var sql = 'SELECT h.* FROM ' + T_OA_HEAD + ' h WHERE 1=1';
  var hArgs = [];
  if (params.doc_type && Q.head.doc_type)         { sql += ' AND h.' + Q.head.doc_type + ' = ?'; hArgs.push(String(params.doc_type)); }
  if (params.country_code && Q.head.country_code) { sql += ' AND h.' + Q.head.country_code + ' = ?'; hArgs.push(String(params.country_code)); }
  if (params.q && Q.head.doc_number)              { sql += ' AND h.' + Q.head.doc_number + ' LIKE ?'; hArgs.push('%' + String(params.q) + '%'); }
  sql += sc.clause; hArgs = hArgs.concat(sc.args);
  sql += ' ORDER BY ' + (Q.head.original_creation_date ? 'h.' + Q.head.original_creation_date : 'h.' + Q.head.doc_number) + ' DESC';
  sql += ' LIMIT ' + limit + ' OFFSET ' + offset;
  return TursoClient.select(sql, hArgs);
}

// ── getDoc ──────────────────────────────────────────────────────────────────

function _oaGetDoc_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  return _oaLoadDoc_(ctx.session, params);
}

// Loads a document (header + steps + comments + stuck) with scope enforcement
// but NO permission gate, so callers gated by their own code (getDoc -> view,
// addComment -> manage) can reuse it without imposing order.view on managers.
function _oaLoadDoc_(session, params) {
  var Q = _oaQ_();
  var docType = String(params.doc_type || '');
  var docNumber = String(params.doc_number || '');
  var approvalId = String(params.approval_id || '');

  var head = null;
  if (approvalId && Q.head.pk) {
    var hr = TursoClient.select('SELECT * FROM ' + T_OA_HEAD + ' WHERE ' + Q.head.pk + ' = ? LIMIT 1', [approvalId]);
    head = hr.length ? hr[0] : null;
  }
  if (!head && docType && docNumber && Q.head.doc_type && Q.head.doc_number) {
    var hr2 = TursoClient.select('SELECT * FROM ' + T_OA_HEAD + ' WHERE ' + Q.head.doc_type + ' = ? AND ' + Q.head.doc_number + ' = ? LIMIT 1', [docType, docNumber]);
    head = hr2.length ? hr2[0] : null;
  }
  if (!head) throw new Errors.NotFound('Document not found.');

  // Scope check.
  var scope = _oaScope_(session);
  if (!scope.isGlobal && Q.head.country_code) {
    var cc = head[Q.head.country_code];
    if (cc && scope.countries.indexOf(cc) === -1) throw new Errors.NotFound('Document not found.');
  }

  var dt = head[Q.head.doc_type], dn = head[Q.head.doc_number];
  var steps = [];
  if (Q.step.doc_type && Q.step.doc_number) {
    steps = TursoClient.select(
      'SELECT * FROM ' + T_OA_STEP + ' WHERE ' + Q.step.doc_type + ' = ? AND ' + Q.step.doc_number + ' = ? ' +
      'ORDER BY ' + (Q.step.step_no ? Q.step.step_no : 'rowid'), [dt, dn]);
  } else if (Q.step.approval_id && Q.head.pk) {
    steps = TursoClient.select('SELECT * FROM ' + T_OA_STEP + ' WHERE ' + Q.step.approval_id + ' = ? ORDER BY ' + (Q.step.step_no || 'rowid'), [head[Q.head.pk]]);
  }

  var comments = [];
  try {
    if (SchemaIntrospect.has(T_OA_COMMENTS, 'doc_number')) {
      comments = TursoClient.select('SELECT * FROM ' + T_OA_COMMENTS + ' WHERE doc_type = ? AND doc_number = ? ORDER BY created_at DESC', [dt, dn]);
    }
  } catch (_) {}

  return { header: head, steps: steps, comments: comments, stuck: _oaComputeStuck_(Q, head, steps) };
}

// First pending step on a document, with who is responsible and how long it has waited.
function _oaComputeStuck_(Q, head, steps) {
  var pendCol = Q.step.is_pending, priorCol = Q.step.prior_date, apprCol = Q.step.approver_name, noCol = Q.step.step_no;
  var pending = (steps || []).filter(function (s) { return parseInt(s[pendCol], 10) === 1; });
  if (!pending.length) return null;
  pending.sort(function (a, b) { return (parseInt(a[noCol], 10) || 0) - (parseInt(b[noCol], 10) || 0); });
  var s = pending[0];
  var prior = s[priorCol] ? new Date(s[priorCol]).getTime() : NaN;
  var waiting = isNaN(prior) ? null : Math.max(0, Math.round((Date.now() - prior) / 60000));
  var who = s[apprCol] || (Q.head.created_by ? head[Q.head.created_by] : '') || '';
  return {
    step_type: s[Q.step.step_type], stage_label: s[Q.step.stage_label],
    step_no: s[noCol], responsible: who, waiting_minutes: waiting, prior_date: s[priorCol] || null
  };
}

// ── stuck (all in-flight documents) ─────────────────────────────────────────

function _oaStuck_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var Q = _oaQ_();
  var join = _oaJoinOn_(Q);
  if (!join || !Q.step.is_pending) return [];
  var scope = _oaScope_(ctx.session);
  var sc    = _oaScopeClause_(Q, scope);

  function sCol(c, alias) { return (c ? 's.' + c : 'NULL') + ' AS ' + alias; }
  var sql = 'SELECT h.*, ' + sCol(Q.step.step_no, 's_no') + ', ' + sCol(Q.step.step_type, 's_type') + ', ' +
            sCol(Q.step.stage_label, 's_stage') + ', ' + sCol(Q.step.approver_name, 's_approver') + ', ' +
            sCol(Q.step.prior_date, 's_prior') + ' ' +
            'FROM ' + T_OA_STEP + ' s JOIN ' + T_OA_HEAD + ' h ON ' + join +
            ' WHERE s.' + Q.step.is_pending + ' = 1';
  var args = [];
  if (params.doc_type && Q.step.doc_type) { sql += ' AND s.' + Q.step.doc_type + ' = ?'; args.push(String(params.doc_type)); }
  sql += sc.clause; args = args.concat(sc.args);
  sql += ' LIMIT 2000';
  var rows = TursoClient.select(sql, args);

  // Group by document, keep the FIRST pending step (lowest step_no).
  var byDoc = {}, order = [];
  rows.forEach(function (r) {
    var key = String(r[Q.head.doc_number]) + '|' + String(r[Q.head.doc_type]);
    if (!byDoc[key]) { byDoc[key] = r; order.push(key); }
    else if ((parseInt(r.s_no, 10) || 0) < (parseInt(byDoc[key].s_no, 10) || 0)) byDoc[key] = r;
  });
  var now = Date.now();
  var out = order.map(function (key) {
    var r = byDoc[key];
    var prior = r.s_prior ? new Date(r.s_prior).getTime() : NaN;
    var waiting = isNaN(prior) ? null : Math.max(0, Math.round((now - prior) / 60000));
    return {
      doc_type: r[Q.head.doc_type], doc_number: r[Q.head.doc_number],
      customer_name: Q.head.customer_name ? r[Q.head.customer_name] : '',
      affiliate: Q.head.affiliate ? r[Q.head.affiliate] : '',
      created_by: Q.head.created_by ? r[Q.head.created_by] : '',
      step_type: r.s_type, stage_label: r.s_stage, step_no: r.s_no,
      responsible: r.s_approver || (Q.head.created_by ? r[Q.head.created_by] : '') || '',
      waiting_minutes: waiting
    };
  });
  out.sort(function (a, b) { return (b.waiting_minutes || 0) - (a.waiting_minutes || 0); });
  var limit = Math.min(parseInt(params.limit, 10) || 50, 200);
  var offset = parseInt(params.offset, 10) || 0;
  return out.slice(offset, offset + limit);
}

// ── addComment (records + emails the responsible person) ────────────────────

function _oaAddComment_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var text = String(params.comment_text || params.comment || '').trim();
  if (!text) throw new Errors.Validation('Enter a comment.');

  var doc = _oaLoadDoc_(ctx.session, params);   // scope + stuck, without the order.view gate
  var head = doc.header, Q = _oaQ_();
  var dt = head[Q.head.doc_type], dn = head[Q.head.doc_number];

  // Responsible person: the pending approver, else the document creator.
  var responsibleName = (doc.stuck && doc.stuck.responsible) || (Q.head.created_by ? head[Q.head.created_by] : '') || '';
  var recipientEmail = String(params.recipient_email || '').trim();
  if (!recipientEmail && responsibleName) recipientEmail = _oaResolveEmail_(responsibleName);

  // Dispatch via Microsoft Graph (EmailInteg), recording the outcome honestly.
  var emailStatus = 'SKIPPED';
  if (recipientEmail) {
    try {
      var subject = 'Hass approvals: comment on ' + dt + ' ' + dn;
      var body = '<p>You have a comment on <b>' + dt + ' ' + esc_(dn) + '</b>'
        + (doc.stuck ? ' (pending at <b>' + esc_(doc.stuck.stage_label || doc.stuck.step_type) + '</b>)' : '') + ':</p>'
        + '<blockquote style="border-left:3px solid #C9A227;margin:0;padding:6px 12px;color:#111827">' + esc_(text) + '</blockquote>'
        + '<p style="color:#6b7280;font-size:12px">Sent from Hass CMS approval timing by ' + esc_(ctx.session.userId) + '.</p>';
      EmailInteg.send(recipientEmail, subject, body, text);
      emailStatus = 'SENT';
    } catch (e) {
      emailStatus = 'FAILED';
      Log.warn({ service: 'oracle_approvals', action: 'addComment.email', msg: e.message });
    }
  }

  // Record the comment + dispatch outcome (schema aware).
  var commentId = _oaWriteComment_({
    approval_id: Q.head.pk ? head[Q.head.pk] : null, doc_type: dt, doc_number: dn,
    step_id: null, comment_text: text, author_id: ctx.session.userId, author_name: ctx.session.userId,
    recipient_name: responsibleName || null, recipient_email: recipientEmail || null, email_status: emailStatus
  });

  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_COMMENT',
    entity: T_OA_HEAD, entityId: dt + ' ' + dn,
    metadata: { recipient: responsibleName, emailStatus: emailStatus }
  });

  return {
    comment_id: commentId, emailed: emailStatus === 'SENT', email_status: emailStatus,
    recipient_name: responsibleName, recipient_email: recipientEmail || null
  };
}

function _oaResolveEmail_(name) {
  var n = String(name || '').trim();
  if (!n) return '';
  if (/@/.test(n)) return n;   // already an email
  try {
    var rows = TursoClient.select(
      "SELECT email FROM users WHERE email = ? OR user_id = ? OR lower(first_name || ' ' || last_name) = lower(?) LIMIT 1",
      [n, n, n]);
    if (rows.length && rows[0].email) return rows[0].email;
  } catch (_) {}
  return '';
}

function _oaWriteComment_(obj) {
  var meta = _oaTableMeta_(T_OA_COMMENTS);
  var pairs = [
    [meta.lc['approval_id'], obj.approval_id], [meta.lc['doc_type'], obj.doc_type],
    [meta.lc['doc_number'], obj.doc_number], [meta.lc['step_id'], obj.step_id],
    [meta.lc['comment_text'] || meta.lc['comment'] || meta.lc['body'], obj.comment_text],
    [meta.lc['author_id'] || meta.lc['created_by'], obj.author_id],
    [meta.lc['author_name'], obj.author_name],
    [meta.lc['recipient_name'], obj.recipient_name],
    [meta.lc['recipient_email'], obj.recipient_email],
    [meta.lc['email_status'] || meta.lc['status'], obj.email_status],
    [meta.lc['created_at'], nowIso()]
  ];
  var id = null;
  if (meta.pk && !meta.pkAuto) { id = genId('OAC'); pairs.unshift([meta.pk, id]); }
  var cols = [], qs = [], args = [];
  pairs.forEach(function (p) { if (p[0]) { cols.push(p[0]); qs.push('?'); args.push(p[1]); } });
  if (cols.length) TursoClient.write('INSERT INTO ' + T_OA_COMMENTS + ' (' + cols.join(',') + ') VALUES (' + qs.join(',') + ')', args);
  return id;
}

// ── targets (editable on-time thresholds) ───────────────────────────────────

function _oaListTargets_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql = 'SELECT * FROM ' + T_OA_TARGETS;
  if (SchemaIntrospect.has(T_OA_TARGETS, 'doc_type')) sql += ' ORDER BY doc_type, stage';
  return TursoClient.select(sql, []);
}

function _oaUpsertTarget_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var docType = String(params.doc_type || '').trim().toUpperCase();
  var stage   = String(params.stage || '').trim();
  var minutes = parseFloat(params.target_minutes);
  if (!docType) throw new Errors.Validation('doc_type required (PO or SO).');
  if (!stage)   throw new Errors.Validation('stage required.');
  if (isNaN(minutes) || minutes < 0) throw new Errors.Validation('target_minutes must be a non-negative number.');

  var meta = _oaTableMeta_(T_OA_TARGETS);
  var cDt = meta.lc['doc_type'], cStg = meta.lc['stage'] || meta.lc['stage_label'] || meta.lc['step_type'];
  var cMin = meta.lc['target_minutes'] || meta.lc['minutes'], cAct = meta.lc['is_active'] || meta.lc['active'];
  var now = nowIso();
  var targetId = String(params.target_id || '').trim();

  // Find an existing row by id, or by (doc_type, stage).
  var existing = null;
  if (targetId && meta.pk) {
    var e1 = TursoClient.select('SELECT * FROM ' + T_OA_TARGETS + ' WHERE ' + meta.pk + ' = ? LIMIT 1', [targetId]);
    existing = e1.length ? e1[0] : null;
  }
  if (!existing && cDt && cStg) {
    var e2 = TursoClient.select('SELECT * FROM ' + T_OA_TARGETS + ' WHERE ' + cDt + ' = ? AND ' + cStg + ' = ? LIMIT 1', [docType, stage]);
    existing = e2.length ? e2[0] : null;
  }

  var active = (params.is_active === undefined || params.is_active === null) ? 1 : (parseInt(params.is_active, 10) ? 1 : 0);
  if (existing && meta.pk) {
    var sets = [], args = [];
    if (cMin) { sets.push(cMin + ' = ?'); args.push(minutes); }
    if (cAct) { sets.push(cAct + ' = ?'); args.push(active); }
    if (meta.lc['updated_at']) { sets.push(meta.lc['updated_at'] + ' = ?'); args.push(now); }
    if (cStg) { sets.push(cStg + ' = ?'); args.push(stage); }
    if (cDt)  { sets.push(cDt + ' = ?');  args.push(docType); }
    args.push(existing[meta.pk]);
    TursoClient.write('UPDATE ' + T_OA_TARGETS + ' SET ' + sets.join(', ') + ' WHERE ' + meta.pk + ' = ?', args);
    Audit.log({ actor: ctx.session.userId, action: 'ORACLE_APPROVALS_TARGET_UPSERT', entity: T_OA_TARGETS, entityId: String(existing[meta.pk]),
                after: { doc_type: docType, stage: stage, target_minutes: minutes, is_active: active } });
    return { success: true, target_id: existing[meta.pk], updated: true };
  }

  var id = null, cols = [], qs = [], args2 = [];
  function add(col, val) { if (col) { cols.push(col); qs.push('?'); args2.push(val); } }
  if (meta.pk && !meta.pkAuto) { id = genId('OAT'); add(meta.pk, id); }
  add(cDt, docType); add(cStg, stage); add(cMin, minutes); add(cAct, active);
  add(meta.lc['created_at'], now); add(meta.lc['updated_at'], now);
  if (!cols.length) throw new Errors.Integration('Targets table has no writable columns.');
  TursoClient.write('INSERT INTO ' + T_OA_TARGETS + ' (' + cols.join(',') + ') VALUES (' + qs.join(',') + ')', args2);
  Audit.log({ actor: ctx.session.userId, action: 'ORACLE_APPROVALS_TARGET_CREATE', entity: T_OA_TARGETS, entityId: id || (docType + ':' + stage),
              after: { doc_type: docType, stage: stage, target_minutes: minutes, is_active: active } });
  return { success: true, target_id: id, created: true };
}

function _oaDeactivateTarget_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var targetId = String(params.target_id || '').trim();
  if (!targetId) throw new Errors.Validation('target_id required.');
  var meta = _oaTableMeta_(T_OA_TARGETS);
  if (!meta.pk) throw new Errors.Integration('Targets table has no primary key.');
  var cAct = meta.lc['is_active'] || meta.lc['active'];
  if (!cAct) throw new Errors.Integration('Targets table has no is_active column.');
  var sets = cAct + ' = 0';
  var args = [];
  if (meta.lc['updated_at']) { sets += ', ' + meta.lc['updated_at'] + ' = ?'; args.push(nowIso()); }
  args.push(targetId);
  TursoClient.write('UPDATE ' + T_OA_TARGETS + ' SET ' + sets + ' WHERE ' + meta.pk + ' = ?', args);
  Audit.log({ actor: ctx.session.userId, action: 'ORACLE_APPROVALS_TARGET_DEACTIVATE', entity: T_OA_TARGETS, entityId: targetId });
  return { success: true, target_id: targetId };
}

// ── integration config + sync ───────────────────────────────────────────────

function _oaGetIntegrationConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var cfg = OracleApprovalsConnector.getConfig() || {};
  // Mask secrets on read; the client shows a "set / not set" indicator instead.
  var safe = {
    enabled:        !!cfg.enabled,
    source_type:    cfg.source_type || '',
    endpoint:       cfg.endpoint || '',
    schedule:       cfg.schedule || 'manual',
    username:       cfg.username || '',
    has_secret:     !!cfg.secret,
    has_webhook_secret: !!cfg.webhook_secret,
    notes:          cfg.notes || '',
    connector_ready: false
  };
  try { safe.connector_ready = OracleApprovalsConnector.isConfigured(); } catch (_) {}
  return safe;
}

function _oaSaveIntegrationConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var cur = OracleApprovalsConnector.getConfig() || {};
  var next = {
    enabled:     params.enabled === undefined ? !!cur.enabled : !!params.enabled,
    source_type: String(params.source_type !== undefined ? params.source_type : (cur.source_type || '')),
    endpoint:    String(params.endpoint !== undefined ? params.endpoint : (cur.endpoint || '')),
    schedule:    String(params.schedule !== undefined ? params.schedule : (cur.schedule || 'manual')),
    username:    String(params.username !== undefined ? params.username : (cur.username || '')),
    notes:       String(params.notes !== undefined ? params.notes : (cur.notes || '')),
    // Secrets: keep the existing value unless a new non-empty one is supplied.
    secret:         (params.secret !== undefined && params.secret !== '') ? String(params.secret) : (cur.secret || ''),
    webhook_secret: (params.webhook_secret !== undefined && params.webhook_secret !== '') ? String(params.webhook_secret) : (cur.webhook_secret || '')
  };
  OracleApprovalsConnector.saveConfig(next);
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_INTEGRATION_SAVE', entity: 'integration_config', entityId: OracleApprovalsConnector.CONFIG_KEY,
    metadata: { enabled: next.enabled, source_type: next.source_type, schedule: next.schedule, endpoint: next.endpoint }
  });
  return _oaGetIntegrationConfig_(ctx, params);
}

function _oaSyncNow_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var summary = OracleApprovalsLoader.syncFromIntegration(ctx.session.userId);
  _oaQcache_ = null;
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_SYNC', entity: T_OA_HEAD, entityId: 'manual',
    metadata: { documents: summary.documents, steps: summary.steps }
  });
  return summary;
}

// ── small shared helpers ─────────────────────────────────────────────────────

function _oaTableMeta_(table) {
  var lc = {}, pk = null, pkAuto = false;
  try {
    TursoClient.select('PRAGMA table_info(' + table + ')').forEach(function (r) {
      var name = String(r.name);
      lc[name.toLowerCase()] = name;
      if (parseInt(r.pk, 10) >= 1 && !pk) { pk = name; pkAuto = String(r.type || '').toUpperCase().indexOf('INT') !== -1; }
    });
  } catch (_) {}
  return { lc: lc, pk: pk, pkAuto: pkAuto };
}

// Minimal server-side HTML escape for the email body (client has its own esc()).
function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerOracleApprovals_() {
  register({ service: 'oracleApprovals', action: 'upload',                permission: 'order.manage', handler: _oaUpload_ });
  register({ service: 'oracleApprovals', action: 'charts',                permission: 'order.view',   handler: _oaCharts_ });
  register({ service: 'oracleApprovals', action: 'leaderboard',           permission: 'order.view',   handler: _oaLeaderboard_ });
  register({ service: 'oracleApprovals', action: 'list',                  permission: 'order.view',   handler: _oaList_ });
  register({ service: 'oracleApprovals', action: 'getDoc',                permission: 'order.view',   handler: _oaGetDoc_ });
  register({ service: 'oracleApprovals', action: 'stuck',                 permission: 'order.view',   handler: _oaStuck_ });
  register({ service: 'oracleApprovals', action: 'addComment',            permission: 'order.manage', handler: _oaAddComment_ });
  register({ service: 'oracleApprovals', action: 'listTargets',           permission: 'order.view',   handler: _oaListTargets_ });
  register({ service: 'oracleApprovals', action: 'upsertTarget',          permission: 'order.manage', handler: _oaUpsertTarget_ });
  register({ service: 'oracleApprovals', action: 'deactivateTarget',      permission: 'order.manage', handler: _oaDeactivateTarget_ });
  register({ service: 'oracleApprovals', action: 'getIntegrationConfig',  permission: 'order.manage', handler: _oaGetIntegrationConfig_ });
  register({ service: 'oracleApprovals', action: 'saveIntegrationConfig', permission: 'order.manage', handler: _oaSaveIntegrationConfig_ });
  register({ service: 'oracleApprovals', action: 'syncNow',               permission: 'order.manage', handler: _oaSyncNow_ });
})();
