/**
 * 60_integ_oracle_approvals.gs  -  Hass CMS  (Oracle PO / SO / LA timing)
 *
 * The ingestion engine shared by BOTH the upload path and the (later) Oracle
 * integration. It turns a raw PO or SO extract into the typed step model and
 * upserts it into the four oracle_approval* tables. All timing is in minutes.
 *
 *   OracleApprovalsLoader.loadFromFile({filename, mimeType, contentBase64}, opts)
 *   OracleApprovalsLoader.loadFromRows(rows2d, opts)
 *   OracleApprovalsLoader.syncFromIntegration(actor)
 *   OracleApprovalsConnector  - the single pluggable fetch point (NOT faked)
 *
 * Design notes:
 *   - CSV is the primary, fully self contained path (Utilities.parseCsv).
 *   - xlsx / xls are converted server side by importing the bytes to a TEMP
 *     Google Sheet through the Drive REST API, reading the rows, then deleting
 *     the temp sheet. Needs the drive scope (see appsscript.json). If Drive is
 *     unavailable the upload returns a clear message asking for CSV; the CSV
 *     path keeps working regardless.
 *   - The loader is schema aware: it introspects the real columns via
 *     SchemaIntrospect and only writes columns that exist, matching them
 *     against alias lists. A small naming difference on the physical table
 *     therefore degrades gracefully instead of breaking the load.
 *   - Re-uploading the same period UPSERTS by (doc_type, doc_number): the
 *     header is updated in place and its steps are replaced, never duplicated.
 */

var OracleApprovalsLoader = (function () {

  var T_HEAD    = 'oracle_approvals';
  var T_STEP    = 'oracle_approval_steps';
  var ORDINALS  = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH'];
  var MAX_ROWS  = 20000;   // safety cap per upload
  var FLUSH_AT  = 80;      // write statements per Turso batch round-trip

  // ── Affiliate name -> ISO country code (SO mapping) ─────────────────────────
  var _AFFIL_MAP_ = [
    ['SOUTH SUDAN', 'SS'], ['SOUTH AFRICA', 'ZA'], ['KENYA', 'KE'], ['UGANDA', 'UG'],
    ['TANZANIA', 'TZ'], ['RWANDA', 'RW'], ['BURUNDI', 'BI'], ['ETHIOPIA', 'ET'],
    ['SOMALIA', 'SO'], ['ZAMBIA', 'ZM'], ['MALAWI', 'MW'], ['MOZAMBIQUE', 'MZ'],
    ['DRC', 'CD'], ['CONGO', 'CD']
  ];
  function _affiliateToCountry_(affiliate) {
    var u = String(affiliate || '').toUpperCase();
    for (var i = 0; i < _AFFIL_MAP_.length; i++) {
      if (u.indexOf(_AFFIL_MAP_[i][0]) !== -1) return _AFFIL_MAP_[i][1];
    }
    return '';
  }

  // ── Header normalisation + cell access ──────────────────────────────────────
  function _normKey_(s) {
    return String(s == null ? '' : s).toUpperCase().trim()
      .replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  // Build { NORMALISED_HEADER: columnIndex } from the header row.
  function _headerIndex_(headerRow) {
    var idx = {};
    (headerRow || []).forEach(function (h, i) {
      var k = _normKey_(h);
      if (k && idx[k] === undefined) idx[k] = i;
    });
    return idx;
  }
  // First candidate header that exists -> its raw cell value (trimmed string).
  function _cell_(row, hidx, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var c = hidx[candidates[i]];
      if (c !== undefined) {
        var v = row[c];
        if (v === null || v === undefined) return '';
        return (v instanceof Date) ? v : String(v).trim();
      }
    }
    return '';
  }
  function _has_(hidx, candidates) {
    for (var i = 0; i < candidates.length; i++) if (hidx[candidates[i]] !== undefined) return true;
    return false;
  }

  // ── Date parsing (tolerant) -> epoch ms, or NaN ─────────────────────────────
  var _MONTHS_ = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  function _toMs_(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (v instanceof Date) { var t0 = v.getTime(); return isNaN(t0) ? NaN : t0; }
    if (typeof v === 'number') {
      // Excel serial day number (epoch 1899-12-30). Guard to a plausible range.
      if (v > 20000 && v < 90000) return Math.round((v - 25569) * 86400000);
      return NaN;
    }
    var s = String(v).trim();
    if (!s) return NaN;
    // DD-MON-YYYY [HH:MM[:SS]] (Oracle default) or DD-MON-YY
    var m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3})[A-Za-z]*[-\/\s](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m && _MONTHS_[m[2].toUpperCase()] !== undefined) {
      var yr = parseInt(m[3], 10); if (yr < 100) yr += 2000;
      return new Date(yr, _MONTHS_[m[2].toUpperCase()], parseInt(m[1],10),
                      parseInt(m[4]||'0',10), parseInt(m[5]||'0',10), parseInt(m[6]||'0',10)).getTime();
    }
    // DD/MM/YYYY [HH:MM[:SS]] (region exports day first; honour that)
    var d = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
    if (d) {
      var dd = parseInt(d[1],10), mm = parseInt(d[2],10), yy = parseInt(d[3],10);
      if (yy < 100) yy += 2000;
      var hh = parseInt(d[4]||'0',10);
      if (d[7]) { var ap = d[7].toUpperCase(); if (ap === 'PM' && hh < 12) hh += 12; if (ap === 'AM' && hh === 12) hh = 0; }
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return new Date(yy, mm - 1, dd, hh, parseInt(d[5]||'0',10), parseInt(d[6]||'0',10)).getTime();
      }
    }
    // ISO and other native-parseable forms
    var n = Date.parse(s);
    return isNaN(n) ? NaN : n;
  }
  // Normalise a parsed value to an ISO string for storage, or null.
  function _toIso_(v) { var ms = _toMs_(v); return isNaN(ms) ? null : new Date(ms).toISOString(); }
  // step_date - prior_date in whole minutes, or null when either is unknown.
  function _durationMinutes_(stepVal, priorVal) {
    var a = _toMs_(stepVal), b = _toMs_(priorVal);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((a - b) / 60000);
  }

  // ── Schema-aware table metadata (introspected, memoised per invocation) ─────
  var _metaCache_ = {};
  function _meta_(table) {
    if (_metaCache_[table]) return _metaCache_[table];
    var lc = {}, cols = [], pkCol = null, pkAuto = false;
    try {
      var rows = TursoClient.select('PRAGMA table_info(' + table + ')');
      rows.forEach(function (r) {
        var name = String(r.name);
        cols.push(name);
        lc[name.toLowerCase()] = name;
        if (parseInt(r.pk, 10) >= 1 && !pkCol) {
          pkCol  = name;
          pkAuto = String(r.type || '').toUpperCase().indexOf('INT') !== -1; // INTEGER PRIMARY KEY = rowid alias
        }
      });
    } catch (e) {
      try { Logger.log('[OracleApprovalsLoader] meta(' + table + ') failed: ' + e.message); } catch (_) {}
    }
    _metaCache_[table] = { table: table, cols: cols, lc: lc, pkCol: pkCol, pkAuto: pkAuto };
    return _metaCache_[table];
  }
  // Resolve a canonical field to the real column name on the table, or null.
  function _col_(meta, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var real = meta.lc[String(candidates[i]).toLowerCase()];
      if (real) return real;
    }
    return null;
  }
  // Build an INSERT statement from [realCol, value] pairs (skips null columns).
  function _insertStmt_(table, pairs) {
    var cols = [], qs = [], args = [];
    pairs.forEach(function (p) { if (p[0]) { cols.push(p[0]); qs.push('?'); args.push(p[1]); } });
    if (!cols.length) return null;
    return { sql: 'INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + qs.join(',') + ')', args: args };
  }
  // Build an UPDATE statement from [realCol, value] pairs (skips null columns).
  function _updateStmt_(table, pkCol, pkVal, pairs) {
    var sets = [], args = [];
    pairs.forEach(function (p) { if (p[0] && p[0] !== pkCol) { sets.push(p[0] + ' = ?'); args.push(p[1]); } });
    if (!sets.length) return null;
    args.push(pkVal);
    return { sql: 'UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE ' + pkCol + ' = ?', args: args };
  }

  // ── Parse a 2D extract into the canonical document + step model ─────────────
  // Returns { docType, docs: [ { header:{...}, steps:[{...}] } ], skipped:[{row,reason}] }
  function _parseExtract_(rows) {
    if (!rows || rows.length < 2) {
      return { docType: null, docs: [], skipped: [], error: 'The file has no data rows.' };
    }
    var header = rows[0];
    var hidx   = _headerIndex_(header);

    var isPO = _has_(hidx, ['PURCHASE_NUMBER', 'PURCHASE_NO', 'PO_NUMBER', 'PURCHASE']);
    var isSO = _has_(hidx, ['DOCUMENT_NUMBER', 'DOC_NUMBER', 'SO_NUMBER']);
    if (!isPO && !isSO) {
      return { docType: null, docs: [], skipped: [],
               error: 'Could not detect PO or SO. Expected a "purchase Number" column (PO) or a "DOCUMENT_NUMBER" column (SO).' };
    }
    // If both somehow appear, prefer the one that yields a doc number.
    var docType = isPO && !isSO ? 'PO' : (isSO && !isPO ? 'SO' : (isPO ? 'PO' : 'SO'));
    return docType === 'PO' ? _parsePO_(rows, hidx) : _parseSO_(rows, hidx);
  }

  function _parsePO_(rows, hidx) {
    var docs = [], skipped = [];
    for (var r = 1; r < rows.length; r++) {
      if (docs.length >= MAX_ROWS) { skipped.push({ row: r + 1, reason: 'Row cap (' + MAX_ROWS + ') reached.' }); continue; }
      var row = rows[r];
      if (!row || !row.length) continue;
      var docNumber = _cell_(row, hidx, ['PURCHASE_NUMBER', 'PURCHASE_NO', 'PO_NUMBER', 'PURCHASE']);
      docNumber = String(docNumber || '').trim();
      if (!docNumber) { skipped.push({ row: r + 1, reason: 'Missing purchase Number.' }); continue; }

      var submission = _toIso_(_cell_(row, hidx, ['SUBMISSION_FOR_APPROVAL_DATE', 'SUBMISSION_DATE', 'SUBMIT_FOR_APPROVAL_DATE']));
      var header = {
        doc_type:               'PO',
        doc_number:             docNumber,
        description:            String(_cell_(row, hidx, ['REQ_DESCRIPTION', 'DESCRIPTION', 'REQUISITION_DESCRIPTION']) || ''),
        nature:                 String(_cell_(row, hidx, ['NATURE']) || ''),
        original_creation_date: _toIso_(_cell_(row, hidx, ['ORIGINAL_CREATION_DATE', 'CREATION_DATE'])),
        submission_date:        submission,
        created_by:             String(_cell_(row, hidx, ['PURCHASE_ORDER_CREATED_BY', 'PO_CREATED_BY', 'CREATED_BY']) || ''),
        final_status:           String(_cell_(row, hidx, ['AUTHORIZATION_STATUS', 'AUTHORISATION_STATUS', 'STATUS']) || '')
      };

      var steps = [];
      var prevDate = submission;   // k=1 prior is the submission date
      for (var i = 0; i < ORDINALS.length; i++) {
        var ord = ORDINALS[i], n = i + 1;
        var approver = String(_cell_(row, hidx, [ord + '_APPROVER', n + '_APPROVER', 'APPROVER_' + n, 'APPROVER' + n]) || '').trim();
        var rawDate  = _cell_(row, hidx, [ord + '_APPROVAL_DATE', ord + '_APPROVAL_DATE_TIME', n + '_APPROVAL_DATE', 'APPROVAL_DATE_' + n]);
        var variance = String(_cell_(row, hidx, [ord + '_APPROVALS_VARIANCE', ord + '_APPROVAL_VARIANCE', n + '_APPROVALS_VARIANCE', n + '_APPROVAL_VARIANCE']) || '');
        var stepIso  = _toIso_(rawDate);
        var present  = !!approver || !!stepIso;
        if (!present) continue;    // only create steps where an approver OR a date is present

        var pending  = stepIso ? 0 : 1;
        steps.push({
          step_no:          n,
          step_type:        'APPROVAL',
          stage_label:      ord.charAt(0) + ord.slice(1).toLowerCase() + ' Approval',
          approver_name:    approver || null,
          step_date:        stepIso,
          prior_date:       prevDate,
          duration_minutes: stepIso ? _durationMinutes_(stepIso, prevDate) : null,
          source_variance:  variance || null,
          is_pending:       pending
        });
        if (stepIso) prevDate = stepIso;   // chain only advances past completed steps
      }
      docs.push({ header: header, steps: steps });
    }
    return { docType: 'PO', docs: docs, skipped: skipped };
  }

  function _parseSO_(rows, hidx) {
    var skipped = [];
    // SO extracts are line level: collapse to one document per DOCUMENT_NUMBER.
    var order = [], byDoc = {};
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || !row.length) continue;
      var docNumber = String(_cell_(row, hidx, ['DOCUMENT_NUMBER', 'DOC_NUMBER', 'SO_NUMBER']) || '').trim();
      if (!docNumber) { skipped.push({ row: r + 1, reason: 'Missing DOCUMENT_NUMBER.' }); continue; }
      if (!byDoc[docNumber]) {
        if (order.length >= MAX_ROWS) { skipped.push({ row: r + 1, reason: 'Row cap (' + MAX_ROWS + ') reached.' }); continue; }
        byDoc[docNumber] = []; order.push(docNumber);
      }
      byDoc[docNumber].push(row);
    }

    var docs = [];
    order.forEach(function (docNumber) {
      var groupRows = byDoc[docNumber];
      var first = groupRows[0];
      // Header comes from the first line for that document.
      var affiliate = String(_cell_(first, hidx, ['AFFILIATE', 'COMPANY', 'ORGANIZATION', 'ORG_NAME']) || '');
      var header = {
        doc_type:               'SO',
        doc_number:             docNumber,
        affiliate:              affiliate,
        country_code:           _affiliateToCountry_(affiliate),
        customer_code:          String(_cell_(first, hidx, ['CUSTOMER_CODE', 'CUSTOMER_NO', 'CUST_CODE', 'CUSTOMER_NUMBER']) || ''),
        customer_name:          String(_cell_(first, hidx, ['CUSTOMER_NAME', 'CUST_NAME', 'CUSTOMER']) || ''),
        created_by:             String(_cell_(first, hidx, ['USER_NAME', 'CREATED_BY', 'SALES_PERSON']) || ''),
        original_creation_date: _toIso_(_cell_(first, hidx, ['CREATE_DATE_TIME', 'CREATION_DATE', 'CREATE_DATE'])),
        final_status:           String(_cell_(first, hidx, ['APPROVAL_STATUS', 'STATUS']) || '')
      };

      // Pick the line that carries each step's data (first line that has it).
      function pick(cands) {
        for (var i = 0; i < groupRows.length; i++) {
          var v = _cell_(groupRows[i], hidx, cands);
          if (v !== '' && v !== null && v !== undefined) return v;
        }
        return '';
      }
      var createIso  = _toIso_(_cell_(first, hidx, ['CREATE_DATE_TIME', 'CREATION_DATE', 'CREATE_DATE']));
      var approver   = String(pick(['APPROVER', 'APPROVED_BY']) || '').trim();
      var approveIso = _toIso_(pick(['APPROVAL_DATE_TIME', 'APPROVAL_DATE']));
      var financeVar = String(pick(['FINANCE_VARIANCE', 'APPROVAL_VARIANCE']) || '');

      var holdBy     = String(pick(['HOLD_RELEASED_BY', 'CREDIT_HOLD_RELEASED_BY']) || '').trim();
      var holdDate   = _toIso_(pick(['CREDIT_HOLD_DATE', 'HOLD_DATE']));
      var holdRelIso = _toIso_(pick(['CREDIT_HOLD_RELEASE_DATE', 'HOLD_RELEASE_DATE']));
      var creditVar  = String(pick(['CREDIT_VARIANCE', 'CREDIT_HOLD_VARIANCE']) || '');

      var laIso      = _toIso_(pick(['LOADING_AUTHORITY_DATE', 'LA_DATE']));
      var laVar      = String(pick(['LOADING_AUTHORITY_VARIANCE', 'LA_VARIANCE']) || '');

      var invIso     = _toIso_(pick(['INVOICE_CREATION_DATE', 'INVOICE_DATE']));
      var invVar     = String(pick(['INVOICE_VARIANCE']) || '');

      var steps = [];

      // 1. Approval (single)
      if (approver || approveIso) {
        steps.push({
          step_no: 1, step_type: 'APPROVAL', stage_label: 'Approval',
          approver_name: approver || null, step_date: approveIso, prior_date: createIso,
          duration_minutes: approveIso ? _durationMinutes_(approveIso, createIso) : null,
          source_variance: financeVar || null, is_pending: approveIso ? 0 : 1
        });
      }
      // 2. Credit hold release (only when a hold occurred)
      if (holdDate) {
        steps.push({
          step_no: 2, step_type: 'CREDIT_HOLD', stage_label: 'Credit Hold Release',
          approver_name: holdBy || null, step_date: holdRelIso, prior_date: holdDate,
          duration_minutes: holdRelIso ? _durationMinutes_(holdRelIso, holdDate) : null,
          source_variance: creditVar || null, is_pending: holdRelIso ? 0 : 1
        });
      }
      // 3. Loading Authority (cycle time, no officer in the extract)
      if (laIso || approveIso) {
        steps.push({
          step_no: 3, step_type: 'LA', stage_label: 'Loading Authority',
          approver_name: null, step_date: laIso, prior_date: approveIso,
          duration_minutes: laIso ? _durationMinutes_(laIso, approveIso) : null,
          source_variance: laVar || null, is_pending: laIso ? 0 : 1
        });
      }
      // 4. Invoice creation
      if (invIso || approveIso) {
        steps.push({
          step_no: 4, step_type: 'INVOICE', stage_label: 'Invoice',
          approver_name: null, step_date: invIso, prior_date: approveIso,
          duration_minutes: invIso ? _durationMinutes_(invIso, approveIso) : null,
          source_variance: invVar || null, is_pending: invIso ? 0 : 1
        });
      }
      docs.push({ header: header, steps: steps });
    });

    return { docType: 'SO', docs: docs, skipped: skipped };
  }

  // ── Upsert parsed docs into Turso (schema aware, batched) ───────────────────
  function _upsert_(parsed, opts) {
    var source  = (opts && opts.source)  || 'UPLOAD';
    var batchId = (opts && opts.batchId) || genId('OABATCH');
    var now     = nowIso();

    var mh = _meta_(T_HEAD), ms = _meta_(T_STEP);
    if (!mh.cols.length) throw new Errors.Integration('Table ' + T_HEAD + ' was not found in the database.');
    if (!ms.cols.length) throw new Errors.Integration('Table ' + T_STEP + ' was not found in the database.');

    // Resolve real column names once.
    var H = {
      pk:       mh.pkCol,
      doc_type: _col_(mh, ['doc_type']), doc_number: _col_(mh, ['doc_number']),
      description: _col_(mh, ['description']), nature: _col_(mh, ['nature']),
      affiliate: _col_(mh, ['affiliate']), country_code: _col_(mh, ['country_code']),
      customer_code: _col_(mh, ['customer_code']), customer_name: _col_(mh, ['customer_name']),
      created_by: _col_(mh, ['created_by']),
      original_creation_date: _col_(mh, ['original_creation_date']),
      submission_date: _col_(mh, ['submission_date']),
      final_status: _col_(mh, ['final_status']),
      source: _col_(mh, ['source']), source_batch_id: _col_(mh, ['source_batch_id']),
      created_at: _col_(mh, ['created_at']), updated_at: _col_(mh, ['updated_at'])
    };
    var S = {
      pk:          ms.pkCol,
      approval_id: _col_(ms, ['approval_id']),
      doc_type:    _col_(ms, ['doc_type']), doc_number: _col_(ms, ['doc_number']),
      step_no:     _col_(ms, ['step_no', 'step_number']),
      step_type:   _col_(ms, ['step_type']), stage_label: _col_(ms, ['stage_label', 'stage']),
      approver_name: _col_(ms, ['approver_name', 'approver']),
      step_date:   _col_(ms, ['step_date']), prior_date: _col_(ms, ['prior_date']),
      duration_minutes: _col_(ms, ['duration_minutes', 'duration_mins', 'duration']),
      source_variance: _col_(ms, ['source_variance', 'variance']),
      is_pending:  _col_(ms, ['is_pending']),
      created_at:  _col_(ms, ['created_at']), updated_at: _col_(ms, ['updated_at'])
    };
    if (!H.doc_type || !H.doc_number) throw new Errors.Integration(T_HEAD + ' is missing doc_type / doc_number columns.');

    // Pre-load existing header keys so re-uploads update in place (no duplicates).
    var docType  = parsed.docType;
    var existing = {};
    var numbers  = parsed.docs.map(function (d) { return d.header.doc_number; });
    for (var off = 0; off < numbers.length; off += 200) {
      var chunk = numbers.slice(off, off + 200);
      if (!chunk.length) break;
      var ph  = chunk.map(function () { return '?'; }).join(',');
      var sel = 'SELECT ' + (H.pk ? H.pk + ' AS pk, ' : '') + H.doc_number + ' AS dn FROM ' + T_HEAD +
                ' WHERE ' + H.doc_type + ' = ? AND ' + H.doc_number + ' IN (' + ph + ')';
      var rws = TursoClient.select(sel, [docType].concat(chunk));
      rws.forEach(function (x) { existing[String(x.dn)] = (x.pk !== undefined ? x.pk : true); });
    }

    var stmts = [], docIns = 0, docUpd = 0, stepIns = 0;
    function flush() { if (stmts.length) { TursoClient.batch(stmts); stmts = []; } }

    parsed.docs.forEach(function (d) {
      var h = d.header;
      var had = Object.prototype.hasOwnProperty.call(existing, h.doc_number);
      // Stable link id: reuse the existing header PK when present, else mint one
      // (only meaningful when the PK is a TEXT id, which is how the tables ship).
      var linkId = had ? existing[h.doc_number] : (H.pk && !mh.pkAuto ? genId('OA') : null);

      var headPairs = [
        [H.doc_type, h.doc_type], [H.doc_number, h.doc_number],
        [H.description, h.description || null], [H.nature, h.nature || null],
        [H.affiliate, h.affiliate || null], [H.country_code, h.country_code || null],
        [H.customer_code, h.customer_code || null], [H.customer_name, h.customer_name || null],
        [H.created_by, h.created_by || null],
        [H.original_creation_date, h.original_creation_date || null],
        [H.submission_date, h.submission_date || null],
        [H.final_status, h.final_status || null],
        [H.source, source], [H.source_batch_id, batchId], [H.updated_at, now]
      ];

      if (had) {
        var up = _updateStmt_(T_HEAD, H.pk || H.doc_number, (H.pk ? linkId : h.doc_number), headPairs);
        if (up) stmts.push(up);
        docUpd++;
      } else {
        var insPairs = headPairs.concat([[H.created_at, now]]);
        if (H.pk && !mh.pkAuto) insPairs.unshift([H.pk, linkId]);
        var ins = _insertStmt_(T_HEAD, insPairs);
        if (ins) stmts.push(ins);
        docIns++;
      }

      // Replace this document's steps (upsert semantics).
      if (S.doc_type && S.doc_number) {
        stmts.push({ sql: 'DELETE FROM ' + T_STEP + ' WHERE ' + S.doc_type + ' = ? AND ' + S.doc_number + ' = ?',
                     args: [h.doc_type, h.doc_number] });
      } else if (S.approval_id && linkId) {
        stmts.push({ sql: 'DELETE FROM ' + T_STEP + ' WHERE ' + S.approval_id + ' = ?', args: [linkId] });
      }

      d.steps.forEach(function (st) {
        var pairs = [
          [S.approval_id, linkId], [S.doc_type, h.doc_type], [S.doc_number, h.doc_number],
          [S.step_no, st.step_no], [S.step_type, st.step_type], [S.stage_label, st.stage_label],
          [S.approver_name, st.approver_name], [S.step_date, st.step_date], [S.prior_date, st.prior_date],
          [S.duration_minutes, st.duration_minutes], [S.source_variance, st.source_variance],
          [S.is_pending, st.is_pending], [S.created_at, now], [S.updated_at, now]
        ];
        if (S.pk && !ms.pkAuto) pairs.unshift([S.pk, genId('OAS')]);
        var sins = _insertStmt_(T_STEP, pairs);
        if (sins) { stmts.push(sins); stepIns++; }
      });

      if (stmts.length >= FLUSH_AT) flush();
    });
    flush();

    return {
      docType: docType, batchId: batchId, source: source,
      documents: { inserted: docIns, updated: docUpd, total: docIns + docUpd },
      steps: { inserted: stepIns },
      skipped: parsed.skipped || []
    };
  }

  // ── File decoding (CSV native; xlsx/xls via a temp Google Sheet) ────────────
  function _b64ToBytes_(contentBase64) {
    var b64 = String(contentBase64 || '');
    var comma = b64.indexOf('base64,');
    if (comma !== -1) b64 = b64.substring(comma + 7);
    return Utilities.base64Decode(b64);
  }
  function _looksCsv_(filename, mimeType) {
    var f = String(filename || '').toLowerCase();
    var m = String(mimeType || '').toLowerCase();
    if (/\.(xlsx|xls)$/.test(f)) return false;
    return /\.csv$/.test(f) || m.indexOf('csv') !== -1 || m.indexOf('text/plain') !== -1 || (!/\.(xlsx|xls)$/.test(f) && m.indexOf('sheet') === -1);
  }
  function _csvToRows_(bytes) {
    var text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
    return Utilities.parseCsv(text);
  }
  // Convert xlsx/xls -> rows by importing to a TEMP Google Sheet, then delete it.
  function _xlsxToRows_(bytes, filename, mimeType) {
    var token = ScriptApp.getOAuthToken();
    var boundary = 'oa' + Date.now() + Math.floor(Math.random() * 1e6);
    var metadata = { name: 'oa_tmp_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' };
    var pre = Utilities.newBlob(
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + (mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') + '\r\n\r\n'
    ).getBytes();
    var post = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
    var payload = pre.concat(bytes).concat(post);

    var up = UrlFetchApp.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
        method: 'post', contentType: 'multipart/related; boundary=' + boundary,
        headers: { Authorization: 'Bearer ' + token }, payload: payload, muteHttpExceptions: true
      });
    var code = up.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Errors.Integration('Could not convert the spreadsheet (Drive HTTP ' + code +
        '). Please re-export the extract as CSV and upload that. Details: ' + up.getContentText().substring(0, 200));
    }
    var fileId = (JSON.parse(up.getContentText()) || {}).id;
    if (!fileId) throw new Errors.Integration('Spreadsheet conversion returned no file id. Please upload CSV instead.');

    try {
      var sheet  = SpreadsheetApp.openById(fileId).getSheets()[0];
      return sheet.getDataRange().getValues();
    } finally {
      try {
        UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?supportsAllDrives=true',
          { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
      } catch (_) {}
    }
  }

  // ── Public: load from an uploaded file ──────────────────────────────────────
  function loadFromFile(file, opts) {
    if (!file || !file.contentBase64) throw new Errors.Validation('No file content received.');
    var bytes = _b64ToBytes_(file.contentBase64);
    var rows  = _looksCsv_(file.filename, file.mimeType)
      ? _csvToRows_(bytes)
      : _xlsxToRows_(bytes, file.filename, file.mimeType);
    return loadFromRows(rows, opts);
  }

  // ── Public: load from a 2D array (shared by upload and integration) ─────────
  function loadFromRows(rows, opts) {
    var parsed = _parseExtract_(rows);
    if (parsed.error) throw new Errors.Validation(parsed.error);
    if (!parsed.docs.length) {
      return { docType: parsed.docType, documents: { inserted: 0, updated: 0, total: 0 },
               steps: { inserted: 0 }, skipped: parsed.skipped || [] };
    }
    return _upsert_(parsed, opts);
  }

  // ── Public: run the integration pull (uses the pluggable connector) ─────────
  function syncFromIntegration(actor) {
    var cfg = OracleApprovalsConnector.getConfig();
    if (!cfg || !cfg.enabled) throw new Errors.Validation('Integration is not enabled. Configure and enable it first.');
    if (!OracleApprovalsConnector.isConfigured()) {
      throw new Errors.Validation('Integration is enabled but not fully configured. Fill in the connection fields.');
    }
    // The connector returns one or more extracts; the SAME loader runs over them.
    var extracts = OracleApprovalsConnector.fetchExtracts(cfg);   // throws if the point is not implemented/reachable
    var summary  = { source: 'INTEGRATION', loads: [], documents: { inserted: 0, updated: 0, total: 0 }, steps: { inserted: 0 }, skipped: [] };
    (extracts || []).forEach(function (rows) {
      var res = loadFromRows(rows, { source: 'INTEGRATION', batchId: genId('OASYNC') });
      summary.loads.push(res);
      summary.documents.inserted += res.documents.inserted;
      summary.documents.updated  += res.documents.updated;
      summary.documents.total    += res.documents.total;
      summary.steps.inserted     += res.steps.inserted;
      summary.skipped = summary.skipped.concat(res.skipped || []);
    });
    return summary;
  }

  return {
    loadFromFile: loadFromFile,
    loadFromRows: loadFromRows,
    syncFromIntegration: syncFromIntegration
  };
})();

/**
 * OracleApprovalsConnector  -  the SINGLE pluggable fetch point.
 *
 * Oracle EBS is typically on-premise behind a firewall and is NOT reachable
 * directly from a cloud Apps Script. So this connector is left as a clearly
 * marked integration point: it stores / reads the connection config, but the
 * actual fetch THROWS until a real connector (a reachable REST endpoint, a
 * shared data store, or the inbound webhook) is slotted in. Nothing here
 * fabricates rows. The upload path does not depend on this in any way.
 *
 * Config (including the source secret and the webhook secret) is stored in
 * Script Properties as JSON, the same place the other integrations keep their
 * credentials (OracleInteg, EmailInteg, etc.). This keeps secrets out of the
 * app-readable `config` table and touches no shared config/RBAC table.
 */
var OracleApprovalsConnector = (function () {

  var CONFIG_KEY = 'ORACLE_APPROVALS_INTEGRATION';

  function getConfig() {
    var raw = null;
    try { raw = PropertiesService.getScriptProperties().getProperty(CONFIG_KEY); } catch (_) {}
    var cfg = raw ? jsonParse(raw, {}) : {};
    return cfg || {};
  }
  function saveConfig(cfg) {
    try { PropertiesService.getScriptProperties().setProperty(CONFIG_KEY, jsonStringify(cfg || {})); } catch (e) {
      throw new Errors.Integration('Could not save integration settings: ' + e.message);
    }
    return getConfig();
  }
  // "Configured" = enough to attempt a pull. Source type + endpoint + secret.
  function isConfigured() {
    var c = getConfig();
    return !!(c && c.enabled && c.source_type && c.endpoint);
  }

  /**
   * fetchExtracts(cfg) -> Array<rows2d>
   *
   * THE PLUGGABLE POINT. Replace the body below with the real connector when
   * Oracle EBS (or its data drop) becomes reachable. It must return one or more
   * 2D arrays (header row + data rows), each shaped like a PO or SO extract, so
   * OracleApprovalsLoader.loadFromRows can run over them unchanged.
   */
  function fetchExtracts(cfg) {
    throw new Errors.Integration(
      'Oracle connector not connected. Oracle EBS is on-premise and not reachable from this cloud script yet. ' +
      'Slot the real fetch into OracleApprovalsConnector.fetchExtracts (or push extracts to the inbound webhook). ' +
      'Until then, use the Upload tab, which works on its own.'
    );
  }

  // ── Inbound webhook ingestion (the one deliberate doPost data path) ─────────
  // Called by 30_router.gs doPost ONLY when the request carries hook=oracle_approvals
  // AND the shared secret matches. It writes solely to the oracle_approval* tables.
  function ingestWebhook(body) {
    var cfg    = getConfig();
    var secret = cfg && cfg.webhook_secret ? String(cfg.webhook_secret) : '';
    var given  = body && (body.secret || body.token) ? String(body.secret || body.token) : '';
    if (!secret) return { ok: false, error: { code: 'WEBHOOK_DISABLED', message: 'Webhook secret is not set.' } };
    if (given !== secret) return { ok: false, error: { code: 'WEBHOOK_FORBIDDEN', message: 'Invalid webhook secret.' } };

    var rows = body && body.rows;   // expects a 2D array (header row + data rows)
    if (!rows || !rows.length) return { ok: false, error: { code: 'WEBHOOK_EMPTY', message: 'No rows in payload.' } };
    try {
      var res = OracleApprovalsLoader.loadFromRows(rows, { source: 'INTEGRATION', batchId: genId('OAHOOK') });
      try {
        Audit.log({ actor: 'SYSTEM', action: 'ORACLE_APPROVALS_WEBHOOK', entity: 'oracle_approvals', entityId: res.batchId,
                    metadata: { docType: res.docType, documents: res.documents, steps: res.steps } });
      } catch (_) {}
      return { ok: true, data: res };
    } catch (e) {
      return { ok: false, error: { code: e.code || 'WEBHOOK_ERROR', message: e.message } };
    }
  }

  return {
    getConfig: getConfig, saveConfig: saveConfig, isConfigured: isConfigured,
    fetchExtracts: fetchExtracts, ingestWebhook: ingestWebhook, CONFIG_KEY: CONFIG_KEY
  };
})();
