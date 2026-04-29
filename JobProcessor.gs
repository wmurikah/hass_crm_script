/**
 * HASS PETROLEUM CMS — JOB PROCESSOR
 * Version: 1.0.0
 *
 * Async job queue backed by the JobQueue sheet.
 * Installed as a 5-minute time-driven trigger (see installJobProcessorTrigger).
 *
 * JOB TYPES
 * ─────────
 *  SEND_EMAIL           Send email via GmailApp
 *  SEND_NOTIFICATION    Write in-app notification row
 *  SLA_BREACH_CHECK     Re-evaluate SLA breach flags on an open ticket
 *  SESSION_CLEANUP      Hard-delete expired session rows
 *  AUDIT_CLEANUP        Hard-delete AuditLog rows older than 90 days
 *  ORACLE_SYNC          POST data to Oracle integration endpoint
 *
 * RETRY POLICY
 * ────────────
 *  Up to 3 attempts per job.
 *  Delays between retries: 60 s → 300 s → 900 s.
 *  After 3 failures the job is marked FAILED (no further retries).
 *
 * SAFETY LIMITS
 * ─────────────
 *  Max jobs per trigger run : 20
 *  Execution time budget    : 4.5 minutes (GAS hard limit is 6 min)
 *  Lock timeout             : 25 s (prevents concurrent runs)
 *
 * JobQueue sheet columns:
 *   job_id, type, payload (JSON string), status, attempts,
 *   next_run_at, created_at, completed_at, error
 */

var JOB_MAX_ATTEMPTS  = 3;
var JOB_BATCH_LIMIT   = 20;
var JOB_LOCK_MS       = 25000;
var JOB_TIME_BUDGET   = 4.5 * 60 * 1000;        // 4.5 min in ms
var JOB_RETRY_SECS    = [60, 300, 900];           // delay per attempt number

// ============================================================================
// TRIGGER ENTRY POINT
// ============================================================================

/**
 * Called by the 5-minute time-driven trigger.
 * Acquires a script lock so only one invocation runs at a time.
 */
function processJobQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(JOB_LOCK_MS)) {
    Logger.log('[JobProcessor] Lock busy — skipping this run');
    return;
  }
  try {
    _runBatch_();
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// BATCH RUNNER
// ============================================================================

function _runBatch_() {
  var now      = new Date();
  var deadline = new Date(now.getTime() + JOB_TIME_BUDGET);

  var allJobs = getSheetData('JobQueue');
  var pending = allJobs.filter(function(j) {
    if (j.status !== 'PENDING' && j.status !== 'RETRY') return false;
    if (!j.next_run_at) return true;
    return new Date(j.next_run_at) <= now;
  }).slice(0, JOB_BATCH_LIMIT);

  if (pending.length === 0) return;
  Logger.log('[JobProcessor] Processing ' + pending.length + ' job(s)');

  for (var i = 0; i < pending.length; i++) {
    if (new Date() >= deadline) {
      Logger.log('[JobProcessor] Time limit reached after ' + i + ' job(s)');
      break;
    }
    _runOneJob_(pending[i]);
  }
}

// ============================================================================
// SINGLE JOB RUNNER
// ============================================================================

function _runOneJob_(job) {
  var jobId    = job.job_id;
  var attempts = parseInt(job.attempts || '0') + 1;
  var payload  = {};
  try { payload = JSON.parse(job.payload || '{}'); } catch(e) {}

  updateRow('JobQueue', 'job_id', jobId, { status: 'RUNNING', attempts: attempts });

  try {
    var result = _dispatch_(job.type, payload);
    updateRow('JobQueue', 'job_id', jobId, {
      status:       'COMPLETED',
      completed_at: new Date(),
      error:        '',
    });
    Logger.log('[JobProcessor] Done ' + jobId + ' (' + job.type + '): ' + JSON.stringify(result));
  } catch(e) {
    Logger.log('[JobProcessor] Failed ' + jobId + ' attempt ' + attempts + ': ' + e.message);
    var nextStatus   = attempts >= JOB_MAX_ATTEMPTS ? 'FAILED' : 'RETRY';
    var delaySecs    = JOB_RETRY_SECS[attempts - 1] || JOB_RETRY_SECS[JOB_RETRY_SECS.length - 1];
    var nextRunAt    = nextStatus === 'FAILED' ? '' : new Date(Date.now() + delaySecs * 1000);
    updateRow('JobQueue', 'job_id', jobId, {
      status:      nextStatus,
      error:       e.message,
      next_run_at: nextRunAt,
    });
  }
}

// ============================================================================
// JOB DISPATCHER
// ============================================================================

function _dispatch_(type, payload) {
  switch (type) {
    case 'SEND_EMAIL':         return _jobEmail_(payload);
    case 'SEND_NOTIFICATION':  return _jobNotification_(payload);
    case 'SLA_BREACH_CHECK':   return _jobSlaCheck_(payload);
    case 'SESSION_CLEANUP':    return _jobSessionClean_();
    case 'AUDIT_CLEANUP':      return _jobAuditClean_();
    case 'ORACLE_SYNC':        return _jobOracleSync_(payload);
    default:
      throw new Error('Unknown job type: ' + type);
  }
}

// ============================================================================
// JOB HANDLERS
// ============================================================================

function _jobEmail_(p) {
  if (!p.to || !p.subject || !p.body) throw new Error('Missing to/subject/body');
  GmailApp.sendEmail(p.to, p.subject, p.body, {
    htmlBody: p.htmlBody || p.body,
    name:     p.fromName || 'Hass Petroleum CRM',
    replyTo:  p.replyTo  || 'noreply@hasspetroleum.com',
  });
  return { sent: true, to: p.to };
}

function _jobNotification_(p) {
  if (!p.userId || !p.message) throw new Error('Missing userId/message');
  appendRow('Notifications', {
    notification_id: generateUUID(),
    user_id:         p.userId,
    user_type:       p.userType       || 'STAFF',
    type:            p.type           || 'SYSTEM',
    title:           p.title          || 'Notification',
    message:         p.message,
    reference_type:  p.referenceType  || '',
    reference_id:    p.referenceId    || '',
    is_read:         false,
    created_at:      new Date(),
  });
  cacheInvalidate('Notifications');
  return { sent: true };
}

function _jobSlaCheck_(p) {
  if (!p.ticketId) throw new Error('ticketId required');
  var ticket = findRow('Tickets', 'ticket_id', p.ticketId);
  if (!ticket) throw new Error('Ticket not found: ' + p.ticketId);

  var done = ['RESOLVED', 'CLOSED', 'CANCELLED'];
  if (done.indexOf(String(ticket.status || '').toUpperCase()) !== -1) {
    return { skipped: true, reason: 'ticket already closed' };
  }

  var now     = new Date();
  var updates = {};
  if (ticket.sla_resolve_by  && !ticket.sla_resolve_breached)
    updates.sla_resolve_breached  = new Date(ticket.sla_resolve_by)  < now;
  if (ticket.sla_response_by && !ticket.sla_response_breached)
    updates.sla_response_breached = new Date(ticket.sla_response_by) < now;
  if (ticket.sla_acknowledge_by && !ticket.sla_acknowledge_breached)
    updates.sla_acknowledge_breached = new Date(ticket.sla_acknowledge_by) < now;

  if (Object.keys(updates).length > 0) {
    updateRow('Tickets', 'ticket_id', p.ticketId, updates);
    cacheInvalidate('Tickets');
  }
  return { checked: true, updates: updates };
}

function _jobSessionClean_() {
  var sessions = getSheetData('Sessions');
  var now      = new Date();
  var removed  = 0;
  // Iterate in reverse so row deletion doesn't shift indices
  var expired  = sessions.filter(function(s) {
    return !s.is_active || (s.expires_at && new Date(s.expires_at) < now);
  });
  for (var i = 0; i < expired.length; i++) {
    deleteRow('Sessions', 'session_id', expired[i].session_id, true);
    removed++;
  }
  if (removed > 0) cacheInvalidate('Sessions');
  Logger.log('[JobProcessor] Session cleanup: removed ' + removed);
  return { removed: removed };
}

function _jobAuditClean_() {
  var cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  var logs   = getSheetData('AuditLog');
  var old    = logs.filter(function(l) { return l.created_at && new Date(l.created_at) < cutoff; });
  var removed = 0;
  for (var i = 0; i < old.length; i++) {
    deleteRow('AuditLog', 'log_id', old[i].log_id, true);
    removed++;
  }
  if (removed > 0) cacheInvalidate('AuditLog');
  Logger.log('[JobProcessor] Audit cleanup: removed ' + removed);
  return { removed: removed };
}

function _jobOracleSync_(p) {
  if (!p.endpoint || !p.data) throw new Error('endpoint and data required');
  var baseUrl = getConfig('ORACLE_BASE_URL', '');
  if (!baseUrl)                throw new Error('ORACLE_BASE_URL not configured');
  var apiKey  = getConfig('ORACLE_API_KEY', '');

  var started  = Date.now();
  var response = UrlFetchApp.fetch(baseUrl + p.endpoint, {
    method:             'post',
    contentType:        'application/json',
    headers:            { 'x-api-key': apiKey },
    payload:            JSON.stringify(p.data),
    muteHttpExceptions: true,
  });
  var duration = Date.now() - started;
  var code     = response.getResponseCode();

  logIntegrationCall('ORACLE', 'OUT', p.endpoint, p.data, response.getContentText(), code, duration);

  if (code < 200 || code >= 300) throw new Error('Oracle sync failed: HTTP ' + code);
  return { status: code, duration: duration };
}

// ============================================================================
// ENQUEUE HELPERS  (used by other services)
// ============================================================================

/**
 * Adds a job to the JobQueue sheet.
 *
 * @param {string} type          - one of the JOB TYPE constants above
 * @param {Object} payload       - job-specific data
 * @param {number} [delaySecs=0] - schedule in the future
 * @returns {string} job_id
 */
function enqueueJob(type, payload, delaySecs) {
  var jobId   = generateId('JOB');
  var runAt   = delaySecs ? new Date(Date.now() + delaySecs * 1000) : new Date();
  appendRow('JobQueue', {
    job_id:       jobId,
    type:         type,
    payload:      JSON.stringify(payload || {}),
    status:       'PENDING',
    attempts:     0,
    next_run_at:  runAt,
    created_at:   new Date(),
    completed_at: '',
    error:        '',
  });
  return jobId;
}

/**
 * Convenience wrapper: enqueue an email notification.
 *
 * @param {string} to
 * @param {string} subject
 * @param {string} body      - plain text
 * @param {string} [htmlBody]
 */
function enqueueEmail(to, subject, body, htmlBody) {
  return enqueueJob('SEND_EMAIL', { to: to, subject: subject, body: body, htmlBody: htmlBody || body });
}

/**
 * Convenience wrapper: enqueue an in-app notification.
 *
 * @param {string} userId
 * @param {string} userType  - 'STAFF' or 'CUSTOMER'
 * @param {string} title
 * @param {string} message
 * @param {Object} [extra]   - { type, referenceType, referenceId }
 */
function enqueueNotification(userId, userType, title, message, extra) {
  var p = Object.assign({ userId: userId, userType: userType, title: title, message: message }, extra || {});
  return enqueueJob('SEND_NOTIFICATION', p);
}

// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================

/**
 * Installs the 5-minute time-driven trigger for processJobQueue().
 * Safe to call multiple times — skips installation if already present.
 */
function installJobProcessorTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processJobQueue') {
      Logger.log('[JobProcessor] Trigger already installed');
      return;
    }
  }
  ScriptApp.newTrigger('processJobQueue')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('[JobProcessor] 5-minute trigger installed');
}

/**
 * Removes the processJobQueue trigger (e.g. for maintenance).
 */
function uninstallJobProcessorTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processJobQueue') {
      ScriptApp.deleteTrigger(triggers[i]);
      Logger.log('[JobProcessor] Trigger removed');
      return;
    }
  }
}

// ============================================================================
// SCHEDULED MAINTENANCE JOBS  (enqueued by a daily/weekly trigger)
// ============================================================================

/**
 * Enqueue routine maintenance jobs.
 * Install as a daily time-driven trigger (e.g. 2:00 AM).
 */
function scheduleDailyMaintenance() {
  enqueueJob('SESSION_CLEANUP', {});
  enqueueJob('AUDIT_CLEANUP',   {});
  Logger.log('[JobProcessor] Daily maintenance jobs enqueued');
}

/**
 * Install the daily maintenance trigger.
 * Safe to call multiple times.
 */
function installMaintenanceTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'scheduleDailyMaintenance') {
      Logger.log('[JobProcessor] Maintenance trigger already installed');
      return;
    }
  }
  ScriptApp.newTrigger('scheduleDailyMaintenance')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  Logger.log('[JobProcessor] Daily maintenance trigger installed (02:00)');
}
