/**
 * HASS PETROLEUM CMS - SHEET DATABASE ENGINE
 * Version: 3.0.0
 *
 * ============================================================
 * SYSTEM ARCHITECTURE (Google Apps Script + Turso CRM)
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
 *                   SheetDatabase.gs    (batch engine - this file)
 *  5. Cache         CacheManager.gs     (L1 CacheService / L2 PropertiesService)
 *  6. Primary DB    Turso (libSQL)       via TursoService.gs HTTP helpers
 *  7. Backup        BackupService.gs    (Turso → Sheets, 60-min trigger)
 *  8. Async         JobProcessor.gs     (5-min time-driven trigger)
 *
 * DATA FLOW (write)
 * ─────────────────
 *   Browser  →POST→  doPost(Code.gs)
 *     → validateSession()      [auth guard]
 *     → handleXxxRequest()     [service dispatch]
 *       → updateRow / appendRow / batchInsertRows / batchUpdateRows
 *         → Turso HTTP (INSERT / UPDATE via TursoService)
 *         → cacheInvalidate(sheetName)
 *
 * DATA FLOW (read)
 * ────────────────
 *   Browser  →POST→  doPost(Code.gs)
 *     → validateSession()
 *     → handleXxxRequest()
 *       → cachedGet(sheetName)
 *           L1 hit  → return JSON.parse(CacheService)
 *           miss    → tursoSelect('SELECT * FROM table')
 *                      → writeL1
 *                      → return data
 *
 * BACKUP FLOW (Turso → Sheets)
 * ────────────────────────────
 *   Trigger (60 min) → runIncrementalBackup_trigger()
 *     → runIncrementalBackup()
 *       → For each table: tursoSelect WHERE updated_at > last_backup_at
 *         → upsertRowsIntoSheet()
 *     → BACKUP_LAST_AT updated in Script Properties
 *
 * ============================================================
 */

// ============================================================================
// BATCH INSERT  - Turso-backed
// ============================================================================

/**
 * Inserts multiple rows into Turso in a single HTTP pipeline call.
 *
 * @param {string}   sheetName
 * @param {Object[]} rowObjects - array of plain objects
 * @param {Object}   [defaults] - default field values applied to all rows
 * @returns {{ inserted: number, errors: string[] }}
 */
function batchInsertRows(sheetName, rowObjects, defaults) {
  if (!rowObjects || rowObjects.length === 0) return { inserted: 0, errors: [] };

  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  var now   = new Date().toISOString();

  var statements = rowObjects.map(function(obj) {
    var clean = {};
    if (defaults) {
      Object.keys(defaults).forEach(function(k) { clean[k] = defaults[k]; });
    }
    Object.keys(obj).forEach(function(k) {
      if (k !== '_rowNumber') clean[k] = obj[k];
    });
    if (!clean.created_at) clean.created_at = now;
    if (!clean.updated_at) clean.updated_at = now;
    return _buildInsert(table, clean);
  });

  try {
    tursoBatchWrite(statements);
    clearSheetCache(sheetName);
    return { inserted: statements.length, errors: [] };
  } catch(e) {
    Logger.log('[SheetDB] batchInsertRows error (' + sheetName + '): ' + e.message);
    return { inserted: 0, errors: [e.message] };
  }
}

// ============================================================================
// BATCH UPDATE  - Turso-backed
// ============================================================================

/**
 * Updates multiple rows via a single Turso pipeline call.
 *
 * @param {string} sheetName
 * @param {string} idColumn    - column used to identify rows (e.g. 'ticket_id')
 * @param {Object} updatesMap  - { [idValue]: { field: newValue, ... } }
 * @returns {{ updated: number, notFound: string[] }}
 */
function batchUpdateRows(sheetName, idColumn, updatesMap) {
  var ids = Object.keys(updatesMap || {});
  if (!ids.length) return { updated: 0, notFound: [] };

  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  var now   = new Date().toISOString();

  var statements = ids.map(function(id) {
    var updates = Object.assign({}, updatesMap[id], { updated_at: now });
    return _buildUpdate(table, idColumn, id, updates);
  }).filter(Boolean);

  try {
    if (statements.length) tursoBatchWrite(statements);
    clearSheetCache(sheetName);
    return { updated: statements.length, notFound: [] };
  } catch(e) {
    Logger.log('[SheetDB] batchUpdateRows error (' + sheetName + '): ' + e.message);
    return { updated: 0, notFound: ids.slice() };
  }
}

/**
 * Fast single-row update using the batch engine.
 *
 * @param {string} sheetName
 * @param {string} idColumn
 * @param {string} idValue
 * @param {Object} updates
 * @returns {boolean}
 */
function updateRowFast(sheetName, idColumn, idValue, updates) {
  var map = {};
  map[idValue] = updates;
  var result = batchUpdateRows(sheetName, idColumn, map);
  return result.updated > 0;
}

// ============================================================================
// INDEXED READS  (use Turso data via getSheetData)
// ============================================================================

/**
 * Builds an in-memory index from a column's values to row objects.
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
 * Returns a slice of filtered + sorted data with total count.
 */
function paginatedRead(sheetName, filters, page, pageSize, orderBy, desc) {
  page     = Math.max(1, page     || 1);
  pageSize = Math.max(1, Math.min(500, pageSize || 50));

  var data = getSheetData(sheetName);

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

  if (orderBy) {
    data = data.slice().sort(function(a, b) {
      var av = a[orderBy], bv = b[orderBy];
      if (av && bv && (av instanceof Date || !isNaN(Date.parse(av)))) {
        av = new Date(av); bv = new Date(bv);
      }
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }

  var total  = data.length;
  var pages  = Math.ceil(total / pageSize) || 1;
  var start  = (page - 1) * pageSize;
  return { data: data.slice(start, start + pageSize), total: total, page: page, pages: pages };
}

// ============================================================================
// BULK STATUS / FIELD SET
// ============================================================================

/**
 * Applies the same field values to multiple rows in one Turso pipeline call.
 */
function bulkSetFields(sheetName, idColumn, ids, fields) {
  if (!ids || ids.length === 0) return { updated: 0 };
  var map = {};
  ids.forEach(function(id) { map[id] = fields; });
  return batchUpdateRows(sheetName, idColumn, map);
}

// ============================================================================
// SCHEMA INITIALISATION  (Sheets side - for backup sheet structure)
// ============================================================================

/**
 * Ensures a Sheets tab exists with the correct header row.
 * Used by BackupService to create backup destination tabs.
 * Never touches Turso schema.
 */
function ensureSheetSchema(sheetName, requiredHeaders) {
  var ss      = getSpreadsheet();
  var tabName = COLLECTION_MAP[sheetName] || sheetName;
  var sheet   = ss.getSheetByName(tabName);

  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    sheet.setFrozenRows(1);
    Logger.log('[SheetDatabase] Created backup sheet: ' + tabName);
    return;
  }

  var existing = getHeaders_(sheet);
  var missing  = requiredHeaders.filter(function(h) { return existing.indexOf(h) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    Logger.log('[SheetDatabase] Added columns to backup sheet ' + tabName + ': ' + missing.join(', '));
  }
}

/**
 * Initialises every backup Sheet tab defined in SCHEMAS.
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
    } catch(e) {
      Logger.log('[SheetDatabase] initializeAllSheets error (' + name + '): ' + e.message);
      results.push({ sheet: name, status: 'ERROR', error: e.message });
    }
  }
  Logger.log('[SheetDatabase] initializeAllSheets: ' + JSON.stringify(results));
  return results;
}

/**
 * One-shot setup: initialise backup sheet tabs and install the job-queue trigger.
 */
function setupSystem() {
  var sheetResults = initializeAllSheets();
  installJobProcessorTrigger();
  Logger.log('[SheetDatabase] setupSystem complete');
  return { sheets: sheetResults };
}
