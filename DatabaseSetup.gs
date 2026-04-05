/**
 * HASS PETROLEUM CMS - DATABASE SETUP & CORE CRUD
 * Version: 2.0.0
 * Database: Google Cloud Firestore (hass-internal-audit-12345)
 *
 * Provides:
 * - Firestore REST API helpers (get, list, create, update, query)
 * - Value conversion (JS <-> Firestore format)
 * - Collection name mapping (Sheet names -> Firestore collections)
 * - CRUD operations with same signatures as legacy Sheets version
 * - Schema definitions (reference only)
 * - Utility functions (ID generation, timestamps, audit logging)
 */

// ============================================================================
// FIRESTORE CONFIGURATION
// ============================================================================

const FIRESTORE_CONFIG = {
  PROJECT_ID: 'hass-internal-audit-12345',
  BASE_URL: 'https://firestore.googleapis.com/v1/projects/hass-internal-audit-12345/databases/(default)/documents',
};

const CONFIG = {
  CACHE_TTL_SECONDS: 300,
  LOCK_TIMEOUT_MS: 30000,
};

// ============================================================================
// COLLECTION NAME MAPPING
// ============================================================================

const COLLECTION_MAP = {
  'Customers': 'customers',
  'Contacts': 'contacts',
  'Users': 'users',
  'Teams': 'teams',
  'Tickets': 'tickets',
  'TicketComments': 'ticketComments',
  'TicketAttachments': 'ticketAttachments',
  'TicketHistory': 'ticketHistory',
  'Orders': 'orders',
  'OrderLines': 'orderLines',
  'OrderStatusHistory': 'orderStatusHistory',
  'RecurringSchedule': 'recurringSchedules',
  'RecurringScheduleLines': 'recurringScheduleLines',
  'Products': 'products',
  'Depots': 'depots',
  'PriceList': 'priceLists',
  'PriceListItems': 'priceListItems',
  'DeliveryLocations': 'deliveryLocations',
  'Documents': 'documents',
  'Vehicles': 'vehicles',
  'Drivers': 'drivers',
  'SLAConfig': 'slaConfigs',
  'BusinessHours': 'businessHours',
  'Holidays': 'holidays',
  'Notifications': 'notifications',
  'NotificationPreferences': 'notificationPreferences',
  'KnowledgeCategories': 'knowledgeCategories',
  'KnowledgeArticles': 'knowledgeArticles',
  'AuditLog': 'auditLog',
  'Sessions': 'sessions',
  'IntegrationLog': 'integrationLog',
  'Config': 'config',
  'Countries': 'countries',
  'Segments': 'segments',
  'ChurnRiskFactors': 'churnRiskFactors',
  'RetentionActivities': 'retentionActivities',
  'JobQueue': 'jobQueue',
};

function getCollectionName(sheetName) {
  return COLLECTION_MAP[sheetName] || sheetName.toLowerCase();
}

// ============================================================================
// FIRESTORE AUTH
// ============================================================================

function getFirestoreToken() {
  return ScriptApp.getOAuthToken();
}

function getFirestoreHeaders_() {
  return {
    'Authorization': 'Bearer ' + getFirestoreToken(),
    'Content-Type': 'application/json',
  };
}

// ============================================================================
// FIRESTORE VALUE CONVERSION
// ============================================================================

function toFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(function(v) { return toFirestoreValue(v); }),
      },
    };
  }
  if (typeof value === 'object') {
    var fields = {};
    for (var key in value) {
      if (value.hasOwnProperty(key)) {
        fields[key] = toFirestoreValue(value[key]);
      }
    }
    return { mapValue: { fields: fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(fv) {
  if (!fv) return null;
  if (fv.stringValue !== undefined) return fv.stringValue;
  if (fv.integerValue !== undefined) return parseInt(fv.integerValue, 10);
  if (fv.doubleValue !== undefined) return fv.doubleValue;
  if (fv.booleanValue !== undefined) return fv.booleanValue;
  if (fv.nullValue !== undefined) return null;
  if (fv.timestampValue !== undefined) return fv.timestampValue;
  if (fv.arrayValue) {
    return (fv.arrayValue.values || []).map(function(v) { return fromFirestoreValue(v); });
  }
  if (fv.mapValue) {
    var obj = {};
    var fields = fv.mapValue.fields || {};
    for (var key in fields) {
      if (fields.hasOwnProperty(key)) {
        obj[key] = fromFirestoreValue(fields[key]);
      }
    }
    return obj;
  }
  return null;
}

function toFirestoreDocument(data) {
  var fields = {};
  for (var key in data) {
    if (data.hasOwnProperty(key) && key !== '_docId' && key !== '_rowNumber') {
      fields[key] = toFirestoreValue(data[key]);
    }
  }
  return { fields: fields };
}

function fromFirestoreDocument(doc) {
  if (!doc || !doc.fields) return null;
  var obj = {};
  var fields = doc.fields;
  for (var key in fields) {
    if (fields.hasOwnProperty(key)) {
      obj[key] = fromFirestoreValue(fields[key]);
    }
  }
  // Extract document ID from name path
  if (doc.name) {
    var parts = doc.name.split('/');
    obj._docId = parts[parts.length - 1];
  }
  return obj;
}

// ============================================================================
// FIRESTORE REST API HELPERS
// ============================================================================

function firestoreGet(collection, docId) {
  try {
    var url = FIRESTORE_CONFIG.BASE_URL + '/' + collection + '/' + docId;
    var response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: getFirestoreHeaders_(),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code === 404) return null;
    if (code >= 400) {
      Logger.log('[DatabaseSetup] firestoreGet error: HTTP ' + code);
      return null;
    }
    return fromFirestoreDocument(JSON.parse(response.getContentText()));
  } catch (e) {
    Logger.log('[DatabaseSetup] firestoreGet error: ' + e.message);
    return null;
  }
}

function firestoreList(collection) {
  try {
    var allDocs = [];
    var pageToken = '';
    do {
      var url = FIRESTORE_CONFIG.BASE_URL + '/' + collection + '?pageSize=300';
      if (pageToken) url += '&pageToken=' + pageToken;
      var response = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: getFirestoreHeaders_(),
        muteHttpExceptions: true,
      });
      var code = response.getResponseCode();
      if (code >= 400) {
        Logger.log('[DatabaseSetup] firestoreList error: HTTP ' + code);
        break;
      }
      var result = JSON.parse(response.getContentText());
      var documents = result.documents || [];
      for (var i = 0; i < documents.length; i++) {
        var obj = fromFirestoreDocument(documents[i]);
        if (obj) allDocs.push(obj);
      }
      pageToken = result.nextPageToken || '';
    } while (pageToken);
    return allDocs;
  } catch (e) {
    Logger.log('[DatabaseSetup] firestoreList error: ' + e.message);
    return [];
  }
}

function firestoreCreate(collection, docId, data) {
  try {
    var url = FIRESTORE_CONFIG.BASE_URL + '/' + collection + '?documentId=' + encodeURIComponent(docId);
    var response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: getFirestoreHeaders_(),
      payload: JSON.stringify(toFirestoreDocument(data)),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code >= 400) {
      Logger.log('[DatabaseSetup] firestoreCreate error: HTTP ' + code + ' ' + response.getContentText());
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('[DatabaseSetup] firestoreCreate error: ' + e.message);
    return false;
  }
}

function firestoreUpdate(collection, docId, data) {
  try {
    var updateMask = Object.keys(data).map(function(k) {
      return 'updateMask.fieldPaths=' + encodeURIComponent(k);
    }).join('&');
    var url = FIRESTORE_CONFIG.BASE_URL + '/' + collection + '/' + encodeURIComponent(docId) + '?' + updateMask;
    var response = UrlFetchApp.fetch(url, {
      method: 'PATCH',
      headers: getFirestoreHeaders_(),
      payload: JSON.stringify(toFirestoreDocument(data)),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code >= 400) {
      Logger.log('[DatabaseSetup] firestoreUpdate error: HTTP ' + code + ' ' + response.getContentText());
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('[DatabaseSetup] firestoreUpdate error: ' + e.message);
    return false;
  }
}

function firestoreQuery(collection, structuredQuery) {
  try {
    var url = FIRESTORE_CONFIG.BASE_URL + ':runQuery';
    var body = {
      structuredQuery: structuredQuery,
    };
    body.structuredQuery.from = [{ collectionId: collection }];
    var response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: getFirestoreHeaders_(),
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code >= 400) {
      Logger.log('[DatabaseSetup] firestoreQuery error: HTTP ' + code);
      return [];
    }
    var results = JSON.parse(response.getContentText());
    var docs = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i].document) {
        var obj = fromFirestoreDocument(results[i].document);
        if (obj) docs.push(obj);
      }
    }
    return docs;
  } catch (e) {
    Logger.log('[DatabaseSetup] firestoreQuery error: ' + e.message);
    return [];
  }
}

// ============================================================================
// VERIFY FIRESTORE CONNECTION
// ============================================================================

function verifyFirestoreConnection() {
  try {
    var url = FIRESTORE_CONFIG.BASE_URL + '?pageSize=1';
    var response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: getFirestoreHeaders_(),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('[DatabaseSetup] Firestore connection verified. Project: ' + FIRESTORE_CONFIG.PROJECT_ID);
      return { success: true, projectId: FIRESTORE_CONFIG.PROJECT_ID };
    }
    return { success: false, error: 'HTTP ' + code };
  } catch (e) {
    Logger.log('[DatabaseSetup] verifyFirestoreConnection error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// CACHING
// ============================================================================

function getCachedSheetData(sheetName) {
  var collection = getCollectionName(sheetName);
  var cacheKey = 'hass_cms_' + collection + '_all';
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) { /* cache parse error, fetch fresh */ }
  }
  var data = firestoreList(collection);
  try {
    var jsonStr = JSON.stringify(data);
    if (jsonStr.length < 100000) {
      cache.put(cacheKey, jsonStr, CONFIG.CACHE_TTL_SECONDS);
    }
  } catch (e) { /* cache too large, skip */ }
  return data;
}

function clearSheetCache(sheetName) {
  var collection = getCollectionName(sheetName);
  var cache = CacheService.getScriptCache();
  cache.remove('hass_cms_' + collection + '_all');
}

// ============================================================================
// CRUD OPERATIONS (compatible signatures)
// ============================================================================

function getSheetData(sheetName) {
  var collection = getCollectionName(sheetName);
  return firestoreList(collection);
}

function appendRow(sheetName, rowData) {
  var collection = getCollectionName(sheetName);
  var idField = getIdField(sheetName);
  var docId = (idField && rowData[idField]) ? rowData[idField] : Utilities.getUuid();

  if (!rowData.created_at) rowData.created_at = new Date().toISOString();
  if (!rowData.updated_at) rowData.updated_at = new Date().toISOString();

  firestoreCreate(collection, docId, rowData);
  return rowData;
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
  var collection = getCollectionName(sheetName);
  var docs = firestoreQuery(collection, {
    where: {
      fieldFilter: {
        field: { fieldPath: columnName },
        op: 'EQUAL',
        value: toFirestoreValue(value),
      },
    },
    limit: 1,
  });
  return docs.length > 0 ? docs[0] : null;
}

function findRows(sheetName, columnName, value) {
  var collection = getCollectionName(sheetName);
  return firestoreQuery(collection, {
    where: {
      fieldFilter: {
        field: { fieldPath: columnName },
        op: 'EQUAL',
        value: toFirestoreValue(value),
      },
    },
  });
}

function updateRow(sheetName, idColumn, idValue, updates) {
  var collection = getCollectionName(sheetName);
  updates.updated_at = new Date().toISOString();

  // Try direct doc access if the idColumn is the primary ID field
  var idField = getIdField(sheetName);
  if (idColumn === idField) {
    return firestoreUpdate(collection, idValue, updates);
  }

  // Otherwise query for the document first
  var doc = findRow(sheetName, idColumn, idValue);
  if (!doc) return false;

  var docId = doc._docId || doc[idField] || '';
  if (!docId) return false;

  return firestoreUpdate(collection, docId, updates);
}

function deleteRow(sheetName, idColumn, idValue, hardDelete) {
  // Per spec: hard deletes are manual-only via Cloud Console
  // Soft delete: set status to DELETED
  if (hardDelete) {
    // Mark as DELETED instead of actual deletion
    return updateRow(sheetName, idColumn, idValue, {
      status: 'DELETED',
      updated_at: new Date().toISOString(),
    });
  }
  return updateRow(sheetName, idColumn, idValue, {
    status: 'DELETED',
    updated_at: new Date().toISOString(),
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
// SEQUENCE NUMBER GENERATORS (Firestore-based)
// ============================================================================

function generateTicketNumber(countryCode) {
  var year = new Date().getFullYear();
  var prefix = 'TKT-' + countryCode + '-' + year;
  var collection = getCollectionName('Tickets');
  var docs = firestoreQuery(collection, {
    where: {
      fieldFilter: {
        field: { fieldPath: 'ticket_number' },
        op: 'GREATER_THAN_OR_EQUAL',
        value: { stringValue: prefix },
      },
    },
  });
  var count = docs.filter(function(d) {
    return d.ticket_number && d.ticket_number.startsWith(prefix);
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

function generateOrderNumber(countryCode) {
  var year = new Date().getFullYear();
  var prefix = 'ORD-' + countryCode + '-' + year;
  var collection = getCollectionName('Orders');
  var docs = firestoreQuery(collection, {
    where: {
      fieldFilter: {
        field: { fieldPath: 'order_number' },
        op: 'GREATER_THAN_OR_EQUAL',
        value: { stringValue: prefix },
      },
    },
  });
  var count = docs.filter(function(d) {
    return d.order_number && d.order_number.startsWith(prefix);
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

function generateAccountNumber(countryCode) {
  var prefix = 'HASS-' + countryCode;
  var collection = getCollectionName('Customers');
  var docs = firestoreQuery(collection, {
    where: {
      fieldFilter: {
        field: { fieldPath: 'account_number' },
        op: 'GREATER_THAN_OR_EQUAL',
        value: { stringValue: prefix },
      },
    },
  });
  var count = docs.filter(function(d) {
    return d.account_number && d.account_number.startsWith(prefix);
  }).length;
  return prefix + '-' + String(count + 1).padStart(6, '0');
}

// ============================================================================
// TIMESTAMP UTILITIES
// ============================================================================

function getCurrentTimestamp() { return new Date().toISOString(); }
function getCurrentDate() { return new Date().toISOString(); }

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
      created_at: new Date().toISOString(),
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
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    Logger.log('[DatabaseSetup] logIntegrationCall error: ' + e.message);
  }
}

function getConfig(key, defaultValue) {
  var row = findRow('Config', 'config_key', key);
  return row ? row.config_value : (defaultValue || '');
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
