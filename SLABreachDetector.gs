/**
 * HASS PETROLEUM CMS - SLA BREACH DETECTOR (G-003)
 * Version: 1.0.0
 *
 * Closes the G-003 gap: SLA targets were being calculated at creation time
 * (sla_acknowledge_by, sla_response_by, sla_resolve_by) but nothing was
 * actively checking whether those targets were breached. This module:
 *
 *   - Scans open tickets for breached SLA targets.
 *   - Marks the breach flags and bumps escalation_level.
 *   - Routes the ticket to the next role tier per the v3 RBAC matrix:
 *       Level 0  -> CS_AGENT  (initial assignment)
 *       Level 1  -> CS_MANAGER       (within country)
 *       Level 2  -> COUNTRY_MANAGER  (within country)
 *       Level 3  -> CFO if BILLING / PAYMENT, otherwise RMD
 *   - Pauses the SLA clock outside business hours / on holidays for SLA
 *     configs that have business_hours_only = true.
 *   - Sends notifications to the original assignee, the new owner and,
 *     where relevant, the customer contact.
 *   - Writes audit_log rows for every breach + escalation event.
 *   - Applies a lighter version of the same pattern to orders that have
 *     missed their requested_date and to documents that are close to
 *     expiry (overlaps with G-014).
 *
 * Job runner deployment is owned by G-015. This file plays nicely with the
 * existing JobProcessor:
 *   - JobProcessor already dispatches per-ticket SLA_BREACH_CHECK jobs.
 *   - This file adds a SLA_BREACH_SWEEP job type for a portfolio sweep.
 *
 * Usage:
 *   detectTicketBreaches()                  - run the sweep
 *   getActiveBreaches({ country, priority }) - dashboard data
 *   recalculateSLATargets(ticketId)          - recompute targets in flight
 *   scheduleSLABreachSweep()                 - enqueue a sweep job
 *   installSLABreachTrigger()                - install time-based trigger
 */

// ============================================================================
// CONFIG
// ============================================================================

var SLA_BREACH_SYSTEM_ACTOR = 'SLA_BREACH_DETECTOR';
var SLA_BREACH_TICKET_BATCH = 2000;
var SLA_BREACH_OPEN_STATUSES = [
  'NEW', 'OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'ESCALATED'
];

// Categories that should escalate to the CFO at the top tier (vs RMD).
var SLA_BREACH_FINANCE_CATEGORIES_ = ['BILLING', 'PAYMENT', 'INVOICE', 'CREDIT'];

// Notification template id for breach/escalation emails.
var SLA_BREACH_TEMPLATE_ID_ = 'TPL-SLA-BREACH';

// ============================================================================
// ENTRY POINTS
// ============================================================================

/**
 * Scans open tickets and processes any SLA breaches.
 * Safe to invoke directly (manual trigger) or via the SLA_BREACH_SWEEP job.
 *
 * @returns {Object} { success, ticketsChecked, breachesDetected, escalations }
 */
function detectTicketBreaches() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { success: false, error: 'SLA breach sweep already running' };
  }

  try {
    var now = new Date();
    var queryRes = findWhere('Tickets',
      { status: SLA_BREACH_OPEN_STATUSES },
      { limit: SLA_BREACH_TICKET_BATCH }
    );
    var tickets = (queryRes && queryRes.data) || [];

    var stats = { ticketsChecked: tickets.length, breachesDetected: 0, escalations: 0, errors: 0 };

    for (var i = 0; i < tickets.length; i++) {
      try {
        var r = _evaluateTicketBreach_(tickets[i], now);
        if (r.breached)   stats.breachesDetected++;
        if (r.escalated)  stats.escalations++;
      } catch(e) {
        stats.errors++;
        Logger.log('[SLABreachDetector] ticket ' + tickets[i].ticket_id + ' error: ' + e.message);
      }
    }

    if (stats.breachesDetected > 0) {
      try { clearSheetCache('Tickets'); } catch(e) {}
    }

    return Object.assign({ success: true }, stats);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns currently breached tickets for dashboard rendering.
 * @param {Object} filter - { country_code, team_id, priority }
 */
function getActiveBreaches(filter) {
  filter = filter || {};
  try {
    var conditions = { status: SLA_BREACH_OPEN_STATUSES };
    if (filter.country_code) conditions.country_code = filter.country_code;
    if (filter.team_id)      conditions.assigned_team_id = filter.team_id;
    if (filter.priority)     conditions.priority = filter.priority;

    var res = findWhere('Tickets', conditions, { limit: 5000, sortBy: 'sla_resolve_by', sortOrder: 'asc' });
    var rows = ((res && res.data) || []).filter(function(t) {
      return t.sla_acknowledge_breached || t.sla_response_breached || t.sla_resolve_breached;
    });

    var byPriority = { CRITICAL: 0, HIGH: 0, NORMAL: 0, LOW: 0 };
    var byLevel    = { 0: 0, 1: 0, 2: 0, 3: 0 };
    rows.forEach(function(t) {
      var p = String(t.priority || 'NORMAL').toUpperCase();
      byPriority[p] = (byPriority[p] || 0) + 1;
      var lvl = parseInt(t.escalation_level || 0, 10);
      byLevel[lvl] = (byLevel[lvl] || 0) + 1;
    });

    var oldest = rows.slice().sort(function(a, b) {
      return new Date(a.sla_resolve_by || a.created_at) - new Date(b.sla_resolve_by || b.created_at);
    }).slice(0, 5).map(function(t) {
      return {
        ticket_id:        t.ticket_id,
        ticket_number:    t.ticket_number,
        priority:         t.priority,
        country_code:     t.country_code,
        category:         t.category,
        escalation_level: t.escalation_level || 0,
        sla_resolve_by:   t.sla_resolve_by,
        assigned_to:      t.assigned_to,
      };
    });

    return {
      success:  true,
      total:    rows.length,
      byPriority: byPriority,
      byLevel:    byLevel,
      oldest:     oldest,
    };
  } catch(e) {
    Logger.log('[SLABreachDetector] getActiveBreaches error: ' + e.message);
    return { success: false, error: e.message, total: 0 };
  }
}

/**
 * Recomputes sla_*_by for an in-flight ticket. Useful when sla_config
 * changes or a ticket is moved between countries.
 */
function recalculateSLATargets(ticketId) {
  try {
    var ticket = getById('Tickets', ticketId);
    if (!ticket) return { success: false, error: 'Ticket not found' };
    if (typeof findSLAConfig !== 'function' || typeof calculateSLADeadlines !== 'function') {
      return { success: false, error: 'SLA helpers unavailable' };
    }
    var customer = ticket.customer_id ? getById('Customers', ticket.customer_id) : null;
    var slaConfig = findSLAConfig(
      ticket.country_code,
      customer && customer.segment_id,
      ticket.priority,
      ticket.category
    );
    if (!slaConfig) return { success: false, error: 'No SLA config matched' };
    var base = ticket.created_at ? new Date(ticket.created_at) : new Date();
    var d = calculateSLADeadlines(base, slaConfig, ticket.country_code);

    updateRow('Tickets', 'ticket_id', ticketId, {
      sla_config_id:      slaConfig.sla_id,
      sla_acknowledge_by: d.acknowledge,
      sla_response_by:    d.response,
      sla_resolve_by:     d.resolve,
      updated_at:         new Date(),
    });
    try { clearSheetCache('Tickets'); } catch(e) {}

    audit_log({
      entity_type: 'Ticket',
      entity_id:   ticketId,
      action:      'SLA_RECALCULATED',
      actor_user_id: SLA_BREACH_SYSTEM_ACTOR,
      changes: {
        sla_config_id: { from: ticket.sla_config_id, to: slaConfig.sla_id },
      },
      country_code: ticket.country_code,
    });

    return { success: true, ticketId: ticketId, sla: d };
  } catch(e) {
    Logger.log('[SLABreachDetector] recalculateSLATargets error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// PER-TICKET EVALUATION
// ============================================================================

function _evaluateTicketBreach_(ticket, now) {
  now = now || new Date();
  var slaConfig = ticket.sla_config_id ? getById('SLAConfig', ticket.sla_config_id) : null;
  var businessHoursOnly = !!(slaConfig && slaConfig.business_hours_only);

  var ackDue      = _effectiveDueDate_(ticket.created_at, ticket.sla_acknowledge_by, ticket.country_code, businessHoursOnly);
  var responseDue = _effectiveDueDate_(ticket.created_at, ticket.sla_response_by,    ticket.country_code, businessHoursOnly);
  var resolveDue  = _effectiveDueDate_(ticket.created_at, ticket.sla_resolve_by,     ticket.country_code, businessHoursOnly);

  var updates = {};
  var newBreaches = [];

  if (!ticket.sla_acknowledge_breached && !ticket.acknowledged_at && ackDue && now > ackDue) {
    updates.sla_acknowledge_breached = true;
    newBreaches.push('ACKNOWLEDGE');
  }
  if (!ticket.sla_response_breached && !ticket.first_response_at && responseDue && now > responseDue) {
    updates.sla_response_breached = true;
    newBreaches.push('RESPONSE');
  }
  if (!ticket.sla_resolve_breached && !ticket.resolved_at && resolveDue && now > resolveDue) {
    updates.sla_resolve_breached = true;
    newBreaches.push('RESOLVE');
  }

  if (newBreaches.length === 0) return { breached: false, escalated: false };

  // Persist breach flags first so subsequent failures don't re-fire.
  updates.updated_at = now;
  updateRow('Tickets', 'ticket_id', ticket.ticket_id, updates);

  newBreaches.forEach(function(stage) {
    audit_log({
      entity_type: 'Ticket',
      entity_id:   ticket.ticket_id,
      action:      'SLA_BREACH',
      actor_user_id: SLA_BREACH_SYSTEM_ACTOR,
      changes: { stage: stage, ticket_number: ticket.ticket_number },
      metadata: {
        priority:    ticket.priority,
        category:    ticket.category,
        sla_target:  stage === 'ACKNOWLEDGE' ? ticket.sla_acknowledge_by
                    : stage === 'RESPONSE' ? ticket.sla_response_by
                    : ticket.sla_resolve_by,
      },
      country_code: ticket.country_code,
    });
  });

  // Escalation: any new breach bumps the level. Cap at 3.
  var currentLevel = parseInt(ticket.escalation_level || 0, 10);
  var newLevel     = Math.min(currentLevel + 1, 3);
  var escalated    = false;

  if (newLevel > currentLevel) {
    var targetUserId = _findBreachEscalationTarget_(ticket, newLevel);
    var primaryStage = newBreaches[newBreaches.length - 1]; // worst stage hit this run
    var reason       = 'SLA ' + primaryStage + ' breach - auto-escalated to level ' + newLevel;

    var escUpdates = {
      status:           'ESCALATED',
      escalation_level: newLevel,
      escalated_at:     now,
      escalation_reason: reason,
      updated_at:       now,
    };
    if (targetUserId) {
      escUpdates.escalated_to = targetUserId;
      escUpdates.assigned_to  = targetUserId;
    }
    updateRow('Tickets', 'ticket_id', ticket.ticket_id, escUpdates);

    // Internal comment for traceability (best effort).
    try {
      if (typeof addTicketComment === 'function') {
        addTicketComment(ticket.ticket_id, {
          content:     reason,
          author_type: 'SYSTEM',
          author_id:   SLA_BREACH_SYSTEM_ACTOR,
          is_internal: true,
        });
      }
    } catch(e) { Logger.log('[SLABreachDetector] comment error: ' + e.message); }

    audit_log({
      entity_type: 'Ticket',
      entity_id:   ticket.ticket_id,
      action:      'SLA_ESCALATED',
      actor_user_id: SLA_BREACH_SYSTEM_ACTOR,
      changes: {
        escalation_level: { from: currentLevel, to: newLevel },
        assigned_to:      { from: ticket.assigned_to, to: targetUserId || ticket.assigned_to },
      },
      metadata: { stage: primaryStage, reason: reason },
      country_code: ticket.country_code,
    });

    _sendBreachNotifications_(ticket, primaryStage, newLevel, targetUserId);
    escalated = true;
  } else {
    // Already at top tier - still notify the existing assignee + customer.
    _sendBreachNotifications_(ticket, newBreaches[newBreaches.length - 1], currentLevel, ticket.assigned_to);
  }

  return { breached: true, escalated: escalated };
}

// ============================================================================
// ESCALATION TIER MAPPING
// ============================================================================

function _findBreachEscalationTarget_(ticket, level) {
  var country = ticket.country_code;
  var category = String(ticket.category || '').toUpperCase();

  if (level === 1) {
    return _findUserByRole_('CS_MANAGER', country) || _findUserByRole_('CS_MANAGER', null);
  }
  if (level === 2) {
    return _findUserByRole_('COUNTRY_MANAGER', country) || _findUserByRole_('COUNTRY_MANAGER', null);
  }
  if (level >= 3) {
    var financeCat = SLA_BREACH_FINANCE_CATEGORIES_.indexOf(category) !== -1;
    var topRole    = financeCat ? 'CFO' : 'RMD';
    return _findUserByRole_(topRole, null) || _findUserByRole_('RMD', null) || _findUserByRole_('CFO', null);
  }
  return null;
}

/**
 * Finds the first ACTIVE user that holds the given role code, optionally
 * scoped to a country. Uses user_roles + users tables.
 */
function _findUserByRole_(roleCode, countryCode) {
  if (!roleCode) return null;
  try {
    var sql, args;
    if (countryCode) {
      sql = 'SELECT u.user_id FROM user_roles ur ' +
            'JOIN users u ON u.user_id = ur.user_id ' +
            "WHERE ur.role_code = ? AND u.country_code = ? AND u.status = 'ACTIVE' " +
            'LIMIT 1';
      args = [roleCode, countryCode];
    } else {
      sql = 'SELECT u.user_id FROM user_roles ur ' +
            'JOIN users u ON u.user_id = ur.user_id ' +
            "WHERE ur.role_code = ? AND u.status = 'ACTIVE' " +
            'LIMIT 1';
      args = [roleCode];
    }
    var rows = tursoSelect(sql, args);
    return rows.length ? rows[0].user_id : null;
  } catch(e) {
    Logger.log('[SLABreachDetector] _findUserByRole_ error: ' + e.message);
    return null;
  }
}

// ============================================================================
// NOTIFICATIONS
// ============================================================================

function _sendBreachNotifications_(ticket, stage, level, newAssigneeId) {
  if (typeof createNotification !== 'function') return;

  var stageLabel = stage === 'ACKNOWLEDGE' ? 'acknowledgement'
                 : stage === 'RESPONSE'    ? 'first response'
                 : 'resolution';
  var refUrl = '/tickets/' + ticket.ticket_id;

  // 1. Heads-up to the original assignee (if different from new owner).
  if (ticket.assigned_to && ticket.assigned_to !== newAssigneeId) {
    try {
      createNotification({
        recipient_type:    'INTERNAL_USER',
        recipient_id:      ticket.assigned_to,
        notification_type: 'SLA_BREACH',
        reference_type:    'Ticket',
        reference_id:      ticket.ticket_id,
        title:             'SLA breach on ' + ticket.ticket_number,
        message:           'Ticket ' + ticket.ticket_number + ' missed its ' + stageLabel +
                           ' target and has been escalated to level ' + level + '.',
        action_url:        refUrl,
        priority:          'HIGH',
      });
    } catch(e) { Logger.log('[SLABreachDetector] heads-up notif error: ' + e.message); }
  }

  // 2. New owner / escalation recipient.
  if (newAssigneeId) {
    try {
      createNotification({
        recipient_type:    'INTERNAL_USER',
        recipient_id:      newAssigneeId,
        notification_type: 'SLA_ESCALATION',
        reference_type:    'Ticket',
        reference_id:      ticket.ticket_id,
        title:             'Escalation L' + level + ': ' + ticket.ticket_number,
        message:           'Ticket ' + ticket.ticket_number + ' has breached its ' + stageLabel +
                           ' SLA. You are the level ' + level + ' owner.',
        action_url:        refUrl,
        priority:          'CRITICAL',
      });
    } catch(e) { Logger.log('[SLABreachDetector] new owner notif error: ' + e.message); }
  }

  // 3. Customer contact - only on resolve breaches, to avoid noise on
  //    internal SLA misses they would not perceive.
  if (stage === 'RESOLVE' && ticket.contact_id) {
    try {
      createNotification({
        recipient_type:    'CUSTOMER_CONTACT',
        recipient_id:      ticket.contact_id,
        notification_type: 'SLA_BREACH_CUSTOMER',
        reference_type:    'Ticket',
        reference_id:      ticket.ticket_id,
        title:             'Update on ticket ' + ticket.ticket_number,
        message:           'We missed our resolution target on ticket ' + ticket.ticket_number +
                           ' and have escalated it internally. A senior team member is now on it.',
        action_url:        '/portal/tickets',
        priority:          'HIGH',
        template_id:       SLA_BREACH_TEMPLATE_ID_,
      });
    } catch(e) { Logger.log('[SLABreachDetector] customer notif error: ' + e.message); }
  }
}

// ============================================================================
// BUSINESS-HOURS-AWARE SLA CLOCK
// ============================================================================

/**
 * Returns the effective SLA due date - i.e. the original target shifted by
 * any non-business-hours / holiday windows that have elapsed since the
 * ticket was created. If business_hours_only is false, the original target
 * is returned unchanged.
 */
function _effectiveDueDate_(createdAtRaw, targetRaw, countryCode, businessHoursOnly) {
  if (!targetRaw) return null;
  var target = new Date(targetRaw);
  if (isNaN(target.getTime())) return null;
  if (!businessHoursOnly || !createdAtRaw) return target;

  var created = new Date(createdAtRaw);
  if (isNaN(created.getTime()) || created >= target) return target;

  // Pause the clock for any non-business minutes between created and target.
  var pauseMin = subtractNonBusinessHours(created, target, countryCode);
  if (pauseMin <= 0) return target;
  return new Date(target.getTime() + pauseMin * 60 * 1000);
}

/**
 * Returns true if `timestamp` falls within the configured business-hours
 * window for `countryCode`. Holidays return false. Days where the window
 * is blank (e.g. Sunday) are treated as closed.
 */
function isWithinBusinessHours(timestamp, countryCode) {
  var ts = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(ts.getTime())) return false;

  var win = _businessHoursWindowFor_(ts, countryCode);
  if (!win) return false;
  if (_isHoliday_(ts, countryCode)) return false;

  var minutes = ts.getHours() * 60 + ts.getMinutes();
  return minutes >= win.startMin && minutes < win.endMin;
}

/**
 * Returns the number of MINUTES between `start` and `end` that fall OUTSIDE
 * business hours / on a holiday. Always >= 0. Walks day-by-day so it copes
 * with multi-day SLA windows. Bounded to 14 days to avoid runaway loops.
 */
function subtractNonBusinessHours(start, end, countryCode) {
  if (!start || !end) return 0;
  start = start instanceof Date ? start : new Date(start);
  end   = end   instanceof Date ? end   : new Date(end);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return 0;

  var nonBusinessMs = 0;
  var MAX_DAYS = 14;
  var cursor   = new Date(start.getTime());

  for (var i = 0; i < MAX_DAYS && cursor < end; i++) {
    var dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 0, 0, 0, 0);
    var dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    var sliceStart = cursor;
    var sliceEnd   = end < dayEnd ? end : dayEnd;
    var sliceMs    = sliceEnd - sliceStart;

    var win = _businessHoursWindowFor_(sliceStart, countryCode);
    var holiday = _isHoliday_(sliceStart, countryCode);

    if (!win || holiday) {
      nonBusinessMs += sliceMs;
    } else {
      var bizStart = new Date(dayStart.getTime() + win.startMin * 60 * 1000);
      var bizEnd   = new Date(dayStart.getTime() + win.endMin   * 60 * 1000);
      var overlap  = _overlapMs_(sliceStart, sliceEnd, bizStart, bizEnd);
      var nonBiz   = sliceMs - overlap;
      if (nonBiz > 0) nonBusinessMs += nonBiz;
    }

    cursor = dayEnd;
  }

  return Math.round(nonBusinessMs / 60000);
}

function _overlapMs_(aStart, aEnd, bStart, bEnd) {
  var s = aStart > bStart ? aStart : bStart;
  var e = aEnd   < bEnd   ? aEnd   : bEnd;
  var ms = e - s;
  return ms > 0 ? ms : 0;
}

// Cache business-hours rows for the duration of the script execution.
var _SLA_BH_CACHE_ = null;
function _allBusinessHours_() {
  if (_SLA_BH_CACHE_) return _SLA_BH_CACHE_;
  try { _SLA_BH_CACHE_ = getSheetData('BusinessHours') || []; }
  catch(e) { _SLA_BH_CACHE_ = []; }
  return _SLA_BH_CACHE_;
}

var _SLA_HOL_CACHE_ = null;
function _allHolidays_() {
  if (_SLA_HOL_CACHE_) return _SLA_HOL_CACHE_;
  try { _SLA_HOL_CACHE_ = getSheetData('Holidays') || []; }
  catch(e) { _SLA_HOL_CACHE_ = []; }
  return _SLA_HOL_CACHE_;
}

var DAY_KEYS_ = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

function _businessHoursWindowFor_(date, countryCode) {
  var rows = _allBusinessHours_();
  if (!rows.length) {
    // Sensible default: Mon-Fri 08:00-17:00 if no data is configured.
    var dow = date.getDay();
    if (dow === 0 || dow === 6) return null;
    return { startMin: 8 * 60, endMin: 17 * 60 };
  }

  var row = null;
  for (var i = 0; i < rows.length; i++) {
    if (countryCode && rows[i].country_code === countryCode) { row = rows[i]; break; }
  }
  if (!row) {
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].is_default || rows[j].country_code === 'ALL') { row = rows[j]; break; }
    }
  }
  if (!row) row = rows[0];

  var dayKey = DAY_KEYS_[date.getDay()];
  var rawStart = row[dayKey + '_start'];
  var rawEnd   = row[dayKey + '_end'];
  var startMin = _parseHHMM_(rawStart);
  var endMin   = _parseHHMM_(rawEnd);
  if (startMin == null || endMin == null || endMin <= startMin) return null;
  return { startMin: startMin, endMin: endMin };
}

function _parseHHMM_(s) {
  if (!s) return null;
  var t = String(s).trim();
  if (!t) return null;
  var m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(min)) return null;
  return h * 60 + min;
}

function _isHoliday_(date, countryCode) {
  var rows = _allHolidays_();
  if (!rows.length) return false;
  var iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
  var mmdd = iso.slice(5);
  for (var i = 0; i < rows.length; i++) {
    var h = rows[i];
    if (countryCode && h.country_code && h.country_code !== countryCode && h.country_code !== 'ALL') continue;
    var hd = String(h.holiday_date || '').slice(0, 10);
    if (!hd) continue;
    if (hd === iso) return true;
    if (h.is_recurring && hd.slice(5) === mmdd) return true;
  }
  return false;
}

// ============================================================================
// ORDER BREACH DETECTION (lighter pattern)
// ============================================================================

/**
 * Flags orders whose requested_date has passed while still in APPROVED
 * status (i.e. not yet dispatched). Notifies SUPPLY_OPS_MANAGER. No
 * multi-tier escalation - orders are less time-critical than tickets.
 *
 * Order rows do not have dedicated breach columns, so the breach state is
 * recorded by tagging special_instructions and writing audit_log entries.
 */
function detectOrderBreaches() {
  try {
    var now = new Date();
    var openStatuses = ['APPROVED', 'SCHEDULED', 'LOADING', 'LOADED'];
    var res = findWhere('Orders', { status: openStatuses }, { limit: 2000 });
    var orders = (res && res.data) || [];

    var breached = 0;
    var supplyOps = _findUserByRole_('SUPPLY_OPS_MANAGER', null);

    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o.requested_date) continue;
      var due = new Date(o.requested_date);
      if (isNaN(due.getTime()) || due >= now) continue;
      // already flagged?
      if (String(o.special_instructions || '').indexOf('[SLA_BREACHED]') !== -1) continue;

      var note = '[SLA_BREACHED ' + now.toISOString().slice(0, 10) + '] ' +
                 (o.special_instructions || '');
      updateRow('Orders', 'order_id', o.order_id, {
        special_instructions: note,
        updated_at: now,
      });

      audit_log({
        entity_type: 'Order',
        entity_id:   o.order_id,
        action:      'SLA_BREACH',
        actor_user_id: SLA_BREACH_SYSTEM_ACTOR,
        changes: { stage: 'FULFILLMENT', requested_date: o.requested_date },
        metadata: { order_number: o.order_number, status: o.status },
        country_code: o.country_code,
      });

      if (supplyOps && typeof createNotification === 'function') {
        try {
          createNotification({
            recipient_type:    'INTERNAL_USER',
            recipient_id:      supplyOps,
            notification_type: 'ORDER_SLA_BREACH',
            reference_type:    'Order',
            reference_id:      o.order_id,
            title:             'Order overdue: ' + o.order_number,
            message:           'Order ' + o.order_number + ' has missed its requested delivery date (' +
                               String(o.requested_date).slice(0, 10) + ') and is still ' + o.status + '.',
            action_url:        '/orders/' + o.order_id,
            priority:          'HIGH',
          });
        } catch(e) { Logger.log('[SLABreachDetector] order notif error: ' + e.message); }
      }
      breached++;
    }

    if (breached > 0) { try { clearSheetCache('Orders'); } catch(e) {} }
    return { success: true, ordersChecked: orders.length, breached: breached };
  } catch(e) {
    Logger.log('[SLABreachDetector] detectOrderBreaches error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// DOCUMENT EXPIRY ALERTS (light overlap with G-014)
// ============================================================================

/**
 * Flags documents whose expiry_date is within 30 days. Sets
 * reminder_sent_at and writes an audit entry. Does NOT send
 * customer-facing emails - that is the G-014 renewal flow's job.
 */
function detectDocumentExpiryAlerts() {
  try {
    var now = new Date();
    var soon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    var res = findWhere('Documents', { status: ['ACTIVE', 'APPROVED'] }, { limit: 5000 });
    var docs = (res && res.data) || [];

    var flagged = 0;
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d.expiry_date) continue;
      var expiry = new Date(d.expiry_date);
      if (isNaN(expiry.getTime())) continue;
      if (expiry > soon) continue;

      // Skip if we already sent a reminder in the last 7 days.
      if (d.reminder_sent_at) {
        var last = new Date(d.reminder_sent_at);
        if (!isNaN(last.getTime()) && (now - last) < 7 * 24 * 60 * 60 * 1000) continue;
      }

      updateRow('Documents', 'document_id', d.document_id, {
        reminder_sent_at: now,
        updated_at:       now,
      });

      audit_log({
        entity_type: 'Document',
        entity_id:   d.document_id,
        action:      'EXPIRY_ALERT',
        actor_user_id: SLA_BREACH_SYSTEM_ACTOR,
        metadata: {
          document_type: d.document_type,
          expiry_date:   d.expiry_date,
          customer_id:   d.customer_id,
        },
      });
      flagged++;
    }

    if (flagged > 0) { try { clearSheetCache('Documents'); } catch(e) {} }
    return { success: true, documentsChecked: docs.length, flagged: flagged };
  } catch(e) {
    Logger.log('[SLABreachDetector] detectDocumentExpiryAlerts error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// JOB QUEUE INTEGRATION
// ============================================================================

/**
 * Enqueues a portfolio breach sweep via the job_queue. The runner picks it
 * up on its next pass (G-015 deploys the runner; until then this still
 * works when invoked directly).
 *
 * Cadence: every 15 minutes during business hours, hourly otherwise. The
 * caller-side trigger fires every 15 minutes; this function decides whether
 * to skip or enqueue based on the current local time / holidays.
 */
function scheduleSLABreachSweep() {
  var now = new Date();
  var inHours = isWithinBusinessHours(now, null);
  // Outside business hours, only enqueue once per hour (when minute < 15).
  if (!inHours && now.getMinutes() >= 15) {
    return { enqueued: false, reason: 'outside business hours, hourly slot already filled' };
  }
  var jobId = enqueueJob('SLA_BREACH_SWEEP', { triggeredAt: now.toISOString() });
  return { enqueued: true, jobId: jobId };
}

/**
 * Job handler invoked by JobProcessor._dispatch_ when type=SLA_BREACH_SWEEP.
 */
function _jobSlaBreachSweep_(payload) {
  var ticketResult    = detectTicketBreaches();
  var orderResult     = detectOrderBreaches();
  var documentResult  = detectDocumentExpiryAlerts();
  var autoCloseResult = detectResolvedAutoClose();
  return {
    tickets:   ticketResult,
    orders:    orderResult,
    documents: documentResult,
    autoClose: autoCloseResult,
  };
}

// ============================================================================
// AUTO-CLOSE: resolved tickets 24 h after customer confirmation (Section 3.3 step 6)
// ============================================================================

/**
 * Closes tickets that have been in RESOLVED status for ≥ 24 hours after the
 * customer confirmed resolution (resolved_at / customer_confirmed_at).
 * Idempotent: tickets already CLOSED are ignored.
 *
 * @returns {Object} { success, checked, closed, errors }
 */
function detectResolvedAutoClose() {
  var now      = new Date();
  var cutoffMs = 24 * 60 * 60 * 1000; // 24 hours in ms

  var stats = { success: true, checked: 0, closed: 0, errors: 0 };
  try {
    var res = findWhere('Tickets', { status: 'RESOLVED' }, { limit: 2000 });
    var tickets = (res && res.data) || [];
    stats.checked = tickets.length;

    for (var i = 0; i < tickets.length; i++) {
      var t = tickets[i];
      try {
        // Use customer_confirmed_at first; fall back to resolved_at.
        var tsRaw = t.customer_confirmed_at || t.resolved_at;
        if (!tsRaw) continue;
        var ts = new Date(tsRaw);
        if (isNaN(ts.getTime())) continue;
        if ((now - ts) < cutoffMs) continue;

        // Auto-close it.
        updateRow('Tickets', 'ticket_id', t.ticket_id, {
          status:     'CLOSED',
          closed_at:  now.toISOString(),
          updated_at: now.toISOString(),
        });

        audit_log({
          entity_type:   'Ticket',
          entity_id:     t.ticket_id,
          action:        'AUTO_CLOSED',
          actor_user_id: SLA_BREACH_SYSTEM_ACTOR,
          changes: {
            status: { from: 'RESOLVED', to: 'CLOSED' },
            closed_after_hours: Math.round((now - ts) / 3600000),
          },
          metadata: {
            ticket_number:       t.ticket_number,
            resolved_at:         t.resolved_at,
            customer_confirmed_at: t.customer_confirmed_at || '',
          },
          country_code: t.country_code,
        });

        // Best-effort customer notification.
        if (t.contact_id && typeof createNotification === 'function') {
          try {
            createNotification({
              recipient_type:    'CUSTOMER_CONTACT',
              recipient_id:      t.contact_id,
              notification_type: 'TICKET_CLOSED',
              reference_type:    'Ticket',
              reference_id:      t.ticket_id,
              title:             'Ticket ' + t.ticket_number + ' has been closed',
              message:           'Your ticket has been automatically closed 24 hours after resolution. ' +
                                 'If you still need help, please open a new ticket.',
              action_url:        '/portal/tickets',
              priority:          'NORMAL',
            });
          } catch(ne) { Logger.log('[SLABreachDetector] auto-close notif error: ' + ne.message); }
        }

        stats.closed++;
      } catch(te) {
        stats.errors++;
        Logger.log('[SLABreachDetector] auto-close error for ticket ' + t.ticket_id + ': ' + te.message);
      }
    }

    if (stats.closed > 0) { try { clearSheetCache('Tickets'); } catch(e) {} }
  } catch(e) {
    Logger.log('[SLABreachDetector] detectResolvedAutoClose error: ' + e.message);
    return { success: false, error: e.message };
  }
  return stats;
}

/**
 * Installs a 15-minute time-driven trigger that calls
 * scheduleSLABreachSweep(). Idempotent.
 */
function installSLABreachTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduleSLABreachSweep') {
      Logger.log('[SLABreachDetector] trigger already installed');
      return;
    }
  }
  ScriptApp.newTrigger('scheduleSLABreachSweep')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('[SLABreachDetector] 15-minute trigger installed');
}

function uninstallSLABreachTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduleSLABreachSweep') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('[SLABreachDetector] trigger removed');
      return;
    }
  }
}

// ============================================================================
// DASHBOARD WIDGET
// ============================================================================

var SLA_BREACH_DASHBOARD_ROLES_ = [
  'CS_MANAGER', 'COUNTRY_MANAGER', 'RMD', 'CFO', 'SUPER_ADMIN'
];

/**
 * Server-side endpoint for the SLA breach dashboard widget. Visible only to
 * the privileged roles listed above.
 */
function getSLABreachWidget(session, filter) {
  if (!session || !session.userId) {
    return { success: false, error: 'No session' };
  }
  try {
    var roles = (typeof tursoSelect === 'function')
      ? tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [session.userId])
          .map(function(r) { return r.role_code; })
      : [];
    var allowed = roles.some(function(r) { return SLA_BREACH_DASHBOARD_ROLES_.indexOf(r) !== -1; });
    if (!allowed) {
      return { success: false, error: 'Permission denied', code: 'PERMISSION_DENIED' };
    }
    return getActiveBreaches(filter || {});
  } catch(e) {
    return { success: false, error: e.message };
  }
}
