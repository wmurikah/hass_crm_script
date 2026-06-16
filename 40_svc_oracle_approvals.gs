/**
 * 40_svc_oracle_approvals.gs  -  Hass CMS  (Oracle PO / SO / LA timing)
 *
 * App facing surface for the approval-timing feature. Every timing calculation
 * runs on the BACKEND (Turso queries or this handler), never in the browser.
 * The two data tables mirror the Oracle extracts one to one:
 *
 *   po_approvals  keyed on purchase_number   (a sequential chain of up to 7 approvers)
 *   so_approvals  keyed on document_number + line_number  (line level; deduped here)
 *
 * Timing rules (the correctness points):
 *   PO per-approver time = the PER-STEP delta of the cumulative *_approvals_variance
 *     columns: variance(k) - variance(k-1), step one measured from submission
 *     (equivalently approval_date(k) - approval_date(k-1)). The leaderboard uses
 *     the per-step delta, NOT the cumulative variance, so later approvers are not
 *     penalised merely for being later in the chain.
 *   SO is deduped to document level first (a multi-line SO must not count its
 *     approval many times). Per document: approval time = finance_variance
 *     (attributed to approver); credit-hold time = credit_variance (attributed to
 *     hold_released_by); LA cycle time = loading_authority_variance (no officer);
 *     invoice time = invoice_variance.
 *
 * Actions (service "oracleApprovals"):
 *   reads  (order.view):  charts, leaderboard, list, getDoc, stuck, getTargets
 *   writes (order.manage): upload, addComment, saveTargets,
 *                          getIntegrationConfig, saveIntegrationConfig, syncNow
 *
 * Country scope: PO carries no affiliate/country in the extract, so PO is
 * group-level (visible to all). SO carries `affiliate`, mapped to a country for
 * scoping; GLOBAL roles see all, country roles see their countries (an unknown
 * affiliate stays group-level, matching the existing activity-feed convention).
 *
 * NOTE on service name: the spec lists the actions under `approvals.*`, but that
 * namespace is already owned by the live internal approval-inbox feature
 * (40_svc_approvals.gs / partial_approvals.html: approvals.inbox/list/get/...).
 * To avoid overriding and breaking that feature, this one registers under
 * `oracleApprovals.*` with the exact action names the spec names. The UI calls
 * the same namespace.
 */

var T_PO_TABLE = 'po_approvals';
var T_SO_TABLE = 'so_approvals';
var T_COMMENTS = 'po_so_comments';
var OA_TARGETS_KEY = 'APPROVALS.ONTIME_TARGETS';
var OA_MAX_SCAN    = 20000;   // cap on PO rows scanned per aggregation
var OA_SO_DOC_CAP  = 50000;   // cap on deduped SO documents per aggregation

var _OA_ORD_      = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
var _OA_ORD_CAP_  = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh'];

// ── Resolved real column names (introspected, memoised per invocation) ────────

var _oaColsCache_ = null;
function _oaCols_() {
  if (_oaColsCache_) return _oaColsCache_;
  function pk(t, c) { return SchemaIntrospect.pick(t, c); }
  var po = {
    pk:                     pk(T_PO_TABLE, ['purchase_number', 'purchase_no', 'po_number']),
    req_description:        pk(T_PO_TABLE, ['req_description', 'description']),
    nature:                 pk(T_PO_TABLE, ['nature']),
    original_creation_date: pk(T_PO_TABLE, ['original_creation_date', 'creation_date']),
    submission:             pk(T_PO_TABLE, ['submission_for_approval_date', 'submission_date']),
    created_by:             pk(T_PO_TABLE, ['purchase_order_created_by', 'created_by']),
    status:                 pk(T_PO_TABLE, ['authorization_status', 'status']),
    approver:      _OA_ORD_.map(function (o) { return pk(T_PO_TABLE, [o + '_approver']); }),
    approval_date: _OA_ORD_.map(function (o) { return pk(T_PO_TABLE, [o + '_approval_date']); }),
    variance:      _OA_ORD_.map(function (o) { return pk(T_PO_TABLE, [o + '_approvals_variance', o + '_approval_variance']); })
  };
  var so = {
    doc:                 pk(T_SO_TABLE, ['document_number', 'doc_number']),
    line:                pk(T_SO_TABLE, ['line_number']),
    affiliate:           pk(T_SO_TABLE, ['affiliate']),
    customer_code:       pk(T_SO_TABLE, ['customer_code']),
    customer_name:       pk(T_SO_TABLE, ['customer_name']),
    user_name:           pk(T_SO_TABLE, ['user_name', 'created_by']),
    create:              pk(T_SO_TABLE, ['create_date_time', 'create_date']),
    approver:            pk(T_SO_TABLE, ['approver']),
    approval_dt:         pk(T_SO_TABLE, ['approval_date_time', 'approval_date']),
    finance_var:         pk(T_SO_TABLE, ['finance_variance']),
    status:              pk(T_SO_TABLE, ['approval_status', 'status']),
    credit_hold_date:    pk(T_SO_TABLE, ['credit_hold_date']),
    credit_hold_name:    pk(T_SO_TABLE, ['credit_hold_name']),
    credit_release_date: pk(T_SO_TABLE, ['credit_hold_release_date']),
    hold_released_by:    pk(T_SO_TABLE, ['hold_released_by']),
    credit_var:          pk(T_SO_TABLE, ['credit_variance']),
    invoice_date:        pk(T_SO_TABLE, ['invoice_creation_date']),
    invoice_var:         pk(T_SO_TABLE, ['invoice_variance']),
    la_date:             pk(T_SO_TABLE, ['loading_authority_date']),
    la_var:              pk(T_SO_TABLE, ['loading_authority_variance'])
  };
  _oaColsCache_ = { po: po, so: so };
  return _oaColsCache_;
}

// ── Small numeric / date helpers (tolerant; dates are stored verbatim) ────────

var _OA_MON_ = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function _oaMs_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (v instanceof Date) { var t = v.getTime(); return isNaN(t) ? NaN : t; }
  if (typeof v === 'number') { return (v > 20000 && v < 90000) ? Math.round((v - 25569) * 86400000) : NaN; }
  var s = String(v).trim(); if (!s) return NaN;
  var m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3})[A-Za-z]*[-\/\s](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && _OA_MON_[m[2].toUpperCase()] !== undefined) {
    var yr = parseInt(m[3], 10); if (yr < 100) yr += 2000;
    return new Date(yr, _OA_MON_[m[2].toUpperCase()], parseInt(m[1], 10), parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10), parseInt(m[6] || '0', 10)).getTime();
  }
  var d = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (d) {
    var dd = parseInt(d[1], 10), mm = parseInt(d[2], 10), yy = parseInt(d[3], 10); if (yy < 100) yy += 2000;
    var hh = parseInt(d[4] || '0', 10);
    if (d[7]) { var ap = d[7].toUpperCase(); if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0; }
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return new Date(yy, mm - 1, dd, hh, parseInt(d[5] || '0', 10), parseInt(d[6] || '0', 10)).getTime();
  }
  var n = Date.parse(s); return isNaN(n) ? NaN : n;
}
function _oaNum_(v) { if (v === null || v === undefined || v === '') return null; var n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }
function _oaMins_(a, b) { var x = _oaMs_(a), y = _oaMs_(b); if (isNaN(x) || isNaN(y)) return null; return Math.round((y - x) / 60000); }
function _oaMonth_(v) { var ms = _oaMs_(v); if (isNaN(ms)) return null; var d = new Date(ms); var mo = d.getUTCMonth() + 1; return d.getUTCFullYear() + '-' + (mo < 10 ? '0' + mo : mo); }
function _oaHas_(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function _isPoFinal_(s) { return /APPROVED|REJECT|CANCEL|COMPLETE|CLOSED/i.test(String(s || '')); }
function _isSoApproved_(s) { return /APPROV|COMPLETE|CLOSED|RELEASED/i.test(String(s || '')); }

// Minimal server-side HTML escape for the email body (client has its own esc()).
function _oaEsc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Country scope (PO is group-level; SO maps affiliate -> country) ───────────

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
        var t = c.trim(); if (t && countries.indexOf(t) === -1) countries.push(t);
      });
    }
  } catch (_) {}
  return { isGlobal: false, countries: countries };
}

var _OA_AFFIL_ = [
  ['SOUTH SUDAN', 'SS'], ['SOUTH AFRICA', 'ZA'], ['KENYA', 'KE'], ['UGANDA', 'UG'],
  ['TANZANIA', 'TZ'], ['RWANDA', 'RW'], ['BURUNDI', 'BI'], ['ETHIOPIA', 'ET'],
  ['SOMALIA', 'SO'], ['ZAMBIA', 'ZM'], ['MALAWI', 'MW'], ['MOZAMBIQUE', 'MZ'],
  ['DRC', 'CD'], ['CONGO', 'CD']
];
function _oaAffilCountry_(affiliate) {
  var u = String(affiliate || '').toUpperCase();
  for (var i = 0; i < _OA_AFFIL_.length; i++) if (u.indexOf(_OA_AFFIL_[i][0]) !== -1) return _OA_AFFIL_[i][1];
  return '';
}
function _soVisible_(affiliate, scope) {
  if (scope.isGlobal) return true;
  var c = _oaAffilCountry_(affiliate);
  if (!c) return true;   // unknown affiliate stays group-level
  return scope.countries.indexOf(c) !== -1;
}

// ── PO per-step computation (the variance-delta calculation) ──────────────────
// Unpivots the 7 (approver, date, variance) triples of one po_approvals row into
// step objects. step_minutes = variance(k) - variance(k-1), step one measured
// from submission. Falls back to the date delta when a variance is missing, and
// never advances the cumulative clock past a still-pending step.
function _poSteps_(row, P) {
  var steps = [];
  var prevVar = 0;
  var prevDate = P.submission ? row[P.submission] : null;
  for (var k = 0; k < 7; k++) {
    var apprCol = P.approver[k], dtCol = P.approval_date[k], vCol = P.variance[k];
    var approver = apprCol ? row[apprCol] : null;
    var dateRaw  = dtCol ? row[dtCol] : null;
    var varRaw   = vCol ? row[vCol] : null;
    approver = (approver == null) ? '' : String(approver).trim();
    var completed = _oaHas_(dateRaw) && !isNaN(_oaMs_(dateRaw));
    var present   = approver !== '' || completed;
    if (!present) continue;   // empty slot in the chain

    var stepNo = k + 1, priorDate = prevDate;
    if (completed) {
      var vNum = _oaNum_(varRaw);
      var stepMin;
      if (vNum != null && vNum >= prevVar) stepMin = vNum - prevVar;       // per-step delta of cumulative variance
      else stepMin = _oaMins_(prevDate, dateRaw);                          // fallback to date delta
      if (stepMin == null || stepMin < 0) stepMin = 0;
      steps.push({
        step_no: stepNo, step_type: 'APPROVAL', stage_label: _OA_ORD_CAP_[k] + ' Approval',
        approver_name: approver || null, step_date: dateRaw, prior_date: priorDate,
        duration_minutes: stepMin, source_variance: (varRaw == null ? null : String(varRaw)), is_pending: 0
      });
      prevVar  = (vNum != null && vNum >= prevVar) ? vNum : (prevVar + stepMin);
      prevDate = dateRaw;
    } else {
      steps.push({
        step_no: stepNo, step_type: 'APPROVAL', stage_label: _OA_ORD_CAP_[k] + ' Approval',
        approver_name: approver || null, step_date: null, prior_date: priorDate,
        duration_minutes: null, source_variance: (varRaw == null ? null : String(varRaw)), is_pending: 1
      });
      // do NOT advance prevVar / prevDate past a pending step
    }
  }
  return steps;
}

function _poHeader_(row, P) {
  var h = {};
  Object.keys(row).forEach(function (k) { h[k] = row[k]; });   // keep raw columns
  h.doc_type = 'PO';
  h.doc_number = P.pk ? row[P.pk] : (row.purchase_number || '');
  h.customer_name = '';
  h.affiliate = '';
  h.created_by = P.created_by ? row[P.created_by] : '';
  h.final_status = P.status ? row[P.status] : '';
  h.original_creation_date = P.original_creation_date ? row[P.original_creation_date] : '';
  h.description = P.req_description ? row[P.req_description] : '';
  h.nature = P.nature ? row[P.nature] : '';
  h.submission_date = P.submission ? row[P.submission] : '';
  return h;
}

// ── SO document dedupe + step computation ─────────────────────────────────────
// _soDocsDeduped_ collapses the line-level extract to one row per document_number
// IN SQL (MAX of each document-level field, identical across a document's lines),
// so a multi-line SO is counted once. Returns rows with stable alias names.
function _soDocsDeduped_(extraWhere, extraArgs, cap) {
  var S = _oaCols_().so;
  if (!S.doc) return [];
  function mx(col, alias) { return (col ? 'MAX(' + col + ')' : 'NULL') + ' AS ' + alias; }
  var sql = 'SELECT ' + S.doc + ' AS document_number, ' +
    mx(S.affiliate, 'affiliate') + ', ' + mx(S.customer_code, 'customer_code') + ', ' + mx(S.customer_name, 'customer_name') + ', ' +
    mx(S.user_name, 'user_name') + ', ' + mx(S.approver, 'approver') + ', ' + mx(S.status, 'status') + ', ' +
    mx(S.create, 'create_dt') + ', ' + mx(S.approval_dt, 'approval_dt') + ', ' + mx(S.finance_var, 'finance_var') + ', ' +
    mx(S.credit_hold_date, 'credit_hold_date') + ', ' + mx(S.credit_hold_name, 'credit_hold_name') + ', ' +
    mx(S.hold_released_by, 'hold_released_by') + ', ' + mx(S.credit_release_date, 'credit_release_date') + ', ' +
    mx(S.credit_var, 'credit_var') + ', ' + mx(S.la_date, 'la_date') + ', ' + mx(S.la_var, 'la_var') + ', ' +
    mx(S.invoice_date, 'invoice_date') + ', ' + mx(S.invoice_var, 'invoice_var') + ', COUNT(*) AS lines ' +
    'FROM ' + T_SO_TABLE + (extraWhere ? ' WHERE ' + extraWhere : '') +
    ' GROUP BY ' + S.doc + ' LIMIT ' + (cap || OA_SO_DOC_CAP);
  return TursoClient.select(sql, extraArgs || []);
}

// Build the typed steps for one deduped SO document row (aliases from above).
function _soSteps_(d) {
  var steps = [];
  var apprDone = _oaHas_(d.approval_dt) || _isSoApproved_(d.status);
  // 1. Approval (single, attributed to approver)
  if (_oaHas_(d.approver) || apprDone || _oaNum_(d.finance_var) != null) {
    var fv = _oaNum_(d.finance_var);
    steps.push({
      step_no: 1, step_type: 'APPROVAL', stage_label: 'Approval', approver_name: d.approver || null,
      step_date: _oaHas_(d.approval_dt) ? d.approval_dt : null, prior_date: d.create_dt || null,
      duration_minutes: apprDone ? (fv != null ? fv : _oaMins_(d.create_dt, d.approval_dt)) : null,
      source_variance: d.finance_var == null ? null : String(d.finance_var), is_pending: apprDone ? 0 : 1
    });
  }
  // 2. Credit hold release (only when a hold occurred; attributed to hold_released_by)
  if (_oaHas_(d.credit_hold_date)) {
    var relDone = _oaHas_(d.credit_release_date);
    var cv = _oaNum_(d.credit_var);
    steps.push({
      step_no: 2, step_type: 'CREDIT_HOLD', stage_label: 'Credit Hold Release',
      approver_name: d.hold_released_by || d.credit_hold_name || null,
      step_date: relDone ? d.credit_release_date : null, prior_date: d.credit_hold_date || null,
      duration_minutes: relDone ? (cv != null ? cv : _oaMins_(d.credit_hold_date, d.credit_release_date)) : null,
      source_variance: d.credit_var == null ? null : String(d.credit_var), is_pending: relDone ? 0 : 1
    });
  }
  // 3. Loading Authority (cycle time, NO officer in the extract)
  if (_oaHas_(d.la_date) || apprDone) {
    var laDone = _oaHas_(d.la_date);
    var lv = _oaNum_(d.la_var);
    steps.push({
      step_no: 3, step_type: 'LA', stage_label: 'Loading Authority', approver_name: null,
      step_date: laDone ? d.la_date : null, prior_date: d.approval_dt || null,
      duration_minutes: laDone ? (lv != null ? lv : _oaMins_(d.approval_dt, d.la_date)) : null,
      source_variance: d.la_var == null ? null : String(d.la_var), is_pending: laDone ? 0 : 1
    });
  }
  // 4. Invoice creation
  if (_oaHas_(d.invoice_date) || apprDone) {
    var invDone = _oaHas_(d.invoice_date);
    var iv = _oaNum_(d.invoice_var);
    steps.push({
      step_no: 4, step_type: 'INVOICE', stage_label: 'Invoice', approver_name: null,
      step_date: invDone ? d.invoice_date : null, prior_date: d.approval_dt || null,
      duration_minutes: invDone ? (iv != null ? iv : _oaMins_(d.approval_dt, d.invoice_date)) : null,
      source_variance: d.invoice_var == null ? null : String(d.invoice_var), is_pending: invDone ? 0 : 1
    });
  }
  return steps;
}

function _soHeader_(d) {
  return {
    doc_type: 'SO', doc_number: d.document_number,
    customer_name: d.customer_name || '', affiliate: d.affiliate || '', created_by: d.user_name || '',
    final_status: d.status || '', original_creation_date: d.create_dt || '', description: '',
    customer_code: d.customer_code || '', lines: d.lines || 0
  };
}

// ── PO row fetch (only the columns the timing maths needs) ────────────────────
function _poRowsCols_(P) {
  var cols = [];
  function add(c) { if (c && cols.indexOf(c) === -1) cols.push(c); }
  add(P.pk); add(P.submission); add(P.original_creation_date); add(P.status); add(P.created_by); add(P.req_description); add(P.nature);
  for (var k = 0; k < 7; k++) { add(P.approver[k]); add(P.approval_date[k]); add(P.variance[k]); }
  return cols;
}
function _poRows_(extraWhere, extraArgs, limit) {
  var P = _oaCols_().po;
  if (!P.pk) return [];
  var cols = _poRowsCols_(P);
  var sql = 'SELECT ' + cols.join(', ') + ' FROM ' + T_PO_TABLE + (extraWhere ? ' WHERE ' + extraWhere : '') +
            ' LIMIT ' + (limit || OA_MAX_SCAN);
  return TursoClient.select(sql, extraArgs || []);
}

// Group a flat measurement list [{key, minutes}] into [{key, avg_minutes, count}] asc.
function _oaAvgBy_(list) {
  var m = {}, order = [];
  list.forEach(function (x) {
    var k = x.key; if (k == null || k === '') return;
    if (!m[k]) { m[k] = { sum: 0, n: 0 }; order.push(k); }
    m[k].sum += x.minutes; m[k].n++;
  });
  var out = order.map(function (k) { return { key: k, avg_minutes: Math.round(m[k].sum / m[k].n), count: m[k].n }; });
  out.sort(function (a, b) { return a.avg_minutes - b.avg_minutes; });
  return out;
}

// ── upload ────────────────────────────────────────────────────────────────────

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
  _oaColsCache_ = null;

  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_UPLOAD',
    entity: summary.table || T_PO_TABLE, entityId: summary.batchId || batchId,
    metadata: { filename: file.filename, docType: summary.docType, rows: summary.rows, documents: summary.documents, skipped: (summary.skipped || []).length }
  });
  return summary;
}

// ── charts (all aggregation on the backend) ──────────────────────────────────

function _oaCharts_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var P = _oaCols_().po;
  var scope = _oaScope_(ctx.session);

  // PO: per-step time per approver (optional stage 1..7), and which stages exist.
  var poMeas = [], stageSet = {};
  if (P.pk) {
    _poRows_('', [], OA_MAX_SCAN).forEach(function (row) {
      _poSteps_(row, P).forEach(function (s) {
        stageSet[s.step_no] = true;
        if (!s.is_pending && s.approver_name && s.duration_minutes != null) {
          poMeas.push({ approver: s.approver_name, step_no: s.step_no, minutes: s.duration_minutes });
        }
      });
    });
  }
  var stageNo = parseInt(params.stage, 10);
  var poF = (!isNaN(stageNo) && stageNo >= 1 && stageNo <= 7) ? poMeas.filter(function (m) { return m.step_no === stageNo; }) : poMeas;
  var poByApprover = _oaAvgBy_(poF.map(function (m) { return { key: m.approver, minutes: m.minutes }; }))
    .map(function (r) { return { approver: r.key, avg_minutes: r.avg_minutes, count: r.count }; });
  var poStages = Object.keys(stageSet).map(Number).filter(function (n) { return n >= 1 && n <= 7; }).sort(function (a, b) { return a - b; });

  // SO: deduped to document level, scope-filtered.
  var soDocs = _soDocsDeduped_('', [], OA_SO_DOC_CAP).filter(function (d) { return _soVisible_(d.affiliate, scope); });
  var soMeas = [], laMonth = {}, laMonthOrder = [], laAff = {}, laAffOrder = [];
  soDocs.forEach(function (d) {
    var fv = _oaNum_(d.finance_var);
    if (_oaHas_(d.approver) && fv != null) soMeas.push({ key: d.approver, minutes: fv });
    var lv = _oaNum_(d.la_var);
    if (_oaHas_(d.la_date) && lv != null) {
      var mo = _oaMonth_(d.la_date);
      if (mo) { if (!laMonth[mo]) { laMonth[mo] = { sum: 0, n: 0 }; laMonthOrder.push(mo); } laMonth[mo].sum += lv; laMonth[mo].n++; }
      var lbl = d.affiliate || d.customer_name || 'Unknown';
      if (!laAff[lbl]) { laAff[lbl] = { sum: 0, n: 0 }; laAffOrder.push(lbl); } laAff[lbl].sum += lv; laAff[lbl].n++;
    }
  });
  var soByApprover = _oaAvgBy_(soMeas).map(function (r) { return { approver: r.key, avg_minutes: r.avg_minutes, count: r.count }; });
  var laOverTime = laMonthOrder.sort().map(function (mo) { return { month: mo, avg_minutes: Math.round(laMonth[mo].sum / laMonth[mo].n), count: laMonth[mo].n }; });
  var laByAffiliate = laAffOrder.map(function (l) { return { label: l, avg_minutes: Math.round(laAff[l].sum / laAff[l].n), count: laAff[l].n }; })
    .sort(function (a, b) { return a.avg_minutes - b.avg_minutes; });

  return { poByApprover: poByApprover, soByApprover: soByApprover, laOverTime: laOverTime, laByAffiliate: laByAffiliate, poStages: poStages };
}

// ── leaderboard (PO per-step + SO document approval, ranked) ──────────────────

function _targetFor_(targets, docType, stageLabel, stepType) {
  var t = targets && targets[docType];
  if (!t) return null;
  if (t[stageLabel] != null && t[stageLabel] !== '') { var a = Number(t[stageLabel]); if (!isNaN(a)) return a; }
  if (t[stepType] != null && t[stepType] !== '') { var b = Number(t[stepType]); if (!isNaN(b)) return b; }
  return null;
}

function _oaLeaderboard_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var cols = _oaCols_(), P = cols.po;
  var scope = _oaScope_(ctx.session);
  var targets = _oaTargetsObj_();

  var meas = [];   // { approver, minutes, target }
  if (P.pk) {
    _poRows_('', [], OA_MAX_SCAN).forEach(function (row) {
      _poSteps_(row, P).forEach(function (s) {
        if (s.step_type === 'APPROVAL' && !s.is_pending && s.approver_name && s.duration_minutes != null) {
          meas.push({ approver: s.approver_name, minutes: s.duration_minutes, target: _targetFor_(targets, 'PO', s.stage_label, 'APPROVAL') });
        }
      });
    });
  }
  var soDocs = _soDocsDeduped_('', [], OA_SO_DOC_CAP).filter(function (d) { return _soVisible_(d.affiliate, scope); });
  var laSum = 0, laN = 0;
  soDocs.forEach(function (d) {
    var fv = _oaNum_(d.finance_var);
    if (_oaHas_(d.approver) && fv != null) meas.push({ approver: d.approver, minutes: fv, target: _targetFor_(targets, 'SO', 'Approval', 'APPROVAL') });
    var lv = _oaNum_(d.la_var);
    if (_oaHas_(d.la_date) && lv != null) { laSum += lv; laN++; }
  });

  // Group by approver.
  var g = {}, order = [];
  meas.forEach(function (x) {
    var k = x.approver; if (!k) return;
    if (!g[k]) { g[k] = { sum: 0, n: 0, withT: 0, on: 0 }; order.push(k); }
    g[k].sum += x.minutes; g[k].n++;
    if (x.target != null) { g[k].withT++; if (x.minutes <= x.target) g[k].on++; }
  });
  var rows = order.map(function (k) {
    var r = g[k];
    return {
      approver: k, count: r.n, avg_minutes: Math.round(r.sum / r.n),
      with_target: r.withT, on_time: r.on,
      on_time_rate: r.withT ? Math.round(r.on * 100 / r.withT) : null
    };
  });
  // Lower average and higher on-time rate rank higher; untargeted rows fall back to avg asc.
  rows.sort(function (a, b) {
    var ar = a.on_time_rate, br = b.on_time_rate;
    if (ar == null && br == null) return a.avg_minutes - b.avg_minutes;
    if (ar == null) return 1;
    if (br == null) return -1;
    if (br !== ar) return br - ar;
    return a.avg_minutes - b.avg_minutes;
  });
  rows.forEach(function (r, i) { r.rank = i + 1; });

  var targetsCount = 0;
  ['PO', 'SO'].forEach(function (dt) { if (targets[dt]) targetsCount += Object.keys(targets[dt]).length; });

  return { rows: rows, la: { avg_minutes: laN ? Math.round(laSum / laN) : null, count: laN }, targetsCount: targetsCount };
}

// ── list (drill-down; server-side paginated) ─────────────────────────────────

function _oaStepMatches_(s, params) {
  if (params.step_type && s.step_type !== String(params.step_type)) return false;
  if (params.approver_name && String(s.approver_name || '') !== String(params.approver_name)) return false;
  if (params.stage !== undefined && params.stage !== null && params.stage !== '') {
    var n = parseInt(params.stage, 10);
    if (!isNaN(n)) { if (s.step_no !== n) return false; }
    else if (String(s.stage_label) !== String(params.stage)) return false;
  }
  if (params.pending !== undefined && params.pending !== '') { if (s.is_pending !== (parseInt(params.pending, 10) ? 1 : 0)) return false; }
  if (params.month) { if (s.is_pending) return false; if (_oaMonth_(s.step_date) !== String(params.month)) return false; }
  return true;
}

function _oaList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var cols = _oaCols_(), P = cols.po;
  var scope = _oaScope_(ctx.session);
  var limit  = Math.min(parseInt(params.limit, 10) || 25, 201);
  var offset = parseInt(params.offset, 10) || 0;
  var docType = String(params.doc_type || '').toUpperCase();

  var stepFilters = ['approver_name', 'stage', 'step_type', 'pending', 'month'].some(function (k) {
    return params[k] !== undefined && params[k] !== null && params[k] !== '';
  });

  var out = [];

  if (stepFilters) {
    // PO steps (skip when explicitly SO, or when filtering for a non-PO step type).
    if (docType !== 'SO' && P.pk && (!params.step_type || String(params.step_type) === 'APPROVAL')) {
      var where = '', args = [];
      if (params.approver_name) {
        var ors = [];
        for (var k = 0; k < 7; k++) { if (P.approver[k]) { ors.push(P.approver[k] + ' = ?'); args.push(String(params.approver_name)); } }
        if (ors.length) where = '(' + ors.join(' OR ') + ')';
      }
      _poRows_(where, args, OA_MAX_SCAN).forEach(function (row) {
        _poSteps_(row, P).forEach(function (s) {
          if (_oaStepMatches_(s, params)) out.push(_oaPoStepResult_(row, P, s));
        });
      });
    }
    // SO steps (skip when explicitly PO). _oaStepMatches_ applies the approver /
    // step_type / stage / month / pending filters per derived step.
    if (docType !== 'PO') {
      _soDocsDeduped_('', [], OA_SO_DOC_CAP).forEach(function (d) {
        if (!_soVisible_(d.affiliate, scope)) return;
        _soSteps_(d).forEach(function (s) {
          if (_oaStepMatches_(s, params)) out.push(_oaSoStepResult_(d, s));
        });
      });
    }
    out.sort(function (a, b) { return (_oaMs_(b.m_step_date) || 0) - (_oaMs_(a.m_step_date) || 0); });
    return out.slice(offset, offset + limit);
  }

  // Header-only browse.
  var q = String(params.q || '').trim();
  if (docType !== 'SO' && P.pk) {
    var pw = '', pa = [];
    if (q) { pw = P.pk + ' LIKE ?'; pa.push('%' + q + '%'); }
    _poRows_(pw, pa, limit + offset + 1).forEach(function (row) { out.push(_oaHeaderResult_(_poHeader_(row, P))); });
  }
  if (docType !== 'PO') {
    var sw = '', sa = [];
    if (q && cols.so.doc) { sw = cols.so.doc + ' LIKE ?'; sa.push('%' + q + '%'); }
    _soDocsDeduped_(sw, sa, limit + offset + 1).forEach(function (d) {
      if (!_soVisible_(d.affiliate, scope)) return;
      out.push(_oaHeaderResult_(_soHeader_(d)));
    });
  }
  out.sort(function (a, b) { return (_oaMs_(b.original_creation_date) || 0) - (_oaMs_(a.original_creation_date) || 0); });
  return out.slice(offset, offset + limit);
}

function _oaPoStepResult_(row, P, s) {
  return {
    doc_type: 'PO', doc_number: P.pk ? row[P.pk] : '',
    customer_name: '', affiliate: '', created_by: P.created_by ? row[P.created_by] : '',
    final_status: P.status ? row[P.status] : '', original_creation_date: P.original_creation_date ? row[P.original_creation_date] : '',
    m_stage: s.stage_label, m_step_type: s.step_type, m_duration: s.duration_minutes,
    m_approver: s.approver_name, m_pending: s.is_pending, m_step_date: s.step_date
  };
}
function _oaSoStepResult_(d, s) {
  return {
    doc_type: 'SO', doc_number: d.document_number,
    customer_name: d.customer_name || '', affiliate: d.affiliate || '', created_by: d.user_name || '',
    final_status: d.status || '', original_creation_date: d.create_dt || '',
    m_stage: s.stage_label, m_step_type: s.step_type, m_duration: s.duration_minutes,
    m_approver: s.approver_name, m_pending: s.is_pending, m_step_date: s.step_date
  };
}
function _oaHeaderResult_(h) {
  return {
    doc_type: h.doc_type, doc_number: h.doc_number, customer_name: h.customer_name || '',
    affiliate: h.affiliate || '', created_by: h.created_by || '', final_status: h.final_status || '',
    original_creation_date: h.original_creation_date || '', description: h.description || ''
  };
}

// ── getDoc (header + steps + comments + stuck) ───────────────────────────────

function _oaGetDoc_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  return _oaLoadDoc_(ctx.session, params);
}

// Loads a document with scope enforcement but NO permission gate, so callers
// gated by their own code (getDoc -> view, addComment -> manage) can reuse it.
function _oaLoadDoc_(session, params) {
  var cols = _oaCols_(), P = cols.po, S = cols.so;
  var docType = String(params.doc_type || '').toUpperCase();
  var docNumber = String(params.doc_number || '');
  if (!docNumber) throw new Errors.Validation('doc_number required.');

  var header = null, steps = null;
  if ((docType === 'PO' || !docType) && P.pk) {
    var pr = TursoClient.select('SELECT * FROM ' + T_PO_TABLE + ' WHERE ' + P.pk + ' = ? LIMIT 1', [docNumber]);
    if (pr.length) { header = _poHeader_(pr[0], P); steps = _poSteps_(pr[0], P); docType = 'PO'; }
  }
  if (!header && (docType === 'SO' || !docType) && S.doc) {
    var dd = _soDocsDeduped_(S.doc + ' = ?', [docNumber], 1);
    if (dd.length) {
      if (!_soVisible_(dd[0].affiliate, _oaScope_(session))) throw new Errors.NotFound('Document not found.');
      header = _soHeader_(dd[0]); steps = _soSteps_(dd[0]); docType = 'SO';
    }
  }
  if (!header) throw new Errors.NotFound('Document not found.');

  var comments = _oaComments_(docType, docNumber);
  var stuck = _oaFirstPending_(docType, header, steps);
  return { header: header, steps: steps, comments: comments, stuck: stuck };
}

// First pending step on a document: pending stage, responsible person, waiting time.
function _oaFirstPending_(docType, header, steps) {
  if (docType === 'PO' && _isPoFinal_(header.final_status)) return null;   // PO must not be final
  var pending = (steps || []).filter(function (s) { return parseInt(s.is_pending, 10) === 1; });
  if (!pending.length) return null;
  pending.sort(function (a, b) { return (parseInt(a.step_no, 10) || 0) - (parseInt(b.step_no, 10) || 0); });
  var s = pending[0];
  var prior = _oaMs_(s.prior_date);
  var waiting = isNaN(prior) ? null : Math.max(0, Math.round((Date.now() - prior) / 60000));
  var who = s.approver_name || header.created_by || '';
  return {
    step_type: s.step_type, stage_label: s.stage_label, step_no: s.step_no,
    responsible: who, waiting_minutes: waiting, prior_date: s.prior_date || null
  };
}

// ── stuck (all in-flight documents) ──────────────────────────────────────────

function _oaStuck_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var cols = _oaCols_(), P = cols.po;
  var scope = _oaScope_(ctx.session);
  var docType = String(params.doc_type || '').toUpperCase();
  var out = [];

  // PO: scan non-final rows, surface the first pending step.
  if (docType !== 'SO' && P.pk) {
    var where = '', args = [];
    if (P.status) {
      where = "(UPPER(COALESCE(" + P.status + ",'')) NOT LIKE 'APPROVED%' AND UPPER(COALESCE(" + P.status + ",'')) NOT LIKE '%REJECT%' " +
              "AND UPPER(COALESCE(" + P.status + ",'')) NOT LIKE '%CANCEL%' AND UPPER(COALESCE(" + P.status + ",'')) NOT LIKE '%COMPLETE%' " +
              "AND UPPER(COALESCE(" + P.status + ",'')) NOT LIKE '%CLOSED%')";
    }
    _poRows_(where, args, OA_MAX_SCAN).forEach(function (row) {
      var header = _poHeader_(row, P);
      var st = _oaFirstPending_('PO', header, _poSteps_(row, P));
      if (st) out.push({
        doc_type: 'PO', doc_number: header.doc_number, customer_name: '', affiliate: '', created_by: header.created_by || '',
        step_type: st.step_type, stage_label: st.stage_label, step_no: st.step_no,
        responsible: st.responsible || '', waiting_minutes: st.waiting_minutes
      });
    });
  }
  // SO: deduped docs, first pending among approval / credit-hold / LA.
  if (docType !== 'PO') {
    _soDocsDeduped_('', [], OA_SO_DOC_CAP).forEach(function (d) {
      if (!_soVisible_(d.affiliate, scope)) return;
      var header = _soHeader_(d);
      var st = _oaFirstPending_('SO', header, _soSteps_(d));
      if (st) out.push({
        doc_type: 'SO', doc_number: d.document_number, customer_name: d.customer_name || '', affiliate: d.affiliate || '',
        created_by: d.user_name || '', step_type: st.step_type, stage_label: st.stage_label, step_no: st.step_no,
        responsible: st.responsible || '', waiting_minutes: st.waiting_minutes
      });
    });
  }
  out.sort(function (a, b) { return (b.waiting_minutes || 0) - (a.waiting_minutes || 0); });
  var limit = Math.min(parseInt(params.limit, 10) || 50, 200);
  var offset = parseInt(params.offset, 10) || 0;
  return out.slice(offset, offset + limit);
}

// ── comments (po_so_comments; created lazily with the migration helper) ──────

var _oaCommentsReady_ = false;
function _oaEnsureComments_() {
  if (_oaCommentsReady_) return;
  TursoClient.write(
    'CREATE TABLE IF NOT EXISTS ' + T_COMMENTS + ' (' +
    ' comment_id TEXT PRIMARY KEY,' +
    ' doc_type TEXT,' +
    ' doc_number TEXT,' +
    ' author_id TEXT,' +
    ' author_name TEXT,' +
    ' recipient TEXT,' +
    ' body TEXT NOT NULL,' +
    ' email_sent INTEGER NOT NULL DEFAULT 0,' +
    ' email_sent_at TEXT,' +
    " created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')'
  );
  _oaCommentsReady_ = true;
}

function _oaComments_(docType, docNumber) {
  try {
    _oaEnsureComments_();
    var rows = TursoClient.select(
      'SELECT * FROM ' + T_COMMENTS + ' WHERE doc_type = ? AND doc_number = ? ORDER BY created_at DESC',
      [docType, docNumber]);
    return rows.map(function (c) {
      return {
        comment_text: c.body, author_name: c.author_name || c.author_id || 'staff', author_id: c.author_id,
        created_at: c.created_at, recipient_email: c.recipient || '',
        email_status: (parseInt(c.email_sent, 10) === 1 ? 'SENT' : 'not sent')
      };
    });
  } catch (e) {
    Log.warn({ service: 'oracle_approvals', action: 'comments', msg: e.message });
    return [];
  }
}

function _oaAddComment_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var text = String(params.comment_text || params.comment || '').trim();
  if (!text) throw new Errors.Validation('Enter a comment.');

  var doc = _oaLoadDoc_(ctx.session, params);   // scope + stuck, without the order.view gate
  var header = doc.header;
  var docType = header.doc_type, docNumber = header.doc_number;

  // Responsible person: the pending approver, else the document creator.
  var responsibleName = (doc.stuck && doc.stuck.responsible) || header.created_by || '';
  var recipientEmail = String(params.recipient_email || '').trim();
  if (!recipientEmail && responsibleName) recipientEmail = _oaResolveEmail_(responsibleName);

  var emailStatus = 'SKIPPED';
  if (recipientEmail) {
    try {
      var subject = 'Hass approvals: comment on ' + docType + ' ' + docNumber;
      var body = '<p>You have a comment on <b>' + docType + ' ' + _oaEsc_(docNumber) + '</b>'
        + (doc.stuck ? ' (pending at <b>' + _oaEsc_(doc.stuck.stage_label || doc.stuck.step_type) + '</b>)' : '') + ':</p>'
        + '<blockquote style="border-left:3px solid #C9A227;margin:0;padding:6px 12px;color:#111827">' + _oaEsc_(text) + '</blockquote>'
        + '<p style="color:#6b7280;font-size:12px">Sent from Hass CMS approval timing by ' + _oaEsc_(ctx.session.userId) + '.</p>';
      EmailInteg.send(recipientEmail, subject, body, text);
      emailStatus = 'SENT';
    } catch (e) {
      emailStatus = 'FAILED';
      Log.warn({ service: 'oracle_approvals', action: 'addComment.email', msg: e.message });
    }
  }

  var commentId = genId('OAC');
  _oaEnsureComments_();
  TursoClient.write(
    'INSERT INTO ' + T_COMMENTS + ' (comment_id, doc_type, doc_number, author_id, author_name, recipient, body, email_sent, email_sent_at, created_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)',
    [commentId, docType, docNumber, ctx.session.userId, _oaDisplayName_(ctx.session.userId), responsibleName || null, text,
     emailStatus === 'SENT' ? 1 : 0, emailStatus === 'SENT' ? nowIso() : null, nowIso()]
  );

  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_COMMENT',
    entity: T_COMMENTS, entityId: docType + ' ' + docNumber,
    metadata: { recipient: responsibleName, recipient_email: recipientEmail || '', emailStatus: emailStatus }
  });

  return {
    comment_id: commentId, emailed: emailStatus === 'SENT', email_status: emailStatus,
    recipient_name: responsibleName, recipient_email: recipientEmail || null
  };
}

function _oaResolveEmail_(name) {
  var n = String(name || '').trim();
  if (!n) return '';
  if (/@/.test(n)) return n;
  try {
    var rows = TursoClient.select(
      "SELECT email FROM users WHERE email = ? OR user_id = ? OR lower(first_name || ' ' || last_name) = lower(?) LIMIT 1",
      [n, n, n]);
    if (rows.length && rows[0].email) return rows[0].email;
  } catch (_) {}
  return '';
}
function _oaDisplayName_(userId) {
  try {
    var rows = TursoClient.select("SELECT first_name, last_name FROM users WHERE user_id = ? OR email = ? LIMIT 1", [userId, userId]);
    if (rows.length) {
      var nm = ((rows[0].first_name || '') + ' ' + (rows[0].last_name || '')).trim();
      if (nm) return nm;
    }
  } catch (_) {}
  return String(userId || 'staff');
}

// ── targets (editable on-time thresholds, stored as JSON in config) ──────────

function _oaTargetsObj_() {
  var obj = Config.getJson(OA_TARGETS_KEY, {}) || {};
  if (!obj.PO) obj.PO = {};
  if (!obj.SO) obj.SO = {};
  return obj;
}

function _oaGetTargets_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var obj = _oaTargetsObj_();
  var list = [];
  ['PO', 'SO'].forEach(function (dt) {
    var t = obj[dt] || {};
    Object.keys(t).forEach(function (stage) { list.push({ doc_type: dt, stage: stage, target_minutes: Number(t[stage]) }); });
  });
  return { targets: obj, list: list };
}

function _oaSaveTargets_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var obj = _oaTargetsObj_();

  if (params.targets && typeof params.targets === 'object') {
    // Full replace (sanitised).
    var next = { PO: {}, SO: {} };
    ['PO', 'SO'].forEach(function (dt) {
      var src = params.targets[dt] || {};
      Object.keys(src).forEach(function (stage) {
        var n = Number(src[stage]);
        if (stage && !isNaN(n) && n >= 0) next[dt][String(stage)] = n;
      });
    });
    obj = next;
  } else {
    var docType = String(params.doc_type || '').trim().toUpperCase();
    var stage   = String(params.stage || '').trim();
    if (docType !== 'PO' && docType !== 'SO') throw new Errors.Validation('doc_type must be PO or SO.');
    if (!stage) throw new Errors.Validation('stage required.');
    if (!obj[docType]) obj[docType] = {};
    if (params.remove) {
      delete obj[docType][stage];
    } else {
      var minutes = parseFloat(params.target_minutes);
      if (isNaN(minutes) || minutes < 0) throw new Errors.Validation('target_minutes must be a non-negative number.');
      obj[docType][stage] = minutes;
    }
  }

  Config.set(OA_TARGETS_KEY, jsonStringify(obj));
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_TARGETS_SAVE', entity: 'config', entityId: OA_TARGETS_KEY,
    after: { targets: obj }
  });
  return _oaGetTargets_(ctx, params);
}

// ── integration config + sync ─────────────────────────────────────────────────

function _oaGetIntegrationConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var cfg = OracleApprovalsConnector.getConfig() || {};
  var safe = {
    enabled: !!cfg.enabled, source_type: cfg.source_type || '', endpoint: cfg.endpoint || '',
    schedule: cfg.schedule || 'manual', username: cfg.username || '',
    has_secret: !!cfg.secret, has_webhook_secret: !!cfg.webhook_secret, notes: cfg.notes || '', connector_ready: false
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
  _oaColsCache_ = null;
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_APPROVALS_SYNC', entity: 'po_approvals', entityId: 'manual',
    metadata: { rows: summary.rows, documents: summary.documents }
  });
  return summary;
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
  register({ service: 'oracleApprovals', action: 'getTargets',            permission: 'order.view',   handler: _oaGetTargets_ });
  register({ service: 'oracleApprovals', action: 'saveTargets',           permission: 'order.manage', handler: _oaSaveTargets_ });
  register({ service: 'oracleApprovals', action: 'getIntegrationConfig',  permission: 'order.manage', handler: _oaGetIntegrationConfig_ });
  register({ service: 'oracleApprovals', action: 'saveIntegrationConfig', permission: 'order.manage', handler: _oaSaveIntegrationConfig_ });
  register({ service: 'oracleApprovals', action: 'syncNow',               permission: 'order.manage', handler: _oaSyncNow_ });
})();
