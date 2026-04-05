/**
 * HASS PETROLEUM CMS - TICKET SERVICE
 * Version: 1.0.0
 * 
 * Handles:
 * - Ticket lifecycle (create, update, resolve, close)
 * - SLA calculation and breach monitoring
 * - Auto-assignment (round-robin, least-busy)
 * - Escalation management
 * - Ticket comments and attachments
 * - Satisfaction surveys
 * - Ticket merging
 * - Bulk operations
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const TICKET_CONFIG = {
  AUTO_CLOSE_DAYS: 7, // Days after resolution to auto-close
  SATISFACTION_REQUEST_DAYS: 1, // Days after resolution to request satisfaction
  MAX_ATTACHMENTS_PER_TICKET: 20,
  MAX_ATTACHMENT_SIZE_MB: 10,
  REOPEN_LIMIT: 3, // Max times a ticket can be reopened
};

// ============================================================================
// TICKET CREATION
// ============================================================================

/**
 * Creates a new ticket with SLA assignment.
 * @param {Object} ticketData - Ticket data
 * @param {Object} context - Context { actorType, actorId, actorEmail, ip }
 * @returns {Object} Created ticket with ticket number
 */
function createTicket(ticketData, context) {
  try {
    // Validate required fields
    if (!ticketData.customer_id) {
      return { success: false, error: 'Customer ID is required' };
    }
    if (!ticketData.subject || ticketData.subject.trim().length < 5) {
      return { success: false, error: 'Subject must be at least 5 characters' };
    }
    if (!ticketData.category) {
      return { success: false, error: 'Category is required' };
    }
    
    // Get customer info
    const customer = getById('Customers', ticketData.customer_id);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }
    
    // Generate ticket ID and number
    const ticketId = generateId('TKT');
    const countryCode = ticketData.country_code || customer.country_code || 'KE';
    const ticketNumber = generateTicketNumber(countryCode);
    
    // Determine priority if not set
    const priority = ticketData.priority || determinePriority(customer, ticketData.category);
    
    // Get SLA configuration
    const slaConfig = findSLAConfig(countryCode, customer.segment_id, priority, ticketData.category);
    
    // Calculate SLA deadlines
    const now = new Date();
    const slaDeadlines = calculateSLADeadlines(now, slaConfig, countryCode);
    
    // Auto-assign if team is specified
    let assignedTo = ticketData.assigned_to || '';
    let assignedTeamId = ticketData.assigned_team_id || '';
    
    if (!assignedTo && assignedTeamId) {
      const assignResult = autoAssignTicket(assignedTeamId, countryCode);
      if (assignResult.success) {
        assignedTo = assignResult.userId;
      }
    } else if (!assignedTo && !assignedTeamId) {
      // Find default team for country and category
      const defaultTeam = findDefaultTeam(countryCode, ticketData.category);
      if (defaultTeam) {
        assignedTeamId = defaultTeam.team_id;
        if (defaultTeam.auto_assign) {
          const assignResult = autoAssignTicket(defaultTeam.team_id, countryCode);
          if (assignResult.success) {
            assignedTo = assignResult.userId;
          }
        }
      }
    }
    
    // Build ticket record
    const ticket = {
      ticket_id: ticketId,
      ticket_number: ticketNumber,
      customer_id: ticketData.customer_id,
      contact_id: ticketData.contact_id || '',
      channel: ticketData.channel || 'PORTAL',
      category: ticketData.category,
      subcategory: ticketData.subcategory || '',
      subject: ticketData.subject.trim(),
      description: ticketData.description || '',
      priority: priority,
      status: 'NEW',
      assigned_to: assignedTo,
      assigned_team_id: assignedTeamId,
      related_order_id: ticketData.related_order_id || '',
      country_code: countryCode,
      sla_config_id: slaConfig ? slaConfig.sla_id : '',
      sla_acknowledge_by: slaDeadlines.acknowledge,
      sla_response_by: slaDeadlines.response,
      sla_resolve_by: slaDeadlines.resolve,
      sla_acknowledge_breached: false,
      sla_response_breached: false,
      sla_resolve_breached: false,
      escalation_level: 0,
      reopened_count: 0,
      tags: ticketData.tags || '',
      created_by: context.actorId || '',
      created_at: now,
      updated_at: now,
    };
    
    // Insert ticket
    const result = appendRow('Tickets', ticket);
    
    // Clear cache
    clearSheetCache('Tickets');
    
    // Add initial comment if description provided
    if (ticketData.description) {
      addTicketComment(ticketId, {
        content: ticketData.description,
        author_type: context.actorType === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT',
        author_id: context.actorId,
        author_name: ticketData.author_name || '',
        channel: ticketData.channel || 'PORTAL',
        is_internal: false,
      });
    }
    
    // Log audit
    logAudit('Ticket', ticketId, 'CREATE', context.actorType, context.actorId, context.actorEmail,
      { ticket_number: ticketNumber, category: ticketData.category, priority: priority },
      { countryCode: countryCode, ip: context.ip });
    
    // Create notification for assigned user
    if (assignedTo) {
      createTicketAssignmentNotification(ticketId, ticketNumber, assignedTo, customer.company_name);
    }
    
    // Create notification for customer
    if (ticketData.contact_id) {
      createTicketCreatedNotification(ticketId, ticketNumber, ticketData.contact_id, customer.company_name);
    }
    
    return {
      success: true,
      ticketId: ticketId,
      ticketNumber: ticketNumber,
      assignedTo: assignedTo,
      slaConfig: slaConfig ? slaConfig.name : null,
    };
    
  } catch (e) {
    Logger.log('createTicket error: ' + e.message);
    return { success: false, error: 'Failed to create ticket' };
  }
}

/**
 * Creates a ticket from an email (inbound).
 * @param {Object} emailData - Email data { from, subject, body, attachments }
 * @returns {Object} Created ticket
 */
function createTicketFromEmail(emailData) {
  try {
    // Find contact by email
    const contact = findRow('Contacts', 'email', emailData.from.toLowerCase());
    
    if (!contact || !contact.customer_id) {
      // Unknown sender - create as general inquiry
      return createTicket({
        customer_id: '', // Will need manual assignment
        subject: emailData.subject || 'Email Inquiry',
        description: emailData.body,
        category: 'GENERAL',
        channel: 'EMAIL',
      }, { actorType: 'SYSTEM', actorId: 'EMAIL_INBOUND', actorEmail: emailData.from });
    }
    
    // Create ticket for known customer
    return createTicket({
      customer_id: contact.customer_id,
      contact_id: contact.contact_id,
      subject: emailData.subject || 'Email Inquiry',
      description: emailData.body,
      category: categorizeEmailSubject(emailData.subject),
      channel: 'EMAIL',
      author_name: `${contact.first_name} ${contact.last_name}`,
    }, { actorType: 'CUSTOMER', actorId: contact.contact_id, actorEmail: contact.email });
    
  } catch (e) {
    Logger.log('createTicketFromEmail error: ' + e.message);
    return { success: false, error: 'Failed to create ticket from email' };
  }
}

// ============================================================================
// TICKET UPDATES
// ============================================================================

/**
 * Updates ticket fields.
 * @param {string} ticketId - Ticket ID
 * @param {Object} updates - Fields to update
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function updateTicket(ticketId, updates, context) {
  try {
    const ticket = getById('Tickets', ticketId);
    if (!ticket) {
      return { success: false, error: 'Ticket not found' };
    }
    
    // Prevent updates on closed/cancelled tickets
    if (['CLOSED', 'CANCELLED'].includes(ticket.status) && !updates.status) {
      return { success: false, error: 'Cannot update a closed ticket' };
    }
    
    // Track changes for history
    const changes = [];
    const now = new Date();
    
    // Protected fields
    const protectedFields = ['ticket_id', 'ticket_number', 'created_at', 'created_by'];
    for (const field of protectedFields) {
      delete updates[field];
    }
    
    // Process specific field changes
    if (updates.status && updates.status !== ticket.status) {
      changes.push({
        field: 'status',
        old: ticket.status,
        new: updates.status,
      });
      
      // Handle status-specific logic
      handleStatusChange(ticket, updates.status, updates, now);
    }
    
    if (updates.priority && updates.priority !== ticket.priority) {
      changes.push({
        field: 'priority',
        old: ticket.priority,
        new: updates.priority,
      });
      
      // Recalculate SLA if priority changes
      const slaConfig = findSLAConfig(
        ticket.country_code, 
        null, // Would need customer segment
        updates.priority,
        ticket.category
      );
      
      if (slaConfig && !ticket.sla_resolve_breached) {
        const slaDeadlines = calculateSLADeadlines(new Date(ticket.created_at), slaConfig, ticket.country_code);
        updates.sla_config_id = slaConfig.sla_id;
        updates.sla_resolve_by = slaDeadlines.resolve;
      }
    }
    
    if (updates.assigned_to && updates.assigned_to !== ticket.assigned_to) {
      changes.push({
        field: 'assigned_to',
        old: ticket.assigned_to,
        new: updates.assigned_to,
      });
      
      // Notify new assignee
      createTicketAssignmentNotification(ticketId, ticket.ticket_number, updates.assigned_to, '');
    }
    
    if (updates.category && updates.category !== ticket.category) {
      changes.push({
        field: 'category',
        old: ticket.category,
        new: updates.category,
      });
    }
    
    // Set updated_at
    updates.updated_at = now;
    
    // Update ticket
    const result = updateRow('Tickets', 'ticket_id', ticketId, updates);
    
    if (!result) {
      return { success: false, error: 'Failed to update ticket' };
    }
    
    // Clear cache
    clearSheetCache('Tickets');
    
    // Record history
    for (const change of changes) {
      recordTicketHistory(ticketId, change.field, change.old, change.new, context);
    }
    
    // Log audit
    logAudit('Ticket', ticketId, 'UPDATE', context.actorType, context.actorId, context.actorEmail,
      { changes: changes }, { countryCode: ticket.country_code });
    
    return {
      success: true,
      changes: changes,
    };
    
  } catch (e) {
    Logger.log('updateTicket error: ' + e.message);
    return { success: false, error: 'Failed to update ticket' };
  }
}

/**
 * Handles status change logic.
 * @param {Object} ticket - Current ticket
 * @param {string} newStatus - New status
 * @param {Object} updates - Updates object to modify
 * @param {Date} now - Current timestamp
 */
function handleStatusChange(ticket, newStatus, updates, now) {
  switch (newStatus) {
    case 'OPEN':
    case 'IN_PROGRESS':
      // Mark as acknowledged if not already
      if (!ticket.acknowledged_at) {
        updates.acknowledged_at = now;
        // Check SLA breach
        if (ticket.sla_acknowledge_by && now > new Date(ticket.sla_acknowledge_by)) {
          updates.sla_acknowledge_breached = true;
        }
      }
      break;
      
    case 'RESOLVED':
      updates.resolved_at = now;
      // Check SLA breach
      if (ticket.sla_resolve_by && now > new Date(ticket.sla_resolve_by)) {
        updates.sla_resolve_breached = true;
      }
      // Schedule satisfaction survey
      updates.satisfaction_requested_at = null; // Will be set by scheduled job
      break;
      
    case 'CLOSED':
      updates.closed_at = now;
      if (!updates.resolved_at && !ticket.resolved_at) {
        updates.resolved_at = now;
      }
      break;
      
    case 'CANCELLED':
      updates.closed_at = now;
      break;
      
    case 'ESCALATED':
      // Escalation is handled separately
      break;
  }
}

/**
 * Acknowledges a ticket (first agent action).
 * @param {string} ticketId - Ticket ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function acknowledgeTicket(ticketId, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (ticket.acknowledged_at) {
    return { success: false, error: 'Ticket already acknowledged' };
  }
  
  const now = new Date();
  const breached = ticket.sla_acknowledge_by && now > new Date(ticket.sla_acknowledge_by);
  
  return updateTicket(ticketId, {
    acknowledged_at: now,
    sla_acknowledge_breached: breached,
    status: ticket.status === 'NEW' ? 'OPEN' : ticket.status,
  }, context);
}

/**
 * Records first response to customer.
 * @param {string} ticketId - Ticket ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function recordFirstResponse(ticketId, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (ticket.first_response_at) {
    return { success: true, message: 'First response already recorded' };
  }
  
  const now = new Date();
  const breached = ticket.sla_response_by && now > new Date(ticket.sla_response_by);
  
  return updateTicket(ticketId, {
    first_response_at: now,
    sla_response_breached: breached,
    acknowledged_at: ticket.acknowledged_at || now,
  }, context);
}

/**
 * Resolves a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {Object} resolution - { type, summary, rootCause, rootCauseCategory }
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function resolveTicket(ticketId, resolution, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) {
    return { success: false, error: 'Ticket is already resolved or closed' };
  }
  
  if (!resolution.type) {
    return { success: false, error: 'Resolution type is required' };
  }
  
  const now = new Date();
  const breached = ticket.sla_resolve_by && now > new Date(ticket.sla_resolve_by);
  
  const result = updateTicket(ticketId, {
    status: 'RESOLVED',
    resolved_at: now,
    resolution_type: resolution.type,
    resolution_summary: resolution.summary || '',
    root_cause: resolution.rootCause || '',
    root_cause_category: resolution.rootCauseCategory || '',
    sla_resolve_breached: breached,
  }, context);
  
  if (result.success) {
    // Add resolution comment
    addTicketComment(ticketId, {
      content: `Ticket resolved: ${resolution.summary || resolution.type}`,
      author_type: 'AGENT',
      author_id: context.actorId,
      is_internal: false,
      is_resolution: true,
    });
    
    // Notify customer
    if (ticket.contact_id) {
      createTicketResolvedNotification(ticketId, ticket.ticket_number, ticket.contact_id);
    }
  }
  
  return result;
}

/**
 * Reopens a resolved ticket.
 * @param {string} ticketId - Ticket ID
 * @param {string} reason - Reason for reopening
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function reopenTicket(ticketId, reason, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return { success: false, error: 'Can only reopen resolved or closed tickets' };
  }
  
  if (ticket.reopened_count >= TICKET_CONFIG.REOPEN_LIMIT) {
    return { success: false, error: `Ticket has been reopened ${TICKET_CONFIG.REOPEN_LIMIT} times. Please create a new ticket.` };
  }
  
  const now = new Date();
  
  const result = updateTicket(ticketId, {
    status: 'OPEN',
    resolved_at: '',
    closed_at: '',
    resolution_type: '',
    resolution_summary: '',
    reopened_count: ticket.reopened_count + 1,
    last_reopened_at: now,
  }, context);
  
  if (result.success) {
    // Add comment
    addTicketComment(ticketId, {
      content: `Ticket reopened: ${reason || 'No reason provided'}`,
      author_type: context.actorType === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT',
      author_id: context.actorId,
      is_internal: false,
    });
    
    // Notify assigned agent
    if (ticket.assigned_to) {
      createTicketReopenedNotification(ticketId, ticket.ticket_number, ticket.assigned_to);
    }
  }
  
  return result;
}

/**
 * Closes a ticket (after resolution period).
 * @param {string} ticketId - Ticket ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function closeTicket(ticketId, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (ticket.status === 'CLOSED') {
    return { success: true, message: 'Ticket already closed' };
  }
  
  return updateTicket(ticketId, {
    status: 'CLOSED',
    closed_at: new Date(),
  }, context);
}

/**
 * Cancels a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {string} reason - Cancellation reason
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function cancelTicket(ticketId, reason, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (['CLOSED', 'CANCELLED'].includes(ticket.status)) {
    return { success: false, error: 'Ticket is already closed or cancelled' };
  }
  
  const result = updateTicket(ticketId, {
    status: 'CANCELLED',
    resolution_type: 'CANCELLED',
    resolution_summary: reason || 'Cancelled by user',
  }, context);
  
  if (result.success) {
    addTicketComment(ticketId, {
      content: `Ticket cancelled: ${reason || 'No reason provided'}`,
      author_type: context.actorType === 'CUSTOMER' ? 'CUSTOMER' : 'AGENT',
      author_id: context.actorId,
      is_internal: false,
    });
  }
  
  return result;
}

// ============================================================================
// TICKET ASSIGNMENT
// ============================================================================

/**
 * Assigns a ticket to a user.
 * @param {string} ticketId - Ticket ID
 * @param {string} userId - User ID to assign to
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function assignTicket(ticketId, userId, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  const user = getById('Users', userId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  if (user.status !== 'ACTIVE') {
    return { success: false, error: 'Cannot assign to inactive user' };
  }
  
  // Check ticket capacity
  const assignedCount = countWhere('Tickets', { 
    assigned_to: userId, 
    status: ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL'] 
  });
  
  if (user.max_tickets && assignedCount >= user.max_tickets) {
    return { success: false, error: `User has reached maximum ticket capacity (${user.max_tickets})` };
  }
  
  const result = updateTicket(ticketId, {
    assigned_to: userId,
    assigned_team_id: user.team_id || ticket.assigned_team_id,
  }, context);
  
  if (result.success) {
    // Notify new assignee
    createTicketAssignmentNotification(ticketId, ticket.ticket_number, userId, '');
  }
  
  return result;
}

/**
 * Reassigns a ticket to a different user.
 * @param {string} ticketId - Ticket ID
 * @param {string} newUserId - New user ID
 * @param {string} reason - Reason for reassignment
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function reassignTicket(ticketId, newUserId, reason, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  const result = assignTicket(ticketId, newUserId, context);
  
  if (result.success && reason) {
    addTicketComment(ticketId, {
      content: `Ticket reassigned: ${reason}`,
      author_type: 'AGENT',
      author_id: context.actorId,
      is_internal: true,
    });
  }
  
  return result;
}

/**
 * Auto-assigns a ticket to a team member.
 * @param {string} teamId - Team ID
 * @param {string} countryCode - Country code
 * @returns {Object} Assignment result
 */
function autoAssignTicket(teamId, countryCode) {
  try {
    const team = getById('Teams', teamId);
    if (!team || !team.is_active) {
      return { success: false, error: 'Team not found or inactive' };
    }
    
    // Get active team members
    const members = findWhere('Users', {
      team_id: teamId,
      status: 'ACTIVE',
    }, { limit: 100 }).data || [];
    
    if (members.length === 0) {
      return { success: false, error: 'No available team members' };
    }
    
    // Filter by country access if specified
    const eligibleMembers = members.filter(m => {
      if (!countryCode) return true;
      const access = m.countries_access || m.country_code;
      return access === 'ALL' || access.includes(countryCode);
    });
    
    if (eligibleMembers.length === 0) {
      return { success: false, error: 'No team members available for this country' };
    }
    
    let selectedUser = null;
    
    if (team.assignment_method === 'ROUND_ROBIN') {
      selectedUser = roundRobinAssign(eligibleMembers, teamId);
    } else if (team.assignment_method === 'LEAST_BUSY') {
      selectedUser = leastBusyAssign(eligibleMembers);
    } else {
      // Manual - don't auto-assign
      return { success: false, error: 'Team uses manual assignment' };
    }
    
    if (!selectedUser) {
      return { success: false, error: 'Could not determine assignee' };
    }
    
    return {
      success: true,
      userId: selectedUser.user_id,
      userName: `${selectedUser.first_name} ${selectedUser.last_name}`,
    };
    
  } catch (e) {
    Logger.log('autoAssignTicket error: ' + e.message);
    return { success: false, error: 'Auto-assignment failed' };
  }
}

/**
 * Round-robin assignment.
 * @param {Object[]} members - Team members
 * @param {string} teamId - Team ID
 * @returns {Object} Selected user
 */
function roundRobinAssign(members, teamId) {
  // Get last assigned user from cache
  const cache = CacheService.getScriptCache();
  const lastAssignedKey = `last_assigned_${teamId}`;
  const lastAssignedId = cache.get(lastAssignedKey);
  
  // Sort members by ID for consistent order
  members.sort((a, b) => a.user_id.localeCompare(b.user_id));
  
  // Find next member
  let nextIndex = 0;
  if (lastAssignedId) {
    const lastIndex = members.findIndex(m => m.user_id === lastAssignedId);
    if (lastIndex !== -1) {
      nextIndex = (lastIndex + 1) % members.length;
    }
  }
  
  const selected = members[nextIndex];
  
  // Update cache
  cache.put(lastAssignedKey, selected.user_id, 86400); // 24 hours
  
  return selected;
}

/**
 * Least-busy assignment.
 * @param {Object[]} members - Team members
 * @returns {Object} Selected user
 */
function leastBusyAssign(members) {
  // Get open ticket counts for each member
  const ticketCounts = {};
  const openStatuses = ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL'];
  
  for (const member of members) {
    ticketCounts[member.user_id] = countWhere('Tickets', {
      assigned_to: member.user_id,
      status: openStatuses,
    });
  }
  
  // Find member with least tickets (respecting max_tickets)
  let minCount = Infinity;
  let selected = null;
  
  for (const member of members) {
    const count = ticketCounts[member.user_id];
    const maxTickets = member.max_tickets || 999;
    
    if (count < maxTickets && count < minCount) {
      minCount = count;
      selected = member;
    }
  }
  
  return selected;
}

/**
 * Finds default team for a country and category.
 * @param {string} countryCode - Country code
 * @param {string} category - Ticket category
 * @returns {Object} Team or null
 */
function findDefaultTeam(countryCode, category) {
  const teams = getAllTeams();
  
  // First try to find team matching country and department
  const department = categoryToDepartment(category);
  
  let team = teams.find(t => 
    t.country_code === countryCode && 
    t.department === department &&
    t.is_active
  );
  
  // Fall back to any CS team for the country
  if (!team) {
    team = teams.find(t => 
      t.country_code === countryCode && 
      t.department === 'CUSTOMER_SERVICE' &&
      t.is_active
    );
  }
  
  // Fall back to regional team
  if (!team) {
    team = teams.find(t => 
      t.country_code === 'ALL' && 
      t.department === 'CUSTOMER_SERVICE' &&
      t.is_active
    );
  }
  
  return team || null;
}

// ============================================================================
// ESCALATION
// ============================================================================

/**
 * Escalates a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {string} reason - Escalation reason
 * @param {string} escalateTo - User ID to escalate to (optional)
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function escalateTicket(ticketId, reason, escalateTo, context) {
  try {
    const ticket = getById('Tickets', ticketId);
    if (!ticket) {
      return { success: false, error: 'Ticket not found' };
    }
    
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(ticket.status)) {
      return { success: false, error: 'Cannot escalate a closed ticket' };
    }
    
    const newLevel = (ticket.escalation_level || 0) + 1;
    const now = new Date();
    
    // Find escalation target
    let targetUserId = escalateTo;
    
    if (!targetUserId) {
      // Auto-determine escalation target based on level
      targetUserId = findEscalationTarget(ticket, newLevel);
    }
    
    const updates = {
      status: 'ESCALATED',
      escalation_level: newLevel,
      escalated_to: targetUserId || ticket.escalated_to,
      escalated_at: now,
      escalation_reason: reason,
    };
    
    // Optionally reassign
    if (targetUserId && targetUserId !== ticket.assigned_to) {
      updates.assigned_to = targetUserId;
    }
    
    const result = updateTicket(ticketId, updates, context);
    
    if (result.success) {
      // Add comment
      addTicketComment(ticketId, {
        content: `Ticket escalated to level ${newLevel}: ${reason}`,
        author_type: 'AGENT',
        author_id: context.actorId,
        is_internal: true,
      });
      
      // Notify escalation target
      if (targetUserId) {
        createTicketEscalationNotification(ticketId, ticket.ticket_number, targetUserId, newLevel);
      }
    }
    
    return result;
    
  } catch (e) {
    Logger.log('escalateTicket error: ' + e.message);
    return { success: false, error: 'Escalation failed' };
  }
}

/**
 * Finds escalation target based on level.
 * @param {Object} ticket - Ticket
 * @param {number} level - Escalation level
 * @returns {string} User ID or null
 */
function findEscalationTarget(ticket, level) {
  // Get current assignee
  const currentAssignee = ticket.assigned_to ? getById('Users', ticket.assigned_to) : null;
  
  if (!currentAssignee) {
    return null;
  }
  
  // Level 1: Team supervisor
  if (level === 1) {
    const team = currentAssignee.team_id ? getById('Teams', currentAssignee.team_id) : null;
    if (team && team.team_lead_id) {
      return team.team_lead_id;
    }
    // Fall back to reports_to
    if (currentAssignee.reports_to) {
      return currentAssignee.reports_to;
    }
  }
  
  // Level 2: Team manager / Country manager
  if (level === 2) {
    const managers = findWhere('Users', {
      role: ['CS_MANAGER', 'COUNTRY_MANAGER'],
      country_code: ticket.country_code,
      status: 'ACTIVE',
    }, { limit: 1 }).data || [];
    
    if (managers.length > 0) {
      return managers[0].user_id;
    }
  }
  
  // Level 3+: Regional/Group level
  if (level >= 3) {
    const executives = findWhere('Users', {
      role: ['REGIONAL_MANAGER', 'GROUP_HEAD'],
      status: 'ACTIVE',
    }, { limit: 1 }).data || [];
    
    if (executives.length > 0) {
      return executives[0].user_id;
    }
  }
  
  return null;
}

/**
 * De-escalates a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function deescalateTicket(ticketId, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (ticket.status !== 'ESCALATED') {
    return { success: false, error: 'Ticket is not escalated' };
  }
  
  const result = updateTicket(ticketId, {
    status: 'IN_PROGRESS',
    escalation_level: Math.max(0, (ticket.escalation_level || 1) - 1),
  }, context);
  
  if (result.success) {
    addTicketComment(ticketId, {
      content: 'Ticket de-escalated',
      author_type: 'AGENT',
      author_id: context.actorId,
      is_internal: true,
    });
  }
  
  return result;
}

// ============================================================================
// SLA MANAGEMENT
// ============================================================================

/**
 * Finds appropriate SLA configuration.
 * @param {string} countryCode - Country code
 * @param {string} segmentId - Customer segment ID
 * @param {string} priority - Ticket priority
 * @param {string} category - Ticket category
 * @returns {Object} SLA config or null
 */
function findSLAConfig(countryCode, segmentId, priority, category) {
  const configs = getAllSLAConfigs();
  
  // Try to find most specific match
  // Priority: Country + Segment + Category > Country + Segment > Country + Category > Country > Default
  
  let bestMatch = null;
  let bestScore = -1;
  
  for (const config of configs) {
    if (config.priority !== priority && config.priority !== 'ALL') continue;
    
    let score = 0;
    
    // Country match
    if (config.country_code === countryCode) {
      score += 4;
    } else if (config.country_code !== 'ALL') {
      continue; // Must match country or be ALL
    }
    
    // Segment match
    if (segmentId && config.segment_id === segmentId) {
      score += 2;
    } else if (config.segment_id && config.segment_id !== 'ALL') {
      continue; // If segment specified, must match
    }
    
    // Category match
    if (config.category === category) {
      score += 1;
    } else if (config.category !== 'ALL') {
      continue; // If category specified, must match
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = config;
    }
  }
  
  return bestMatch;
}

/**
 * Calculates SLA deadlines from creation time.
 * @param {Date} createdAt - Ticket creation time
 * @param {Object} slaConfig - SLA configuration
 * @param {string} countryCode - Country code
 * @returns {Object} Deadline timestamps
 */
function calculateSLADeadlines(createdAt, slaConfig, countryCode) {
  if (!slaConfig) {
    return {
      acknowledge: null,
      response: null,
      resolve: null,
    };
  }
  
  const businessHoursOnly = slaConfig.business_hours_only;
  
  // Simple calculation (without business hours complexity)
  // In production, would use business hours calendar
  
  const acknowledgeBy = new Date(createdAt);
  acknowledgeBy.setMinutes(acknowledgeBy.getMinutes() + (slaConfig.acknowledge_minutes || 60));
  
  const responseBy = new Date(createdAt);
  responseBy.setMinutes(responseBy.getMinutes() + (slaConfig.first_response_minutes || 120));
  
  const resolveBy = new Date(createdAt);
  resolveBy.setMinutes(resolveBy.getMinutes() + (slaConfig.resolution_minutes || 1440));
  
  return {
    acknowledge: acknowledgeBy,
    response: responseBy,
    resolve: resolveBy,
  };
}

/**
 * Checks for SLA breaches (run via scheduled trigger).
 * @returns {Object} Breach check results
 */
function checkSLABreaches() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Could not obtain lock' };
  }
  
  try {
    const now = new Date();
    let breachCount = 0;
    
    // Get open tickets with SLA deadlines
    const openStatuses = ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED'];
    const tickets = findWhere('Tickets', { status: openStatuses }, { limit: 5000 }).data || [];
    
    for (const ticket of tickets) {
      const updates = {};
      
      // Check acknowledge breach
      if (!ticket.sla_acknowledge_breached && ticket.sla_acknowledge_by && !ticket.acknowledged_at) {
        if (now > new Date(ticket.sla_acknowledge_by)) {
          updates.sla_acknowledge_breached = true;
          breachCount++;
        }
      }
      
      // Check response breach
      if (!ticket.sla_response_breached && ticket.sla_response_by && !ticket.first_response_at) {
        if (now > new Date(ticket.sla_response_by)) {
          updates.sla_response_breached = true;
          breachCount++;
        }
      }
      
      // Check resolution breach
      if (!ticket.sla_resolve_breached && ticket.sla_resolve_by && !ticket.resolved_at) {
        if (now > new Date(ticket.sla_resolve_by)) {
          updates.sla_resolve_breached = true;
          breachCount++;
        }
      }
      
      // Update if any breaches found
      if (Object.keys(updates).length > 0) {
        updateRow('Tickets', 'ticket_id', ticket.ticket_id, updates);
        
        // Trigger escalation for resolution breaches
        if (updates.sla_resolve_breached && ticket.escalation_level < 3) {
          escalateTicket(ticket.ticket_id, 'SLA Resolution Breach', null, 
            { actorType: 'SYSTEM', actorId: 'SLA_MONITOR', actorEmail: '' });
        }
      }
    }
    
    // Clear cache if any updates
    if (breachCount > 0) {
      clearSheetCache('Tickets');
    }
    
    return {
      success: true,
      ticketsChecked: tickets.length,
      breachesFound: breachCount,
    };
    
  } catch (e) {
    Logger.log('checkSLABreaches error: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// COMMENTS & ATTACHMENTS
// ============================================================================

/**
 * Adds a comment to a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {Object} commentData - Comment data
 * @returns {Object} Created comment
 */
function addTicketComment(ticketId, commentData) {
  try {
    const ticket = getById('Tickets', ticketId);
    if (!ticket) {
      return { success: false, error: 'Ticket not found' };
    }
    
    const commentId = generateId('CMT');
    const now = new Date();
    
    const comment = {
      comment_id: commentId,
      ticket_id: ticketId,
      parent_comment_id: commentData.parent_comment_id || '',
      author_type: commentData.author_type || 'AGENT',
      author_id: commentData.author_id || '',
      author_name: commentData.author_name || '',
      content: commentData.content || '',
      content_html: commentData.content_html || '',
      is_internal: commentData.is_internal || false,
      is_resolution: commentData.is_resolution || false,
      channel: commentData.channel || 'PORTAL',
      external_message_id: commentData.external_message_id || '',
      sentiment: commentData.sentiment || 'NEUTRAL',
      created_at: now,
      updated_at: now,
    };
    
    appendRow('TicketComments', comment);
    
    // Update ticket's updated_at
    updateRow('Tickets', 'ticket_id', ticketId, { updated_at: now });
    
    // Record first response if this is agent's first public comment
    if (commentData.author_type === 'AGENT' && !commentData.is_internal && !ticket.first_response_at) {
      recordFirstResponse(ticketId, { 
        actorType: 'AGENT', 
        actorId: commentData.author_id, 
        actorEmail: '' 
      });
    }
    
    // Notify relevant parties
    if (!commentData.is_internal) {
      if (commentData.author_type === 'CUSTOMER' && ticket.assigned_to) {
        // Notify agent of customer reply
        createTicketReplyNotification(ticketId, ticket.ticket_number, ticket.assigned_to, 'CUSTOMER');
      } else if (commentData.author_type === 'AGENT' && ticket.contact_id) {
        // Notify customer of agent reply
        createTicketReplyNotification(ticketId, ticket.ticket_number, ticket.contact_id, 'AGENT');
      }
    }
    
    return {
      success: true,
      commentId: commentId,
    };
    
  } catch (e) {
    Logger.log('addTicketComment error: ' + e.message);
    return { success: false, error: 'Failed to add comment' };
  }
}

/**
 * Adds an attachment to a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {Object} attachmentData - Attachment data
 * @returns {Object} Created attachment
 */
function addTicketAttachment(ticketId, attachmentData) {
  try {
    const ticket = getById('Tickets', ticketId);
    if (!ticket) {
      return { success: false, error: 'Ticket not found' };
    }
    
    // Check attachment count
    const existingCount = countWhere('TicketAttachments', { ticket_id: ticketId });
    if (existingCount >= TICKET_CONFIG.MAX_ATTACHMENTS_PER_TICKET) {
      return { success: false, error: `Maximum ${TICKET_CONFIG.MAX_ATTACHMENTS_PER_TICKET} attachments per ticket` };
    }
    
    const attachmentId = generateId('ATT');
    
    const attachment = {
      attachment_id: attachmentId,
      ticket_id: ticketId,
      comment_id: attachmentData.comment_id || '',
      file_name: attachmentData.file_name,
      file_path: attachmentData.file_path,
      file_size: attachmentData.file_size || 0,
      mime_type: attachmentData.mime_type || '',
      uploaded_by_type: attachmentData.uploaded_by_type || 'AGENT',
      uploaded_by_id: attachmentData.uploaded_by_id || '',
      is_inline: attachmentData.is_inline || false,
      created_at: new Date(),
    };
    
    appendRow('TicketAttachments', attachment);
    
    return {
      success: true,
      attachmentId: attachmentId,
    };
    
  } catch (e) {
    Logger.log('addTicketAttachment error: ' + e.message);
    return { success: false, error: 'Failed to add attachment' };
  }
}

/**
 * Records a change in ticket history.
 * @param {string} ticketId - Ticket ID
 * @param {string} fieldName - Changed field
 * @param {*} oldValue - Old value
 * @param {*} newValue - New value
 * @param {Object} context - Actor context
 */
function recordTicketHistory(ticketId, fieldName, oldValue, newValue, context) {
  try {
    appendRow('TicketHistory', {
      history_id: generateId('TH'),
      ticket_id: ticketId,
      field_name: fieldName,
      old_value: String(oldValue || ''),
      new_value: String(newValue || ''),
      changed_by_type: context.actorType || 'SYSTEM',
      changed_by_id: context.actorId || '',
      changed_by_name: context.actorName || '',
      change_reason: context.changeReason || '',
      created_at: new Date(),
    });
  } catch (e) {
    Logger.log('recordTicketHistory error: ' + e.message);
  }
}

// ============================================================================
// SATISFACTION SURVEY
// ============================================================================

/**
 * Records satisfaction rating for a ticket.
 * @param {string} ticketId - Ticket ID
 * @param {number} rating - Rating (1-5)
 * @param {string} comment - Optional comment
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function recordSatisfaction(ticketId, rating, comment, context) {
  const ticket = getById('Tickets', ticketId);
  if (!ticket) {
    return { success: false, error: 'Ticket not found' };
  }
  
  if (!['RESOLVED', 'CLOSED'].includes(ticket.status)) {
    return { success: false, error: 'Can only rate resolved tickets' };
  }
  
  if (ticket.satisfaction_rating) {
    return { success: false, error: 'Ticket already rated' };
  }
  
  if (rating < 1 || rating > 5) {
    return { success: false, error: 'Rating must be between 1 and 5' };
  }
  
  return updateTicket(ticketId, {
    satisfaction_rating: rating,
    satisfaction_comment: comment || '',
  }, context);
}

// ============================================================================
// TICKET MERGING
// ============================================================================

/**
 * Merges a ticket into another (duplicate handling).
 * @param {string} sourceTicketId - Ticket to merge (will be closed)
 * @param {string} targetTicketId - Ticket to merge into
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function mergeTickets(sourceTicketId, targetTicketId, context) {
  try {
    const source = getById('Tickets', sourceTicketId);
    const target = getById('Tickets', targetTicketId);
    
    if (!source || !target) {
      return { success: false, error: 'One or both tickets not found' };
    }
    
    if (source.customer_id !== target.customer_id) {
      return { success: false, error: 'Can only merge tickets from the same customer' };
    }
    
    if (['CLOSED', 'CANCELLED'].includes(target.status)) {
      return { success: false, error: 'Cannot merge into a closed ticket' };
    }
    
    // Copy comments from source to target
    const sourceComments = findWhere('TicketComments', { ticket_id: sourceTicketId }).data || [];
    for (const comment of sourceComments) {
      addTicketComment(targetTicketId, {
        content: `[Merged from ${source.ticket_number}] ${comment.content}`,
        author_type: comment.author_type,
        author_id: comment.author_id,
        author_name: comment.author_name,
        is_internal: comment.is_internal,
        channel: comment.channel,
      });
    }
    
    // Close source ticket
    const closeResult = updateTicket(sourceTicketId, {
      status: 'CLOSED',
      resolution_type: 'DUPLICATE',
      resolution_summary: `Merged into ${target.ticket_number}`,
      merged_into_id: targetTicketId,
    }, context);
    
    // Add note to target
    addTicketComment(targetTicketId, {
      content: `Ticket ${source.ticket_number} merged into this ticket`,
      author_type: 'SYSTEM',
      author_id: 'SYSTEM',
      is_internal: true,
    });
    
    return {
      success: true,
      sourceTicket: sourceTicketId,
      targetTicket: targetTicketId,
    };
    
  } catch (e) {
    Logger.log('mergeTickets error: ' + e.message);
    return { success: false, error: 'Merge failed' };
  }
}

// ============================================================================
// BULK OPERATIONS
// ============================================================================

/**
 * Bulk assigns tickets to a user.
 * @param {string[]} ticketIds - Array of ticket IDs
 * @param {string} userId - User ID
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function bulkAssignTickets(ticketIds, userId, context) {
  const results = { success: 0, failed: 0, errors: [] };
  
  for (const ticketId of ticketIds) {
    const result = assignTicket(ticketId, userId, context);
    if (result.success) {
      results.success++;
    } else {
      results.failed++;
      results.errors.push({ ticketId, error: result.error });
    }
  }
  
  return {
    success: true,
    assigned: results.success,
    failed: results.failed,
    errors: results.errors,
  };
}

/**
 * Bulk updates ticket status.
 * @param {string[]} ticketIds - Array of ticket IDs
 * @param {string} status - New status
 * @param {Object} context - Actor context
 * @returns {Object} Result
 */
function bulkUpdateStatus(ticketIds, status, context) {
  const results = { success: 0, failed: 0 };
  
  for (const ticketId of ticketIds) {
    const result = updateTicket(ticketId, { status }, context);
    if (result.success) {
      results.success++;
    } else {
      results.failed++;
    }
  }
  
  return {
    success: true,
    updated: results.success,
    failed: results.failed,
  };
}

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

/**
 * Auto-closes resolved tickets after configured days.
 * Run via daily trigger.
 */
function autoCloseResolvedTickets() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Could not obtain lock' };
  }
  
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - TICKET_CONFIG.AUTO_CLOSE_DAYS);
    
    const resolvedTickets = findWhere('Tickets', { status: 'RESOLVED' }, { limit: 1000 }).data || [];
    
    let closedCount = 0;
    
    for (const ticket of resolvedTickets) {
      if (ticket.resolved_at && new Date(ticket.resolved_at) < cutoffDate) {
        closeTicket(ticket.ticket_id, { actorType: 'SYSTEM', actorId: 'AUTO_CLOSE', actorEmail: '' });
        closedCount++;
      }
    }
    
    if (closedCount > 0) {
      clearSheetCache('Tickets');
    }
    
    return {
      success: true,
      closedCount: closedCount,
    };
    
  } catch (e) {
    Logger.log('autoCloseResolvedTickets error: ' + e.message);
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Determines priority based on customer segment and category.
 * @param {Object} customer - Customer record
 * @param {string} category - Ticket category
 * @returns {string} Priority
 */
function determinePriority(customer, category) {
  // Strategic and Enterprise customers get higher priority
  if (['SEG001', 'SEG002'].includes(customer.segment_id)) {
    return category === 'DELIVERY' ? 'CRITICAL' : 'HIGH';
  }
  
  // Delivery issues are higher priority
  if (category === 'DELIVERY') {
    return 'HIGH';
  }
  
  // Default
  return 'MEDIUM';
}

/**
 * Maps category to department.
 * @param {string} category - Ticket category
 * @returns {string} Department
 */
function categoryToDepartment(category) {
  const mapping = {
    'DELIVERY': 'OPERATIONS',
    'QUALITY': 'OPERATIONS',
    'BILLING': 'FINANCE',
    'PRICING': 'BUSINESS_DEVELOPMENT',
    'ACCOUNT': 'CUSTOMER_SERVICE',
    'CONTRACT': 'BUSINESS_DEVELOPMENT',
    'TECHNICAL': 'IT',
    'GENERAL': 'CUSTOMER_SERVICE',
  };
  
  return mapping[category] || 'CUSTOMER_SERVICE';
}

/**
 * Categorizes email subject to ticket category.
 * @param {string} subject - Email subject
 * @returns {string} Category
 */
function categorizeEmailSubject(subject) {
  const lowerSubject = (subject || '').toLowerCase();
  
  if (lowerSubject.includes('delivery') || lowerSubject.includes('order')) {
    return 'DELIVERY';
  }
  if (lowerSubject.includes('invoice') || lowerSubject.includes('bill') || lowerSubject.includes('payment')) {
    return 'BILLING';
  }
  if (lowerSubject.includes('price') || lowerSubject.includes('quote')) {
    return 'PRICING';
  }
  if (lowerSubject.includes('quality') || lowerSubject.includes('fuel')) {
    return 'QUALITY';
  }
  if (lowerSubject.includes('account') || lowerSubject.includes('password')) {
    return 'ACCOUNT';
  }
  if (lowerSubject.includes('contract')) {
    return 'CONTRACT';
  }
  
  return 'GENERAL';
}

// ============================================================================
// NOTIFICATION HELPERS
// ============================================================================

function createTicketAssignmentNotification(ticketId, ticketNumber, userId, customerName) {
  // Would integrate with NotificationService
  Logger.log(`Notification: Ticket ${ticketNumber} assigned to ${userId}`);
}

function createTicketCreatedNotification(ticketId, ticketNumber, contactId, customerName) {
  Logger.log(`Notification: Ticket ${ticketNumber} created for contact ${contactId}`);
}

function createTicketResolvedNotification(ticketId, ticketNumber, contactId) {
  Logger.log(`Notification: Ticket ${ticketNumber} resolved, notifying ${contactId}`);
}

function createTicketReopenedNotification(ticketId, ticketNumber, userId) {
  Logger.log(`Notification: Ticket ${ticketNumber} reopened, notifying ${userId}`);
}

function createTicketEscalationNotification(ticketId, ticketNumber, userId, level) {
  Logger.log(`Notification: Ticket ${ticketNumber} escalated to level ${level}, notifying ${userId}`);
}

function createTicketReplyNotification(ticketId, ticketNumber, recipientId, senderType) {
  Logger.log(`Notification: New reply on ${ticketNumber} from ${senderType}, notifying ${recipientId}`);
}

// ============================================================================
// WEB APP HANDLER
// ============================================================================

/**
 * Handles ticket API requests.
 * @param {Object} params - Request parameters
 * @returns {Object} Response
 */
function handleTicketRequest(params) {
  const action = params.action;
  
  switch (action) {
    case 'create':
      return createTicket(params.data, params.context);
      
    case 'get':
      return getTicketDetail(params.ticketId);
      
    case 'update':
      return updateTicket(params.ticketId, params.data, params.context);
      
    case 'acknowledge':
      return acknowledgeTicket(params.ticketId, params.context);
      
    case 'resolve':
      return resolveTicket(params.ticketId, params.resolution, params.context);
      
    case 'reopen':
      return reopenTicket(params.ticketId, params.reason, params.context);
      
    case 'close':
      return closeTicket(params.ticketId, params.context);
      
    case 'cancel':
      return cancelTicket(params.ticketId, params.reason, params.context);
      
    case 'assign':
      return assignTicket(params.ticketId, params.userId, params.context);
      
    case 'reassign':
      return reassignTicket(params.ticketId, params.userId, params.reason, params.context);
      
    case 'escalate':
      return escalateTicket(params.ticketId, params.reason, params.escalateTo, params.context);
      
    case 'deescalate':
      return deescalateTicket(params.ticketId, params.context);
      
    case 'addComment':
      return addTicketComment(params.ticketId, params.comment);
      
    case 'addAttachment':
      return addTicketAttachment(params.ticketId, params.attachment);
      
    case 'recordSatisfaction':
      return recordSatisfaction(params.ticketId, params.rating, params.comment, params.context);
      
    case 'merge':
      return mergeTickets(params.sourceTicketId, params.targetTicketId, params.context);
      
    case 'bulkAssign':
      return bulkAssignTickets(params.ticketIds, params.userId, params.context);
      
    case 'bulkUpdateStatus':
      return bulkUpdateStatus(params.ticketIds, params.status, params.context);

    case 'getNewComments':
      return getNewCommentsForTicket(params.ticketId, params.since);

    case 'getOpenTicketsForChat':
      return getCustomerOpenTicketsForChat(params.customerId);

    case 'getComments':
      return getTicketComments(params.ticketId);

    case 'getByCustomer':
      return getTicketsByCustomer(params.customerId, params.limit);

    case 'updateStatus':
      return updateTicketStatus(params.ticketId, params.status, params.agentId);

    default:
      return { success: false, error: 'Unknown action: ' + action };
  }
}

// ============================================================================
// CHAT SUPPORT FUNCTIONS
// ============================================================================

/**
 * Returns comments added after a given ISO timestamp. Used by 15-second chat polling.
 * @param {string} ticketId - Ticket ID
 * @param {string} since - ISO timestamp
 * @returns {Object} New comments since timestamp
 */
function getNewCommentsForTicket(ticketId, since) {
  try {
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 30000);
    const allComments = getSheetData('TicketComments');
    const ticketComments = allComments
      .filter(function(c) { return c.ticket_id === ticketId; })
      .sort(function(a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    const newComments = ticketComments.filter(function(c) {
      return new Date(c.created_at) > sinceDate;
    });
    return {
      success:     true,
      newComments: newComments,
      checkedAt:   new Date().toISOString()
    };
  } catch (e) {
    Logger.log('getNewCommentsForTicket error: ' + e.message);
    return { success: false, error: e.message, newComments: [] };
  }
}

/**
 * Returns all comments for a ticket ordered by created_at ascending.
 * Used for initial chat load.
 * @param {string} ticketId - Ticket ID
 * @returns {Object} All ticket comments
 */
function getTicketComments(ticketId) {
  try {
    const allComments = getSheetData('TicketComments');
    const comments = allComments
      .filter(function(c) { return c.ticket_id === ticketId; })
      .sort(function(a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    return { success: true, comments: comments };
  } catch (e) {
    Logger.log('getTicketComments error: ' + e.message);
    return { success: false, error: e.message, comments: [] };
  }
}

/**
 * Returns open tickets for a customer with latest comment.
 * Populates the customer chat widget ticket selector.
 * @param {string} customerId - Customer ID
 * @returns {Object} Open tickets with latest message
 */
function getCustomerOpenTicketsForChat(customerId) {
  try {
    const openStatuses = ['NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED'];
    const allTickets = getSheetData('Tickets');
    const tickets = allTickets
      .filter(function(t) {
        return t.customer_id === customerId && openStatuses.includes(t.status);
      })
      .sort(function(a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, 10);

    const allComments = getSheetData('TicketComments');
    const enriched = tickets.map(function(t) {
      const ticketComments = allComments
        .filter(function(c) { return c.ticket_id === t.ticket_id && !c.is_internal; })
        .sort(function(a, b) { return new Date(b.created_at) - new Date(a.created_at); });
      return {
        ticket_id:     t.ticket_id,
        ticket_number: t.ticket_number,
        subject:       t.subject,
        status:        t.status,
        priority:      t.priority,
        assigned_to:   t.assigned_to,
        updated_at:    t.updated_at,
        latestMessage: ticketComments.length > 0 ? ticketComments[0] : null
      };
    });

    return { success: true, tickets: enriched };
  } catch (e) {
    Logger.log('getCustomerOpenTicketsForChat error: ' + e.message);
    return { success: false, error: e.message, tickets: [] };
  }
}

/**
 * Returns all tickets for a customer sorted by updated_at desc.
 * Used for the history tab in the staff chat panel.
 * @param {string} customerId - Customer ID
 * @param {number} limit - Max tickets to return (default 20)
 * @returns {Object} Customer tickets
 */
function getTicketsByCustomer(customerId, limit) {
  try {
    const cap = parseInt(limit) || 20;
    const allTickets = getSheetData('Tickets');
    const tickets = allTickets
      .filter(function(t) { return t.customer_id === customerId; })
      .sort(function(a, b) { return new Date(b.updated_at) - new Date(a.updated_at); })
      .slice(0, cap);
    return { success: true, tickets: tickets };
  } catch (e) {
    Logger.log('getTicketsByCustomer error: ' + e.message);
    return { success: false, error: e.message, tickets: [] };
  }
}

/**
 * Updates ticket status and timestamps. Called from staff quick actions.
 * @param {string} ticketId - Ticket ID
 * @param {string} newStatus - New status value
 * @param {string} agentId - Agent performing the update
 * @returns {Object} Result
 */
function updateTicketStatus(ticketId, newStatus, agentId) {
  try {
    if (!ticketId || !newStatus) return { success: false, error: 'ticketId and status are required' };
    const validStatuses = ['NEW','OPEN','IN_PROGRESS','PENDING_CUSTOMER','PENDING_INTERNAL','ESCALATED','RESOLVED','CLOSED'];
    if (!validStatuses.includes(newStatus)) return { success: false, error: 'Invalid status: ' + newStatus };

    const now = new Date().toISOString();
    const updates = {
      status:     newStatus,
      updated_at: now
    };
    if (newStatus === 'RESOLVED') {
      updates.resolved_at     = now;
      updates.resolved_by     = agentId || '';
    }
    if (newStatus === 'CLOSED') {
      updates.closed_at = now;
    }
    const result = updateRow('Tickets', 'ticket_id', ticketId, updates);
    if (!result) return { success: false, error: 'Ticket not found' };
    return { success: true, ticketId: ticketId, newStatus: newStatus };
  } catch (e) {
    Logger.log('updateTicketStatus error: ' + e.message);
    return { success: false, error: e.message };
  }
}
