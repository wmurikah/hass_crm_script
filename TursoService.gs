/**
 * HASS PETROLEUM CMS - TursoService.gs
 * Version: 3.0.0
 *
 * Turso (libSQL) is the SOLE operational database.
 * Google Sheets is a read-only backup sink written only by BackupService.gs.
 *
 * This file provides:
 *  (a) Low-level HTTP helpers:  _tursoExec, tursoSelect, tursoWrite,
 *                               tursoBatchWrite, _formatArgs, _parseRows
 *  (b) SQL builder helpers:     _buildInsert, _buildUpdate
 *  (c) Constants:               TABLE_MAP, PK_MAP
 *  (d) Diagnostics:             testTursoConnection, benchmarkReadSpeed
 *  (e) One-time utilities:      migrateAllSheetsToTurso, verifyMigration
 *
 * Credentials stored in Script Properties:
 *   TURSO_URL   - e.g. https://hass-cms-wmurikah.aws-ap-south-1.turso.io
 *   TURSO_TOKEN - JWT bearer token
 */

// ============================================================================
// TABLE MAP  (sheet name → Turso table name)
// ============================================================================

var TABLE_MAP = {
  'Countries':              'countries',
  'Segments':               'segments',
  'Products':               'products',
  'Depots':                 'depots',
  'Teams':                  'teams',
  'Users':                  'users',
  'Customers':              'customers',
  'Contacts':               'contacts',
  'DeliveryLocations':      'delivery_locations',
  'PriceList':              'price_list',
  'PriceListItems':         'price_list_items',
  'Vehicles':               'vehicles',
  'Drivers':                'drivers',
  'Orders':                 'orders',
  'OrderLines':             'order_lines',
  'OrderStatusHistory':     'order_status_history',
  'Invoices':               'invoices',
  'PaymentUploads':         'payment_uploads',
  'Documents':              'documents',
  'SLAConfig':              'sla_config',
  'BusinessHours':          'business_hours',
  'Holidays':               'holidays',
  'Tickets':                'tickets',
  'TicketComments':         'ticket_comments',
  'TicketAttachments':      'ticket_attachments',
  'TicketHistory':          'ticket_history',
  'SLAData':                'sla_data',
  'POApprovals':            'po_approvals',
  'ApprovalWorkflows':      'approval_workflows',
  'Sessions':               'sessions',
  'PasswordResets':         'password_resets',
  'SignupRequests':         'signup_requests',
  'Notifications':          'notifications',
  'NotificationPreferences':'notification_preferences',
  'NotificationTemplates':  'notification_templates',
  'StaffMessages':          'staff_messages',
  'KnowledgeCategories':    'knowledge_categories',
  'KnowledgeArticles':      'knowledge_articles',
  'Config':                 'config',
  'AuditLog':               'audit_log',
  'IntegrationLog':         'integration_log',
  'JobQueue':               'job_queue',
  'RecurringSchedule':      'recurring_schedule',
  'RecurringScheduleLines': 'recurring_schedule_lines',
  'ChurnRiskFactors':       'churn_risk_factors',
  'RetentionActivities':    'retention_activities',
};

// ============================================================================
// PRIMARY KEY MAP  (sheet name → primary key column)
// ============================================================================

var PK_MAP = {
  'Countries':              'country_code',
  'Segments':               'segment_id',
  'Products':               'product_id',
  'Depots':                 'depot_id',
  'Teams':                  'team_id',
  'Users':                  'user_id',
  'Customers':              'customer_id',
  'Contacts':               'contact_id',
  'DeliveryLocations':      'location_id',
  'PriceList':              'price_id',
  'PriceListItems':         'item_id',
  'Vehicles':               'vehicle_id',
  'Drivers':                'driver_id',
  'Orders':                 'order_id',
  'OrderLines':             'line_id',
  'OrderStatusHistory':     'history_id',
  'Invoices':               'invoice_id',
  'PaymentUploads':         'upload_id',
  'Documents':              'document_id',
  'SLAConfig':              'sla_id',
  'BusinessHours':          'hours_id',
  'Holidays':               'holiday_id',
  'Tickets':                'ticket_id',
  'TicketComments':         'comment_id',
  'TicketAttachments':      'attachment_id',
  'TicketHistory':          'history_id',
  'SLAData':                'log_id',
  'POApprovals':            'po_number',
  'ApprovalWorkflows':      'workflow_id',
  'Sessions':               'session_id',
  'PasswordResets':         'email',
  'SignupRequests':         'request_id',
  'Notifications':          'notification_id',
  'NotificationPreferences':'preference_id',
  'NotificationTemplates':  'template_id',
  'StaffMessages':          'message_id',
  'KnowledgeCategories':    'category_id',
  'KnowledgeArticles':      'article_id',
  'Config':                 'config_key',
  'AuditLog':               'log_id',
  'IntegrationLog':         'log_id',
  'JobQueue':               'job_id',
  'RecurringSchedule':      'schedule_id',
  'RecurringScheduleLines': 'line_id',
  'ChurnRiskFactors':       'factor_id',
  'RetentionActivities':    'activity_id',
};

// ============================================================================
// TURSO CONFIGURATION
// ============================================================================

function _getTursoConfig() {
  var props = PropertiesService.getScriptProperties();
  var url   = props.getProperty('TURSO_URL');
  var token = props.getProperty('TURSO_TOKEN');
  if (!url || !token) {
    throw new Error('TURSO_URL and TURSO_TOKEN must be set in Script Properties');
  }
  return { url: url.replace(/\/$/, ''), token: token };
}

// ============================================================================
// LOW-LEVEL HTTP EXECUTION
// ============================================================================

/**
 * Sends a pipeline of statements to Turso via the hrana-over-http v2 API.
 * Each item in `statements` is { sql: string, args?: any[] }.
 * PRAGMA foreign_keys = ON is automatically prepended.
 *
 * @param {Array<{sql:string, args?:any[]}>} statements
 * @returns {Object} parsed JSON response
 */
function _tursoExec(statements) {
  var cfg = _getTursoConfig();

  // Always enforce FK constraints
  var allStmts = [{ sql: 'PRAGMA foreign_keys = ON' }].concat(statements);

  var requests = allStmts.map(function(stmt) {
    return {
      type: 'execute',
      stmt: {
        sql: stmt.sql,
        args: (stmt.args || []).map(_formatArg)
      }
    };
  });
  requests.push({ type: 'close' });

  var response = UrlFetchApp.fetch(cfg.url + '/v2/pipeline', {
    method:            'post',
    contentType:       'application/json',
    headers:           { 'Authorization': 'Bearer ' + cfg.token },
    payload:           JSON.stringify({ requests: requests }),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Turso HTTP ' + code + ': ' + response.getContentText().substring(0, 400));
  }

  return JSON.parse(response.getContentText());
}

// ============================================================================
// PUBLIC QUERY HELPERS
// ============================================================================

/**
 * Executes a SELECT and returns an array of row objects.
 *
 * @param {string}  sql
 * @param {any[]}   [args]
 * @returns {Object[]}
 */
function tursoSelect(sql, args) {
  var resp = _tursoExec([{ sql: sql, args: args || [] }]);
  // results[0] = PRAGMA, results[1] = our query, results[-1] = close
  if (!resp.results || resp.results.length < 2) return [];
  var r = resp.results[1];
  if (r.type === 'error') throw new Error('Turso query error: ' + (r.error && r.error.message));
  return _parseRows(r.response && r.response.result);
}

/**
 * Executes a single write statement (INSERT / UPDATE / DELETE).
 *
 * @param {string}  sql
 * @param {any[]}   [args]
 */
function tursoWrite(sql, args) {
  var resp = _tursoExec([{ sql: sql, args: args || [] }]);
  if (!resp.results || resp.results.length < 2) return;
  var r = resp.results[1];
  if (r.type === 'error') throw new Error('Turso write error: ' + (r.error && r.error.message));
}

/**
 * Executes multiple write statements in a single HTTP round-trip.
 * Aborts on the first error.
 *
 * @param {Array<{sql:string, args?:any[]}>} statements
 */
function tursoBatchWrite(statements) {
  if (!statements || statements.length === 0) return;
  var resp = _tursoExec(statements);
  if (!resp.results) return;
  // results[0] = PRAGMA; [1..n] = our stmts; last = close
  for (var i = 1; i < resp.results.length - 1; i++) {
    var r = resp.results[i];
    if (r.type === 'error') {
      throw new Error('Turso batch error at statement ' + i + ': ' + (r.error && r.error.message));
    }
  }
}

// ============================================================================
// VALUE FORMATTER  (JS → Turso hrana arg)
// ============================================================================

function _formatArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean')        return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (Number.isInteger(v))         return { type: 'integer', value: String(v) };
    return                                  { type: 'float',   value: v };
  }
  if (v instanceof Date)             return { type: 'text', value: v.toISOString() };
  return                                    { type: 'text', value: String(v) };
}

// Keep the old name as an alias for any callers
function _formatArgs(v) { return _formatArg(v); }

// ============================================================================
// ROW PARSER  (Turso hrana result → array of objects)
// ============================================================================

function _parseRows(result) {
  if (!result || !result.cols || !result.rows) return [];
  var cols = result.cols.map(function(c) { return c.name; });
  return result.rows.map(function(row) {
    var obj = {};
    for (var i = 0; i < cols.length; i++) {
      var cell = row[i];
      obj[cols[i]] = (cell && cell.type !== 'null') ? cell.value : null;
    }
    return obj;
  });
}

// ============================================================================
// SQL BUILDER HELPERS
// ============================================================================

/**
 * Builds an INSERT OR REPLACE statement.
 *
 * @param {string} table
 * @param {Object} obj   - plain object of column→value pairs
 * @returns {{ sql: string, args: any[] }}
 */
function _buildInsert(table, obj) {
  var keys = Object.keys(obj).filter(function(k) { return k !== '_rowNumber'; });
  if (!keys.length) throw new Error('_buildInsert: no columns provided for ' + table);
  var cols         = keys.join(', ');
  var placeholders = keys.map(function() { return '?'; }).join(', ');
  var args         = keys.map(function(k) { return obj[k]; });
  return { sql: 'INSERT OR REPLACE INTO ' + table + ' (' + cols + ') VALUES (' + placeholders + ')', args: args };
}

/**
 * Builds an UPDATE statement.
 * Returns null if there are no columns to update.
 *
 * @param {string} table
 * @param {string} idCol   - WHERE column name
 * @param {*}      idVal   - WHERE value
 * @param {Object} updates - fields to SET
 * @returns {{ sql: string, args: any[] } | null}
 */
function _buildUpdate(table, idCol, idVal, updates) {
  var keys = Object.keys(updates).filter(function(k) {
    return k !== '_rowNumber' && k !== idCol;
  });
  if (!keys.length) return null;
  var sets = keys.map(function(k) { return k + ' = ?'; }).join(', ');
  var args = keys.map(function(k) { return updates[k]; });
  args.push(idVal);
  return { sql: 'UPDATE ' + table + ' SET ' + sets + ' WHERE ' + idCol + ' = ?', args: args };
}

// ============================================================================
// DIAGNOSTIC - run from GAS IDE
// ============================================================================

function testTursoConnection() {
  var results = [];
  try {
    var cfg = _getTursoConfig();
    results.push('Config OK: ' + cfg.url);
  } catch(e) {
    results.push('FAIL Config: ' + e.message);
    Logger.log(results.join('\n'));
    return results;
  }

  // Test 1: simple SELECT
  try {
    var rows = tursoSelect('SELECT 1 AS ping');
    results.push(rows.length && rows[0].ping === '1' ? 'PASS SELECT 1' : 'FAIL SELECT 1 unexpected result');
  } catch(e) {
    results.push('FAIL SELECT 1: ' + e.message);
  }

  // Test 2: list tables
  try {
    var tables = tursoSelect("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    results.push('PASS list tables (' + tables.length + ' tables found)');
  } catch(e) {
    results.push('FAIL list tables: ' + e.message);
  }

  // Test 3: write (temp table)
  try {
    tursoWrite("CREATE TABLE IF NOT EXISTS _connection_test (id TEXT PRIMARY KEY, ts TEXT)");
    tursoWrite("INSERT OR REPLACE INTO _connection_test VALUES (?, ?)", ['test', new Date().toISOString()]);
    var check = tursoSelect("SELECT * FROM _connection_test WHERE id = ?", ['test']);
    results.push(check.length ? 'PASS write+read roundtrip' : 'FAIL write+read roundtrip empty');
    tursoWrite("DROP TABLE IF EXISTS _connection_test");
  } catch(e) {
    results.push('FAIL write test: ' + e.message);
  }

  var allPassed = results.every(function(r) { return r.indexOf('FAIL') === -1; });
  results.push(allPassed ? '\n=== ALL TESTS PASSED ===' : '\n=== SOME TESTS FAILED ===');
  Logger.log(results.join('\n'));
  return results;
}

function benchmarkReadSpeed() {
  var tables = ['customers', 'tickets', 'orders', 'users'];
  var timings = {};
  tables.forEach(function(t) {
    try {
      var start = Date.now();
      var rows  = tursoSelect('SELECT * FROM ' + t + ' LIMIT 500');
      timings[t] = { ms: Date.now() - start, rows: rows.length };
    } catch(e) {
      timings[t] = { error: e.message };
    }
  });
  Logger.log('benchmarkReadSpeed: ' + JSON.stringify(timings, null, 2));
  return timings;
}

// ============================================================================
// ONE-TIME MIGRATION UTILITY  (kept for reference; safe to re-run)
// ============================================================================

function migrateAllSheetsToTurso() {
  var sheetNames = Object.keys(TABLE_MAP);
  var results    = [];

  sheetNames.forEach(function(sheetName) {
    try {
      var table = TABLE_MAP[sheetName];
      var data  = getSheetData(sheetName);
      if (!data || data.length === 0) {
        results.push({ sheet: sheetName, status: 'SKIPPED', rows: 0 });
        return;
      }

      // Insert in batches of 200
      var batch = [];
      var inserted = 0;
      data.forEach(function(row) {
        batch.push(_buildInsert(table, row));
        if (batch.length >= 200) {
          tursoBatchWrite(batch);
          inserted += batch.length;
          batch = [];
        }
      });
      if (batch.length > 0) {
        tursoBatchWrite(batch);
        inserted += batch.length;
      }
      results.push({ sheet: sheetName, status: 'OK', rows: inserted });
    } catch(e) {
      Logger.log('[migrateAllSheetsToTurso] ' + sheetName + ': ' + e.message);
      results.push({ sheet: sheetName, status: 'ERROR', error: e.message });
    }
  });

  Logger.log('Migration results: ' + JSON.stringify(results, null, 2));
  return results;
}

function verifyMigration() {
  var sheetNames = Object.keys(TABLE_MAP);
  var report     = [];

  sheetNames.forEach(function(sheetName) {
    try {
      var table       = TABLE_MAP[sheetName];
      var sheetCount  = getSheetData(sheetName).length;
      var tursoResult = tursoSelect('SELECT COUNT(*) AS cnt FROM ' + table);
      var tursoCount  = tursoResult.length ? parseInt(tursoResult[0].cnt) : 0;
      report.push({
        sheet: sheetName, sheetRows: sheetCount, tursoRows: tursoCount,
        match: sheetCount === tursoCount
      });
    } catch(e) {
      report.push({ sheet: sheetName, error: e.message });
    }
  });

  Logger.log('Verification report: ' + JSON.stringify(report, null, 2));
  return report;
}
