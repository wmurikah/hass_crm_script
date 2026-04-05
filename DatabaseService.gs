/**
 * HASS PETROLEUM CMS - DATABASE SERVICE
 * Version: 1.0.0
 * 
 * Advanced CRUD operations with:
 * - CacheService integration (5-minute TTL)
 * - Batch operations for performance
 * - Query helpers (findWhere, search, pagination)
 * - Transaction-like operations with LockService
 * - Optimized reads (load entire sheet into memory for filtering)
 * 
 * Note: Basic CRUD functions are in DatabaseSetup.gs
 * This file extends those with advanced features.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DB_SERVICE_CONFIG = {
  CACHE_TTL_SECONDS: 300, // 5 minutes
  CACHE_MAX_SIZE: 100000, // 100KB max for cache entries
  BATCH_SIZE: 500, // Rows per batch operation
  LOCK_TIMEOUT_MS: 30000, // 30 seconds
  MAX_QUERY_RESULTS: 1000,
  STATIC_SHEETS: ['Countries', 'Segments', 'Products', 'Depots', 'SLAConfig', 'Config', 'Teams', 'KnowledgeCategories'],
};

// ============================================================================
// ENHANCED CRUD OPERATIONS
// ============================================================================

/**
 * Creates a new record with validation and audit logging.
 * @param {string} sheetName - Name of the sheet
 * @param {Object} data - Record data
 * @param {Object} context - Context with actor info { actorType, actorId, actorEmail }
 * @returns {Object} Created record with ID
 */
function createRecord(sheetName, data, context) {
  const lock = LockService.getScriptLock();
  
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    
    // Get schema for validation
    const schema = getSchema(sheetName);
    if (!schema) {
      return { success: false, error: `Unknown entity: ${sheetName}` };
    }
    
    // Generate ID if not provided
    const idField = getIdField(sheetName);
    if (idField && !data[idField]) {
      data[idField] = generateIdForSheet(sheetName);
    }
    
    // Add timestamps
    const now = getCurrentDate();
    data.created_at = now;
    data.updated_at = now;
    
    // Validate required fields and data types
    const validation = validateRecord(sheetName, data, schema);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    
    // Insert record
    const result = appendRow(sheetName, data);
    
    // Clear cache for this sheet
    clearSheetCache(sheetName);
    
    // Audit log
    if (context) {
      logAudit(sheetName, data[idField], 'CREATE', 
        context.actorType || 'SYSTEM', 
        context.actorId || '', 
        context.actorEmail || '',
        { record: sanitizeForAudit(data) },
        { countryCode: data.country_code || '' }
      );
    }
    
    return {
      success: true,
      data: result,
      id: data[idField],
    };
    
  } catch (e) {
    Logger.log(`createRecord error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Failed to create record' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Updates an existing record with optimistic locking support.
 * @param {string} sheetName - Name of the sheet
 * @param {string} id - Record ID
 * @param {Object} updates - Fields to update
 * @param {Object} context - Context with actor info
 * @param {Date} expectedUpdatedAt - For optimistic locking (optional)
 * @returns {Object} Result
 */
function updateRecord(sheetName, id, updates, context, expectedUpdatedAt) {
  const lock = LockService.getScriptLock();
  
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    
    const idField = getIdField(sheetName);
    if (!idField) {
      return { success: false, error: `Unknown entity: ${sheetName}` };
    }
    
    // Get current record
    const current = findRow(sheetName, idField, id);
    if (!current) {
      return { success: false, error: 'Record not found' };
    }
    
    // Optimistic locking check
    if (expectedUpdatedAt && current.updated_at) {
      const currentTime = new Date(current.updated_at).getTime();
      const expectedTime = new Date(expectedUpdatedAt).getTime();
      if (currentTime !== expectedTime) {
        return { 
          success: false, 
          error: 'Record has been modified by another user. Please refresh and try again.',
          conflict: true,
        };
      }
    }
    
    // Remove protected fields from updates
    const protectedFields = ['created_at', idField];
    for (const field of protectedFields) {
      delete updates[field];
    }
    
    // Set updated_at
    updates.updated_at = getCurrentDate();
    
    // Track changes for audit
    const changes = {};
    for (const [key, newValue] of Object.entries(updates)) {
      if (current[key] !== newValue) {
        changes[key] = { from: current[key], to: newValue };
      }
    }
    
    // Update record
    const success = updateRow(sheetName, idField, id, updates);
    
    if (!success) {
      return { success: false, error: 'Failed to update record' };
    }
    
    // Clear cache
    clearSheetCache(sheetName);
    
    // Audit log
    if (context && Object.keys(changes).length > 0) {
      logAudit(sheetName, id, 'UPDATE',
        context.actorType || 'SYSTEM',
        context.actorId || '',
        context.actorEmail || '',
        changes,
        { countryCode: current.country_code || '' }
      );
    }
    
    return {
      success: true,
      changes: changes,
    };
    
  } catch (e) {
    Logger.log(`updateRecord error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Failed to update record' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Soft deletes a record (sets status to DELETED).
 * @param {string} sheetName - Name of the sheet
 * @param {string} id - Record ID
 * @param {Object} context - Context with actor info
 * @returns {Object} Result
 */
function softDeleteRecord(sheetName, id, context) {
  return updateRecord(sheetName, id, { status: 'DELETED' }, context);
}

/**
 * Hard deletes a record (removes row from sheet).
 * @param {string} sheetName - Name of the sheet
 * @param {string} id - Record ID
 * @param {Object} context - Context with actor info
 * @returns {Object} Result
 */
function hardDeleteRecord(sheetName, id, context) {
  const lock = LockService.getScriptLock();
  
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    
    const idField = getIdField(sheetName);
    if (!idField) {
      return { success: false, error: `Unknown entity: ${sheetName}` };
    }
    
    // Get current record for audit
    const current = findRow(sheetName, idField, id);
    if (!current) {
      return { success: false, error: 'Record not found' };
    }
    
    // Delete
    const success = deleteRow(sheetName, idField, id, true);
    
    if (!success) {
      return { success: false, error: 'Failed to delete record' };
    }
    
    // Clear cache
    clearSheetCache(sheetName);
    
    // Audit log
    if (context) {
      logAudit(sheetName, id, 'DELETE',
        context.actorType || 'SYSTEM',
        context.actorId || '',
        context.actorEmail || '',
        { deleted_record: sanitizeForAudit(current) },
        { countryCode: current.country_code || '' }
      );
    }
    
    return { success: true };
    
  } catch (e) {
    Logger.log(`hardDeleteRecord error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Failed to delete record' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// QUERY OPERATIONS
// ============================================================================

/**
 * Finds records matching multiple conditions.
 * @param {string} sheetName - Name of the sheet
 * @param {Object} conditions - Field-value pairs or complex conditions
 * @param {Object} options - Query options { limit, offset, sortBy, sortOrder, includeDeleted }
 * @returns {Object} { data: [], total: number, hasMore: boolean }
 */
function findWhere(sheetName, conditions, options = {}) {
  try {
    // Use cache for static sheets
    const useCache = DB_SERVICE_CONFIG.STATIC_SHEETS.includes(sheetName);
    let allData = useCache ? getCachedSheetData(sheetName) : getSheetData(sheetName);
    
    // Filter by conditions
    let filtered = allData.filter(row => {
      // Exclude deleted records by default
      if (!options.includeDeleted && row.status === 'DELETED') {
        return false;
      }
      
      for (const [field, condition] of Object.entries(conditions)) {
        const rowValue = row[field];
        
        // Handle different condition types
        if (condition === null || condition === undefined) {
          if (rowValue !== null && rowValue !== undefined && rowValue !== '') {
            return false;
          }
        } else if (typeof condition === 'object' && condition.op) {
          // Complex condition: { op: '>', value: 100 }
          if (!evaluateCondition(rowValue, condition.op, condition.value)) {
            return false;
          }
        } else if (Array.isArray(condition)) {
          // IN condition: field: ['value1', 'value2']
          if (!condition.includes(rowValue)) {
            return false;
          }
        } else {
          // Simple equality
          if (rowValue !== condition) {
            return false;
          }
        }
      }
      return true;
    });
    
    const total = filtered.length;
    
    // Apply sorting
    if (options.sortBy) {
      const sortOrder = options.sortOrder === 'desc' ? -1 : 1;
      filtered.sort((a, b) => {
        const aVal = a[options.sortBy];
        const bVal = b[options.sortBy];
        
        // Handle dates
        if (aVal instanceof Date && bVal instanceof Date) {
          return (aVal.getTime() - bVal.getTime()) * sortOrder;
        }
        
        // Handle strings
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return aVal.localeCompare(bVal) * sortOrder;
        }
        
        // Handle numbers and others
        if (aVal < bVal) return -1 * sortOrder;
        if (aVal > bVal) return 1 * sortOrder;
        return 0;
      });
    }
    
    // Apply pagination
    const offset = options.offset || 0;
    const limit = Math.min(options.limit || DB_SERVICE_CONFIG.MAX_QUERY_RESULTS, DB_SERVICE_CONFIG.MAX_QUERY_RESULTS);
    
    const paginated = filtered.slice(offset, offset + limit);
    
    return {
      success: true,
      data: paginated,
      total: total,
      offset: offset,
      limit: limit,
      hasMore: offset + paginated.length < total,
    };
    
  } catch (e) {
    Logger.log(`findWhere error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Query failed', data: [], total: 0 };
  }
}

/**
 * Searches records by text across multiple fields.
 * @param {string} sheetName - Name of the sheet
 * @param {string} searchText - Text to search for
 * @param {string[]} searchFields - Fields to search in
 * @param {Object} additionalFilters - Additional field conditions
 * @param {Object} options - Query options
 * @returns {Object} Search results
 */
function searchRecords(sheetName, searchText, searchFields, additionalFilters = {}, options = {}) {
  try {
    if (!searchText || searchText.trim().length < 2) {
      return { success: false, error: 'Search text must be at least 2 characters', data: [], total: 0 };
    }
    
    const searchLower = searchText.toLowerCase().trim();
    const searchTerms = searchLower.split(/\s+/);
    
    let allData = getSheetData(sheetName);
    
    // Filter by search text
    let filtered = allData.filter(row => {
      // Exclude deleted records
      if (!options.includeDeleted && row.status === 'DELETED') {
        return false;
      }
      
      // Apply additional filters first
      for (const [field, value] of Object.entries(additionalFilters)) {
        if (row[field] !== value) {
          return false;
        }
      }
      
      // Search in specified fields
      for (const field of searchFields) {
        const fieldValue = String(row[field] || '').toLowerCase();
        
        // Check if all search terms are found
        const allTermsFound = searchTerms.every(term => fieldValue.includes(term));
        if (allTermsFound) {
          return true;
        }
      }
      
      return false;
    });
    
    const total = filtered.length;
    
    // Sort by relevance (simple: prefer matches at start)
    filtered.sort((a, b) => {
      const aName = String(a[searchFields[0]] || '').toLowerCase();
      const bName = String(b[searchFields[0]] || '').toLowerCase();
      
      const aStartsWith = aName.startsWith(searchLower) ? 0 : 1;
      const bStartsWith = bName.startsWith(searchLower) ? 0 : 1;
      
      if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith;
      return aName.localeCompare(bName);
    });
    
    // Apply pagination
    const offset = options.offset || 0;
    const limit = Math.min(options.limit || 50, DB_SERVICE_CONFIG.MAX_QUERY_RESULTS);
    
    const paginated = filtered.slice(offset, offset + limit);
    
    return {
      success: true,
      data: paginated,
      total: total,
      searchText: searchText,
      hasMore: offset + paginated.length < total,
    };
    
  } catch (e) {
    Logger.log(`searchRecords error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Search failed', data: [], total: 0 };
  }
}

/**
 * Gets a single record by ID.
 * @param {string} sheetName - Name of the sheet
 * @param {string} id - Record ID
 * @returns {Object} Record or null
 */
function getById(sheetName, id) {
  const idField = getIdField(sheetName);
  if (!idField) return null;
  
  const useCache = DB_SERVICE_CONFIG.STATIC_SHEETS.includes(sheetName);
  const data = useCache ? getCachedSheetData(sheetName) : getSheetData(sheetName);
  
  return data.find(row => row[idField] === id) || null;
}

/**
 * Gets multiple records by IDs.
 * @param {string} sheetName - Name of the sheet
 * @param {string[]} ids - Array of record IDs
 * @returns {Object[]} Array of records
 */
function getByIds(sheetName, ids) {
  if (!ids || ids.length === 0) return [];
  
  const idField = getIdField(sheetName);
  if (!idField) return [];
  
  const data = getSheetData(sheetName);
  const idSet = new Set(ids);
  
  return data.filter(row => idSet.has(row[idField]));
}

/**
 * Counts records matching conditions.
 * @param {string} sheetName - Name of the sheet
 * @param {Object} conditions - Field-value pairs
 * @returns {number} Count
 */
function countWhere(sheetName, conditions = {}) {
  const result = findWhere(sheetName, conditions, { limit: 1 });
  return result.total || 0;
}

/**
 * Checks if a record exists.
 * @param {string} sheetName - Name of the sheet
 * @param {string} field - Field to check
 * @param {*} value - Value to check
 * @param {string} excludeId - ID to exclude (for update uniqueness checks)
 * @returns {boolean} Whether record exists
 */
function exists(sheetName, field, value, excludeId = null) {
  const idField = getIdField(sheetName);
  const data = getSheetData(sheetName);
  
  return data.some(row => {
    if (excludeId && row[idField] === excludeId) return false;
    return row[field] === value && row.status !== 'DELETED';
  });
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Bulk creates multiple records.
 * @param {string} sheetName - Name of the sheet
 * @param {Object[]} records - Array of record objects
 * @param {Object} context - Context with actor info
 * @returns {Object} Result with created IDs
 */
function bulkCreate(sheetName, records, context) {
  if (!records || records.length === 0) {
    return { success: true, created: 0, ids: [] };
  }
  
  const lock = LockService.getScriptLock();
  
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    
    const idField = getIdField(sheetName);
    const now = getCurrentDate();
    const ids = [];
    
    // Prepare records with IDs and timestamps
    const preparedRecords = records.map(record => {
      const id = record[idField] || generateIdForSheet(sheetName);
      ids.push(id);
      
      return {
        ...record,
        [idField]: id,
        created_at: now,
        updated_at: now,
      };
    });
    
    // Insert in batches
    const batches = chunkArray(preparedRecords, DB_SERVICE_CONFIG.BATCH_SIZE);
    let totalCreated = 0;
    
    for (const batch of batches) {
      const count = bulkInsert(sheetName, batch);
      totalCreated += count;
    }
    
    // Clear cache
    clearSheetCache(sheetName);
    
    // Audit log
    if (context) {
      logAudit(sheetName, ids.join(','), 'BULK_CREATE',
        context.actorType || 'SYSTEM',
        context.actorId || '',
        context.actorEmail || '',
        { count: totalCreated },
        {}
      );
    }
    
    return {
      success: true,
      created: totalCreated,
      ids: ids,
    };
    
  } catch (e) {
    Logger.log(`bulkCreate error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Bulk create failed' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Bulk updates multiple records.
 * @param {string} sheetName - Name of the sheet
 * @param {Object[]} updates - Array of { id, fields } objects
 * @param {Object} context - Context with actor info
 * @returns {Object} Result
 */
function bulkUpdate(sheetName, updates, context) {
  if (!updates || updates.length === 0) {
    return { success: true, updated: 0 };
  }
  
  const lock = LockService.getScriptLock();
  
  try {
    if (!lock.tryLock(DB_SERVICE_CONFIG.LOCK_TIMEOUT_MS)) {
      return { success: false, error: 'System busy. Please try again.' };
    }
    
    const idField = getIdField(sheetName);
    const sheet = getSheet(sheetName);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idColIndex = headers.indexOf(idField);
    const updatedAtColIndex = headers.indexOf('updated_at');
    
    if (idColIndex === -1) {
      return { success: false, error: 'Invalid sheet structure' };
    }
    
    // Build lookup map for row indices
    const rowMap = new Map();
    for (let i = 1; i < data.length; i++) {
      rowMap.set(data[i][idColIndex], i + 1); // 1-based row number
    }
    
    const now = getCurrentDate();
    let updatedCount = 0;
    
    // Process each update
    for (const update of updates) {
      const rowNum = rowMap.get(update.id);
      if (!rowNum) continue;
      
      const fields = update.fields || {};
      fields.updated_at = now;
      
      // Update each field
      for (const [field, value] of Object.entries(fields)) {
        const colIndex = headers.indexOf(field);
        if (colIndex !== -1) {
          sheet.getRange(rowNum, colIndex + 1).setValue(value);
        }
      }
      
      updatedCount++;
    }
    
    // Clear cache
    clearSheetCache(sheetName);
    
    // Audit log
    if (context) {
      logAudit(sheetName, `bulk_${updates.length}`, 'BULK_UPDATE',
        context.actorType || 'SYSTEM',
        context.actorId || '',
        context.actorEmail || '',
        { count: updatedCount },
        {}
      );
    }
    
    return {
      success: true,
      updated: updatedCount,
    };
    
  } catch (e) {
    Logger.log(`bulkUpdate error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Bulk update failed' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Bulk updates records matching a condition.
 * @param {string} sheetName - Name of the sheet
 * @param {Object} conditions - Match conditions
 * @param {Object} updates - Fields to update
 * @param {Object} context - Context with actor info
 * @returns {Object} Result
 */
function updateWhere(sheetName, conditions, updates, context) {
  try {
    // Find matching records
    const matches = findWhere(sheetName, conditions, { limit: 10000 });
    if (!matches.success || matches.data.length === 0) {
      return { success: true, updated: 0 };
    }
    
    const idField = getIdField(sheetName);
    const updateItems = matches.data.map(row => ({
      id: row[idField],
      fields: updates,
    }));
    
    return bulkUpdate(sheetName, updateItems, context);
    
  } catch (e) {
    Logger.log(`updateWhere error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Update where failed' };
  }
}

// ============================================================================
// RELATIONSHIP QUERIES
// ============================================================================

/**
 * Gets a customer with all related data (Customer 360 view).
 * @param {string} customerId - Customer ID
 * @returns {Object} Customer with related records
 */
function getCustomer360(customerId) {
  try {
    const customer = getById('Customers', customerId);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    // Get related data in parallel (using cached where possible)
    const contacts = findWhere('Contacts', { customer_id: customerId }, { limit: 100 }).data || [];
    const locations = findWhere('DeliveryLocations', { customer_id: customerId, status: 'ACTIVE' }, { limit: 50 }).data || [];
    const documents = findWhere('Documents', { customer_id: customerId }, { sortBy: 'expiry_date', sortOrder: 'asc', limit: 50 }).data || [];
    
    // Recent orders (last 20)
    const orders = findWhere('Orders', { customer_id: customerId }, 
      { sortBy: 'created_at', sortOrder: 'desc', limit: 20 }).data || [];
    
    // Open tickets
    const openTickets = findWhere('Tickets', 
      { customer_id: customerId, status: ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED'] },
      { sortBy: 'created_at', sortOrder: 'desc', limit: 20 }).data || [];
    
    // Recent closed tickets
    const closedTickets = findWhere('Tickets',
      { customer_id: customerId, status: ['RESOLVED', 'CLOSED'] },
      { sortBy: 'resolved_at', sortOrder: 'desc', limit: 10 }).data || [];
    
    // Get segment info
    const segment = customer.segment_id ? getById('Segments', customer.segment_id) : null;
    
    // Get country info
    const country = customer.country_code ? 
      getCachedSheetData('Countries').find(c => c.country_code === customer.country_code) : null;
    
    // Get relationship owner
    const relationshipOwner = customer.relationship_owner_id ? 
      getById('Users', customer.relationship_owner_id) : null;
    
    // Calculate stats
    const stats = {
      totalOrders: countWhere('Orders', { customer_id: customerId }),
      totalTickets: countWhere('Tickets', { customer_id: customerId }),
      openTickets: openTickets.length,
      documentsExpiringSoon: documents.filter(d => {
        if (!d.expiry_date) return false;
        const daysUntilExpiry = (new Date(d.expiry_date) - new Date()) / (1000 * 60 * 60 * 24);
        return daysUntilExpiry > 0 && daysUntilExpiry <= 30;
      }).length,
      creditUtilization: customer.credit_limit > 0 ? 
        Math.round((customer.credit_used / customer.credit_limit) * 100) : 0,
    };
    
    return {
      success: true,
      customer: customer,
      segment: segment,
      country: country,
      relationshipOwner: relationshipOwner ? {
        user_id: relationshipOwner.user_id,
        name: `${relationshipOwner.first_name} ${relationshipOwner.last_name}`,
        email: relationshipOwner.email,
        phone: relationshipOwner.phone,
      } : null,
      contacts: contacts,
      locations: locations,
      documents: documents,
      orders: orders,
      openTickets: openTickets,
      closedTickets: closedTickets,
      stats: stats,
    };
    
  } catch (e) {
    Logger.log(`getCustomer360 error: ${e.message}`);
    return { success: false, error: 'Failed to load customer data' };
  }
}

/**
 * Gets a ticket with all related data.
 * @param {string} ticketId - Ticket ID
 * @returns {Object} Ticket with related records
 */
function getTicketDetail(ticketId) {
  try {
    const ticket = getById('Tickets', ticketId);
    if (!ticket) {
      return { success: false, error: 'Ticket not found' };
    }
    
    // Get related data
    const customer = ticket.customer_id ? getById('Customers', ticket.customer_id) : null;
    const contact = ticket.contact_id ? getById('Contacts', ticket.contact_id) : null;
    const assignee = ticket.assigned_to ? getById('Users', ticket.assigned_to) : null;
    const team = ticket.assigned_team_id ? getById('Teams', ticket.assigned_team_id) : null;
    
    // Get comments
    const comments = findWhere('TicketComments', { ticket_id: ticketId },
      { sortBy: 'created_at', sortOrder: 'asc', limit: 500 }).data || [];
    
    // Get attachments
    const attachments = findWhere('TicketAttachments', { ticket_id: ticketId },
      { sortBy: 'created_at', sortOrder: 'desc', limit: 100 }).data || [];
    
    // Get history
    const history = findWhere('TicketHistory', { ticket_id: ticketId },
      { sortBy: 'created_at', sortOrder: 'desc', limit: 100 }).data || [];
    
    // Get related order if any
    const relatedOrder = ticket.related_order_id ? getById('Orders', ticket.related_order_id) : null;
    
    // Get SLA config
    const slaConfig = ticket.sla_config_id ? getById('SLAConfig', ticket.sla_config_id) : null;
    
    // Calculate SLA status
    const slaStatus = calculateSLAStatus(ticket, slaConfig);
    
    return {
      success: true,
      ticket: ticket,
      customer: customer ? {
        customer_id: customer.customer_id,
        company_name: customer.company_name,
        account_number: customer.account_number,
        segment_id: customer.segment_id,
        country_code: customer.country_code,
        status: customer.status,
      } : null,
      contact: contact ? {
        contact_id: contact.contact_id,
        name: `${contact.first_name} ${contact.last_name}`,
        email: contact.email,
        phone: contact.phone,
      } : null,
      assignee: assignee ? {
        user_id: assignee.user_id,
        name: `${assignee.first_name} ${assignee.last_name}`,
        email: assignee.email,
      } : null,
      team: team,
      comments: comments,
      attachments: attachments,
      history: history,
      relatedOrder: relatedOrder,
      slaConfig: slaConfig,
      slaStatus: slaStatus,
    };
    
  } catch (e) {
    Logger.log(`getTicketDetail error: ${e.message}`);
    return { success: false, error: 'Failed to load ticket data' };
  }
}

/**
 * Gets an order with all related data.
 * @param {string} orderId - Order ID
 * @returns {Object} Order with related records
 */
function getOrderDetail(orderId) {
  try {
    const order = getById('Orders', orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }
    
    // Get related data
    const customer = order.customer_id ? getById('Customers', order.customer_id) : null;
    const contact = order.contact_id ? getById('Contacts', order.contact_id) : null;
    const location = order.delivery_location_id ? getById('DeliveryLocations', order.delivery_location_id) : null;
    const depot = order.source_depot_id ? getById('Depots', order.source_depot_id) : null;
    
    // Get order lines
    const lines = findWhere('OrderLines', { order_id: orderId },
      { sortBy: 'created_at', sortOrder: 'asc' }).data || [];
    
    // Enrich lines with product info
    const products = getCachedSheetData('Products');
    const enrichedLines = lines.map(line => {
      const product = products.find(p => p.product_id === line.product_id);
      return {
        ...line,
        product: product || null,
      };
    });
    
    // Get status history
    const statusHistory = findWhere('OrderStatusHistory', { order_id: orderId },
      { sortBy: 'created_at', sortOrder: 'desc', limit: 50 }).data || [];
    
    // Get vehicle and driver if assigned
    const vehicle = order.vehicle_id ? getById('Vehicles', order.vehicle_id) : null;
    const driver = order.driver_id ? getById('Drivers', order.driver_id) : null;
    
    // Get approved by user
    const approver = order.approved_by ? getById('Users', order.approved_by) : null;
    
    // Get related tickets
    const relatedTickets = findWhere('Tickets', { related_order_id: orderId },
      { sortBy: 'created_at', sortOrder: 'desc', limit: 10 }).data || [];
    
    return {
      success: true,
      order: order,
      customer: customer,
      contact: contact,
      location: location,
      depot: depot,
      lines: enrichedLines,
      statusHistory: statusHistory,
      vehicle: vehicle,
      driver: driver,
      approver: approver ? {
        user_id: approver.user_id,
        name: `${approver.first_name} ${approver.last_name}`,
      } : null,
      relatedTickets: relatedTickets,
    };
    
  } catch (e) {
    Logger.log(`getOrderDetail error: ${e.message}`);
    return { success: false, error: 'Failed to load order data' };
  }
}

// ============================================================================
// AGGREGATION QUERIES
// ============================================================================

/**
 * Gets aggregated statistics for a field.
 * @param {string} sheetName - Name of the sheet
 * @param {string} groupByField - Field to group by
 * @param {Object} conditions - Filter conditions
 * @returns {Object} Aggregated counts by group
 */
function groupByCount(sheetName, groupByField, conditions = {}) {
  try {
    const data = getSheetData(sheetName);
    const counts = {};
    
    for (const row of data) {
      // Check conditions
      let matches = true;
      for (const [field, value] of Object.entries(conditions)) {
        if (row[field] !== value) {
          matches = false;
          break;
        }
      }
      
      if (!matches) continue;
      
      // Exclude deleted
      if (row.status === 'DELETED') continue;
      
      const groupValue = row[groupByField] || 'Unknown';
      counts[groupValue] = (counts[groupValue] || 0) + 1;
    }
    
    return {
      success: true,
      groupBy: groupByField,
      data: counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    };
    
  } catch (e) {
    Logger.log(`groupByCount error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Aggregation failed', data: {} };
  }
}

/**
 * Gets sum of a numeric field.
 * @param {string} sheetName - Name of the sheet
 * @param {string} sumField - Field to sum
 * @param {Object} conditions - Filter conditions
 * @returns {Object} Sum result
 */
function sumField(sheetName, sumField, conditions = {}) {
  try {
    const data = getSheetData(sheetName);
    let sum = 0;
    let count = 0;
    
    for (const row of data) {
      // Check conditions
      let matches = true;
      for (const [field, value] of Object.entries(conditions)) {
        if (row[field] !== value) {
          matches = false;
          break;
        }
      }
      
      if (!matches) continue;
      if (row.status === 'DELETED') continue;
      
      const value = parseFloat(row[sumField]) || 0;
      sum += value;
      count++;
    }
    
    return {
      success: true,
      field: sumField,
      sum: sum,
      count: count,
      average: count > 0 ? sum / count : 0,
    };
    
  } catch (e) {
    Logger.log(`sumField error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Sum failed', sum: 0 };
  }
}

/**
 * Gets records created/updated within a date range.
 * @param {string} sheetName - Name of the sheet
 * @param {string} dateField - Date field to filter on
 * @param {Date} startDate - Start of range
 * @param {Date} endDate - End of range
 * @param {Object} additionalConditions - Additional filters
 * @param {Object} options - Query options
 * @returns {Object} Query results
 */
function getByDateRange(sheetName, dateField, startDate, endDate, additionalConditions = {}, options = {}) {
  try {
    const data = getSheetData(sheetName);
    
    const filtered = data.filter(row => {
      // Date range filter
      const dateValue = row[dateField];
      if (!dateValue) return false;
      
      const rowDate = new Date(dateValue);
      if (rowDate < startDate || rowDate > endDate) return false;
      
      // Additional conditions
      for (const [field, value] of Object.entries(additionalConditions)) {
        if (row[field] !== value) return false;
      }
      
      // Exclude deleted
      if (!options.includeDeleted && row.status === 'DELETED') return false;
      
      return true;
    });
    
    // Sort by date
    filtered.sort((a, b) => {
      const dateA = new Date(a[dateField]);
      const dateB = new Date(b[dateField]);
      return options.sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
    });
    
    // Paginate
    const offset = options.offset || 0;
    const limit = options.limit || 100;
    const paginated = filtered.slice(offset, offset + limit);
    
    return {
      success: true,
      data: paginated,
      total: filtered.length,
      hasMore: offset + paginated.length < filtered.length,
    };
    
  } catch (e) {
    Logger.log(`getByDateRange error (${sheetName}): ${e.message}`);
    return { success: false, error: 'Date range query failed', data: [] };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Gets the ID field name for a sheet.
 * @param {string} sheetName - Name of the sheet
 * @returns {string} ID field name
 */
function getIdField(sheetName) {
  const idFields = {
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

/**
 * Generates an ID for a specific sheet.
 * @param {string} sheetName - Name of the sheet
 * @returns {string} Generated ID
 */
function generateIdForSheet(sheetName) {
  const prefixes = {
    'Customers': 'CUS',
    'Contacts': 'CON',
    'Users': 'USR',
    'Teams': 'TEAM',
    'Tickets': 'TKT',
    'TicketComments': 'CMT',
    'TicketAttachments': 'ATT',
    'TicketHistory': 'TH',
    'Orders': 'ORD',
    'OrderLines': 'OL',
    'OrderStatusHistory': 'OSH',
    'RecurringSchedule': 'RS',
    'RecurringScheduleLines': 'RSL',
    'Products': 'PROD',
    'Depots': 'DEP',
    'PriceList': 'PL',
    'PriceListItems': 'PLI',
    'DeliveryLocations': 'LOC',
    'Documents': 'DOC',
    'Vehicles': 'VEH',
    'Drivers': 'DRV',
    'SLAConfig': 'SLA',
    'BusinessHours': 'BH',
    'Holidays': 'HOL',
    'ChurnRiskFactors': 'CRF',
    'RetentionActivities': 'RA',
    'Notifications': 'NOT',
    'NotificationPreferences': 'NP',
    'KnowledgeCategories': 'KCAT',
    'KnowledgeArticles': 'KART',
    'AuditLog': 'LOG',
    'Sessions': 'SES',
    'IntegrationLog': 'INT',
    'JobQueue': 'JOB',
  };
  
  const prefix = prefixes[sheetName] || 'REC';
  return generateId(prefix);
}

/**
 * Evaluates a comparison condition.
 * @param {*} value - Value to compare
 * @param {string} op - Operator
 * @param {*} compareValue - Value to compare against
 * @returns {boolean} Result
 */
function evaluateCondition(value, op, compareValue) {
  switch (op) {
    case '=':
    case '==':
      return value === compareValue;
    case '!=':
    case '<>':
      return value !== compareValue;
    case '>':
      return value > compareValue;
    case '>=':
      return value >= compareValue;
    case '<':
      return value < compareValue;
    case '<=':
      return value <= compareValue;
    case 'contains':
      return String(value).toLowerCase().includes(String(compareValue).toLowerCase());
    case 'startsWith':
      return String(value).toLowerCase().startsWith(String(compareValue).toLowerCase());
    case 'endsWith':
      return String(value).toLowerCase().endsWith(String(compareValue).toLowerCase());
    case 'in':
      return Array.isArray(compareValue) && compareValue.includes(value);
    case 'notIn':
      return Array.isArray(compareValue) && !compareValue.includes(value);
    case 'isNull':
      return value === null || value === undefined || value === '';
    case 'isNotNull':
      return value !== null && value !== undefined && value !== '';
    default:
      return false;
  }
}

/**
 * Validates a record against schema.
 * @param {string} sheetName - Name of the sheet
 * @param {Object} data - Record data
 * @param {Object} schema - Schema definition
 * @returns {Object} Validation result
 */
function validateRecord(sheetName, data, schema) {
  // Basic validation - check required ID field exists
  const idField = getIdField(sheetName);
  if (idField && !data[idField]) {
    return { valid: false, error: `${idField} is required` };
  }
  
  // Validate enum fields
  if (schema.validations) {
    for (const [field, allowedValues] of Object.entries(schema.validations)) {
      if (data[field] && !allowedValues.includes(data[field])) {
        return { valid: false, error: `Invalid value for ${field}: ${data[field]}` };
      }
    }
  }
  
  return { valid: true };
}

/**
 * Sanitizes data for audit logging (removes sensitive fields).
 * @param {Object} data - Data to sanitize
 * @returns {Object} Sanitized data
 */
function sanitizeForAudit(data) {
  const sensitiveFields = ['password', 'password_hash', 'token', 'token_hash', 'mfa_secret', 'auth_uid'];
  const sanitized = { ...data };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  return sanitized;
}

/**
 * Splits an array into chunks.
 * @param {Array} array - Array to chunk
 * @param {number} size - Chunk size
 * @returns {Array[]} Array of chunks
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Calculates SLA status for a ticket.
 * @param {Object} ticket - Ticket record
 * @param {Object} slaConfig - SLA configuration
 * @returns {Object} SLA status
 */
function calculateSLAStatus(ticket, slaConfig) {
  if (!slaConfig) {
    return { hasConfig: false };
  }
  
  const now = new Date();
  
  const status = {
    hasConfig: true,
    acknowledge: {
      target: ticket.sla_acknowledge_by ? new Date(ticket.sla_acknowledge_by) : null,
      actual: ticket.acknowledged_at ? new Date(ticket.acknowledged_at) : null,
      breached: ticket.sla_acknowledge_breached || false,
    },
    response: {
      target: ticket.sla_response_by ? new Date(ticket.sla_response_by) : null,
      actual: ticket.first_response_at ? new Date(ticket.first_response_at) : null,
      breached: ticket.sla_response_breached || false,
    },
    resolution: {
      target: ticket.sla_resolve_by ? new Date(ticket.sla_resolve_by) : null,
      actual: ticket.resolved_at ? new Date(ticket.resolved_at) : null,
      breached: ticket.sla_resolve_breached || false,
    },
  };
  
  // Calculate time remaining or overdue
  for (const metric of ['acknowledge', 'response', 'resolution']) {
    const m = status[metric];
    if (m.target && !m.actual) {
      const diff = m.target - now;
      m.remainingMs = diff;
      m.remainingMinutes = Math.floor(diff / 60000);
      m.isOverdue = diff < 0;
      m.urgency = diff < 0 ? 'breached' : 
                  diff < 3600000 ? 'critical' : 
                  diff < 7200000 ? 'warning' : 'ok';
    } else if (m.target && m.actual) {
      m.metSLA = m.actual <= m.target;
    }
  }
  
  return status;
}

// ============================================================================
// DATA LOOKUP HELPERS
// ============================================================================

/**
 * Gets all countries (cached).
 * @returns {Object[]} Array of countries
 */
function getAllCountries() {
  return getCachedSheetData('Countries').filter(c => c.is_active !== false);
}

/**
 * Gets all segments (cached).
 * @returns {Object[]} Array of segments
 */
function getAllSegments() {
  return getCachedSheetData('Segments').filter(s => s.is_active !== false);
}

/**
 * Gets all products (cached).
 * @returns {Object[]} Array of products
 */
function getAllProducts() {
  return getCachedSheetData('Products').filter(p => p.is_active !== false);
}

/**
 * Gets all depots (cached).
 * @returns {Object[]} Array of depots
 */
function getAllDepots() {
  return getCachedSheetData('Depots').filter(d => d.is_active !== false);
}

/**
 * Gets all teams (cached).
 * @returns {Object[]} Array of teams
 */
function getAllTeams() {
  return getCachedSheetData('Teams').filter(t => t.is_active !== false);
}

/**
 * Gets all SLA configs (cached).
 * @returns {Object[]} Array of SLA configs
 */
function getAllSLAConfigs() {
  return getCachedSheetData('SLAConfig').filter(s => s.is_active !== false);
}

/**
 * Gets users by role.
 * @param {string} role - User role
 * @returns {Object[]} Array of users
 */
function getUsersByRole(role) {
  return findWhere('Users', { role: role, status: 'ACTIVE' }, { limit: 500 }).data || [];
}

/**
 * Gets users by team.
 * @param {string} teamId - Team ID
 * @returns {Object[]} Array of users
 */
function getUsersByTeam(teamId) {
  return findWhere('Users', { team_id: teamId, status: 'ACTIVE' }, { limit: 100 }).data || [];
}

/**
 * Gets users by country.
 * @param {string} countryCode - Country code
 * @returns {Object[]} Array of users
 */
function getUsersByCountry(countryCode) {
  return findWhere('Users', { country_code: countryCode, status: 'ACTIVE' }, { limit: 500 }).data || [];
}

// ============================================================================
// EXPORT FOR WEB APP
// ============================================================================

/**
 * Handles database API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleDatabaseRequest(params) {
  const action = params.action;
  const entity = params.entity;
  
  switch (action) {
    case 'get':
      return { success: true, data: getById(entity, params.id) };
      
    case 'list':
      return findWhere(entity, params.conditions || {}, params.options || {});
      
    case 'search':
      return searchRecords(entity, params.searchText, params.searchFields, 
        params.filters || {}, params.options || {});
      
    case 'create':
      return createRecord(entity, params.data, params.context);
      
    case 'update':
      return updateRecord(entity, params.id, params.data, params.context);
      
    case 'delete':
      return params.hard ? 
        hardDeleteRecord(entity, params.id, params.context) :
        softDeleteRecord(entity, params.id, params.context);
      
    case 'bulkCreate':
      return bulkCreate(entity, params.records, params.context);
      
    case 'bulkUpdate':
      return bulkUpdate(entity, params.updates, params.context);
      
    case 'count':
      return { success: true, count: countWhere(entity, params.conditions || {}) };
      
    case 'groupBy':
      return groupByCount(entity, params.groupBy, params.conditions || {});
      
    case 'customer360':
      return getCustomer360(params.customerId);
      
    case 'ticketDetail':
      return getTicketDetail(params.ticketId);
      
    case 'orderDetail':
      return getOrderDetail(params.orderId);
      
    // Lookup endpoints
    case 'countries':
      return { success: true, data: getAllCountries() };
      
    case 'segments':
      return { success: true, data: getAllSegments() };
      
    case 'products':
      return { success: true, data: getAllProducts() };
      
    case 'depots':
      return { success: true, data: getAllDepots() };
      
    case 'teams':
      return { success: true, data: getAllTeams() };
      
    case 'slaConfigs':
      return { success: true, data: getAllSLAConfigs() };
      
    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}
