/**
 * HASS PETROLEUM CMS - BackupService.gs
 * Version: 1.0.0
 *
 * Turso is the primary database.
 * Google Sheets is a READ-ONLY backup snapshot written ONLY by this service.
 *
 * BACKUP STRATEGY
 * ───────────────
 *  Incremental: queries Turso WHERE updated_at > BACKUP_LAST_AT, upserts
 *               changed rows into the matching Sheets tab.
 *  Full:        clears each Sheets tab and rewrites all rows from Turso.
 *  Trigger:     60-minute time-driven trigger calls runIncrementalBackup_trigger().
 *  Manual:      Settings page calls handleBackupRequest({action:...}).
 *
 * SCRIPT PROPERTY KEYS
 * ────────────────────
 *  BACKUP_LAST_AT           ISO string of last successful backup run start
 *  BACKUP_LAST_FULL_AT      ISO string of last full backup completion
 *  BACKUP_LAST_STATUS       SUCCESS | PARTIAL | FAILED
 *  BACKUP_LAST_TABLES       number of tables backed up in last run
 *  BACKUP_LAST_ROWS         number of rows upserted in last run
 *  BACKUP_TRIGGER_INSTALLED true | false
 */

// ============================================================================
// BACKUP ORDER  (FK-safe)
// ============================================================================

var BACKUP_ORDER_ = [
  'Countries', 'Segments', 'Products', 'Depots', 'Teams', 'Users',
  'Customers', 'Contacts', 'DeliveryLocations', 'PriceList', 'PriceListItems',
  'Vehicles', 'Drivers', 'Orders', 'OrderLines', 'OrderStatusHistory',
  'Invoices', 'PaymentUploads', 'Documents',
  'SLAConfig', 'BusinessHours', 'Holidays',
  'Tickets', 'TicketComments', 'TicketAttachments', 'TicketHistory',
  'SLAData', 'POApprovals', 'ApprovalWorkflows',
  'Sessions', 'PasswordResets', 'SignupRequests',
  'Notifications', 'NotificationPreferences', 'StaffMessages',
  'KnowledgeCategories', 'KnowledgeArticles',
  'Config', 'AuditLog', 'IntegrationLog',
  'JobQueue', 'RecurringSchedule', 'RecurringScheduleLines',
  'ChurnRiskFactors', 'RetentionActivities',
];

// Tables without updated_at - use created_at for incremental
var TABLES_USE_CREATED_AT_ = [
  'order_status_history', 'ticket_attachments', 'ticket_history',
  'order_lines', 'audit_log', 'integration_log', 'staff_messages',
  'holidays', 'price_list_items',
];

// Tables with neither timestamp - skip in incremental, include in full
var TABLES_NO_TIMESTAMP_ = [
  'countries', 'segments', 'products', 'depots', 'sla_config', 'business_hours',
];

// ============================================================================
// PUBLIC ENTRY POINTS
// ============================================================================

/**
 * Called by the Settings page for all backup actions.
 */
function handleBackupRequest(params) {
  var action = (params && params.action) || '';
  try {
    switch(action) {
      case 'runFull':         return runFullBackup();
      case 'runIncremental':  return runIncrementalBackup();
      case 'getStatus':       return getBackupStatus();
      case 'installTrigger':  return installBackupTrigger();
      case 'removeTrigger':   return removeBackupTrigger();
      default:
        return { success: false, error: 'Unknown backup action: ' + action };
    }
  } catch(e) {
    Logger.log('[BackupService] handleBackupRequest error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// FULL BACKUP
// ============================================================================

/**
 * Backs up ALL tables from Turso to Sheets.
 * Clears existing data rows before writing.
 */
function runFullBackup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Backup already running. Try again in a moment.' };
  }

  var startAt       = new Date().toISOString();
  var startMs       = Date.now();
  var tablesBackedUp = 0;
  var rowsCopied    = 0;
  var errors        = [];
  var props         = PropertiesService.getScriptProperties();

  try {
    BACKUP_ORDER_.forEach(function(sheetName) {
      try {
        var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
        var rows  = tursoSelect('SELECT * FROM ' + table);
        var result = backupTableToSheet(sheetName, rows, true /* fullMode */);
        tablesBackedUp++;
        rowsCopied += result.upserted + result.appended;
        if (result.errors && result.errors.length) {
          errors.push(sheetName + ': ' + result.errors.join('; '));
        }
      } catch(e) {
        Logger.log('[BackupService] full backup error (' + sheetName + '): ' + e.message);
        errors.push(sheetName + ': ' + e.message);
      }
    });

    var status = errors.length === 0 ? 'SUCCESS' : (tablesBackedUp > 0 ? 'PARTIAL' : 'FAILED');
    props.setProperties({
      BACKUP_LAST_AT:       startAt,
      BACKUP_LAST_FULL_AT:  new Date().toISOString(),
      BACKUP_LAST_STATUS:   status,
      BACKUP_LAST_TABLES:   String(tablesBackedUp),
      BACKUP_LAST_ROWS:     String(rowsCopied),
    });

    var duration = Date.now() - startMs;
    return {
      success:       status !== 'FAILED',
      tablesBackedUp: tablesBackedUp,
      rowsCopied:    rowsCopied,
      errors:        errors,
      duration_ms:   duration,
    };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// INCREMENTAL BACKUP
// ============================================================================

/**
 * Backs up only rows changed since the last backup run.
 * Called by the 60-minute trigger and by admin manual action.
 */
function runIncrementalBackup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Backup already running. Try again in a moment.' };
  }

  var startAt       = new Date().toISOString();
  var startMs       = Date.now();
  var tablesChecked = 0;
  var rowsUpserted  = 0;
  var errors        = [];
  var props         = PropertiesService.getScriptProperties();

  // Default: 24 hours ago if no previous backup
  var lastAt = props.getProperty('BACKUP_LAST_AT');
  if (!lastAt) {
    lastAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  }

  try {
    BACKUP_ORDER_.forEach(function(sheetName) {
      var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();

      // Tables with no timestamps at all - skip in incremental
      if (TABLES_NO_TIMESTAMP_.indexOf(table) !== -1) return;

      try {
        var tsCol = TABLES_USE_CREATED_AT_.indexOf(table) !== -1 ? 'created_at' : 'updated_at';
        var rows  = tursoSelect(
          'SELECT * FROM ' + table + ' WHERE ' + tsCol + ' > ?',
          [lastAt]
        );
        tablesChecked++;
        if (rows.length === 0) return;

        var result = backupTableToSheet(sheetName, rows, false /* incrementalMode */);
        rowsUpserted += result.upserted + result.appended;
        if (result.errors && result.errors.length) {
          errors.push(sheetName + ': ' + result.errors.join('; '));
        }
      } catch(e) {
        Logger.log('[BackupService] incremental error (' + sheetName + '): ' + e.message);
        errors.push(sheetName + ': ' + e.message);
      }
    });

    var status = errors.length === 0 ? 'SUCCESS' : (tablesChecked > 0 ? 'PARTIAL' : 'FAILED');
    // Use startAt (not endAt) so rows updated during the run are not missed next time
    props.setProperties({
      BACKUP_LAST_AT:      startAt,
      BACKUP_LAST_STATUS:  status,
      BACKUP_LAST_TABLES:  String(tablesChecked),
      BACKUP_LAST_ROWS:    String(rowsUpserted),
    });

    var duration = Date.now() - startMs;
    return {
      success:       status !== 'FAILED',
      tablesChecked: tablesChecked,
      rowsUpserted:  rowsUpserted,
      errors:        errors,
      duration_ms:   duration,
    };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// TABLE BACKUP LOGIC
// ============================================================================

/**
 * Writes rows to the Sheets tab named sheetName.
 * Creates the sheet with header row if it does not exist.
 *
 * @param {string}   sheetName   - logical name (e.g. 'Customers')
 * @param {Object[]} rows        - array of objects from Turso
 * @param {boolean}  fullMode    - true → clear data rows before writing
 * @returns {{ upserted: number, appended: number, errors: string[] }}
 */
function backupTableToSheet(sheetName, rows, fullMode) {
  if (!rows || rows.length === 0) return { upserted: 0, appended: 0, errors: [] };

  var ss      = getSpreadsheet();
  var tabName = COLLECTION_MAP[sheetName] || sheetName;
  var sheet   = ss.getSheetByName(tabName);

  // Derive headers from the first row's keys (preserving order)
  var headers = Object.keys(rows[0]).filter(function(k) { return k !== '_rowNumber'; });

  // Create sheet if absent
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else {
    // Ensure all columns exist
    var existingHeaders = sheet.getLastRow() >= 1
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      : [];
    var missing = headers.filter(function(h) { return existingHeaders.indexOf(h) === -1; });
    if (missing.length > 0) {
      sheet.getRange(1, existingHeaders.length + 1, 1, missing.length).setValues([missing]);
      // Re-read headers after expansion
      existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    }
    // Use the actual sheet header order for writing
    headers = existingHeaders.filter(function(h) { return h !== ''; });
  }

  if (fullMode) {
    // Clear data rows (keep header)
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    }
    // Write all rows
    var values = rows.map(function(row) {
      return headers.map(function(h) {
        var v = row[h];
        return (v !== null && v !== undefined) ? v : '';
      });
    });
    if (values.length > 0) {
      sheet.getRange(2, 1, values.length, headers.length).setValues(values);
    }
    return { upserted: 0, appended: values.length, errors: [] };
  }

  // Incremental: upsert - update matching rows in-place, append new rows
  var pkField  = PK_MAP[sheetName] || 'id';
  var existing = sheet.getLastRow() > 1
    ? sheet.getRange(1, 1, sheet.getLastRow(), headers.length).getValues()
    : [headers];

  var result = upsertRowsIntoSheet(sheet, headers, existing, rows, pkField);
  return result;
}

/**
 * Performs in-place upsert logic for incremental backup.
 *
 * @param {Sheet}    sheet
 * @param {string[]} headers
 * @param {Array}    existingData  - 2D array from sheet (row 0 = headers)
 * @param {Object[]} newRows       - objects from Turso
 * @param {string}   pkField       - primary key column name
 * @returns {{ upserted: number, appended: number, errors: string[] }}
 */
function upsertRowsIntoSheet(sheet, headers, existingData, newRows, pkField) {
  var pkColIdx = headers.indexOf(pkField);
  if (pkColIdx === -1) {
    // No PK column in sheet - just append
    var appendValues = newRows.map(function(row) {
      return headers.map(function(h) { return (row[h] !== null && row[h] !== undefined) ? row[h] : ''; });
    });
    if (appendValues.length > 0) {
      sheet.getRange(existingData.length + 1, 1, appendValues.length, headers.length).setValues(appendValues);
    }
    return { upserted: 0, appended: appendValues.length, errors: [] };
  }

  // Build PK → row-index map from existing data (skip header row)
  var pkIndex = {};
  for (var r = 1; r < existingData.length; r++) {
    var pk = String(existingData[r][pkColIdx] || '');
    if (pk) pkIndex[pk] = r;
  }

  var toAppend = [];
  var upserted = 0;

  newRows.forEach(function(row) {
    var pk = String(row[pkField] || '');
    var rowValues = headers.map(function(h) {
      var v = row[h];
      return (v !== null && v !== undefined) ? v : '';
    });

    if (pk && pkIndex.hasOwnProperty(pk)) {
      // Update existing row in-place
      existingData[pkIndex[pk]] = rowValues;
      upserted++;
    } else {
      // New row - append
      if (pk) pkIndex[pk] = existingData.length;
      existingData.push(rowValues);
      toAppend.push(rowValues);
    }
  });

  // Write the full data range back (header + all rows)
  if (existingData.length > 1) {
    sheet.getRange(1, 1, existingData.length, headers.length).setValues(existingData);
  }

  return { upserted: upserted, appended: toAppend.length, errors: [] };
}

// ============================================================================
// STATUS
// ============================================================================

function getBackupStatus() {
  var props = PropertiesService.getScriptProperties();

  var triggerInstalled = false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runIncrementalBackup_trigger') {
      triggerInstalled = true;
      break;
    }
  }

  return {
    success:             true,
    last_backup_at:      props.getProperty('BACKUP_LAST_AT')      || null,
    last_full_backup_at: props.getProperty('BACKUP_LAST_FULL_AT') || null,
    last_backup_status:  props.getProperty('BACKUP_LAST_STATUS')  || 'NEVER',
    last_backup_tables:  parseInt(props.getProperty('BACKUP_LAST_TABLES') || '0'),
    last_backup_rows:    parseInt(props.getProperty('BACKUP_LAST_ROWS')   || '0'),
    trigger_installed:   triggerInstalled,
  };
}

// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================

/**
 * Installs a 60-minute time-driven trigger for runIncrementalBackup_trigger.
 * Safe to call multiple times - skips if already installed.
 */
function installBackupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runIncrementalBackup_trigger') {
      PropertiesService.getScriptProperties().setProperty('BACKUP_TRIGGER_INSTALLED', 'true');
      return { success: true, message: 'Auto-backup trigger already installed.' };
    }
  }

  ScriptApp.newTrigger('runIncrementalBackup_trigger')
    .timeBased()
    .everyMinutes(60)
    .create();

  PropertiesService.getScriptProperties().setProperty('BACKUP_TRIGGER_INSTALLED', 'true');
  return { success: true, message: 'Auto-backup trigger installed (every 60 minutes).' };
}

/**
 * Removes the backup trigger.
 */
function removeBackupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed  = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runIncrementalBackup_trigger') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  PropertiesService.getScriptProperties().setProperty('BACKUP_TRIGGER_INSTALLED', 'false');
  return {
    success: true,
    message: removed > 0 ? 'Auto-backup trigger removed.' : 'No backup trigger was installed.',
  };
}

/**
 * Called by the GAS time-driven trigger every 60 minutes.
 * Acquires a script lock to prevent overlapping runs.
 */
function runIncrementalBackup_trigger() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('[BackupService] trigger skipped - backup already running');
    return;
  }
  try {
    var result = runIncrementalBackup();
    Logger.log('[BackupService] trigger run: ' + JSON.stringify({
      success:       result.success,
      tablesChecked: result.tablesChecked,
      rowsUpserted:  result.rowsUpserted,
      duration_ms:   result.duration_ms,
      errors:        result.errors,
    }));
  } finally {
    lock.releaseLock();
  }
}
