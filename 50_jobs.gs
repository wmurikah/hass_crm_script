/**
 * 50_jobs.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Background job scheduler and trigger management.
 *
 * installAllTriggers()    — one-time setup: registers all time-based triggers
 * uninstallAllTriggers()  — removes all project triggers (for maintenance)
 *
 * Trigger functions (called by Apps Script scheduler):
 *   jobSlaCheck()         — every hour: check SLA breaches for open tickets/orders
 *   jobNotifFlush()       — every 5 min: dispatch PENDING notifications
 *   jobSessionCleanup()   — daily: expire old sessions
 *   jobApprovalExpiry()   — every hour: expire timed-out approval requests
 *
 * Job queue table: job_runs (job_name, started_at, finished_at, status, error_message, created_at)
 */

// ── Trigger installation ────────────────────────────────────────────────────────

/**
 * Run once from the IDE to register all time-based triggers.
 * Idempotent: checks for duplicates before creating.
 */
function installAllTriggers() {
  var existing = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });

  var triggers = [
    { fn: 'jobSlaCheck',        everyMinutes: 60   },
    { fn: 'jobNotifFlush',      everyMinutes: 5    },
    { fn: 'jobSessionCleanup',  everyHours:   24   },
    { fn: 'jobApprovalExpiry',  everyMinutes: 60   },
  ];

  triggers.forEach(function (spec) {
    if (existing.indexOf(spec.fn) !== -1) {
      Logger.log('Trigger already registered: ' + spec.fn);
      return;
    }
    var builder = ScriptApp.newTrigger(spec.fn).timeBased();
    if (spec.everyMinutes) {
      builder.everyMinutes(spec.everyMinutes);
    } else {
      builder.everyHours(spec.everyHours);
    }
    builder.create();
    Logger.log('Trigger registered: ' + spec.fn);
  });
  Logger.log('installAllTriggers complete.');
}

/**
 * Remove every trigger in this project. Use during maintenance windows.
 */
function uninstallAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
    Logger.log('Deleted trigger: ' + t.getHandlerFunction());
  });
  Logger.log('uninstallAllTriggers complete.');
}

// ── Job run logging helper ─────────────────────────────────────────────────────

function _jobStart_(jobName) {
  var now = nowIso();
  try {
    TursoClient.write(
      'INSERT INTO job_runs (job_name, started_at, status, created_at) VALUES (?,?,?,?)',
      [jobName, now, 'RUNNING', now]
    );
  } catch (_) {}
  return now;
}

function _jobEnd_(jobName, startedAt, status, error) {
  var now = nowIso();
  try {
    TursoClient.write(
      'UPDATE job_runs SET finished_at = ?, status = ?, error_message = ? ' +
      'WHERE job_name = ? AND started_at = ? AND status = ?',
      [now, status, error || null, jobName, startedAt, 'RUNNING']
    );
  } catch (_) {}
}

// ── jobSlaCheck ────────────────────────────────────────────────────────────────

function jobSlaCheck() {
  var startedAt = _jobStart_('jobSlaCheck');
  var checked = 0; var errors = 0;
  try {
    // Open tickets
    var tickets = TursoClient.select(
      "SELECT ticket_id, country_code, priority, created_at FROM tickets " +
      "WHERE status IN ('NEW','OPEN') AND created_at >= datetime('now','-14 days') LIMIT 500"
    );
    tickets.forEach(function (t) {
      try {
        _slaCheckEntity_({ session: { userId: 'SYSTEM', role: 'SUPER_ADMIN', countryCode: '' } },
          { entity_type: 'TICKET', entity_id: t.ticket_id });
        checked++;
      } catch (e) { errors++; Log.warn({ service: 'jobSlaCheck', msg: e.message, data: { ticket_id: t.ticket_id } }); }
    });
    // Open orders
    var orders = TursoClient.select(
      "SELECT order_id, country_code, created_at FROM orders " +
      "WHERE status IN ('SUBMITTED','APPROVED') AND created_at >= datetime('now','-14 days') LIMIT 500"
    );
    orders.forEach(function (o) {
      try {
        _slaCheckEntity_({ session: { userId: 'SYSTEM', role: 'SUPER_ADMIN', countryCode: '' } },
          { entity_type: 'ORDER', entity_id: o.order_id });
        checked++;
      } catch (e) { errors++; }
    });
    _jobEnd_('jobSlaCheck', startedAt, 'OK');
    Logger.log('jobSlaCheck: checked=' + checked + ' errors=' + errors);
  } catch (e) {
    _jobEnd_('jobSlaCheck', startedAt, 'ERROR', e.message);
    Logger.log('jobSlaCheck FATAL: ' + e.message);
  }
}

// ── jobNotifFlush ──────────────────────────────────────────────────────────────

function jobNotifFlush() {
  var startedAt = _jobStart_('jobNotifFlush');
  try {
    var pending = TursoClient.select(
      "SELECT * FROM notifications WHERE status = 'PENDING' ORDER BY created_at LIMIT 50"
    );
    var sent = 0; var failed = 0;
    pending.forEach(function (n) {
      var ok = false;
      try {
        if (n.channel === 'EMAIL') {
          ok = _dispatchEmail_(n);
        } else if (n.channel === 'SMS') {
          ok = _dispatchSms_(n);
        } else {
          // IN_APP: just mark as sent.
          ok = true;
        }
      } catch (_) {}
      var now = nowIso();
      if (ok) {
        TursoClient.write(
          "UPDATE notifications SET status='SENT', sent_at=?, updated_at=? WHERE notification_id=?",
          [now, now, n.notification_id]
        );
        sent++;
      } else {
        TursoClient.write(
          "UPDATE notifications SET status='FAILED', updated_at=? WHERE notification_id=?",
          [now, n.notification_id]
        );
        failed++;
      }
    });
    _jobEnd_('jobNotifFlush', startedAt, 'OK');
    Logger.log('jobNotifFlush: sent=' + sent + ' failed=' + failed);
  } catch (e) {
    _jobEnd_('jobNotifFlush', startedAt, 'ERROR', e.message);
    Logger.log('jobNotifFlush FATAL: ' + e.message);
  }
}

// ── jobSessionCleanup ─────────────────────────────────────────────────────────

function jobSessionCleanup() {
  var startedAt = _jobStart_('jobSessionCleanup');
  try {
    var now = nowIso();
    var result = TursoClient.write(
      "UPDATE sessions SET is_active=0, updated_at=? WHERE is_active=1 AND expires_at < ?",
      [now, now]
    );
    _jobEnd_('jobSessionCleanup', startedAt, 'OK');
    Logger.log('jobSessionCleanup: expired sessions cleared at ' + now);
  } catch (e) {
    _jobEnd_('jobSessionCleanup', startedAt, 'ERROR', e.message);
    Logger.log('jobSessionCleanup FATAL: ' + e.message);
  }
}

// ── jobApprovalExpiry ─────────────────────────────────────────────────────────

function jobApprovalExpiry() {
  var startedAt = _jobStart_('jobApprovalExpiry');
  try {
    var now = nowIso();
    TursoClient.write(
      "UPDATE approval_requests SET status='EXPIRED', updated_at=? " +
      "WHERE status='PENDING' AND expires_at IS NOT NULL AND expires_at < ?",
      [now, now]
    );
    _jobEnd_('jobApprovalExpiry', startedAt, 'OK');
    Logger.log('jobApprovalExpiry: ran at ' + now);
  } catch (e) {
    _jobEnd_('jobApprovalExpiry', startedAt, 'ERROR', e.message);
    Logger.log('jobApprovalExpiry FATAL: ' + e.message);
  }
}
