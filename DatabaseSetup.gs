/**
 * HASS PETROLEUM CMS - DATABASE SETUP & CORE CRUD
 * Version: 2.0.0
 * Database: Google Sheets (SPREADSHEET_ID in Script Properties)
 *
 * Provides:
 * - Google Sheets CRUD helpers (get, list, create, update, delete)
 * - Collection name mapping (logical names -> Sheet tab names)
 * - CRUD operations used by all service files
 * - Schema definitions (reference only)
 * - Utility functions (ID generation, timestamps, audit logging)
 */

// ============================================================================
// GOOGLE SHEETS CONFIGURATION
// ============================================================================

const CONFIG = {
  CACHE_TTL_SECONDS: 300,
  LOCK_TIMEOUT_MS: 30000,
};

/**
 * Returns the CMS spreadsheet. The ID is stored in Script Properties
 * under the key SPREADSHEET_ID.
 */
function getSpreadsheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

/**
 * Returns a sheet (tab) by its logical name. If a mapping exists in
 * COLLECTION_MAP the mapped name is used; otherwise the name is used as-is.
 */
function getSheet_(sheetName) {
  var tabName = COLLECTION_MAP[sheetName] || sheetName;
  var sheet = getSpreadsheet().getSheetByName(tabName);
  if (!sheet) throw new Error('Sheet not found: ' + tabName);
  return sheet;
}

// ============================================================================
// COLLECTION NAME MAPPING
// ============================================================================

const COLLECTION_MAP = {
  'Customers': 'Customers',
  'Contacts': 'Contacts',
  'Users': 'Users',
  'Teams': 'Teams',
  'Tickets': 'Tickets',
  'TicketComments': 'TicketComments',
  'TicketAttachments': 'TicketAttachments',
  'TicketHistory': 'TicketHistory',
  'Orders': 'Orders',
  'OrderLines': 'OrderLines',
  'OrderStatusHistory': 'OrderStatusHistory',
  'RecurringSchedule': 'RecurringSchedule',
  'RecurringScheduleLines': 'RecurringScheduleLines',
  'Products': 'Products',
  'Depots': 'Depots',
  'PriceList': 'PriceList',
  'PriceListItems': 'PriceListItems',
  'DeliveryLocations': 'DeliveryLocations',
  'Documents': 'Documents',
  'Vehicles': 'Vehicles',
  'Drivers': 'Drivers',
  'SLAConfig': 'SLAConfig',
  'BusinessHours': 'BusinessHours',
  'Holidays': 'Holidays',
  'Notifications': 'Notifications',
  'NotificationPreferences': 'NotificationPreferences',
  'KnowledgeCategories': 'KnowledgeCategories',
  'KnowledgeArticles': 'KnowledgeArticles',
  'AuditLog': 'AuditLog',
  'Sessions': 'Sessions',
  'IntegrationLog': 'IntegrationLog',
  'Config': 'Config',
  'Countries': 'Countries',
  'Segments': 'Segments',
  'ChurnRiskFactors': 'ChurnRiskFactors',
  'RetentionActivities': 'RetentionActivities',
  'JobQueue': 'JobQueue',
  'NotificationTemplates': 'NotificationTemplates',
  'PasswordResets': 'PasswordResets',
  'SLAData': 'SLAData',
  'POApprovals': 'POApprovals',
  'Invoices': 'Invoices',
  'ApprovalWorkflows': 'ApprovalWorkflows',
  'PaymentUploads': 'PaymentUploads',
};

function getCollectionName(sheetName) {
  return COLLECTION_MAP[sheetName] || sheetName;
}

// ============================================================================
// GOOGLE SHEETS HELPERS
// ============================================================================

/**
 * Reads all rows from a sheet and returns them as an array of objects.
 * Row 1 is the header row; data starts at row 2.
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
      // Convert Date objects to ISO strings for consistency
      if (val instanceof Date) {
        val = val.toISOString();
      }
      obj[headers[c]] = val;
    }
    obj._rowNumber = r + 1; // 1-based sheet row number
    results.push(obj);
  }
  return results;
}

/**
 * Returns the header row for a given sheet as an array of strings.
 */
function getHeaders_(sheet) {
  if (sheet.getLastRow() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

// ============================================================================
// CACHING
// ============================================================================

function getCachedSheetData(sheetName) {
  var cacheKey = 'hass_cms_' + sheetName + '_all';
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) { /* cache parse error, fetch fresh */ }
  }
  var data = getSheetData(sheetName);
  try {
    var jsonStr = JSON.stringify(data);
    if (jsonStr.length < 100000) {
      cache.put(cacheKey, jsonStr, CONFIG.CACHE_TTL_SECONDS);
    }
  } catch (e) { /* cache too large, skip */ }
  return data;
}

function clearSheetCache(sheetName) {
  var cache = CacheService.getScriptCache();
  cache.remove('hass_cms_' + sheetName + '_all');
}

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

function getSheetData(sheetName) {
  try {
    var sheet = getSheet_(sheetName);
    return sheetToObjects(sheet);
  } catch (e) {
    Logger.log('[DatabaseSetup] getSheetData error (' + sheetName + '): ' + e.message);
    return [];
  }
}

function appendRow(sheetName, rowData) {
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet);

    if (!rowData.created_at) rowData.created_at = new Date();
    if (!rowData.updated_at) rowData.updated_at = new Date();

    var row = [];
    for (var i = 0; i < headers.length; i++) {
      var val = rowData[headers[i]];
      row.push(val !== undefined && val !== null ? val : '');
    }
    sheet.appendRow(row);
    return rowData;
  } catch (e) {
    Logger.log('[DatabaseSetup] appendRow error (' + sheetName + '): ' + e.message);
    return rowData;
  }
}

function bulkInsert(sheetName, rowsData) {
  if (!rowsData || rowsData.length === 0) return 0;
  var count = 0;
  for (var i = 0; i < rowsData.length; i++) {
    appendRow(sheetName, rowsData[i]);
    count++;
  }
  return count;
}

function findRow(sheetName, columnName, value) {
  try {
    var data = getSheetData(sheetName);
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][columnName]) === String(value)) {
        return data[i];
      }
    }
    return null;
  } catch (e) {
    Logger.log('[DatabaseSetup] findRow error (' + sheetName + '): ' + e.message);
    return null;
  }
}

function findRows(sheetName, columnName, value) {
  try {
    var data = getSheetData(sheetName);
    return data.filter(function(row) {
      return String(row[columnName]) === String(value);
    });
  } catch (e) {
    Logger.log('[DatabaseSetup] findRows error (' + sheetName + '): ' + e.message);
    return [];
  }
}

function updateRow(sheetName, idColumn, idValue, updates) {
  try {
    var sheet = getSheet_(sheetName);
    var headers = getHeaders_(sheet);
    var data = sheet.getDataRange().getValues();

    var colIndex = headers.indexOf(idColumn);
    if (colIndex === -1) {
      Logger.log('[DatabaseSetup] updateRow: column not found: ' + idColumn);
      return false;
    }

    updates.updated_at = new Date();

    for (var r = 1; r < data.length; r++) {
      if (String(data[r][colIndex]) === String(idValue)) {
        for (var key in updates) {
          if (!updates.hasOwnProperty(key)) continue;
          var ci = headers.indexOf(key);
          if (ci !== -1) {
            sheet.getRange(r + 1, ci + 1).setValue(updates[key]);
          }
        }
        return true;
      }
    }
    return false;
  } catch (e) {
    Logger.log('[DatabaseSetup] updateRow error (' + sheetName + '): ' + e.message);
    return false;
  }
}

function deleteRow(sheetName, idColumn, idValue, hardDelete) {
  if (hardDelete) {
    try {
      var sheet = getSheet_(sheetName);
      var headers = getHeaders_(sheet);
      var data = sheet.getDataRange().getValues();
      var colIndex = headers.indexOf(idColumn);
      if (colIndex === -1) return false;

      for (var r = data.length - 1; r >= 1; r--) {
        if (String(data[r][colIndex]) === String(idValue)) {
          sheet.deleteRow(r + 1);
          return true;
        }
      }
      return false;
    } catch (e) {
      Logger.log('[DatabaseSetup] deleteRow error (' + sheetName + '): ' + e.message);
      return false;
    }
  }
  // Soft delete: set status to DELETED
  return updateRow(sheetName, idColumn, idValue, {
    status: 'DELETED',
    updated_at: new Date(),
  });
}

// ============================================================================
// ID FIELD MAPPING
// ============================================================================

function getIdField(sheetName) {
  var idFields = {
    'Countries': 'country_code',
    'Segments': 'segment_id',
    'Customers': 'customer_id',
    'Contacts': 'contact_id',
    'Users': 'user_id',
    'Teams': 'team_id',
    'Tickets': 'ticket_id',
    'TicketComments': 'comment_id',
    'TicketAttachments': 'attachment_id',
    'TicketHistory': 'history_id',
    'Orders': 'order_id',
    'OrderLines': 'line_id',
    'OrderStatusHistory': 'history_id',
    'RecurringSchedule': 'schedule_id',
    'RecurringScheduleLines': 'line_id',
    'Products': 'product_id',
    'Depots': 'depot_id',
    'PriceList': 'price_id',
    'PriceListItems': 'item_id',
    'DeliveryLocations': 'location_id',
    'Documents': 'document_id',
    'Vehicles': 'vehicle_id',
    'Drivers': 'driver_id',
    'SLAConfig': 'sla_id',
    'BusinessHours': 'hours_id',
    'Holidays': 'holiday_id',
    'ChurnRiskFactors': 'factor_id',
    'RetentionActivities': 'activity_id',
    'Notifications': 'notification_id',
    'NotificationPreferences': 'preference_id',
    'KnowledgeCategories': 'category_id',
    'KnowledgeArticles': 'article_id',
    'AuditLog': 'log_id',
    'Sessions': 'session_id',
    'IntegrationLog': 'log_id',
    'JobQueue': 'job_id',
    'Config': 'config_key',
    'NotificationTemplates': 'template_id',
    'Invoices': 'invoice_id',
    'ApprovalWorkflows': 'workflow_id',
    'PaymentUploads': 'upload_id',
    'SLAData': 'log_id',
    'POApprovals': 'po_number',
    'PasswordResets': 'email',
  };
  return idFields[sheetName] || null;
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
  };
  var prefix = prefixes[sheetName] || 'REC';
  return generateId(prefix);
}

function generateUUID() { return Utilities.getUuid(); }

function generateId(prefix) {
  var timestamp = Date.now().toString(36).toUpperCase();
  var random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return prefix + timestamp + random;
}

// ============================================================================
// SEQUENCE NUMBER GENERATORS
// ============================================================================

function generateTicketNumber(countryCode) {
  var year = new Date().getFullYear();
  var prefix = 'TKT-' + countryCode + '-' + year;
  var data = getSheetData('Tickets');
  var count = data.filter(function(d) {
    return d.ticket_number && String(d.ticket_number).indexOf(prefix) === 0;
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

function generateOrderNumber(countryCode) {
  var year = new Date().getFullYear();
  var prefix = 'ORD-' + countryCode + '-' + year;
  var data = getSheetData('Orders');
  var count = data.filter(function(d) {
    return d.order_number && String(d.order_number).indexOf(prefix) === 0;
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

function generateAccountNumber(countryCode) {
  var prefix = 'HASS-' + countryCode;
  var data = getSheetData('Customers');
  var count = data.filter(function(d) {
    return d.account_number && String(d.account_number).indexOf(prefix) === 0;
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

// ============================================================================
// TIMESTAMP UTILITIES
// ============================================================================

function getCurrentTimestamp() { return new Date(); }
function getCurrentDate() { return new Date(); }

// ============================================================================
// AUDIT & CONFIG
// ============================================================================

function logAudit(entityType, entityId, action, actorType, actorId, actorEmail, changes, metadata) {
  try {
    appendRow('AuditLog', {
      log_id: generateUUID(),
      entity_type: entityType,
      entity_id: entityId,
      action: action,
      actor_type: actorType,
      actor_id: actorId,
      actor_email: actorEmail,
      actor_ip: (metadata && metadata.ip) || '',
      actor_user_agent: (metadata && metadata.userAgent) || '',
      changes: JSON.stringify(changes || {}),
      metadata: JSON.stringify(metadata || {}),
      country_code: (metadata && metadata.countryCode) || '',
      created_at: new Date(),
    });
  } catch (e) {
    Logger.log('[DatabaseSetup] logAudit error: ' + e.message);
  }
}

function logIntegrationCall(integration, direction, endpoint, requestBody, responseBody, statusCode, durationMs) {
  try {
    appendRow('IntegrationLog', {
      log_id: generateUUID(),
      integration: integration,
      direction: direction,
      endpoint: endpoint,
      method: '',
      request_body: JSON.stringify(requestBody || {}),
      response_body: JSON.stringify(responseBody || {}),
      status_code: statusCode,
      error_message: '',
      duration_ms: durationMs,
      reference_type: '',
      reference_id: '',
      created_at: new Date(),
    });
  } catch (e) {
    Logger.log('[DatabaseSetup] logIntegrationCall error: ' + e.message);
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
      updated_by: updatedBy || 'SYSTEM',
    });
  }
  appendRow('Config', {
    config_key: key,
    config_value: value,
    value_type: 'STRING',
    updated_by: updatedBy || 'SYSTEM',
  });
  return true;
}

// ============================================================================
// SCHEMA DEFINITIONS (reference only)
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
    headers: ['user_id', 'email', 'first_name', 'last_name', 'phone', 'role', 'team_id', 'country_code', 'countries_access', 'reports_to', 'can_approve_orders', 'approval_limit', 'max_tickets', 'status', 'created_at', 'updated_at'],
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
