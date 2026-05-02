/**
 * HASS PETROLEUM CMS — DebugDB.gs
 *
 * Run from the GAS editor to diagnose why Orders / Dashboard / SLA / Tickets
 * pages are not loading. Inspects the Turso database directly using the
 * existing tursoSelect() helper from TursoService.gs.
 *
 * USAGE
 *   1. Open Apps Script editor.
 *   2. Select the function `debugDB` from the dropdown.
 *   3. Click Run. View output under "Execution log".
 *
 * The function returns the full report object as well, so you can also
 * call it from another script and JSON.stringify it.
 */

function debugDB() {
  var report = {
    timestamp: new Date().toISOString(),
    connection: null,
    counts: {},
    schemas: {},
    samples: {},
    distributions: {},
    dashboardChecks: {},
    slaChecks: {},
    issues: []
  };

  // ----- 1. Connection -------------------------------------------------------
  try {
    var ping = tursoSelect('SELECT 1 AS ping');
    report.connection = (ping.length && (ping[0].ping == 1 || ping[0].ping === '1'))
      ? 'OK'
      : 'UNEXPECTED: ' + JSON.stringify(ping);
  } catch (e) {
    report.connection = 'FAIL: ' + e.message;
    report.issues.push('Cannot reach Turso. Check TURSO_URL / TURSO_TOKEN in Script Properties.');
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  }

  // ----- 2. Tables we care about for the failing pages -----------------------
  var tables = [
    'orders',          // Orders page + Dashboard
    'order_lines',
    'order_status_history',
    'tickets',         // Tickets page + Dashboard
    'ticket_comments',
    'ticket_history',
    'sla_config',      // SLA page
    'sla_data',
    'business_hours',
    'holidays',
    'customers',       // Joined into orders/tickets
    'users',
    'staff_messages',  // Dashboard unread count
    'notifications'
  ];

  // ----- 3. List of all tables actually present ------------------------------
  var existingTables = {};
  try {
    var tlist = tursoSelect("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    tlist.forEach(function(r) { existingTables[r.name] = true; });
    report.allTables = tlist.map(function(r) { return r.name; });
  } catch (e) {
    report.issues.push('Could not list tables: ' + e.message);
  }

  // ----- 4. For each target table: count, schema, sample, distributions ------
  tables.forEach(function(tbl) {
    if (!existingTables[tbl]) {
      report.counts[tbl] = 'TABLE MISSING';
      report.issues.push('Table missing: ' + tbl);
      return;
    }

    // count
    try {
      var c = tursoSelect('SELECT COUNT(*) AS n FROM ' + tbl);
      var n = c.length ? parseInt(c[0].n, 10) : 0;
      report.counts[tbl] = n;
      if (n === 0) report.issues.push('Empty table: ' + tbl);
    } catch (e) {
      report.counts[tbl] = 'COUNT ERROR: ' + e.message;
      report.issues.push('COUNT failed for ' + tbl + ': ' + e.message);
    }

    // schema
    try {
      var cols = tursoSelect("PRAGMA table_info('" + tbl + "')");
      report.schemas[tbl] = cols.map(function(c) {
        return c.name + ' ' + c.type + (c.notnull == 1 ? ' NOT NULL' : '') + (c.pk == 1 ? ' PK' : '');
      });
    } catch (e) {
      report.schemas[tbl] = 'SCHEMA ERROR: ' + e.message;
    }

    // sample (3 rows)
    try {
      report.samples[tbl] = tursoSelect('SELECT * FROM ' + tbl + ' LIMIT 3');
    } catch (e) {
      report.samples[tbl] = 'SAMPLE ERROR: ' + e.message;
    }
  });

  // ----- 5. Status / priority distributions ----------------------------------
  report.distributions = {};

  if (existingTables['orders']) {
    try {
      report.distributions.orders_by_status = tursoSelect(
        'SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC'
      );
      report.distributions.orders_by_country = tursoSelect(
        'SELECT country_code, COUNT(*) AS n FROM orders GROUP BY country_code ORDER BY n DESC'
      );
      report.distributions.orders_null_status = tursoSelect(
        "SELECT COUNT(*) AS n FROM orders WHERE status IS NULL OR status = ''"
      );
    } catch (e) { report.issues.push('orders distribution: ' + e.message); }
  }

  if (existingTables['tickets']) {
    try {
      report.distributions.tickets_by_status = tursoSelect(
        'SELECT status, COUNT(*) AS n FROM tickets GROUP BY status ORDER BY n DESC'
      );
      report.distributions.tickets_by_priority = tursoSelect(
        'SELECT priority, COUNT(*) AS n FROM tickets GROUP BY priority ORDER BY n DESC'
      );
      report.distributions.tickets_by_country = tursoSelect(
        'SELECT country_code, COUNT(*) AS n FROM tickets GROUP BY country_code ORDER BY n DESC'
      );
      report.distributions.tickets_null_status = tursoSelect(
        "SELECT COUNT(*) AS n FROM tickets WHERE status IS NULL OR status = ''"
      );
    } catch (e) { report.issues.push('tickets distribution: ' + e.message); }
  }

  // ----- 6. Reproduce dashboard queries --------------------------------------
  try {
    if (existingTables['tickets']) {
      report.dashboardChecks.openTickets = tursoSelect(
        "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('NEW','OPEN','IN_PROGRESS','ESCALATED')"
      );
    }
    if (existingTables['orders']) {
      report.dashboardChecks.pendingOrders = tursoSelect(
        "SELECT COUNT(*) AS n FROM orders WHERE status IN ('SUBMITTED','PENDING_APPROVAL','APPROVED')"
      );
      report.dashboardChecks.inTransitOrders = tursoSelect(
        "SELECT COUNT(*) AS n FROM orders WHERE status = 'IN_TRANSIT'"
      );
      report.dashboardChecks.recentOrders = tursoSelect(
        'SELECT order_number, status, country_code, total_amount, created_at ' +
        'FROM orders ORDER BY created_at DESC LIMIT 5'
      );
    }
    if (existingTables['staff_messages']) {
      report.dashboardChecks.unreadStaffMessages = tursoSelect(
        "SELECT COUNT(*) AS n FROM staff_messages WHERE read_by IS NULL OR read_by NOT LIKE '%ALL%'"
      );
    }
  } catch (e) {
    report.issues.push('dashboard checks: ' + e.message);
  }

  // ----- 7. SLA-specific checks ---------------------------------------------
  try {
    if (existingTables['sla_config']) {
      report.slaChecks.activeSlaConfigs = tursoSelect(
        "SELECT COUNT(*) AS n FROM sla_config WHERE is_active = 1 OR is_active = '1' OR is_active IS NULL"
      );
      report.slaChecks.slaConfigSample = tursoSelect(
        'SELECT * FROM sla_config LIMIT 5'
      );
    }
    if (existingTables['sla_data']) {
      report.slaChecks.slaDataRecent = tursoSelect(
        'SELECT * FROM sla_data ORDER BY created_at DESC LIMIT 5'
      );
      report.slaChecks.slaBreaches = tursoSelect(
        "SELECT COUNT(*) AS n FROM sla_data WHERE breached = 1 OR breached = '1'"
      );
    }
    if (existingTables['business_hours']) {
      report.slaChecks.businessHoursRows = tursoSelect(
        'SELECT * FROM business_hours LIMIT 10'
      );
    }
  } catch (e) {
    report.issues.push('SLA checks: ' + e.message);
  }

  // ----- 8. Script Properties sanity (non-secret keys only) ------------------
  try {
    var props = PropertiesService.getScriptProperties().getProperties();
    report.scriptProperties = {
      TURSO_URL_set:   !!props.TURSO_URL,
      TURSO_TOKEN_set: !!props.TURSO_TOKEN,
      keys: Object.keys(props)
    };
  } catch (e) {
    report.issues.push('script properties: ' + e.message);
  }

  // ----- 9. Pretty print -----------------------------------------------------
  Logger.log('================ DEBUG DB REPORT ================');
  Logger.log('Connection:  ' + report.connection);
  Logger.log('Tables in DB: ' + (report.allTables ? report.allTables.length : '?'));
  Logger.log('---- Row counts ----');
  Object.keys(report.counts).forEach(function(t) {
    Logger.log('  ' + t + ': ' + report.counts[t]);
  });
  Logger.log('---- Status distributions ----');
  Logger.log(JSON.stringify(report.distributions, null, 2));
  Logger.log('---- Dashboard checks ----');
  Logger.log(JSON.stringify(report.dashboardChecks, null, 2));
  Logger.log('---- SLA checks ----');
  Logger.log(JSON.stringify(report.slaChecks, null, 2));
  Logger.log('---- Schemas ----');
  Object.keys(report.schemas).forEach(function(t) {
    Logger.log(t + ':');
    var s = report.schemas[t];
    if (Array.isArray(s)) s.forEach(function(c) { Logger.log('    ' + c); });
    else Logger.log('    ' + s);
  });
  Logger.log('---- Samples (3 rows each) ----');
  Object.keys(report.samples).forEach(function(t) {
    Logger.log(t + ': ' + JSON.stringify(report.samples[t]));
  });
  Logger.log('---- Issues found ----');
  if (report.issues.length === 0) Logger.log('  none');
  else report.issues.forEach(function(i) { Logger.log('  - ' + i); });
  Logger.log('=================================================');

  return report;
}

/**
 * Run an ad-hoc SELECT from the GAS editor.
 * Edit the SQL string inside, then Run.
 */
function debugQuery() {
  var sql = "SELECT order_id, order_number, status, country_code, customer_id, created_at " +
            "FROM orders ORDER BY created_at DESC LIMIT 20";
  var rows = tursoSelect(sql);
  Logger.log('Rows: ' + rows.length);
  Logger.log(JSON.stringify(rows, null, 2));
  return rows;
}
