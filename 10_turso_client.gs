/**
 * 10_turso_client.gs  —  Hass CMS rebuild foundation
 *
 * Sole owner of all /v2/pipeline HTTP calls to Turso (libSQL).
 * No other file may call UrlFetchApp against the Turso endpoint.
 *
 * Credentials are read from Script Properties:
 *   TURSO_URL    e.g. https://hass-cms-wmurikah.aws-ap-south-1.turso.io
 *   TURSO_TOKEN  JWT bearer token  (masked in any logged error)
 *
 * Public API (namespace object TursoClient):
 *   select(sql, args)    → array of row objects
 *   write(sql, args)     → { lastInsertId, rowsAffected }
 *   batch(statements)    → array of { rows, lastInsertId, rowsAffected }
 */

// ── Credentials ───────────────────────────────────────────────────────────────

function _tursoCfg_() {
  var props = PropertiesService.getScriptProperties();
  var url   = props.getProperty('TURSO_URL');
  var token = props.getProperty('TURSO_TOKEN');
  if (!url || !token) {
    throw new Errors.AppError(
      'TURSO_URL and TURSO_TOKEN must be set in Script Properties',
      'CONFIG_ERROR'
    );
  }
  return { url: url.replace(/\/$/, ''), token: token };
}

// ── Hrana arg formatter ───────────────────────────────────────────────────────

function _tursoArg_(v) {
  if (v === null || v === undefined)  return { type: 'null' };
  if (typeof v === 'boolean')          return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (Number.isInteger(v))           return { type: 'integer', value: String(v) };
    return                                    { type: 'float',   value: v };
  }
  if (v instanceof Date)               return { type: 'text', value: v.toISOString() };
  return                                      { type: 'text', value: String(v) };
}

// ── Row deserialiser ──────────────────────────────────────────────────────────

function _tursoRows_(result) {
  if (!result || !result.cols || !result.rows) return [];
  var cols = result.cols.map(function (c) { return c.name; });
  return result.rows.map(function (row) {
    var obj = {};
    for (var i = 0; i < cols.length; i++) {
      var cell = row[i];
      obj[cols[i]] = (cell && cell.type !== 'null') ? cell.value : null;
    }
    return obj;
  });
}

// ── Core HTTP call ────────────────────────────────────────────────────────────

function _tursoPipeline_(statements) {
  var cfg = _tursoCfg_();

  var allStmts = [{ sql: 'PRAGMA foreign_keys = ON' }].concat(statements);
  var requests = allStmts.map(function (stmt) {
    return {
      type: 'execute',
      stmt: {
        sql:  stmt.sql,
        args: (stmt.args || []).map(_tursoArg_),
      },
    };
  });
  requests.push({ type: 'close' });

  var response = UrlFetchApp.fetch(cfg.url + '/v2/pipeline', {
    method:             'post',
    contentType:        'application/json',
    headers:            { Authorization: 'Bearer ' + cfg.token },
    payload:            JSON.stringify({ requests: requests }),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    var masked = cfg.token.substring(0, 8) + '***';
    throw new Errors.Integration(
      'Turso HTTP ' + code + ' (token prefix: ' + masked + '): ' +
      response.getContentText().substring(0, 300)
    );
  }

  return JSON.parse(response.getContentText());
}

// ── Public API ────────────────────────────────────────────────────────────────

var TursoClient = {

  /**
   * Run a SELECT statement and return an array of plain row objects.
   * @param {string}  sql
   * @param {Array}   [args]
   * @returns {Object[]}
   */
  select: function (sql, args) {
    var t0   = Date.now();
    var resp = _tursoPipeline_([{ sql: sql, args: args || [] }]);
    // results[0] = PRAGMA, results[1] = our query, results[-1] = close
    if (!resp.results || resp.results.length < 2) return [];
    var r = resp.results[1];
    if (r.type === 'error') {
      throw new Errors.Integration('Turso select error: ' + (r.error && r.error.message));
    }
    var rows = _tursoRows_(r.response && r.response.result);
    Logger.log(JSON.stringify({ service: 'turso', action: 'select', durationMs: Date.now() - t0,
                data: { sql: sql.substring(0, 80), rows: rows.length } }));
    return rows;
  },

  /**
   * Run a single write statement (INSERT / UPDATE / DELETE).
   * @param {string}  sql
   * @param {Array}   [args]
   * @returns {{ lastInsertId: string|null, rowsAffected: number }}
   */
  write: function (sql, args) {
    var t0   = Date.now();
    var resp = _tursoPipeline_([{ sql: sql, args: args || [] }]);
    if (!resp.results || resp.results.length < 2) return { lastInsertId: null, rowsAffected: 0 };
    var r = resp.results[1];
    if (r.type === 'error') {
      throw new Errors.Integration('Turso write error: ' + (r.error && r.error.message));
    }
    var result = r.response && r.response.result;
    Logger.log(JSON.stringify({ service: 'turso', action: 'write', durationMs: Date.now() - t0,
                data: { sql: sql.substring(0, 80) } }));
    return {
      lastInsertId: result ? result.last_insert_rowid  : null,
      rowsAffected: result ? result.affected_row_count : 0,
    };
  },

  /**
   * Run multiple statements in a single HTTP round-trip.
   * Throws on the first error.
   * @param {Array<{sql:string, args?:Array}>} statements
   * @returns {Array<{ rows:Object[], lastInsertId:string|null, rowsAffected:number }>}
   */
  batch: function (statements) {
    if (!statements || statements.length === 0) return [];
    var t0   = Date.now();
    var resp = _tursoPipeline_(statements);
    if (!resp.results) return [];

    var out = [];
    // results[0] = PRAGMA; [1..n] = our stmts; last = close
    for (var i = 1; i < resp.results.length - 1; i++) {
      var r = resp.results[i];
      if (r.type === 'error') {
        throw new Errors.Integration(
          'Turso batch error at statement ' + i + ': ' + (r.error && r.error.message)
        );
      }
      var result = r.response && r.response.result;
      out.push({
        rows:         _tursoRows_(result),
        lastInsertId: result ? result.last_insert_rowid  : null,
        rowsAffected: result ? result.affected_row_count : 0,
      });
    }
    Logger.log(JSON.stringify({ service: 'turso', action: 'batch', durationMs: Date.now() - t0,
                data: { statements: statements.length } }));
    return out;
  },
};
