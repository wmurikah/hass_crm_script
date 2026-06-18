/**
 * 50_jobs.gs  —  Hass CMS rebuild  (Stage 9)
 *
 * Global job queue processor and trigger management.
 *
 * Jobs.runJobs()             — process up to 20 PENDING rows from job_queue
 * Jobs.installAllTriggers()  — (re)install all time-based triggers
 *
 * Trigger entry points (called by GAS scheduler):
 *   runJobs()               — every 5 min
 *   runDailyMaintenance()   — daily at 02:00 (SESSION_SWEEP, AUDIT_LOG_RETENTION, MFA_CHALLENGE_SWEEP)
 *   runHourlyApproval()     — hourly (ORACLE_SYNC)
 *   runSlaBreachSweep()     — every 15 min (SLA_BREACH_SWEEP)
 *   runNotifFlush()         - every 5 min (NOTIF_FLUSH: drain PENDING notifications)
 *
 * job_queue columns: job_id, type, status, priority, next_run_at,
 *   attempts, max_attempts, payload, completed_at, created_at, updated_at
 *
 * integration_log columns: log_id, integration, action, status,
 *   request_summary, response_summary, error_message, created_at
 */

var Jobs = (function () {

  // ── Trigger management ──────────────────────────────────────────────────────

  var _TRIGGERS_ = [
    { fn: 'runJobs',                 type: 'minutes', value: 5   },
    { fn: 'runDailyMaintenance',     type: 'hour',    value: 2   },
    { fn: 'runHourlyApproval',       type: 'minutes', value: 60  },
    { fn: 'runSlaBreachSweep',       type: 'minutes', value: 15  },
    // Drain PENDING notifications on a short schedule (NOT-1). The actual send
    // (claim, dispatch, mark SENT/FAILED) lives in jobNotifFlush; this just runs
    // the NOTIF_FLUSH job type frequently. No-ops cleanly when the queue is empty.
    { fn: 'runNotifFlush',           type: 'minutes', value: 5   },
    // Near-real-time Oracle approvals pull. Apps Script has no push, so a short
    // interval scheduled pull is the closest equivalent; it no-ops silently
    // unless the integration is enabled and configured (see runOracleApprovalsSync).
    { fn: 'runOracleApprovalsSync',  type: 'minutes', value: 10  },
    { fn: 'keepWarm',                type: 'minutes', value: 1   },  // anti-cold-start ping (see installKeepWarmTrigger)
    // Precompute the heavy GLOBAL aggregate blobs (dashboard + approval
    // leaderboards) so the common case reads a warm cache (Layer 7). Optional:
    // correctness comes from read-through + write invalidation; this only keeps
    // the GLOBAL blobs hot. Activated by re-running installAllTriggers().
    { fn: 'precomputeAggregates',    type: 'minutes', value: 5   },
  ];

  function installAllTriggers() {
    var existing = ScriptApp.getProjectTriggers();

    // Delete any existing triggers for our known functions.
    var managed = _TRIGGERS_.map(function (t) { return t.fn; });
    existing.forEach(function (t) {
      if (managed.indexOf(t.getHandlerFunction()) !== -1) {
        ScriptApp.deleteTrigger(t);
        Logger.log('Deleted existing trigger: ' + t.getHandlerFunction());
      }
    });

    // (Re)create each trigger.
    _TRIGGERS_.forEach(function (spec) {
      var builder = ScriptApp.newTrigger(spec.fn).timeBased();
      if (spec.type === 'minutes') {
        builder.everyMinutes(spec.value);
      } else if (spec.type === 'hour') {
        builder.atHour(spec.value).everyDays(1).inTimezone('Africa/Nairobi');
      }
      builder.create();
      Logger.log('Created trigger: ' + spec.fn);
    });
    Logger.log('installAllTriggers complete.');
  }

  // ── Core runner ─────────────────────────────────────────────────────────────

  function runJobs() {
    var rows;
    try {
      rows = TursoClient.select(
        "SELECT * FROM job_queue WHERE status = 'PENDING' AND next_run_at <= datetime('now') " +
        "ORDER BY priority ASC, next_run_at ASC LIMIT 20"
      );
    } catch (e) {
      Logger.log('runJobs: failed to query job_queue — ' + e.message);
      return;
    }

    rows.forEach(function (job) {
      var now = nowIso();
      // Mark RUNNING.
      try {
        TursoClient.write(
          "UPDATE job_queue SET status='RUNNING', updated_at=? WHERE job_id=?",
          [now, job.job_id]
        );
      } catch (_) {}

      var ok = false;
      var errMsg = null;
      try {
        _dispatch_(job);
        ok = true;
      } catch (e) {
        errMsg = e.message;
      }

      var finish = nowIso();
      if (ok) {
        try {
          TursoClient.write(
            "UPDATE job_queue SET status='DONE', completed_at=?, updated_at=? WHERE job_id=?",
            [finish, finish, job.job_id]
          );
        } catch (_) {}
      } else {
        var attempts = (parseInt(job.attempts, 10) || 0) + 1;
        var maxAttempts = parseInt(job.max_attempts, 10) || 5;
        var finalStatus = attempts >= maxAttempts ? 'FAILED' : 'PENDING';
        // Exponential backoff: next_run_at = now + attempts*2 minutes.
        var delaySeconds = attempts * 120;
        try {
          TursoClient.write(
            "UPDATE job_queue SET status=?, attempts=?, next_run_at=datetime('now','+' || ? || ' seconds'), updated_at=? WHERE job_id=?",
            [finalStatus, attempts, String(delaySeconds), finish, job.job_id]
          );
        } catch (_) {}
        Log.warn({ service: 'jobs', msg: 'Job failed', data: { job_id: job.job_id, type: job.type, attempt: attempts, error: errMsg } });
      }
    });

    // Background jobs (SLA sweep, integrations, recurring orders) can mutate data
    // without going through an audited handler. If any job ran, invalidate the
    // dashboard aggregate cache so those changes cannot be served stale (Layer 7).
    if (rows && rows.length) { try { if (typeof AggCache !== 'undefined') AggCache.bump('dash'); } catch (_) {} }
  }

  // ── Job type dispatcher ────────────────────────────────────────────────────

  function _dispatch_(job) {
    var payload = {};
    try { payload = JSON.parse(job.payload || '{}'); } catch (_) {}

    switch (job.type) {
      case 'NOTIF_FLUSH':           return _handleNotifFlush_(payload);
      case 'ORACLE_SYNC':           return _handleOracleSync_(payload);
      case 'ORACLE_APPROVALS_SYNC': return _handleOracleApprovalsSync_(payload);
      case 'MPESA_RECON':           return _handleMpesaRecon_(payload);
      case 'ETIMS_SUBMIT':          return _handleEtimsSubmit_(payload);
      case 'DOC_EXPIRY_ALERT':      return _handleDocExpiryAlert_(payload);
      case 'RECURRING_ORDER_GEN':   return _handleRecurringOrderGen_(payload);
      case 'SLA_BREACH_SWEEP':      return _handleSlaBreachSweep_(payload);
      case 'AUDIT_LOG_RETENTION':   return _handleAuditLogRetention_(payload);
      case 'SESSION_SWEEP':         return _handleSessionSweep_(payload);
      case 'MFA_CHALLENGE_SWEEP':   return _handleMfaChallengeSweep_(payload);
      default:
        throw new Error('Unknown job type: ' + job.type);
    }
  }

  // ── Job handlers ───────────────────────────────────────────────────────────

  // NOT-1: drain PENDING notifications through the channel senders. The flush is
  // idempotent (it claims each row before sending) and caps its own per-row
  // retries, so a failed batch never double-sends and never loops forever. The
  // core lives in 60_integ_notifications.gs so the emit and send paths stay
  // cleanly reusable.
  function _handleNotifFlush_(payload) {
    if (typeof jobNotifFlush !== 'function') {
      throw new Error('NOTIF_FLUSH: jobNotifFlush is not available');
    }
    return jobNotifFlush(payload || {});
  }

  function _handleOracleSync_(payload) {
    OracleInteg.sync();
  }

  function _handleOracleApprovalsSync_(payload) {
    // Runs the SAME shared loader the upload path uses, tagged INTEGRATION.
    OracleApprovalsLoader.syncFromIntegration('SYSTEM');
  }

  function _handleMpesaRecon_(payload) {
    MpesaInteg.reconcile();
  }

  function _handleEtimsSubmit_(payload) {
    if (!payload.invoice_id) throw new Error('ETIMS_SUBMIT: missing invoice_id');
    var rows = TursoClient.select('SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1', [payload.invoice_id]);
    if (!rows.length) throw new Error('ETIMS_SUBMIT: invoice not found: ' + payload.invoice_id);
    var inv = rows[0];
    EtimsInteg.submit({
      invoiceNumber: inv.invoice_number,
      invoiceDate:   (inv.issued_at || inv.created_at || '').substring(0, 10),
      totalAmount:   parseFloat(inv.total_amount || 0),
      taxAmount:     parseFloat(inv.tax_amount   || 0),
      netAmount:     parseFloat(inv.subtotal     || 0),
      currency:      inv.currency_code || 'KES',
      customerId:    inv.customer_id,
      orderId:       inv.order_id,
    });
  }

  function _handleDocExpiryAlert_(payload) {
    var horizon = payload.days_ahead || 30;
    var docs = TursoClient.select(
      "SELECT d.document_id, d.document_type, d.customer_id, d.country_code, d.expiry_date " +
      "FROM documents d WHERE d.status = 'ACTIVE' AND d.expiry_date IS NOT NULL " +
      "AND d.expiry_date <= date('now','+" + parseInt(horizon, 10) + " days') " +
      "AND d.expiry_date >= date('now') LIMIT 200"
    );
    docs.forEach(function (doc) {
      // Best-effort emit through the shared helper so the recipient resolves
      // correctly (NOT-4: CUSTOMER -> customer's contact email) and a template
      // can override the message (NOT-3). Recipient stays the customer.
      _notifyEmit_({
        recipient_id:   doc.customer_id,
        recipient_type: 'CUSTOMER',
        channel:        'EMAIL',
        event_key:      'DOCUMENT_EXPIRING',
        vars:           { document_type: doc.document_type, expiry_date: doc.expiry_date, document_id: doc.document_id },
        subject:        'Document expiring soon: ' + doc.document_type,
        body:           'Your document (' + doc.document_type + ') expires on ' + doc.expiry_date + '. Please renew.',
        entity_type:    'documents',
        entity_id:      doc.document_id,
        country_code:   doc.country_code,
      });
    });
  }

  function _handleRecurringOrderGen_(payload) {
    var schedules = TursoClient.select(
      "SELECT * FROM recurring_schedule WHERE is_active = 1 AND next_order_date <= date('now') LIMIT 100"
    );
    schedules.forEach(function (sched) {
      try {
        // Enqueue ETIMS/order creation logic — delegate to order service if present.
        var orderId = Utilities.getUuid();
        var now = nowIso();
        TursoClient.write(
          "INSERT INTO orders (order_id,customer_id,country_code,status,source,created_at,updated_at) VALUES (?,?,?,'SUBMITTED','RECURRING',?,?)",
          [orderId, sched.customer_id, sched.country_code, now, now]
        );
        Audit.log({ actor: 'SYSTEM', action: 'RECURRING_ORDER_CREATED', entity: 'orders', entityId: orderId,
                    after: { schedule_id: sched.schedule_id, customer_id: sched.customer_id } });
        // Advance next_order_date by 1 month.
        TursoClient.write(
          "UPDATE recurring_schedule SET next_order_date = date(next_order_date, '+1 month'), updated_at = ? WHERE schedule_id = ?",
          [now, sched.schedule_id]
        );
      } catch (e) {
        Log.warn({ service: 'jobs', msg: 'Recurring order gen failed', data: { schedule_id: sched.schedule_id, error: e.message } });
      }
    });
  }

  function _handleSlaBreachSweep_(payload) {
    var now = nowIso();
    // Mark tickets where sla_resolve_by has passed and not yet flagged.
    TursoClient.write(
      "UPDATE tickets SET sla_resolve_breached=1, updated_at=? " +
      "WHERE status IN ('NEW','OPEN') AND sla_resolve_by IS NOT NULL AND sla_resolve_by < ? AND sla_resolve_breached=0",
      [now, now]
    );
    // Mark orders similarly if they have an sla column.
    try {
      TursoClient.write(
        "UPDATE orders SET sla_resolve_breached=1, updated_at=? " +
        "WHERE status IN ('SUBMITTED','APPROVED') AND sla_resolve_by IS NOT NULL AND sla_resolve_by < ? AND sla_resolve_breached=0",
        [now, now]
      );
    } catch (_) {}
  }

  function _handleAuditLogRetention_(payload) {
    var retainDays = parseInt(payload.retain_days, 10) || 365;
    TursoClient.write(
      "DELETE FROM audit_log WHERE created_at < datetime('now','-" + retainDays + " days')"
    );
  }

  function _handleSessionSweep_(payload) {
    var now = nowIso();
    TursoClient.write(
      "UPDATE sessions SET is_active=0, updated_at=? WHERE is_active=1 AND expires_at < ?",
      [now, now]
    );
  }

  function _handleMfaChallengeSweep_(payload) {
    var now = nowIso();
    // Mark expired, unconsumed MFA challenges — no-op if already expired.
    TursoClient.write(
      "DELETE FROM mfa_challenges WHERE expires_at < ? AND consumed_at IS NULL",
      [now]
    );
  }

  return { runJobs: runJobs, installAllTriggers: installAllTriggers };
})();

// ── Trigger entry point functions (top-level, callable by GAS scheduler) ──────

function runJobs()              { Jobs.runJobs(); }
function runSlaBreachSweep()    { Jobs.runJobs(); }  // same runner, SLA jobs inserted separately
function runHourlyApproval()    { Jobs.runJobs(); }

/**
 * runNotifFlush - short-interval notification drain (NOT-1). Enqueues a single
 * NOTIF_FLUSH job (deduped, so the queue never piles up if a run is slow) and
 * then drains the queue now, so the flush runs through the audited job_queue path
 * with its retry/backoff. The per-notification claim and SENT/FAILED bookkeeping
 * live in jobNotifFlush (60_integ_notifications.gs). Never throws.
 */
function runNotifFlush() {
  try {
    var pending = TursoClient.select(
      "SELECT job_id FROM job_queue WHERE type = 'NOTIF_FLUSH' AND status IN ('PENDING','RUNNING') LIMIT 1"
    );
    if (!pending.length) {
      var now = nowIso();
      TursoClient.write(
        'INSERT INTO job_queue (job_id,type,status,priority,next_run_at,attempts,max_attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'NOTIF_FLUSH', 'PENDING', 5, now, 0, 3, '{}', now, now]
      );
    }
  } catch (e) {
    try { Logger.log('[runNotifFlush] enqueue failed: ' + (e && e.message ? e.message : e)); } catch (_) {}
  }
  Jobs.runJobs();
}

/**
 * runOracleApprovalsSync - short-interval pull for the Oracle PO/SO/LA timing
 * feature (the near-real-time refresh). It is a no-op unless the integration is
 * both enabled and fully configured, so leaving it installed while the Oracle
 * connector is not yet wired is harmless and silent. When the connector is not
 * connected the loader throws; that is caught and logged, never surfaced to a
 * user (the upload path is unaffected).
 */
function runOracleApprovalsSync() {
  try {
    if (typeof OracleApprovalsConnector === 'undefined') return;
    if (!OracleApprovalsConnector.isConfigured()) return;   // not enabled / not configured
    OracleApprovalsLoader.syncFromIntegration('SYSTEM');
  } catch (e) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'oracle_approvals', 'sync', 'FAILED', 'scheduled pull', '', String(e && e.message ? e.message : e).substring(0, 300), nowIso()]
      );
    } catch (_) {}
  }
}

function runDailyMaintenance() {
  // Enqueue maintenance jobs if not already pending.
  var now = nowIso();
  ['SESSION_SWEEP', 'AUDIT_LOG_RETENTION', 'MFA_CHALLENGE_SWEEP'].forEach(function (type) {
    try {
      TursoClient.write(
        "INSERT INTO job_queue (job_id,type,status,priority,next_run_at,attempts,max_attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [Utilities.getUuid(), type, 'PENDING', 10, now, 0, 3, '{}', now, now]
      );
    } catch (_) {}
  });
  Jobs.runJobs();
}

// ── precomputeAggregates: warm the heavy GLOBAL aggregate blobs (Layer 7) ─────
//
// The dashboard summary/charts/SLA and the PO/SO approval charts + leaderboard
// are precomputed for the GLOBAL scope and stored in AggCache so the common case
// reads a warm cache instead of grinding the aggregation. This is best-effort and
// purely an accelerator: the read-through cache plus write invalidation already
// guarantee correctness, so a failure here is silent and harmless. Each piece is
// isolated so one failing compute never blocks the others.
function precomputeAggregates() {
  if (typeof AggCache === 'undefined') return;
  var G = { isGlobal: true, countries: [] };

  // Dashboard GLOBAL blobs.
  try { if (typeof _dashSummaryCompute_ === 'function') AggCache.set('dash.summary', 'G', _dashSummaryCompute_(G), 600); } catch (e) {}
  try { if (typeof _dashChartsCompute_  === 'function') AggCache.set('dash.charts',  'G', _dashChartsCompute_(G),  600); } catch (e) {}
  try { if (typeof _dashSlaCompute_     === 'function') AggCache.set('dash.sla',     'G', _dashSlaCompute_(G),     600); } catch (e) {}

  // Approvals GLOBAL blobs. Charts default has no stage filter, so its signature
  // is 'G|s=' (matching _oaCharts_ with no params); the leaderboard is 'G'.
  try { if (typeof _oaChartsCompute_      === 'function') AggCache.set('oa.charts',      'G|s=', _oaChartsCompute_(G, {}),  900); } catch (e) {}
  try { if (typeof _oaLeaderboardCompute_ === 'function') AggCache.set('oa.leaderboard', 'G',    _oaLeaderboardCompute_(G), 900); } catch (e) {}
}

// ── keepWarm: anti-cold-start ping ────────────────────────────────────────────
//
// GAS spins down idle web-app instances; the first request after a quiet spell
// then pays a V8 cold-start (seconds). A frequent, trivial time trigger keeps an
// instance — and the Turso HTTP path — warm so real users land on a hot runtime.

// GAS time triggers only accept minute intervals of 1, 5, 10, 15, or 30 — there
// is no "every 2 minutes". 1 minute is used because it reliably prevents
// cold starts; raise to 5 if you'd rather spend fewer executions from your daily
// trigger-runtime quota (at a small cold-start risk).
var KEEP_WARM_MINUTES = 1;

/**
 * keepWarm — the trivial server function the time trigger pings. A single 1-row
 * read warms both the runtime and the Turso connection. Never throws.
 */
function keepWarm() {
  try {
    TursoClient.select('SELECT 1 AS ok');
  } catch (e) {
    try { Logger.log('[keepWarm] ' + (e && e.message ? e.message : e)); } catch (_) {}
  }
}

/**
 * installKeepWarmTrigger — (re)install ONLY the keepWarm trigger, leaving the
 * other managed triggers untouched.
 *
 * HOW TO INSTALL (one time):
 *   1. Open the project in the Apps Script editor.
 *   2. In the function dropdown choose  installKeepWarmTrigger  and press Run.
 *   3. Authorise the script.app scope if prompted (already in appsscript.json).
 *   4. Verify under Triggers (clock icon): a time-driven "keepWarm", every
 *      minute. Re-running this is safe — it removes any old keepWarm trigger
 *      first, so it never stacks duplicates.
 */
function installKeepWarmTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(KEEP_WARM_MINUTES).create();
  var msg = 'keepWarm trigger installed (every ' + KEEP_WARM_MINUTES + ' min).';
  Logger.log(msg);
  return msg;
}
