/**
 * HASS PETROLEUM CMS - DATABASE SETUP & CORE CRUD
 * Version: 3.0.0
 *
 * ALL reads and writes go to Turso (libSQL).
 * Google Sheets is a read-only backup sink - written only by BackupService.gs.
 *
 * Provides:
 * - Turso-backed CRUD helpers (getSheetData, appendRow, updateRow, deleteRow, findRow, findRows)
 * - Collection name mapping (COLLECTION_MAP - logical names, kept for backward compat)
 * - Schema definitions (SCHEMAS - reference / validation only)
 * - Utility functions (ID generation, timestamps, audit logging, config)
 * - getSpreadsheet() / sheetToObjects() / getHeaders_() - kept for BackupService only
 */

// ============================================================================
// RUNTIME CONFIGURATION
// ============================================================================

const CONFIG = {
  CACHE_TTL_SECONDS: 300,
  LOCK_TIMEOUT_MS:   30000,
};

// ============================================================================
// SPREADSHEET ACCESS  (BackupService + bootstrapping only)
// ============================================================================

/**
 * Returns the CMS spreadsheet. Used ONLY by BackupService and schema init.
 * Service code MUST NOT call this for data reads/writes.
 */
function getSpreadsheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

/**
 * Reads a sheet object into an array of plain objects.
 * Used ONLY by BackupService for writing backup snapshots.
 */
function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  var results = [];
  for (var r = 1; r < data.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var val = data[r][c];
      if (val instanceof Date) val = val.toISOString();
      obj[headers[c]] = val;
    }
    obj._rowNumber = r + 1;
    results.push(obj);
  }
  return results;
}

/**
 * Returns the header row for a sheet. Used ONLY by BackupService.
 */
function getHeaders_(sheet) {
  if (sheet.getLastRow() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

// ============================================================================
// COLLECTION NAME MAPPING  (kept for backward compatibility)
// ============================================================================

const COLLECTION_MAP = {
  'Customers':              'Customers',
  'Contacts':               'Contacts',
  'Users':                  'Users',
  'Teams':                  'Teams',
  'Tickets':                'Tickets',
  'TicketComments':         'TicketComments',
  'TicketAttachments':      'TicketAttachments',
  'TicketHistory':          'TicketHistory',
  'Orders':                 'Orders',
  'OrderLines':             'OrderLines',
  'OrderStatusHistory':     'OrderStatusHistory',
  'RecurringSchedule':      'RecurringSchedule',
  'RecurringScheduleLines': 'RecurringScheduleLines',
  'Products':               'Products',
  'Depots':                 'Depots',
  'PriceList':              'PriceList',
  'PriceListItems':         'PriceListItems',
  'DeliveryLocations':      'DeliveryLocations',
  'Documents':              'Documents',
  'Vehicles':               'Vehicles',
  'Drivers':                'Drivers',
  'SLAConfig':              'SLAConfig',
  'BusinessHours':          'BusinessHours',
  'Holidays':               'Holidays',
  'Notifications':          'Notifications',
  'NotificationPreferences':'NotificationPreferences',
  'KnowledgeCategories':    'KnowledgeCategories',
  'KnowledgeArticles':      'KnowledgeArticles',
  'AuditLog':               'AuditLog',
  'Sessions':               'Sessions',
  'IntegrationLog':         'IntegrationLog',
  'Config':                 'Config',
  'Countries':              'Countries',
  'Segments':               'Segments',
  'ChurnRiskFactors':       'ChurnRiskFactors',
  'RetentionActivities':    'RetentionActivities',
  'JobQueue':               'JobQueue',
  'NotificationTemplates':  'NotificationTemplates',
  'PasswordResets':         'PasswordResets',
  'SLAData':                'SLAData',
  'POApprovals':            'POApprovals',
  'Invoices':               'Invoices',
  'ApprovalWorkflows':      'ApprovalWorkflows',
  'PaymentUploads':         'PaymentUploads',
  'SignupRequests':         'SignupRequests',
  'StaffMessages':          'StaffMessages',
};

function getCollectionName(sheetName) {
  return COLLECTION_MAP[sheetName] || sheetName;
}

// ============================================================================
// CACHING  (delegates to CacheManager - now caches Turso results)
// ============================================================================

/**
 * Returns Turso data for sheetName, served from the L1/L2 cache when possible.
 * Drop-in replacement for the old sheet-backed getCachedSheetData().
 */
function getCachedSheetData(sheetName) {
  return cachedGet(sheetName);
}

function clearSheetCache(sheetName) {
  try { cacheInvalidate(sheetName); } catch(e) {}
}

// ============================================================================
// CORE CRUD - ALL READ/WRITE VIA TURSO
// ============================================================================

/**
 * Returns all rows from a Turso table as an array of objects.
 */
function getSheetData(sheetName) {
  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  try {
    return tursoSelect('SELECT * FROM ' + table);
  } catch(e) {
    Logger.log('[DB] getSheetData error (' + sheetName + '): ' + e.message);
    return [];
  }
}

/**
 * Inserts a new row into Turso.
 */
function appendRow(sheetName, rowData) {
  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  try {
    if (!rowData.created_at) rowData.created_at = new Date().toISOString();
    if (!rowData.updated_at) rowData.updated_at = new Date().toISOString();
    var stmt = _buildInsert(table, rowData);
    tursoWrite(stmt.sql, stmt.args);
    clearSheetCache(sheetName);
    return rowData;
  } catch(e) {
    Logger.log('[DB] appendRow error (' + sheetName + '): ' + e.message);
    return rowData;
  }
}

/**
 * Inserts multiple rows into Turso in a single HTTP request.
 */
function bulkInsert(sheetName, rowsData) {
  if (!rowsData || rowsData.length === 0) return 0;
  try {
    var result = batchInsertRows(sheetName, rowsData);
    return result.inserted;
  } catch(e) {
    Logger.log('[DB] bulkInsert error (' + sheetName + '): ' + e.message);
    return 0;
  }
}

/**
 * Finds the first row matching columnName = value.
 */
function findRow(sheetName, columnName, value) {
  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  try {
    var rows = tursoSelect(
      'SELECT * FROM ' + table + ' WHERE ' + columnName + ' = ? LIMIT 1',
      [value]
    );
    return rows.length ? rows[0] : null;
  } catch(e) {
    Logger.log('[DB] findRow error (' + sheetName + '): ' + e.message);
    return null;
  }
}

/**
 * Returns all rows matching columnName = value.
 */
function findRows(sheetName, columnName, value) {
  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  try {
    return tursoSelect(
      'SELECT * FROM ' + table + ' WHERE ' + columnName + ' = ?',
      [value]
    );
  } catch(e) {
    Logger.log('[DB] findRows error (' + sheetName + '): ' + e.message);
    return [];
  }
}

/**
 * Updates a row in Turso identified by idColumn = idValue.
 */
function updateRow(sheetName, idColumn, idValue, updates) {
  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  try {
    updates.updated_at = new Date().toISOString();
    var stmt = _buildUpdate(table, idColumn, idValue, updates);
    if (stmt) tursoWrite(stmt.sql, stmt.args);
    clearSheetCache(sheetName);
    return true;
  } catch(e) {
    Logger.log('[DB] updateRow error (' + sheetName + '): ' + e.message);
    return false;
  }
}

/**
 * Soft-deletes (status = DELETED) or hard-deletes a row from Turso.
 */
function deleteRow(sheetName, idColumn, idValue, hardDelete) {
  var table = TABLE_MAP[sheetName] || sheetName.toLowerCase();
  try {
    if (hardDelete) {
      tursoWrite('DELETE FROM ' + table + ' WHERE ' + idColumn + ' = ?', [idValue]);
    } else {
      tursoWrite(
        'UPDATE ' + table + ' SET status = ?, updated_at = ? WHERE ' + idColumn + ' = ?',
        ['DELETED', new Date().toISOString(), idValue]
      );
    }
    clearSheetCache(sheetName);
    return true;
  } catch(e) {
    Logger.log('[DB] deleteRow error (' + sheetName + '): ' + e.message);
    return false;
  }
}

// ============================================================================
// ID FIELD MAPPING
// ============================================================================

function getIdField(sheetName) {
  return PK_MAP[sheetName] || null;
}

// ============================================================================
// ID GENERATION
// ============================================================================

function generateIdForSheet(sheetName) {
  var prefixes = {
    'Customers': 'CUS', 'Contacts': 'CON', 'Users': 'USR', 'Teams': 'TEAM',
    'Tickets': 'TKT', 'TicketComments': 'CMT', 'TicketAttachments': 'ATT',
    'TicketHistory': 'TH', 'Orders': 'ORD', 'OrderLines': 'OL',
    'OrderStatusHistory': 'OSH', 'RecurringSchedule': 'RS',
    'RecurringScheduleLines': 'RSL', 'Products': 'PROD', 'Depots': 'DEP',
    'PriceList': 'PL', 'PriceListItems': 'PLI', 'DeliveryLocations': 'LOC',
    'Documents': 'DOC', 'Vehicles': 'VEH', 'Drivers': 'DRV',
    'SLAConfig': 'SLA', 'BusinessHours': 'BH', 'Holidays': 'HOL',
    'ChurnRiskFactors': 'CRF', 'RetentionActivities': 'RA',
    'Notifications': 'NOT', 'NotificationPreferences': 'NP',
    'KnowledgeCategories': 'KCAT', 'KnowledgeArticles': 'KART',
    'AuditLog': 'LOG', 'Sessions': 'SES', 'IntegrationLog': 'INT',
    'JobQueue': 'JOB',
    'Invoices': 'INV', 'ApprovalWorkflows': 'WF', 'PaymentUploads': 'PUP',
    'SignupRequests': 'SRQ', 'StaffMessages': 'MSG',
  };
  var prefix = prefixes[sheetName] || 'REC';
  return generateId(prefix);
}

function generateUUID() { return Utilities.getUuid(); }

function generateId(prefix) {
  var timestamp = Date.now().toString(36).toUpperCase();
  var random    = Math.random().toString(36).substring(2, 8).toUpperCase();
  return prefix + timestamp + random;
}

// ============================================================================
// SEQUENCE NUMBER GENERATORS
// ============================================================================

function generateTicketNumber(countryCode) {
  var year   = new Date().getFullYear();
  var prefix = 'TKT-' + countryCode + '-' + year;
  var data   = getSheetData('Tickets');
  var count  = data.filter(function(d) {
    return d.ticket_number && String(d.ticket_number).indexOf(prefix) === 0;
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

function generateOrderNumber(countryCode) {
  var year   = new Date().getFullYear();
  var prefix = 'ORD-' + countryCode + '-' + year;
  var data   = getSheetData('Orders');
  var count  = data.filter(function(d) {
    return d.order_number && String(d.order_number).indexOf(prefix) === 0;
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

function generateAccountNumber(countryCode) {
  var prefix = 'HASS-' + countryCode;
  var data   = getSheetData('Customers');
  var count  = data.filter(function(d) {
    return d.account_number && String(d.account_number).indexOf(prefix) === 0;
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

// ============================================================================
// TIMESTAMP UTILITIES
// ============================================================================

function getCurrentTimestamp() { return new Date(); }
function getCurrentDate()      { return new Date(); }

// ============================================================================
// AUDIT & CONFIG
// ============================================================================

function logAudit(entityType, entityId, action, actorType, actorId, actorEmail, changes, metadata) {
  try {
    appendRow('AuditLog', {
      log_id:           generateUUID(),
      entity_type:      entityType,
      entity_id:        entityId,
      action:           action,
      actor_type:       actorType,
      actor_id:         actorId,
      actor_email:      actorEmail,
      actor_ip:         (metadata && metadata.ip)          || '',
      actor_user_agent: (metadata && metadata.userAgent)   || '',
      changes:          JSON.stringify(changes  || {}),
      metadata:         JSON.stringify(metadata || {}),
      country_code:     (metadata && metadata.countryCode) || '',
      created_at:       new Date().toISOString(),
    });
  } catch(e) {
    Logger.log('[DB] logAudit error: ' + e.message);
  }
}

function logIntegrationCall(integration, direction, endpoint, requestBody, responseBody, statusCode, durationMs) {
  try {
    appendRow('IntegrationLog', {
      log_id:        generateUUID(),
      integration:   integration,
      direction:     direction,
      endpoint:      endpoint,
      method:        '',
      request_body:  JSON.stringify(requestBody  || {}),
      response_body: JSON.stringify(responseBody || {}),
      status_code:   statusCode,
      error_message: '',
      duration_ms:   durationMs,
      reference_type:'',
      reference_id:  '',
      created_at:    new Date().toISOString(),
    });
  } catch(e) {
    Logger.log('[DB] logIntegrationCall error: ' + e.message);
  }
}

function getConfig(key, defaultValue) {
  var row = findRow('Config', 'config_key', key);
  return row ? row.config_value : (defaultValue || '');
}

function getConfigNumber(key, defaultValue) {
  var val = getConfig(key, '');
  var num = Number(val);
  return isNaN(num) ? (defaultValue || 0) : num;
}

function setConfig(key, value, updatedBy) {
  var existing = findRow('Config', 'config_key', key);
  if (existing) {
    return updateRow('Config', 'config_key', key, {
      config_value: value,
      updated_by:   updatedBy || 'SYSTEM',
    });
  }
  appendRow('Config', {
    config_key:   key,
    config_value: value,
    value_type:   'STRING',
    updated_by:   updatedBy || 'SYSTEM',
  });
  return true;
}

// ============================================================================
// SCHEMA DEFINITIONS  (reference / validation only - not used for DB creation)
// ============================================================================

const SCHEMAS = {
  Countries: {
    headers: ['country_code', 'country_name', 'affiliate_code', 'currency_code', 'timezone', 'dialing_code', 'is_active'],
    validations: { country_code: ['KE', 'UG', 'TZ', 'RW', 'SS', 'ZM', 'DRC', 'HTW'] },
  },
  Segments: {
    headers: ['segment_id', 'segment_name', 'description', 'min_volume', 'max_volume', 'credit_terms_days', 'discount_percentage', 'priority_level', 'is_active'],
  },
  Customers: {
    headers: ['customer_id', 'account_number', 'company_name', 'trading_name', 'segment_id', 'country_code', 'tax_pin', 'registration_number', 'email', 'phone', 'address', 'city', 'website', 'payment_terms', 'credit_limit', 'credit_used', 'currency_code', 'oracle_customer_id', 'relationship_owner_id', 'status', 'onboarding_status', 'created_at', 'updated_at'],
    validations: { status: ['ACTIVE', 'SUSPENDED', 'ON_HOLD', 'CLOSED', 'DELETED'], onboarding_status: ['PENDING', 'IN_PROGRESS', 'COMPLETED'] },
  },
  Contacts: {
    headers: ['contact_id', 'customer_id', 'first_name', 'last_name', 'email', 'phone', 'job_title', 'department', 'contact_type', 'is_portal_user', 'password_hash', 'auth_provider', 'auth_uid', 'failed_login_attempts', 'locked_until', 'last_login_at', 'status', 'created_at', 'updated_at'],
    validations: { contact_type: ['PRIMARY', 'BILLING', 'OPERATIONS', 'TECHNICAL', 'SECONDARY'], status: ['ACTIVE', 'INACTIVE', 'DELETED'] },
  },
  Users: {
    headers: ['user_id', 'email', 'first_name', 'last_name', 'phone', 'role', 'team_id', 'country_code', 'countries_access', 'reports_to', 'can_approve_orders', 'approval_limit', 'max_tickets', 'status', 'password_hash', 'created_at', 'updated_at'],
    validations: { role: ['SUPER_ADMIN', 'ADMIN', 'CS_MANAGER', 'CS_AGENT', 'SALES_REP', 'COUNTRY_MANAGER', 'REGIONAL_MANAGER', 'GROUP_HEAD', 'VIEWER'], status: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] },
  },
  Teams: {
    headers: ['team_id', 'team_name', 'department', 'country_code', 'team_lead_id', 'assignment_method', 'auto_assign', 'is_active', 'created_at'],
    validations: { department: ['CUSTOMER_SERVICE', 'SALES', 'OPERATIONS', 'FINANCE', 'LOGISTICS'], assignment_method: ['ROUND_ROBIN', 'LEAST_BUSY', 'MANUAL'] },
  },
  Tickets: {
    headers: ['ticket_id', 'ticket_number', 'customer_id', 'contact_id', 'channel', 'category', 'subcategory', 'subject', 'description', 'priority', 'status', 'assigned_to', 'assigned_team_id', 'related_order_id', 'country_code', 'sla_config_id', 'sla_acknowledge_by', 'sla_response_by', 'sla_resolve_by', 'sla_acknowledge_breached', 'sla_response_breached', 'sla_resolve_breached', 'acknowledged_at', 'first_response_at', 'resolved_at', 'closed_at', 'resolution_type', 'resolution_summary', 'root_cause', 'root_cause_category', 'satisfaction_rating', 'satisfaction_comment', 'escalation_level', 'escalated_to', 'escalated_at', 'escalation_reason', 'reopened_count', 'last_reopened_at', 'merged_into_id', 'tags', 'created_by', 'created_at', 'updated_at'],
    validations: { priority: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], status: ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED', 'RESOLVED', 'CLOSED', 'CANCELLED'] },
  },
  Orders: {
    headers: ['order_id', 'order_number', 'oracle_order_id', 'customer_id', 'contact_id', 'delivery_location_id', 'source_depot_id', 'price_list_id', 'requested_date', 'requested_time_from', 'requested_time_to', 'confirmed_date', 'confirmed_time', 'status', 'payment_status', 'subtotal', 'tax_amount', 'delivery_fee', 'discount_amount', 'total_amount', 'currency_code', 'special_instructions', 'po_number', 'is_recurring', 'recurring_schedule_id', 'vehicle_id', 'driver_id', 'submitted_at', 'approved_at', 'approved_by', 'dispatched_at', 'delivered_at', 'cancelled_at', 'cancelled_by', 'cancelled_reason', 'delivery_notes', 'delivery_confirmed_by', 'invoice_number', 'invoice_date', 'created_by_type', 'created_by_id', 'country_code', 'created_at', 'updated_at'],
    validations: { status: ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'LOADING', 'LOADED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED', 'ON_HOLD'] },
  },
  Config: {
    headers: ['config_key', 'config_value', 'value_type', 'description', 'is_encrypted', 'country_code', 'updated_by', 'updated_at'],
    validations: { value_type: ['STRING', 'NUMBER', 'BOOLEAN', 'JSON'] },
  },
};

// ============================================================================
// AFFILIATE CODE MAPPING
// ============================================================================

const AFFILIATE_CODES = {
  'KE': 'HPK', 'UG': 'HPU', 'TZ': 'HPT', 'RW': 'HPR',
  'SS': 'HSS', 'ZM': 'HPZ', 'DRC': 'HPC', 'HTW': 'HTW',
};

function getAffiliateCode(countryCode) {
  return AFFILIATE_CODES[countryCode] || countryCode;
}
