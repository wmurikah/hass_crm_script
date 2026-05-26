/**
 * HASS PETROLEUM CMS - Document Expiry Alert Job (G-014)
 *
 * Daily time-driven trigger that finds APPROVED, non-archived documents
 * whose expiry_date falls within a configurable look-ahead window
 * (default 30 days from config key DOCUMENT_EXPIRY_ALERT_DAYS) and
 * notifies the responsible CS_MANAGER for each customer exactly once
 * per expiry/window cycle.
 *
 * De-duplication table: document_expiry_alert_log
 *   document_id TEXT PK, alerted_for_expiry TEXT, alerted_at TEXT
 *
 * Acceptance
 *   • A document expiring within the window triggers exactly one alert.
 *   • Subsequent daily runs are silent until expiry_date or the window
 *     changes (a renewed document gets a fresh alert).
 *   • All alerts are written to audit_log.
 *
 * Public entry points
 *   runDocumentExpiryAlerts()            — called by the daily trigger
 *   installDocumentExpiryAlertTrigger()  — one-time trigger setup
 */

// ============================================================================
// SCHEMA BOOTSTRAP
// ============================================================================

/**
 * Creates the de-duplication table if it does not yet exist.
 * Safe to call multiple times (CREATE TABLE IF NOT EXISTS).
 */
function _ensureExpiryAlertLogTable_() {
  try {
    tursoWrite(
      'CREATE TABLE IF NOT EXISTS document_expiry_alert_log (' +
      '  document_id         TEXT PRIMARY KEY,' +
      '  alerted_for_expiry  TEXT NOT NULL,' +
      '  alerted_at          TEXT NOT NULL,' +
      '  updated_at          TEXT NOT NULL' +
      ')'
    );
  } catch (e) {
    Logger.log('[DocExpiryAlert] table bootstrap error: ' + e.message);
  }
}

// ============================================================================
// MAIN JOB
// ============================================================================

/**
 * Daily entry point.  Acquires a script lock so only one invocation runs at
 * a time (guards against overlapping triggers or manual reruns).
 *
 * @returns {{success:boolean, alertsSent:number, skipped:number, errors:number}}
 */
function runDocumentExpiryAlerts() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('[DocExpiryAlert] Lock busy – skipping run');
    return { success: false, reason: 'lock_busy' };
  }
  try {
    return _execDocumentExpiryAlerts_();
  } finally {
    lock.releaseLock();
  }
}

function _execDocumentExpiryAlerts_() {
  _ensureExpiryAlertLogTable_();

  var windowDays = getConfigNumber('DOCUMENT_EXPIRY_ALERT_DAYS', 30);
  var today      = new Date();
  var cutoff     = new Date(today.getTime() + windowDays * 24 * 60 * 60 * 1000);
  var todayIso   = today.toISOString();

  // ── 1. Load existing de-dup log ──────────────────────────────────────────
  var alertLog = {};
  try {
    var logRows = tursoSelect('SELECT document_id, alerted_for_expiry FROM document_expiry_alert_log');
    logRows.forEach(function(r) { alertLog[r.document_id] = r.alerted_for_expiry; });
  } catch (e) {
    Logger.log('[DocExpiryAlert] Could not load alert log: ' + e.message);
  }

  // ── 2. Find candidate documents ──────────────────────────────────────────
  var docs = tursoSelect(
    'SELECT * FROM documents ' +
    'WHERE status = ? AND (is_archived = 0 OR is_archived = "false") ' +
    '  AND expiry_date IS NOT NULL AND expiry_date != "" ' +
    '  AND expiry_date >= ? AND expiry_date <= ?',
    ['APPROVED', todayIso, cutoff.toISOString()]
  );

  if (!docs.length) {
    Logger.log('[DocExpiryAlert] No expiring documents in window (' + windowDays + ' days)');
    return { success: true, alertsSent: 0, skipped: 0, errors: 0, windowDays: windowDays };
  }

  // ── 3. Load customer map (batch) ─────────────────────────────────────────
  var customerIds = Array.from(new Set(docs.map(function(d) { return d.customer_id; })));
  var customerMap = {};
  customerIds.forEach(function(cid) {
    try {
      var rows = tursoSelect('SELECT * FROM customers WHERE customer_id = ? LIMIT 1', [cid]);
      if (rows.length) customerMap[cid] = rows[0];
    } catch (e) {}
  });

  // ── 4. Process each document ──────────────────────────────────────────────
  var alertsSent = 0, skipped = 0, errors = 0;

  docs.forEach(function(doc) {
    try {
      var expiryStr = String(doc.expiry_date || '');

      // De-dup check: skip if we already alerted for this exact expiry value.
      if (alertLog[doc.document_id] && alertLog[doc.document_id] === expiryStr) {
        skipped++;
        return;
      }

      var customer = customerMap[doc.customer_id];
      if (!customer) {
        errors++;
        return;
      }

      // Find responsible CS_MANAGERs for this customer's country.
      var managers = _findCsManagersForCustomer_(customer);
      if (!managers.length) {
        Logger.log('[DocExpiryAlert] No CS_MANAGER found for customer ' + doc.customer_id +
          ' (country: ' + customer.country_code + ')');
        skipped++;
        return;
      }

      // Days until expiry.
      var daysLeft = Math.ceil((new Date(expiryStr) - today) / (1000 * 60 * 60 * 24));
      var docTypeName = doc.document_name || doc.document_type || 'Document';
      var companyName = customer.company_name || doc.customer_id;
      var subject = 'Document Expiring in ' + daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') +
        ': ' + companyName;
      var body    = companyName + ' has a document expiring soon.\n\n' +
        'Document : ' + docTypeName + '\n' +
        'Expiry   : ' + new Date(expiryStr).toDateString() + ' (' + daysLeft + ' day' +
        (daysLeft !== 1 ? 's' : '') + ')\n' +
        'Customer : ' + companyName + ' (' + (customer.account_number || doc.customer_id) + ')\n' +
        'Country  : ' + (customer.country_code || '') + '\n\n' +
        'Please follow up with the customer to obtain a renewed document.';

      // Notify each manager.
      managers.forEach(function(mgr) {
        try {
          createNotification({
            recipient_type:    'INTERNAL_USER',
            recipient_id:      mgr.user_id,
            notification_type: 'DOCUMENT_EXPIRY_ALERT',
            reference_type:    'Document',
            reference_id:      doc.document_id,
            title:             subject,
            message:           body,
            priority:          daysLeft <= 7 ? 'HIGH' : 'NORMAL',
            action_url:        '?page=customers&customerId=' + doc.customer_id + '&tab=documents',
            data: {
              document_name:    docTypeName,
              expiry_date:      expiryStr,
              days_until_expiry: daysLeft,
              customer_name:    companyName,
            },
          });
        } catch (ne) {
          Logger.log('[DocExpiryAlert] notify error for manager ' + mgr.user_id + ': ' + ne.message);
        }
      });

      // ── 5. Upsert the de-dup log ────────────────────────────────────────
      try {
        tursoWrite(
          'INSERT INTO document_expiry_alert_log (document_id, alerted_for_expiry, alerted_at, updated_at) ' +
          'VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(document_id) DO UPDATE SET ' +
          '  alerted_for_expiry = excluded.alerted_for_expiry,' +
          '  alerted_at         = excluded.alerted_at,' +
          '  updated_at         = excluded.updated_at',
          [doc.document_id, expiryStr, todayIso, todayIso]
        );
      } catch (de) {
        Logger.log('[DocExpiryAlert] log upsert error: ' + de.message);
      }

      // ── 6. Write audit entry ────────────────────────────────────────────
      try {
        auditLogCustom(
          'Document', doc.document_id,
          'RECURRING_SCHEDULER',
          'EXPIRY_ALERT_SENT',
          {
            days_until_expiry: daysLeft,
            expiry_date:       expiryStr,
            window_days:       windowDays,
            managers_notified: managers.map(function(m) { return m.user_id; }),
            customer_id:       doc.customer_id,
          },
          customer.country_code || ''
        );
      } catch (ae) {
        Logger.log('[DocExpiryAlert] audit error: ' + ae.message);
      }

      alertsSent++;

    } catch (docErr) {
      Logger.log('[DocExpiryAlert] Error on doc ' + doc.document_id + ': ' + docErr.message);
      errors++;
    }
  });

  Logger.log('[DocExpiryAlert] Run complete. sent=' + alertsSent +
    ' skipped=' + skipped + ' errors=' + errors + ' window=' + windowDays + 'd');

  return { success: true, alertsSent: alertsSent, skipped: skipped, errors: errors, windowDays: windowDays };
}

// ============================================================================
// HELPER: find CS_MANAGERs for a customer
// ============================================================================

/**
 * Returns all active users who hold the CS_MANAGER role and are scoped to
 * the customer's country (or have no country restriction).
 *
 * If the customer has a relationship_owner_id whose role IS CS_MANAGER, only
 * that user is returned (personalised alert).  Otherwise every active
 * CS_MANAGER in the country is included.
 *
 * @param {Object} customer  - customer row from Turso
 * @returns {Object[]}  array of user rows (may be empty)
 */
function _findCsManagersForCustomer_(customer) {
  var countryCode = String(customer.country_code || '').trim();

  // Prefer the named relationship owner if they hold CS_MANAGER.
  if (customer.relationship_owner_id) {
    try {
      var ownerRoleRows = tursoSelect(
        'SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ? LIMIT 1',
        [customer.relationship_owner_id, 'CS_MANAGER']
      );
      if (ownerRoleRows.length) {
        var ownerRows = tursoSelect(
          'SELECT user_id, email, first_name, last_name, country_code ' +
          'FROM users WHERE user_id = ? AND COALESCE(status,"ACTIVE") = "ACTIVE" LIMIT 1',
          [customer.relationship_owner_id]
        );
        if (ownerRows.length) return ownerRows;
      }
    } catch (e) {
      Logger.log('[DocExpiryAlert] owner lookup error: ' + e.message);
    }
  }

  // Fall back: all active CS_MANAGERs in the customer's country.
  try {
    var sql = 'SELECT DISTINCT u.user_id, u.email, u.first_name, u.last_name, u.country_code ' +
              'FROM users u JOIN user_roles ur ON ur.user_id = u.user_id ' +
              'WHERE ur.role_code = ? AND COALESCE(u.status,"ACTIVE") = "ACTIVE"';
    var args = ['CS_MANAGER'];
    if (countryCode) {
      sql += ' AND (u.country_code = ? OR u.country_code IS NULL OR u.country_code = "")';
      args.push(countryCode);
    }
    return tursoSelect(sql, args);
  } catch (e) {
    Logger.log('[DocExpiryAlert] CS_MANAGER lookup error: ' + e.message);
    return [];
  }
}

// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================

/**
 * Installs a daily time-driven trigger for runDocumentExpiryAlerts().
 * Safe to call multiple times – skips installation if already present.
 */
function installDocumentExpiryAlertTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runDocumentExpiryAlerts') {
      Logger.log('[DocExpiryAlert] Trigger already installed');
      return;
    }
  }
  ScriptApp.newTrigger('runDocumentExpiryAlerts')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('[DocExpiryAlert] Daily trigger installed (06:00)');
}

/**
 * Removes the trigger (e.g. for maintenance).
 */
function uninstallDocumentExpiryAlertTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runDocumentExpiryAlerts') {
      ScriptApp.deleteTrigger(t);
      Logger.log('[DocExpiryAlert] Trigger removed');
    }
  });
}
