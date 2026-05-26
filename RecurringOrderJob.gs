/**
 * HASS PETROLEUM CMS - Recurring Order Job Runner (Section 3.5)
 *
 * Daily time-driven trigger at 02:00 that:
 *   1. Finds active recurring_schedule rows whose next_order_date is today
 *      or earlier (i.e., due).
 *   2. Enqueues a RECURRING_ORDER_GEN job per due schedule (idempotent:
 *      skips schedules that already have a PENDING/RUNNING/COMPLETED job
 *      enqueued today).
 *   3. The 5-minute JobProcessor trigger picks up and processes each job:
 *      - Calls createOrderFromSchedule() to generate a DRAFT order.
 *      - Where auto_submit = 1, submits the order and routes it through
 *        the ApprovalEngine (G-002) via submitOrder().
 *      - Advances next_order_date on the schedule (done inside
 *        createOrderFromSchedule).
 *      - Logs every action to audit_log.
 *
 * Idempotency guarantee
 *   - The enqueue step checks for an existing job in job_queue for the
 *     same schedule_id created today (regardless of status), so a re-run
 *     of scheduleRecurringOrders() within the same calendar day is safe.
 *   - createOrderFromSchedule() itself advances next_order_date, so even
 *     if a second RECURRING_ORDER_GEN job slips through it will find
 *     next_order_date > today and skip.
 *
 * Public entry points
 *   scheduleRecurringOrders()        — daily trigger handler (02:00)
 *   installRecurringOrderTrigger()   — one-time trigger setup
 *
 * JobProcessor integration
 *   _jobRecurringOrderGen_(payload)  — called by JobProcessor._dispatch_
 *   Registered in JobProcessor.gs under case 'RECURRING_ORDER_GEN'.
 */

// ============================================================================
// DAILY TRIGGER: ENQUEUE DUE SCHEDULES
// ============================================================================

/**
 * Called at 02:00 by the daily time-driven trigger.
 * Finds all due recurring schedules and enqueues RECURRING_ORDER_GEN jobs
 * for those that have not already been enqueued today.
 *
 * @returns {{success:boolean, enqueued:number, skipped:number, errors:number}}
 */
function scheduleRecurringOrders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('[RecurringOrderJob] Lock busy – skipping run');
    return { success: false, reason: 'lock_busy' };
  }
  try {
    return _execScheduleRecurringOrders_();
  } finally {
    lock.releaseLock();
  }
}

function _execScheduleRecurringOrders_() {
  var todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  var todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
  var todayIso     = todayStart.toISOString();
  var todayEndIso  = todayEnd.toISOString();

  // ── 1. Load today's already-enqueued RECURRING_ORDER_GEN jobs ────────────
  var existingToday = {};
  try {
    var existingRows = tursoSelect(
      'SELECT payload, status FROM job_queue ' +
      'WHERE type = ? AND created_at >= ? AND created_at <= ?',
      ['RECURRING_ORDER_GEN', todayIso, todayEndIso]
    );
    existingRows.forEach(function(r) {
      try {
        var p = JSON.parse(r.payload || '{}');
        if (p.schedule_id) existingToday[p.schedule_id] = r.status;
      } catch(e) {}
    });
  } catch (e) {
    Logger.log('[RecurringOrderJob] Could not load existing jobs: ' + e.message);
  }

  // ── 2. Find due schedules: is_active=1 AND next_order_date <= today ───────
  var dueSchedules = [];
  try {
    dueSchedules = tursoSelect(
      'SELECT * FROM recurring_schedule ' +
      'WHERE (is_active = 1 OR is_active = "true") ' +
      '  AND next_order_date IS NOT NULL AND next_order_date != "" ' +
      '  AND next_order_date <= ? ' +
      '  AND (end_date IS NULL OR end_date = "" OR end_date >= ?)',
      [todayEndIso, todayIso]
    );
  } catch (e) {
    Logger.log('[RecurringOrderJob] Failed to query due schedules: ' + e.message);
    return { success: false, error: e.message };
  }

  if (!dueSchedules.length) {
    Logger.log('[RecurringOrderJob] No due recurring schedules today');
    return { success: true, enqueued: 0, skipped: 0, errors: 0 };
  }

  var enqueued = 0, skipped = 0, errors = 0;

  dueSchedules.forEach(function(schedule) {
    try {
      var sid = schedule.schedule_id;

      // Idempotency: skip if a job was already created for this schedule today.
      if (existingToday[sid]) {
        Logger.log('[RecurringOrderJob] Schedule ' + sid + ' already has a job today (' +
          existingToday[sid] + ') – skipping');
        skipped++;
        return;
      }

      // Enqueue the job.
      var jobId = enqueueJob('RECURRING_ORDER_GEN', {
        schedule_id:  sid,
        customer_id:  schedule.customer_id,
        auto_submit:  schedule.auto_submit,
        triggered_at: todayIso,
      });

      Logger.log('[RecurringOrderJob] Enqueued job ' + jobId + ' for schedule ' + sid);

      auditLogCustom(
        'RecurringSchedule', sid,
        'RECURRING_SCHEDULER',
        'RECURRING_ORDER_ENQUEUED',
        { job_id: jobId, triggered_at: todayIso, auto_submit: schedule.auto_submit },
        schedule.country_code || ''
      );

      enqueued++;

    } catch (e) {
      Logger.log('[RecurringOrderJob] Error enqueuing schedule ' +
        (schedule.schedule_id || '?') + ': ' + e.message);
      errors++;
    }
  });

  Logger.log('[RecurringOrderJob] Done. enqueued=' + enqueued +
    ' skipped=' + skipped + ' errors=' + errors);

  return { success: true, enqueued: enqueued, skipped: skipped, errors: errors };
}

// ============================================================================
// JOB HANDLER  (called from JobProcessor._dispatch_)
// ============================================================================

/**
 * Processes one RECURRING_ORDER_GEN job queue entry.
 *
 * Steps:
 *   1. Reload the schedule; bail if inactive or next_order_date has advanced
 *      past today (means a concurrent run already processed it).
 *   2. Call createOrderFromSchedule(scheduleId), which generates the DRAFT
 *      order and advances next_order_date.
 *   3. If auto_submit = 1, the existing createOrderFromSchedule() already
 *      calls submitOrder() which routes via the ApprovalEngine (G-002).
 *   4. Log the outcome to audit_log.
 *
 * @param {{schedule_id:string, customer_id:string, auto_submit:*, triggered_at:string}} payload
 * @returns {{success:boolean, orderId?:string}}
 */
function _jobRecurringOrderGen_(payload) {
  if (!payload || !payload.schedule_id) {
    throw new Error('RECURRING_ORDER_GEN: schedule_id missing in payload');
  }

  var sid = payload.schedule_id;
  var todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  // ── 1. Re-read schedule for freshness ────────────────────────────────────
  var schedRows = tursoSelect(
    'SELECT * FROM recurring_schedule WHERE schedule_id = ? LIMIT 1', [sid]
  );
  if (!schedRows.length) {
    throw new Error('RECURRING_ORDER_GEN: schedule not found: ' + sid);
  }
  var schedule = schedRows[0];

  if (!schedule.is_active || String(schedule.is_active) === 'false' ||
      String(schedule.is_active) === '0') {
    Logger.log('[RecurringOrderJob] Schedule ' + sid + ' is inactive – skipping');
    return { success: true, skipped: true, reason: 'inactive' };
  }

  // Idempotency guard: if next_order_date has already advanced past today,
  // another execution already processed this schedule – do nothing.
  if (schedule.next_order_date && new Date(schedule.next_order_date) > todayEnd) {
    Logger.log('[RecurringOrderJob] Schedule ' + sid +
      ' next_order_date ' + schedule.next_order_date + ' is future – already processed');
    return { success: true, skipped: true, reason: 'already_processed' };
  }

  // ── 2. Generate the order ─────────────────────────────────────────────────
  // createOrderFromSchedule handles:
  //   - Fetching lines from recurring_schedule_lines
  //   - Creating DRAFT order via createOrder()
  //   - Calling submitOrder() if auto_submit=1 (routes through ApprovalEngine)
  //   - Advancing next_order_date on the schedule
  var result = createOrderFromSchedule(sid);

  if (!result || !result.success) {
    var errMsg = (result && result.error) || 'createOrderFromSchedule returned failure';
    auditLogCustom(
      'RecurringSchedule', sid,
      'RECURRING_SCHEDULER',
      'RECURRING_ORDER_FAILED',
      { error: errMsg, payload: payload },
      schedule.country_code || ''
    );
    throw new Error('RECURRING_ORDER_GEN failed for ' + sid + ': ' + errMsg);
  }

  // ── 3. Audit success ──────────────────────────────────────────────────────
  auditLogCustom(
    'RecurringSchedule', sid,
    'RECURRING_SCHEDULER',
    'RECURRING_ORDER_CREATED',
    {
      order_id:    result.orderId,
      order_number: result.orderNumber || '',
      auto_submit: schedule.auto_submit,
      status:      result.status || 'DRAFT',
      triggered_at: payload.triggered_at || '',
    },
    schedule.country_code || ''
  );

  if (schedule.auto_submit && String(schedule.auto_submit) !== '0') {
    auditLogCustom(
      'Order', result.orderId,
      'RECURRING_SCHEDULER',
      'RECURRING_ORDER_AUTO_SUBMITTED',
      {
        schedule_id:  sid,
        triggered_at: payload.triggered_at || '',
      },
      schedule.country_code || ''
    );
  }

  Logger.log('[RecurringOrderJob] Created order ' + result.orderId +
    ' for schedule ' + sid + ' (auto_submit=' + schedule.auto_submit + ')');

  return { success: true, orderId: result.orderId };
}

// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================

/**
 * Installs the daily 02:00 trigger for scheduleRecurringOrders().
 * Safe to call multiple times.
 */
function installRecurringOrderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduleRecurringOrders') {
      Logger.log('[RecurringOrderJob] Trigger already installed');
      return;
    }
  }
  ScriptApp.newTrigger('scheduleRecurringOrders')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  Logger.log('[RecurringOrderJob] Daily 02:00 trigger installed');
}

/**
 * Removes the trigger.
 */
function uninstallRecurringOrderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'scheduleRecurringOrders') {
      ScriptApp.deleteTrigger(t);
      Logger.log('[RecurringOrderJob] Trigger removed');
    }
  });
}
