/**
 * HASS PETROLEUM CMS — SHEET DATABASE ENGINE
 * Version: 1.0.0
 *
 * ============================================================
 * SYSTEM ARCHITECTURE (Google Apps Script + Google Sheets CRM)
 * ============================================================
 *
 * LAYERS
 * ──────
 *  1. Presentation  Login.html | Staffdashboard.html | Customerportal.html
 *  2. Gateway       Code.gs  doGet / doPost  (auth-guard, routing)
 *  3. Services      AuthService | TicketService | OrderService | CustomerService
 *                   DashboardService | SLAService | NotificationService | ...
 *  4. Data-Access   DatabaseService.gs  (query engine, findWhere, search, pagination)
 *                   DatabaseSetup.gs    (CRUD, schema, id-gen, audit helpers)
 *                   SheetDatabase.gs    (batch engine — this file)
 *  5. Cache         CacheManager.gs     (L1 CacheService / L2 PropertiesService)
 *  6. Database      Google Sheets  (44 collections — see COLLECTION_MAP)
 *  7. Async         JobProcessor.gs     (5-min time-driven trigger)
 *
 * DATA FLOW (write)
 * ─────────────────
 *   Browser  →POST→  doPost(Code.gs)
 *     → validateSession()      [auth guard]
 *     → handleXxxRequest()     [service dispatch]
 *       → updateRow / appendRow / batchInsertRows / batchUpdateRows
 *         → sheet.getRange().setValues()   [single API call per operation]
 *         → cacheInvalidate(sheetName)     [clear L1+L2 cache]
 *
 * DATA FLOW (read)
 * ────────────────
 *   Browser  →POST→  doPost(Code.gs)
 *     → validateSession()
 *     → handleXxxRequest()
 *       → cachedGet(sheetName)
 *           L1 hit  → return JSON.parse(CacheService)
 *           L2 hit  → promote to L1, return
 *           miss    → sheet.getDataRange().getValues()
 *                      → writeL1 / writeL2
 *                      → return data
 *
 * API DESIGN (all via doPost, Content-Type: application/json)
 * ──────────────────────────────────────────────────────────
 *   Request  { service, action, token, ...params }
 *   Response { success: bool, data|error, [meta] }
 *
 *   Services: auth | tickets | orders | customers | documents | knowledge
 *             notifications | integrations | sla | chat | settings
 *             upload | dashboard | users
 *
 * DATABASE SCHEMA (key collections)
 * ──────────────────────────────────
 *   Customers       customer_id, account_number, company_name, segment_id,
 *                   country_code, credit_limit, status, oracle_customer_id
 *   Contacts        contact_id, customer_id, email, password_hash, role
 *   Users           user_id, email, role, team_id, country_code, status
 *   Tickets         ticket_id, customer_id, priority, status, sla_*_by,
 *                   sla_*_breached, assigned_to, country_code
 *   Orders          order_id, customer_id, status, total_amount, country_code
 *   OrderLines      line_id, order_id, product_id, quantity, unit_price
 *   Sessions        session_id, token_hash, user_id, user_type, expires_at
 *   JobQueue        job_id, type, payload, status, attempts, next_run_at
 *   AuditLog        log_id, entity_type, entity_id, action, actor_id
 *   SLAData         log_id, document_number, affiliate, oracle_approver,
 *                   finance_approved_at, la_approved_at, delivered_at
 *
 * CACHING STRATEGY
 * ────────────────
 *   L1 (CacheService.getScriptCache)
 *     TTL: 300 s dynamic data, 3600 s static reference data
 *     Limit: 100 KB per key — large sheets are chunked (80 KB/chunk)
 *     Cleared: on every write via cacheInvalidate()
 *
 *   L2 (PropertiesService.getScriptProperties)
 *     TTL: 3600 s (stored in envelope)
 *     Limit: 9 KB per key — static reference data only
 *     Promoted to L1 on read
 *
 *   Static sheets (longer TTL): Countries, Segments, Products, Depots,
 *     SLAConfig, Config, Teams, KnowledgeCategories
 *
 * PERFORMANCE NOTES
 * ─────────────────
 *   updateRow (old)  → N setValue() calls (N = fields changed)
 *   updateRow (new)  → 1 setValues([row]) call  ≈ 10–50× faster
 *
 *   bulkInsert (old) → N appendRow() calls
 *   batchInsertRows  → 1 setValues(rows) call   ≈ 10–100× faster
 *
 *   batchUpdateRows  → 1 read + 1 write for M rows in one operation
 * ============================================================
 */

// ============================================================================
// BATCH INSERT
// ============================================================================

/**
 * Inserts multiple rows into a sheet in a single API call.
 * ~10–100× faster than calling appendRow() per row.
 *
 * @param {string}   sheetName
 * @param {Object[]} rowObjects - array of plain objects matching the sheet headers
 * @param {Object}   [defaults] - default field values applied to all rows
 * @returns {{ inserted: number, errors: string[] }}
 */
function batchInsertRows(sheetName, rowObjects, defaults) {
  if (!rowObjects || rowObjects.length === 0) return { inserted: 0, errors: [] };

  try {
    var sheet   = getSheet_(sheetName);
    var headers = getHeaders_(sheet);
    if (headers.length === 0) return { inserted: 0, errors: ['No headers in sheet: ' + sheetName] };

    var now    = new Date();
    var values = [];

    for (var i = 0; i < rowObjects.length; i++) {
      var obj = {};
      // Apply defaults first, then override with the row object
      if (defaults) {
        for (var dk in defaults) { if (defaults.hasOwnProperty(dk)) obj[dk] = defaults[dk]; }
      }
      var src = rowObjects[i];
      for (var rk in src) { if (src.hasOwnProperty(rk)) obj[rk] = src[rk]; }

      if (!obj.created_at) obj.created_at = now;
      if (!obj.updated_at) obj.updated_at = now;

      var row = [];
      for (var h = 0; h < headers.length; h++) {
        var v = obj[headers[h]];
        row.push(v !== undefined && v !== null ? v : '');
      }
      values.push(row);
    }

    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, values.length, headers.length).setValues(values);
    clearSheetCache(sheetName);
    return { inserted: values.length, errors: [] };
  } catch (e) {
    Logger.log('[SheetDatabase] batchInsertRows error (' + sheetName + '): ' + e.message);
    return { inserted: 0, errors: [e.message] };
  }
}

// ============================================================================
// BATCH UPDATE
// ============================================================================

/**
 * Updates multiple rows in a single read → patch → write cycle.
 *
 * Old pattern: N rows × M fields = N×M setValue() calls.
 * New pattern: 1 getValues() + 1 setValues() regardless of N and M.
 *
 * @param {string} sheetName
 * @param {string} idColumn    - column used to identify rows (e.g. 'ticket_id')
 * @param {Object} updatesMap  - { [idValue]: { field: newValue, ... } }
 * @returns {{ updated: number, notFound: string[] }}
 */
function batchUpdateRows(sheetName, idColumn, updatesMap) {
  var ids = Object.keys(updatesMap || {});
  if (ids.length === 0) return { updated: 0, notFound: [] };

  try {
    var sheet   = getSheet_(sheetName);
    var allData = sheet.getDataRange().getValues();
    if (allData.length < 2) return { updated: 0, notFound: ids.slice() };

    var headers  = allData[0];
    var idColIdx = headers.indexOf(idColumn);
    if (idColIdx === -1) throw new Error('Column not found: ' + idColumn);

    var updAtIdx = headers.indexOf('updated_at');

    // Build column → index map for O(1) lookups
    var colIdx = {};
    for (var h = 0; h < headers.length; h++) colIdx[headers[h]] = h;

    var idSet    = {};
    for (var i = 0; i < ids.length; i++) idSet[ids[i]] = true;

    var now      = new Date();
    var updated  = 0;
    var notFound = ids.slice();

    for (var r = 1; r < allData.length; r++) {
      var rowId = String(allData[r][idColIdx] || '');
      if (!idSet[rowId]) continue;

      var changes = updatesMap[rowId];
      var keys    = Object.keys(changes);
      for (var k = 0; k < keys.length; k++) {
        var ci = colIdx[keys[k]];
        if (ci !== undefined) allData[r][ci] = changes[keys[k]];
      }
      if (updAtIdx !== -1) allData[r][updAtIdx] = now;

      var fi = notFound.indexOf(rowId);
      if (fi !== -1) notFound.splice(fi, 1);
      updated++;
    }

    if (updated > 0) {
      sheet.getRange(1, 1, allData.length, headers.length).setValues(allData);
      clearSheetCache(sheetName);
    }
    return { updated: updated, notFound: notFound };
  } catch (e) {
    Logger.log('[SheetDatabase] batchUpdateRows error (' + sheetName + '): ' + e.message);
    return { updated: 0, notFound: ids.slice() };
  }
}

/**
 * Fast single-row update using the batch engine.
 * Writes the entire row in one setValues() call instead of N setValue() calls.
 *
 * @param {string} sheetName
 * @param {string} idColumn
 * @param {string} idValue
 * @param {Object} updates
 * @returns {boolean}
 */
function updateRowFast(sheetName, idColumn, idValue, updates) {
  var map    = {};
  map[idValue] = updates;
  var result = batchUpdateRows(sheetName, idColumn, map);
  return result.updated > 0;
}

// ============================================================================
// INDEXED READS
// ============================================================================

/**
 * Builds an in-memory index from a column's values to row objects.
 * Useful for joining two sheets without repeated full scans.
 *
 * @param {string}  sheetName
 * @param {string}  column       - column to index on (e.g. 'customer_id')
 * @param {boolean} [multi=false] - true → index values are arrays (one-to-many)
 * @returns {Object} { [value]: rowObject } or { [value]: rowObject[] }
 */
function buildSheetIndex(sheetName, column, multi) {
  var data  = getSheetData(sheetName);
  var index = {};
  for (var i = 0; i < data.length; i++) {
    var key = String(data[i][column] || '');
    if (!key) continue;
    if (multi) {
      if (!index[key]) index[key] = [];
      index[key].push(data[i]);
    } else {
      index[key] = data[i];
    }
  }
  return index;
}

/**
 * Returns rows whose column value is in the given set.
 * Uses a hash-set for O(1) per-row membership test.
 *
 * @param {string}   sheetName
 * @param {string}   column
 * @param {string[]} values
 * @returns {Object[]}
 */
function getRowsByValues(sheetName, column, values) {
  if (!values || values.length === 0) return [];
  var set = {};
  for (var i = 0; i < values.length; i++) set[String(values[i])] = true;
  return getSheetData(sheetName).filter(function(row) {
    return set[String(row[column] || '')];
  });
}

// ============================================================================
// PAGINATED READ
// ============================================================================

/**
 * Returns a slice of filtered + sorted sheet data with total count.
 * Prevents loading entire sheets into API response payloads.
 *
 * @param {string}  sheetName
 * @param {Object}  [filters]      - { column: exactValue } applied with AND
 * @param {number}  [page=1]       - 1-based page number
 * @param {number}  [pageSize=50]  - rows per page (max 500)
 * @param {string}  [orderBy]      - column name to sort by
 * @param {boolean} [desc=false]   - sort descending
 * @returns {{ data: Object[], total: number, page: number, pages: number }}
 */
function paginatedRead(sheetName, filters, page, pageSize, orderBy, desc) {
  page     = Math.max(1, page || 1);
  pageSize = Math.max(1, Math.min(500, pageSize || 50));

  var data = getSheetData(sheetName);

  // Filter
  if (filters) {
    var keys = Object.keys(filters);
    if (keys.length > 0) {
      data = data.filter(function(row) {
        for (var i = 0; i < keys.length; i++) {
          if (filters[keys[i]] !== undefined &&
              String(row[keys[i]] || '') !== String(filters[keys[i]])) return false;
        }
        return true;
      });
    }
  }

  // Sort
  if (orderBy) {
    data = data.slice().sort(function(a, b) {
      var av = a[orderBy], bv = b[orderBy];
      // Date-aware comparison
      if (av && bv && (av instanceof Date || !isNaN(Date.parse(av)))) {
        av = new Date(av); bv = new Date(bv);
      }
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }

  var total = data.length;
  var pages = Math.ceil(total / pageSize) || 1;
  var start = (page - 1) * pageSize;

  return { data: data.slice(start, start + pageSize), total: total, page: page, pages: pages };
}

// ============================================================================
// BULK STATUS / FIELD SET
// ============================================================================

/**
 * Applies the same field values to multiple rows in one operation.
 * Common pattern: bulk-close tickets, bulk-mark notifications as read.
 *
 * @param {string}   sheetName
 * @param {string}   idColumn
 * @param {string[]} ids
 * @param {Object}   fields   - e.g. { status: 'CLOSED', closed_at: new Date() }
 * @returns {{ updated: number }}
 */
function bulkSetFields(sheetName, idColumn, ids, fields) {
  if (!ids || ids.length === 0) return { updated: 0 };
  var map = {};
  for (var i = 0; i < ids.length; i++) map[ids[i]] = fields;
  return batchUpdateRows(sheetName, idColumn, map);
}

// ============================================================================
// SCHEMA INITIALISATION
// ============================================================================

/**
 * Ensures a sheet exists with the correct header row.
 * Creates the tab if absent; appends missing columns on the right.
 * Never removes existing columns — safe to run against live data.
 *
 * @param {string}   sheetName
 * @param {string[]} requiredHeaders
 */
function ensureSheetSchema(sheetName, requiredHeaders) {
  var ss      = getSpreadsheet();
  var tabName = COLLECTION_MAP[sheetName] || sheetName;
  var sheet   = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    Logger.log('[SheetDatabase] Created sheet: ' + tabName);
    return;
  }

  var existing = getHeaders_(sheet);
  var missing  = requiredHeaders.filter(function(h) { return existing.indexOf(h) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    Logger.log('[SheetDatabase] Added columns to ' + tabName + ': ' + missing.join(', '));
  }
}

/**
 * Initialises every sheet defined in SCHEMAS.
 * Run once on first deployment or after adding new schema fields.
 *
 * @returns {{ sheet: string, status: string, error?: string }[]}
 */
function initializeAllSheets() {
  var names   = Object.keys(SCHEMAS);
  var results = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    try {
      if (SCHEMAS[name] && SCHEMAS[name].headers) {
        ensureSheetSchema(name, SCHEMAS[name].headers);
        results.push({ sheet: name, status: 'OK' });
      }
    } catch (e) {
      Logger.log('[SheetDatabase] initializeAllSheets error (' + name + '): ' + e.message);
      results.push({ sheet: name, status: 'ERROR', error: e.message });
    }
  }
  Logger.log('[SheetDatabase] initializeAllSheets: ' + JSON.stringify(results));
  return results;
}

// ============================================================================
// SYSTEM SETUP (run once after deployment)
// ============================================================================

/**
 * One-shot setup: initialise all sheets and install the job-queue trigger.
 * Safe to re-run — additive only (never deletes data).
 */
function setupSystem() {
  var sheetResults = initializeAllSheets();
  installJobProcessorTrigger();
  Logger.log('[SheetDatabase] setupSystem complete');
  return { sheets: sheetResults };
}
