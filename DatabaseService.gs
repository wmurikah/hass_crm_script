/**
 * HASS PETROLEUM CMS - DATABASE SERVICE
 * Version: 2.0.0
 * Database: Google Sheets (SPREADSHEET_ID in Script Properties)
 *
 * Advanced CRUD operations with:
 * - CacheService integration (5-minute TTL)
 * - Batch operations
 * - Query helpers (findWhere, search, pagination)
 * - Transaction-like operations with LockService
 * - DB object (read-only helpers)
 *
 * Core Sheet functions are in DatabaseSetup.gs
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DB_SERVICE_CONFIG = {
  CACHE_TTL_SECONDS: 300,
  CACHE_MAX_SIZE: 100000,
  BATCH_SIZE: 500,
  LOCK_TIMEOUT_MS: 30000,
  MAX_QUERY_RESULTS: 1000,
  STATIC_SHEETS: ['Countries', 'Segments', 'Products', 'Depots', 'SLAConfig', 'Config', 'Teams', 'KnowledgeCategories'],
};

// ============================================================================
// DB OBJECT (read-only helpers)
// ============================================================================

const DB = {
  getById: function(sheetName, id) {
    var idField = getIdField(sheetName);
    if (!idField) return null;
    return findRow(sheetName, idField, id);
  },

  getByIds: function(sheetName, ids) {
    if (!ids || ids.length === 0) return [];
    var idField = getIdField(sheetName);
    if (!idField) return [];
    var data = getSheetData(sheetName);
    var idSet = {};
    for (var i = 0; i < ids.length; i++) idSet[ids[i]] = true;
    return data.filter(function(row) { return idSet[row[idField]]; });
  },

  getAll: function(sheetName) {
    return getSheetData(sheetName);
  },

  getFiltered: function(sheetName, filters, orderBy, limit) {
    var data = getSheetData(sheetName);
    var filterKeys = Object.keys(filters || {});

    var filtered = data.filter(function(row) {
      for (var i = 0; i < filterKeys.length; i++) {
        if (String(row[filterKeys[i]]) !== String(filters[filterKeys[i]])) return false;
      }
      return true;
    });

    if (orderBy) {
      filtered.sort(function(a, b) {
        var aVal = a[orderBy];
        var bVal = b[orderBy];
        if (typeof aVal === 'string' && typeof bVal === 'string') return aVal.localeCompare(bVal);
        if (aVal < bVal) return -1;
        if (aVal > bVal) return 1;
        return 0;
      });
    }

    if (limit) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  },

  count: function(sheetName, filters) {
    var results = DB.getFiltered(sheetName, filters);
    return results.length;
  },
};

// ============================================================================
// ENHANCED CRUD OPERATIONS
// ============================================================================

function createRecord(sheetName, data, context) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    var schema = SCHEMAS[sheetName];
    var idField = getIdField(sheetName);
    if (idField && !data[idField]) {
      data[idField] = generateIdForSheet(sheetName);
    }
    var now = new Date().toISOString();
    data.created_at = now;
    data.updated_at = now;

    if (schema) {
      var validation = validateRecord(sheetName, data, schema);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
    }

    var result = appendRow(sheetName, data);
    clearSheetCache(sheetName);

    if (context) {
      logAudit(sheetName, data[idField], 'CREATE',
        context.actorType || 'SYSTEM',
        context.actorId || '',
        context.actorEmail || '',
        { record: sanitizeForAudit(data) },
        { countryCode: data.country_code || '' });
    }

    return { success: true, data: result, id: data[idField] };
  } catch (e) {
    Logger.log('[DatabaseService] createRecord error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Failed to create record' };
  } finally {
    lock.releaseLock();
  }
}

function updateRecord(sheetName, id, updates, context, expectedUpdatedAt) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    var idField = getIdField(sheetName);
    if (!idField) {
      return { success: false, error: 'Unknown entity: ' + sheetName };
    }
    var current = getById(sheetName, id);
    if (!current) {
      return { success: false, error: 'Record not found' };
    }
    if (expectedUpdatedAt && current.updated_at) {
      if (String(current.updated_at) !== String(expectedUpdatedAt)) {
        return { success: false, error: 'Record has been modified by another user. Please refresh and try again.', conflict: true };
      }
    }
    var protectedFields = ['created_at', idField];
    for (var i = 0; i < protectedFields.length; i++) {
      delete updates[protectedFields[i]];
    }
    updates.updated_at = new Date().toISOString();

    var changes = {};
    for (var key in updates) {
      if (updates.hasOwnProperty(key) && current[key] !== updates[key]) {
        changes[key] = { from: current[key], to: updates[key] };
      }
    }

    var success = updateRow(sheetName, idField, id, updates);
    if (!success) {
      return { success: false, error: 'Failed to update record' };
    }
    clearSheetCache(sheetName);

    if (context && Object.keys(changes).length > 0) {
      logAudit(sheetName, id, 'UPDATE',
        context.actorType || 'SYSTEM',
        context.actorId || '',
        context.actorEmail || '',
        changes,
        { countryCode: current.country_code || '' });
    }
    return { success: true, changes: changes };
  } catch (e) {
    Logger.log('[DatabaseService] updateRecord error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Failed to update record' };
  } finally {
    lock.releaseLock();
  }
}

function softDeleteRecord(sheetName, id, context) {
  return updateRecord(sheetName, id, { status: 'DELETED' }, context);
}

function hardDeleteRecord(sheetName, id, context) {
  // Log the intent and perform the delete
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    var idField = getIdField(sheetName);
    var current = getById(sheetName, id);
    if (!current) {
      return { success: false, error: 'Record not found' };
    }
    updateRow(sheetName, idField, id, { status: 'DELETED', updated_at: new Date().toISOString() });
    clearSheetCache(sheetName);
    if (context) {
      logAudit(sheetName, id, 'DELETE',
        context.actorType || 'SYSTEM', context.actorId || '', context.actorEmail || '',
        { deleted_record: sanitizeForAudit(current) },
        { countryCode: current.country_code || '' });
    }
    return { success: true };
  } catch (e) {
    Logger.log('[DatabaseService] hardDeleteRecord error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Failed to delete record' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

function findWhere(sheetName, conditions, options) {
  options = options || {};
  try {
    var useCache = DB_SERVICE_CONFIG.STATIC_SHEETS.indexOf(sheetName) !== -1;
    var allData = useCache ? getCachedSheetData(sheetName) : getSheetData(sheetName);

    var filtered = allData.filter(function(row) {
      if (!options.includeDeleted && row.status === 'DELETED') return false;
      for (var field in conditions) {
        if (!conditions.hasOwnProperty(field)) continue;
        var condition = conditions[field];
        var rowValue = row[field];
        if (condition === null || condition === undefined) {
          if (rowValue !== null && rowValue !== undefined && rowValue !== '') return false;
        } else if (typeof condition === 'object' && condition.op) {
          if (!evaluateCondition(rowValue, condition.op, condition.value)) return false;
        } else if (Array.isArray(condition)) {
          if (condition.indexOf(rowValue) === -1) return false;
        } else {
          if (rowValue !== condition) return false;
        }
      }
      return true;
    });

    var total = filtered.length;

    if (options.sortBy) {
      var sortOrder = options.sortOrder === 'desc' ? -1 : 1;
      filtered.sort(function(a, b) {
        var aVal = a[options.sortBy];
        var bVal = b[options.sortBy];
        if (typeof aVal === 'string' && typeof bVal === 'string') return aVal.localeCompare(bVal) * sortOrder;
        if (aVal < bVal) return -1 * sortOrder;
        if (aVal > bVal) return 1 * sortOrder;
        return 0;
      });
    }

    var offset = options.offset || 0;
    var limit = Math.min(options.limit || DB_SERVICE_CONFIG.MAX_QUERY_RESULTS, DB_SERVICE_CONFIG.MAX_QUERY_RESULTS);
    var paginated = filtered.slice(offset, offset + limit);

    return { success: true, data: paginated, total: total, offset: offset, limit: limit, hasMore: offset + paginated.length < total };
  } catch (e) {
    Logger.log('[DatabaseService] findWhere error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Query failed', data: [], total: 0 };
  }
}

function searchRecords(sheetName, searchText, searchFields, additionalFilters, options) {
  additionalFilters = additionalFilters || {};
  options = options || {};
  try {
    if (!searchText || searchText.trim().length < 2) {
      return { success: false, error: 'Search text must be at least 2 characters', data: [], total: 0 };
    }
    var searchLower = searchText.toLowerCase().trim();
    var searchTerms = searchLower.split(/\s+/);
    var allData = getSheetData(sheetName);

    var filtered = allData.filter(function(row) {
      if (!options.includeDeleted && row.status === 'DELETED') return false;
      for (var field in additionalFilters) {
        if (row[field] !== additionalFilters[field]) return false;
      }
      for (var i = 0; i < searchFields.length; i++) {
        var fieldValue = String(row[searchFields[i]] || '').toLowerCase();
        var allTermsFound = searchTerms.every(function(term) { return fieldValue.indexOf(term) !== -1; });
        if (allTermsFound) return true;
      }
      return false;
    });

    var total = filtered.length;
    filtered.sort(function(a, b) {
      var aName = String(a[searchFields[0]] || '').toLowerCase();
      var bName = String(b[searchFields[0]] || '').toLowerCase();
      var aStarts = aName.indexOf(searchLower) === 0 ? 0 : 1;
      var bStarts = bName.indexOf(searchLower) === 0 ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return aName.localeCompare(bName);
    });

    var offset = options.offset || 0;
    var limit = Math.min(options.limit || 50, DB_SERVICE_CONFIG.MAX_QUERY_RESULTS);
    var paginated = filtered.slice(offset, offset + limit);

    return { success: true, data: paginated, total: total, searchText: searchText, hasMore: offset + paginated.length < total };
  } catch (e) {
    Logger.log('[DatabaseService] searchRecords error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Search failed', data: [], total: 0 };
  }
}

function getById(sheetName, id) {
  var idField = getIdField(sheetName);
  if (!idField) return null;
  var useCache = DB_SERVICE_CONFIG.STATIC_SHEETS.indexOf(sheetName) !== -1;
  if (useCache) {
    var data = getCachedSheetData(sheetName);
    return data.find(function(row) { return row[idField] === id; }) || null;
  }
  return findRow(sheetName, idField, id);
}

function getByIds(sheetName, ids) {
  if (!ids || ids.length === 0) return [];
  var idField = getIdField(sheetName);
  if (!idField) return [];
  var data = getSheetData(sheetName);
  var idSet = {};
  for (var i = 0; i < ids.length; i++) idSet[ids[i]] = true;
  return data.filter(function(row) { return idSet[row[idField]]; });
}

function countWhere(sheetName, conditions) {
  conditions = conditions || {};
  var result = findWhere(sheetName, conditions, { limit: 1 });
  return result.total || 0;
}

function exists(sheetName, field, value, excludeId) {
  var idField = getIdField(sheetName);
  var data = getSheetData(sheetName);
  return data.some(function(row) {
    if (excludeId && row[idField] === excludeId) return false;
    return row[field] === value && row.status !== 'DELETED';
  });
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

function bulkCreate(sheetName, records, context) {
  if (!records || records.length === 0) {
    return { success: true, created: 0, ids: [] };
  }
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    var idField = getIdField(sheetName);
    var now = new Date().toISOString();
    var ids = [];
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      var id = record[idField] || generateIdForSheet(sheetName);
      ids.push(id);
      record[idField] = id;
      record.created_at = now;
      record.updated_at = now;
      appendRow(sheetName, record);
    }
    clearSheetCache(sheetName);
    if (context) {
      logAudit(sheetName, ids.join(','), 'BULK_CREATE',
        context.actorType || 'SYSTEM', context.actorId || '', context.actorEmail || '',
        { count: records.length }, {});
    }
    return { success: true, created: records.length, ids: ids };
  } catch (e) {
    Logger.log('[DatabaseService] bulkCreate error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Bulk create failed' };
  } finally {
    lock.releaseLock();
  }
}

function bulkUpdate(sheetName, updates, context) {
  if (!updates || updates.length === 0) {
    return { success: true, updated: 0 };
  }
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    var idField = getIdField(sheetName);
    var now = new Date().toISOString();
    var updatedCount = 0;
    for (var i = 0; i < updates.length; i++) {
      var update = updates[i];
      var fields = update.fields || {};
      fields.updated_at = now;
      var success = updateRow(sheetName, idField, update.id, fields);
      if (success) updatedCount++;
    }
    clearSheetCache(sheetName);
    if (context) {
      logAudit(sheetName, 'bulk_' + updates.length, 'BULK_UPDATE',
        context.actorType || 'SYSTEM', context.actorId || '', context.actorEmail || '',
        { count: updatedCount }, {});
    }
    return { success: true, updated: updatedCount };
  } catch (e) {
    Logger.log('[DatabaseService] bulkUpdate error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Bulk update failed' };
  } finally {
    lock.releaseLock();
  }
}

function updateWhere(sheetName, conditions, updates, context) {
  try {
    var matches = findWhere(sheetName, conditions, { limit: 10000 });
    if (!matches.success || matches.data.length === 0) {
      return { success: true, updated: 0 };
    }
    var idField = getIdField(sheetName);
    var updateItems = matches.data.map(function(row) {
      return { id: row[idField], fields: updates };
    });
    return bulkUpdate(sheetName, updateItems, context);
  } catch (e) {
    Logger.log('[DatabaseService] updateWhere error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Update where failed' };
  }
}

// ============================================================================
// RELATIONSHIP QUERIES
// ============================================================================

function getCustomer360(customerId) {
  try {
    var customer = getById('Customers', customerId);
    if (!customer) return { success: false, error: 'Customer not found' };

    var contacts = findWhere('Contacts', { customer_id: customerId }, { limit: 100 }).data || [];
    var locations = findWhere('DeliveryLocations', { customer_id: customerId, status: 'ACTIVE' }, { limit: 50 }).data || [];
    var documents = findWhere('Documents', { customer_id: customerId }, { sortBy: 'expiry_date', sortOrder: 'asc', limit: 50 }).data || [];
    var orders = findWhere('Orders', { customer_id: customerId }, { sortBy: 'created_at', sortOrder: 'desc', limit: 20 }).data || [];
    var openTickets = findWhere('Tickets', { customer_id: customerId, status: ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED'] }, { sortBy: 'created_at', sortOrder: 'desc', limit: 20 }).data || [];
    var closedTickets = findWhere('Tickets', { customer_id: customerId, status: ['RESOLVED', 'CLOSED'] }, { sortBy: 'resolved_at', sortOrder: 'desc', limit: 10 }).data || [];
    var segment = customer.segment_id ? getById('Segments', customer.segment_id) : null;
    var country = customer.country_code ? getCachedSheetData('Countries').find(function(c) { return c.country_code === customer.country_code; }) : null;
    var relationshipOwner = customer.relationship_owner_id ? getById('Users', customer.relationship_owner_id) : null;

    var stats = {
      totalOrders: countWhere('Orders', { customer_id: customerId }),
      totalTickets: countWhere('Tickets', { customer_id: customerId }),
      openTickets: openTickets.length,
      documentsExpiringSoon: documents.filter(function(d) {
        if (!d.expiry_date) return false;
        var daysUntilExpiry = (new Date(d.expiry_date) - new Date()) / (1000 * 60 * 60 * 24);
        return daysUntilExpiry > 0 && daysUntilExpiry <= 30;
      }).length,
      creditUtilization: customer.credit_limit > 0 ? Math.round((customer.credit_used / customer.credit_limit) * 100) : 0,
    };

    return {
      success: true, customer: customer, segment: segment, country: country,
      relationshipOwner: relationshipOwner ? { user_id: relationshipOwner.user_id, name: relationshipOwner.first_name + ' ' + relationshipOwner.last_name, email: relationshipOwner.email, phone: relationshipOwner.phone } : null,
      contacts: contacts, locations: locations, documents: documents, orders: orders,
      openTickets: openTickets, closedTickets: closedTickets, stats: stats,
    };
  } catch (e) {
    Logger.log('[DatabaseService] getCustomer360 error: ' + e.message);
    return { success: false, error: 'Failed to load customer data' };
  }
}

function getTicketDetail(ticketId) {
  try {
    var ticket = getById('Tickets', ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found' };

    var customer = ticket.customer_id ? getById('Customers', ticket.customer_id) : null;
    var contact = ticket.contact_id ? getById('Contacts', ticket.contact_id) : null;
    var assignee = ticket.assigned_to ? getById('Users', ticket.assigned_to) : null;
    var team = ticket.assigned_team_id ? getById('Teams', ticket.assigned_team_id) : null;
    var comments = findWhere('TicketComments', { ticket_id: ticketId }, { sortBy: 'created_at', sortOrder: 'asc', limit: 500 }).data || [];
    var attachments = findWhere('TicketAttachments', { ticket_id: ticketId }, { sortBy: 'created_at', sortOrder: 'desc', limit: 100 }).data || [];
    var history = findWhere('TicketHistory', { ticket_id: ticketId }, { sortBy: 'created_at', sortOrder: 'desc', limit: 100 }).data || [];
    var relatedOrder = ticket.related_order_id ? getById('Orders', ticket.related_order_id) : null;
    var slaConfig = ticket.sla_config_id ? getById('SLAConfig', ticket.sla_config_id) : null;
    var slaStatus = calculateSLAStatus(ticket, slaConfig);

    return {
      success: true, ticket: ticket,
      customer: customer ? { customer_id: customer.customer_id, company_name: customer.company_name, account_number: customer.account_number, segment_id: customer.segment_id, country_code: customer.country_code, status: customer.status } : null,
      contact: contact ? { contact_id: contact.contact_id, name: contact.first_name + ' ' + contact.last_name, email: contact.email, phone: contact.phone } : null,
      assignee: assignee ? { user_id: assignee.user_id, name: assignee.first_name + ' ' + assignee.last_name, email: assignee.email } : null,
      team: team, comments: comments, attachments: attachments, history: history,
      relatedOrder: relatedOrder, slaConfig: slaConfig, slaStatus: slaStatus,
    };
  } catch (e) {
    Logger.log('[DatabaseService] getTicketDetail error: ' + e.message);
    return { success: false, error: 'Failed to load ticket data' };
  }
}

function getOrderDetail(orderId) {
  try {
    var order = getById('Orders', orderId);
    if (!order) return { success: false, error: 'Order not found' };

    var customer = order.customer_id ? getById('Customers', order.customer_id) : null;
    var contact = order.contact_id ? getById('Contacts', order.contact_id) : null;
    var location = order.delivery_location_id ? getById('DeliveryLocations', order.delivery_location_id) : null;
    var depot = order.source_depot_id ? getById('Depots', order.source_depot_id) : null;
    var lines = findWhere('OrderLines', { order_id: orderId }, { sortBy: 'created_at', sortOrder: 'asc' }).data || [];
    var products = getCachedSheetData('Products');
    var enrichedLines = lines.map(function(line) {
      var product = products.find(function(p) { return p.product_id === line.product_id; });
      return Object.assign({}, line, { product: product || null });
    });
    var statusHistory = findWhere('OrderStatusHistory', { order_id: orderId }, { sortBy: 'created_at', sortOrder: 'desc', limit: 50 }).data || [];
    var vehicle = order.vehicle_id ? getById('Vehicles', order.vehicle_id) : null;
    var driver = order.driver_id ? getById('Drivers', order.driver_id) : null;
    var approver = order.approved_by ? getById('Users', order.approved_by) : null;
    var relatedTickets = findWhere('Tickets', { related_order_id: orderId }, { sortBy: 'created_at', sortOrder: 'desc', limit: 10 }).data || [];

    return {
      success: true, order: order, customer: customer, contact: contact, location: location, depot: depot,
      lines: enrichedLines, statusHistory: statusHistory, vehicle: vehicle, driver: driver,
      approver: approver ? { user_id: approver.user_id, name: approver.first_name + ' ' + approver.last_name } : null,
      relatedTickets: relatedTickets,
    };
  } catch (e) {
    Logger.log('[DatabaseService] getOrderDetail error: ' + e.message);
    return { success: false, error: 'Failed to load order data' };
  }
}

// ============================================================================
// AGGREGATION QUERIES
// ============================================================================

function groupByCount(sheetName, groupByField, conditions) {
  conditions = conditions || {};
  try {
    var data = getSheetData(sheetName);
    var counts = {};
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var matches = true;
      for (var field in conditions) {
        if (row[field] !== conditions[field]) { matches = false; break; }
      }
      if (!matches || row.status === 'DELETED') continue;
      var groupValue = row[groupByField] || 'Unknown';
      counts[groupValue] = (counts[groupValue] || 0) + 1;
    }
    var totalCount = 0;
    for (var k in counts) totalCount += counts[k];
    return { success: true, groupBy: groupByField, data: counts, total: totalCount };
  } catch (e) {
    Logger.log('[DatabaseService] groupByCount error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Aggregation failed', data: {} };
  }
}

function sumField(sheetName, sumFieldName, conditions) {
  conditions = conditions || {};
  try {
    var data = getSheetData(sheetName);
    var sum = 0, count = 0;
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var matches = true;
      for (var field in conditions) {
        if (row[field] !== conditions[field]) { matches = false; break; }
      }
      if (!matches || row.status === 'DELETED') continue;
      var value = parseFloat(row[sumFieldName]) || 0;
      sum += value;
      count++;
    }
    return { success: true, field: sumFieldName, sum: sum, count: count, average: count > 0 ? sum / count : 0 };
  } catch (e) {
    Logger.log('[DatabaseService] sumField error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Sum failed', sum: 0 };
  }
}

function getByDateRange(sheetName, dateField, startDate, endDate, additionalConditions, options) {
  additionalConditions = additionalConditions || {};
  options = options || {};
  try {
    var data = getSheetData(sheetName);
    var filtered = data.filter(function(row) {
      var dateValue = row[dateField];
      if (!dateValue) return false;
      var rowDate = new Date(dateValue);
      if (rowDate < startDate || rowDate > endDate) return false;
      for (var field in additionalConditions) {
        if (row[field] !== additionalConditions[field]) return false;
      }
      if (!options.includeDeleted && row.status === 'DELETED') return false;
      return true;
    });
    filtered.sort(function(a, b) {
      var dateA = new Date(a[dateField]);
      var dateB = new Date(b[dateField]);
      return options.sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
    });
    var offset = options.offset || 0;
    var limit = options.limit || 100;
    var paginated = filtered.slice(offset, offset + limit);
    return { success: true, data: paginated, total: filtered.length, hasMore: offset + paginated.length < filtered.length };
  } catch (e) {
    Logger.log('[DatabaseService] getByDateRange error (' + sheetName + '): ' + e.message);
    return { success: false, error: 'Date range query failed', data: [] };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function evaluateCondition(value, op, compareValue) {
  switch (op) {
    case '=': case '==': return value === compareValue;
    case '!=': case '<>': return value !== compareValue;
    case '>': return value > compareValue;
    case '>=': return value >= compareValue;
    case '<': return value < compareValue;
    case '<=': return value <= compareValue;
    case 'contains': return String(value).toLowerCase().indexOf(String(compareValue).toLowerCase()) !== -1;
    case 'startsWith': return String(value).toLowerCase().indexOf(String(compareValue).toLowerCase()) === 0;
    case 'in': return Array.isArray(compareValue) && compareValue.indexOf(value) !== -1;
    case 'notIn': return Array.isArray(compareValue) && compareValue.indexOf(value) === -1;
    case 'isNull': return value === null || value === undefined || value === '';
    case 'isNotNull': return value !== null && value !== undefined && value !== '';
    default: return false;
  }
}

function validateRecord(sheetName, data, schema) {
  var idField = getIdField(sheetName);
  if (idField && !data[idField]) {
    return { valid: false, error: idField + ' is required' };
  }
  if (schema.validations) {
    for (var field in schema.validations) {
      if (data[field] && schema.validations[field].indexOf(data[field]) === -1) {
        return { valid: false, error: 'Invalid value for ' + field + ': ' + data[field] };
      }
    }
  }
  return { valid: true };
}

function sanitizeForAudit(data) {
  var sensitiveFields = ['password', 'password_hash', 'token', 'token_hash', 'mfa_secret', 'auth_uid'];
  var sanitized = Object.assign({}, data);
  for (var i = 0; i < sensitiveFields.length; i++) {
    if (sanitized[sensitiveFields[i]]) sanitized[sensitiveFields[i]] = '[REDACTED]';
  }
  return sanitized;
}

function chunkArray(array, size) {
  var chunks = [];
  for (var i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function calculateSLAStatus(ticket, slaConfig) {
  if (!slaConfig) return { hasConfig: false };
  var now = new Date();
  var status = {
    hasConfig: true,
    acknowledge: { target: ticket.sla_acknowledge_by ? new Date(ticket.sla_acknowledge_by) : null, actual: ticket.acknowledged_at ? new Date(ticket.acknowledged_at) : null, breached: ticket.sla_acknowledge_breached || false },
    response: { target: ticket.sla_response_by ? new Date(ticket.sla_response_by) : null, actual: ticket.first_response_at ? new Date(ticket.first_response_at) : null, breached: ticket.sla_response_breached || false },
    resolution: { target: ticket.sla_resolve_by ? new Date(ticket.sla_resolve_by) : null, actual: ticket.resolved_at ? new Date(ticket.resolved_at) : null, breached: ticket.sla_resolve_breached || false },
  };
  var metrics = ['acknowledge', 'response', 'resolution'];
  for (var i = 0; i < metrics.length; i++) {
    var m = status[metrics[i]];
    if (m.target && !m.actual) {
      var diff = m.target - now;
      m.remainingMs = diff;
      m.remainingMinutes = Math.floor(diff / 60000);
      m.isOverdue = diff < 0;
      m.urgency = diff < 0 ? 'breached' : diff < 3600000 ? 'critical' : diff < 7200000 ? 'warning' : 'ok';
    } else if (m.target && m.actual) {
      m.metSLA = m.actual <= m.target;
    }
  }
  return status;
}

// ============================================================================
// DATA LOOKUP HELPERS
// ============================================================================

function getAllCountries() { return getCachedSheetData('Countries').filter(function(c) { return c.is_active !== false; }); }
function getAllSegments() { return getCachedSheetData('Segments').filter(function(s) { return s.is_active !== false; }); }
function getAllProducts() { return getCachedSheetData('Products').filter(function(p) { return p.is_active !== false; }); }
function getAllDepots() { return getCachedSheetData('Depots').filter(function(d) { return d.is_active !== false; }); }
function getAllTeams() { return getCachedSheetData('Teams').filter(function(t) { return t.is_active !== false; }); }
function getAllSLAConfigs() { return getCachedSheetData('SLAConfig').filter(function(s) { return s.is_active !== false; }); }

function getUsersByRole(role) { return findWhere('Users', { role: role, status: 'ACTIVE' }, { limit: 500 }).data || []; }
function getUsersByTeam(teamId) { return findWhere('Users', { team_id: teamId, status: 'ACTIVE' }, { limit: 100 }).data || []; }
function getUsersByCountry(countryCode) { return findWhere('Users', { country_code: countryCode, status: 'ACTIVE' }, { limit: 500 }).data || []; }

// ============================================================================
// API HANDLER
// ============================================================================

function handleDatabaseRequest(params) {
  var action = params.action;
  var entity = params.entity;

  switch (action) {
    case 'get': return { success: true, data: getById(entity, params.id) };
    case 'list': return findWhere(entity, params.conditions || {}, params.options || {});
    case 'search': return searchRecords(entity, params.searchText, params.searchFields, params.filters || {}, params.options || {});
    case 'create': return createRecord(entity, params.data, params.context);
    case 'update': return updateRecord(entity, params.id, params.data, params.context);
    case 'delete': return params.hard ? hardDeleteRecord(entity, params.id, params.context) : softDeleteRecord(entity, params.id, params.context);
    case 'bulkCreate': return bulkCreate(entity, params.records, params.context);
    case 'bulkUpdate': return bulkUpdate(entity, params.updates, params.context);
    case 'count': return { success: true, count: countWhere(entity, params.conditions || {}) };
    case 'groupBy': return groupByCount(entity, params.groupBy, params.conditions || {});
    case 'customer360': return getCustomer360(params.customerId);
    case 'ticketDetail': return getTicketDetail(params.ticketId);
    case 'orderDetail': return getOrderDetail(params.orderId);
    case 'countries': return { success: true, data: getAllCountries() };
    case 'segments': return { success: true, data: getAllSegments() };
    case 'products': return { success: true, data: getAllProducts() };
    case 'depots': return { success: true, data: getAllDepots() };
    case 'teams': return { success: true, data: getAllTeams() };
    case 'slaConfigs': return { success: true, data: getAllSLAConfigs() };
    default: return { success: false, error: 'Unknown action: ' + action };
  }
}
