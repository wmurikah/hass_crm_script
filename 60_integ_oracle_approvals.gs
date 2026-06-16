/**
 * 60_integ_oracle_approvals.gs  -  Hass CMS  (Oracle PO / SO / LA timing)
 *
 * The ingestion engine shared by BOTH the upload path and the (later) Oracle
 * integration. It maps a raw PO or SO extract STRAIGHT into the two data tables
 * that mirror the Oracle extracts one to one:
 *
 *   po_approvals  keyed on purchase_number
 *   so_approvals  keyed on document_number + line_number
 *
 * There is NO reshaping and NO normalized step model. Each extract header is
 * snake-cased (for example "purchase Number" -> purchase_number,
 * LOADING_AUTHORITY_VARIANCE -> loading_authority_variance) and written into the
 * matching column. All timing (variance) columns are stored verbatim in MINUTES;
 * dates are stored verbatim as text. The timing maths (per-step PO deltas, SO
 * document dedupe, LA cycle time) is derived later in 40_svc_oracle_approvals.gs.
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
 *   - The loader is schema aware: it introspects the real columns and their
 *     declared types via PRAGMA table_info and only writes columns that exist,
 *     coercing each value to the column's type (REAL / INTEGER / TEXT). A column
 *     present in the extract but absent on the table is simply skipped.
 *   - Re-uploading the same period UPSERTS by primary key: PO by purchase_number,
 *     SO by (document_number, line_number). Rows are updated in place, never
 *     duplicated.
 */

var OracleApprovalsLoader = (function () {

  var T_PO     = 'po_approvals';
  var T_SO     = 'so_approvals';
  var MAX_ROWS = 50000;   // safety cap per upload
  var FLUSH_AT = 80;      // write statements per Turso batch round-trip

  // ── Header snake-case (the one-to-one mapping rule) ─────────────────────────
  // "purchase Number" -> purchase_number ; "LOADING_AUTHORITY_VARIANCE" ->
  // loading_authority_variance. No transformation beyond casing/separators.
  function _snake_(h) {
    return String(h == null ? '' : h)
      .trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
  // Build { snake_header: columnIndex } from the header row (first wins on dupes).
  function _headerIndex_(headerRow) {
    var idx = {};
    (headerRow || []).forEach(function (h, i) {
      var k = _snake_(h);
      if (k && idx[k] === undefined) idx[k] = i;
    });
    return idx;
  }

  // ── Schema-aware table metadata (introspected, memoised per invocation) ─────
  var _metaCache_ = {};
  function _meta_(table) {
    if (_metaCache_[table]) return _metaCache_[table];
    var byLc = {}, names = [], types = {}, pkOrdered = [];
    try {
      var rows = TursoClient.select('PRAGMA table_info(' + table + ')');
      // Collect declared types and primary-key order.
      var pkRows = [];
      rows.forEach(function (r) {
        var name = String(r.name);
        names.push(name);
        byLc[name.toLowerCase()] = name;
        types[name.toLowerCase()] = String(r.type || '').toUpperCase();
        var pk = parseInt(r.pk, 10) || 0;
        if (pk >= 1) pkRows.push({ name: name, ord: pk });
      });
      pkRows.sort(function (a, b) { return a.ord - b.ord; });
      pkOrdered = pkRows.map(function (p) { return p.name; });
    } catch (e) {
      try { Logger.log('[OracleApprovalsLoader] meta(' + table + ') failed: ' + e.message); } catch (_) {}
    }
    _metaCache_[table] = { table: table, names: names, byLc: byLc, types: types, pk: pkOrdered };
    return _metaCache_[table];
  }

  // Coerce a raw cell to the column's declared SQLite type. Empty -> null.
  function _coerce_(raw, declType) {
    var t = String(declType || '').toUpperCase();
    var isInt  = t.indexOf('INT') !== -1;
    var isReal = t.indexOf('REAL') !== -1 || t.indexOf('FLOA') !== -1 || t.indexOf('DOUB') !== -1 || t.indexOf('NUMER') !== -1 || t.indexOf('DEC') !== -1;
    var s = (raw == null) ? '' : (raw instanceof Date ? raw.toISOString() : String(raw).trim());
    if (isInt || isReal) {
      if (s === '') return null;
      var n = Number(s.replace(/,/g, ''));   // tolerate thousands separators
      if (isNaN(n)) return null;
      return isInt ? Math.round(n) : n;
    }
    return s === '' ? null : s;   // text stored verbatim
  }

  // ── Parse + upsert a 2D extract into its mirror table ───────────────────────
  function _loadExtract_(rows, opts) {
    var source  = (opts && opts.source)  || 'UPLOAD';
    var batchId = (opts && opts.batchId) || genId('OABATCH');
    var now     = nowIso();

    if (!rows || rows.length < 2) {
      throw new Errors.Validation('The file has no data rows.');
    }
    var hidx = _headerIndex_(rows[0]);

    // Detect PO vs SO purely from the presence of the key column.
    var isPO = hidx['purchase_number'] !== undefined;
    var isSO = hidx['document_number'] !== undefined;
    if (!isPO && !isSO) {
      throw new Errors.Validation(
        'Could not detect PO or SO. Expected a "purchase Number" column (PO) or a "DOCUMENT_NUMBER" column (SO).');
    }
    var docType = (isPO && !isSO) ? 'PO' : (isSO && !isPO ? 'SO' : (isPO ? 'PO' : 'SO'));
    var table   = docType === 'PO' ? T_PO : T_SO;
    var pkCols  = docType === 'PO' ? ['purchase_number'] : ['document_number', 'line_number'];

    var meta = _meta_(table);
    if (!meta.names.length) throw new Errors.Integration('Table ' + table + ' was not found in the database.');
    pkCols.forEach(function (c) {
      if (!meta.byLc[c]) throw new Errors.Integration(table + ' is missing the ' + c + ' primary-key column.');
    });

    // Which extract headers map onto a real column? (the one-to-one mapping)
    var mapped = [];   // [{ col: realColName, idx: cellIndex, type: declType }]
    Object.keys(hidx).forEach(function (snake) {
      var real = meta.byLc[snake];
      if (real) mapped.push({ col: real, idx: hidx[snake], type: meta.types[snake] });
    });

    // Resolve the load-bookkeeping columns that actually exist.
    var cSource  = meta.byLc['source'];
    var cBatch   = meta.byLc['source_batch_id'];
    var cLoaded  = meta.byLc['loaded_at'] || meta.byLc['created_at'];
    var cUpdated = meta.byLc['updated_at'];

    // Build the row objects (coerced), capturing each row's PK tuple.
    var built = [], skipped = [], docSet = {};
    for (var r = 1; r < rows.length; r++) {
      if (built.length >= MAX_ROWS) { skipped.push({ row: r + 1, reason: 'Row cap (' + MAX_ROWS + ') reached.' }); continue; }
      var row = rows[r];
      if (!row || !row.length) continue;

      var obj = {};
      mapped.forEach(function (m) { obj[m.col] = _coerce_(row[m.idx], m.type); });

      // PK validation: every PK component must resolve to a value.
      var pkVals = {}, missing = null;
      pkCols.forEach(function (c) {
        var real = meta.byLc[c];
        var v = obj[real];
        if (c === 'line_number' && (v === null || v === undefined)) v = 0;   // tolerate a blank line number
        if (v === null || v === undefined || v === '') missing = c;
        pkVals[real] = v;
        obj[real] = v;
      });
      if (missing) { skipped.push({ row: r + 1, reason: 'Missing ' + missing + '.' }); continue; }

      // Load bookkeeping.
      if (cSource)  obj[cSource]  = source;
      if (cBatch)   obj[cBatch]   = batchId;
      if (cUpdated) obj[cUpdated] = now;

      built.push({ obj: obj, pk: pkVals });
      var dn = docType === 'PO' ? String(pkVals[meta.byLc['purchase_number']]) : String(pkVals[meta.byLc['document_number']]);
      docSet[dn] = true;
    }

    if (!built.length) {
      return { docType: docType, table: table, batchId: batchId, source: source,
               rows: { inserted: 0, updated: 0, total: 0 }, documents: 0, skipped: skipped };
    }

    // Pre-load existing PK tuples so re-uploads UPDATE in place (no duplicates).
    var existing = _loadExistingKeys_(table, meta, docType, built);

    // Emit upserts in batches.
    var stmts = [], ins = 0, upd = 0;
    function flush() { if (stmts.length) { TursoClient.batch(stmts); stmts = []; } }

    built.forEach(function (b) {
      var keyStr = _pkString_(meta, docType, b.pk);
      if (existing[keyStr]) {
        var u = _updateStmt_(table, meta, pkCols, b.obj);
        if (u) { stmts.push(u); upd++; }
      } else {
        if (cLoaded) b.obj[cLoaded] = b.obj[cLoaded] || now;   // set loaded_at only on insert
        var i = _insertStmt_(table, b.obj);
        if (i) { stmts.push(i); ins++; }
      }
      if (stmts.length >= FLUSH_AT) flush();
    });
    flush();

    return {
      docType: docType, table: table, batchId: batchId, source: source,
      rows: { inserted: ins, updated: upd, total: ins + upd },
      documents: Object.keys(docSet).length,
      skipped: skipped
    };
  }

  // Composite-safe key string for an existing-row lookup.
  function _pkString_(meta, docType, pkVals) {
    if (docType === 'PO') return String(pkVals[meta.byLc['purchase_number']]);
    return String(pkVals[meta.byLc['document_number']]) + '' + String(pkVals[meta.byLc['line_number']]);
  }

  // SELECT existing PK tuples in chunks; returns { keyString: true }.
  function _loadExistingKeys_(table, meta, docType, built) {
    var existing = {};
    if (docType === 'PO') {
      var pkCol = meta.byLc['purchase_number'];
      var nums = built.map(function (b) { return b.pk[pkCol]; });
      for (var off = 0; off < nums.length; off += 200) {
        var chunk = nums.slice(off, off + 200);
        if (!chunk.length) break;
        var ph = chunk.map(function () { return '?'; }).join(',');
        var rws = TursoClient.select('SELECT ' + pkCol + ' AS k FROM ' + table + ' WHERE ' + pkCol + ' IN (' + ph + ')', chunk);
        rws.forEach(function (x) { existing[String(x.k)] = true; });
      }
      return existing;
    }
    // SO: composite (document_number, line_number). Fetch by document_number set,
    // then match the line within the doc.
    var cDoc = meta.byLc['document_number'], cLine = meta.byLc['line_number'];
    var docNums = {};
    built.forEach(function (b) { docNums[String(b.pk[cDoc])] = true; });
    var list = Object.keys(docNums);
    for (var o = 0; o < list.length; o += 200) {
      var c2 = list.slice(o, o + 200);
      if (!c2.length) break;
      var ph2 = c2.map(function () { return '?'; }).join(',');
      var rows2 = TursoClient.select('SELECT ' + cDoc + ' AS d, ' + cLine + ' AS l FROM ' + table + ' WHERE ' + cDoc + ' IN (' + ph2 + ')', c2);
      rows2.forEach(function (x) { existing[String(x.d) + '' + String(x.l == null ? 0 : x.l)] = true; });
    }
    return existing;
  }

  function _insertStmt_(table, obj) {
    var cols = Object.keys(obj);
    if (!cols.length) return null;
    var qs = cols.map(function () { return '?'; });
    var args = cols.map(function (c) { return obj[c]; });
    return { sql: 'INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + qs.join(',') + ')', args: args };
  }
  function _updateStmt_(table, meta, pkCols, obj) {
    var pkReal = pkCols.map(function (c) { return meta.byLc[c]; });
    var setCols = Object.keys(obj).filter(function (c) { return pkReal.indexOf(c) === -1; });
    if (!setCols.length) return null;
    var sets = setCols.map(function (c) { return c + ' = ?'; });
    var args = setCols.map(function (c) { return obj[c]; });
    var where = pkReal.map(function (c) { return c + ' = ?'; });
    pkReal.forEach(function (c) { args.push(obj[c]); });
    return { sql: 'UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE ' + where.join(' AND '), args: args };
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
      var sheet = SpreadsheetApp.openById(fileId).getSheets()[0];
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
    _metaCache_ = {};   // fresh introspection per load
    return _loadExtract_(rows, opts);
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
    var summary  = { source: 'INTEGRATION', loads: [], rows: { inserted: 0, updated: 0, total: 0 }, documents: 0, skipped: [] };
    (extracts || []).forEach(function (rows) {
      var res = loadFromRows(rows, { source: 'INTEGRATION', batchId: genId('OASYNC') });
      summary.loads.push(res);
      summary.rows.inserted += res.rows.inserted;
      summary.rows.updated  += res.rows.updated;
      summary.rows.total    += res.rows.total;
      summary.documents     += res.documents || 0;
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
  // "Configured" = enough to attempt a pull. Enabled + source type + endpoint.
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
  // AND the shared secret matches. It writes solely to po_approvals / so_approvals.
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
        Audit.log({ actor: 'SYSTEM', action: 'ORACLE_APPROVALS_WEBHOOK', entity: res.table, entityId: res.batchId,
                    metadata: { docType: res.docType, rows: res.rows, documents: res.documents } });
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
