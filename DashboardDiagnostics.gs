// ================================================================
// HASS PETROLEUM CMS — DashboardDiagnostics.gs
//
// Standalone diagnostics for the "dashboard loads but shows zero
// data / Loading… forever" symptom. Run each function from the
// Apps Script editor and read the Execution Log (View → Logs).
//
// All output is written via Logger.log AND returned as a value so
// you can also see it in the editor's "Execution log".
// ================================================================

// ----------------------------------------------------------------
// 1. END-TO-END HEALTH CHECK
//    Runs every layer (config → connection → schema → data → API)
//    and prints a single PASS/FAIL summary. Start here.
// ----------------------------------------------------------------
function diagDashboard() {
  var out = [];
  var fail = function(msg) { out.push('FAIL  ' + msg); };
  var pass = function(msg) { out.push('PASS  ' + msg); };
  var info = function(msg) { out.push('      ' + msg); };

  out.push('=== HASS CMS DASHBOARD DIAGNOSTICS ===');
  out.push('Time: ' + new Date().toISOString());

  // 1. Script Properties
  try {
    var props = PropertiesService.getScriptProperties();
    var url   = props.getProperty('TURSO_URL');
    var token = props.getProperty('TURSO_TOKEN');
    if (!url)   fail('TURSO_URL not set in Script Properties');
    else        pass('TURSO_URL = ' + url);
    if (!token) fail('TURSO_TOKEN not set in Script Properties');
    else        pass('TURSO_TOKEN length = ' + token.length + ' chars');
  } catch (e) {
    fail('Script Properties read failed: ' + e.message);
  }

  // 2. Turso connectivity
  var tursoOk = false;
  try {
    var ping = tursoSelect('SELECT 1 AS ping');
    if (ping.length && (ping[0].ping == 1 || ping[0].ping === '1')) {
      pass('Turso reachable (SELECT 1 → ' + ping[0].ping + ')');
      tursoOk = true;
    } else {
      fail('Turso ping returned unexpected: ' + JSON.stringify(ping));
    }
  } catch (e) {
    fail('Turso ping failed: ' + e.message);
  }

  if (!tursoOk) {
    Logger.log(out.join('\n'));
    return out;
  }

  // 3. Tables present in the database
  try {
    var tables = tursoSelect(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    pass('sqlite_master returned ' + tables.length + ' tables');
    var names = tables.map(function(t){ return t.name; });
    info('tables: ' + names.join(', '));

    // Confirm every table referenced by TABLE_MAP exists
    var missing = [];
    Object.keys(TABLE_MAP).forEach(function(sheet) {
      if (names.indexOf(TABLE_MAP[sheet]) === -1) {
        missing.push(sheet + ' → ' + TABLE_MAP[sheet]);
      }
    });
    if (missing.length) {
      fail('Missing Turso tables for: ' + missing.join(', '));
      info('→ either create them in Turso, or remove from TABLE_MAP.');
    } else {
      pass('All ' + Object.keys(TABLE_MAP).length + ' TABLE_MAP entries exist in Turso');
    }
  } catch (e) {
    fail('Listing tables failed: ' + e.message);
  }

  // 4. Row counts for tables the dashboard reads
  var dashTables = ['Tickets', 'Orders', 'StaffMessages', 'Users', 'Customers', 'Contacts', 'Sessions'];
  out.push('');
  out.push('--- Row counts (dashboard tables) ---');
  dashTables.forEach(function(sheet) {
    var table = TABLE_MAP[sheet];
    if (!table) { info(sheet + ': NOT in TABLE_MAP'); return; }
    try {
      var r = tursoSelect('SELECT COUNT(*) AS cnt FROM ' + table);
      var cnt = r.length ? parseInt(r[0].cnt, 10) : 0;
      info(sheet + ' (' + table + '): ' + cnt + ' rows');
    } catch (e) {
      fail(sheet + ' (' + table + ') count failed: ' + e.message);
    }
  });

  // 5. Schema check for the staff dashboard's critical columns
  out.push('');
  out.push('--- Schema sanity (PRAGMA table_info) ---');
  var required = {
    tickets:        ['ticket_number','subject','priority','status','country_code','updated_at'],
    orders:         ['order_number','status','country_code','total_amount','created_at'],
    staff_messages: ['message_id','sender_id','room_id','content','read_by','created_at'],
    users:          ['user_id','email','role','status','password_hash','first_name','last_name'],
    sessions:       ['session_id','user_id','user_type','role','token_hash','is_active','expires_at'],
  };
  Object.keys(required).forEach(function(table) {
    try {
      var cols  = tursoSelect("PRAGMA table_info(" + table + ")");
      var have  = cols.map(function(c){ return c.name; });
      var miss  = required[table].filter(function(col){ return have.indexOf(col) === -1; });
      if (miss.length) fail(table + ': missing column(s) → ' + miss.join(', '));
      else             pass(table + ': all required columns present (' + have.length + ' total)');
    } catch (e) {
      fail(table + ': PRAGMA table_info failed → ' + e.message);
    }
  });

  // 6. Run the actual dashboard backend that the UI calls
  out.push('');
  out.push('--- handleDashboardRequest({getDashboardSummary, ALL}) ---');
  var t0 = Date.now();
  try {
    var result = handleDashboardRequest({ action: 'getDashboardSummary', affiliate: 'ALL' });
    var ms = Date.now() - t0;
    info('elapsed: ' + ms + 'ms');
    info('payload: ' + JSON.stringify(result));
    if (result && result.success) {
      pass('getDashboardSummary returned success');
      if (ms > 30000) fail('SLOW (>30s) — UI may time out before payload arrives');
    } else {
      fail('getDashboardSummary FAILED: ' + (result && result.error));
    }
  } catch (e) {
    fail('getDashboardSummary threw: ' + e.message + '\n' + e.stack);
  }

  // 7. Sessions table sanity (super-admin login depends on it)
  out.push('');
  out.push('--- Recent sessions (last 5) ---');
  try {
    var ss = tursoSelect(
      "SELECT session_id, user_id, user_type, role, is_active, expires_at, created_at " +
      "FROM sessions ORDER BY created_at DESC LIMIT 5"
    );
    if (!ss.length) info('(no sessions yet — login has never happened)');
    ss.forEach(function(s){ info(JSON.stringify(s)); });
  } catch (e) {
    fail('sessions read failed: ' + e.message);
  }

  out.push('');
  out.push('=== END ===');
  Logger.log(out.join('\n'));
  return out;
}

// ----------------------------------------------------------------
// 2. PRINT SCHEMA OF EVERY TABLE THE APP USES
//    Run if you suspect column-name drift between code and Turso.
// ----------------------------------------------------------------
function diagPrintFullSchema() {
  var out = [];
  out.push('=== TURSO SCHEMA DUMP ===');
  Object.keys(TABLE_MAP).sort().forEach(function(sheet) {
    var table = TABLE_MAP[sheet];
    out.push('');
    out.push('# ' + sheet + ' → ' + table);
    try {
      var cols = tursoSelect("PRAGMA table_info(" + table + ")");
      if (!cols.length) {
        out.push('  (table missing or empty PRAGMA result)');
        return;
      }
      cols.forEach(function(c) {
        var pk = (c.pk == 1 || c.pk === '1') ? ' PK' : '';
        var nn = (c.notnull == 1 || c.notnull === '1') ? ' NOT NULL' : '';
        var dflt = c.dflt_value ? ' DEFAULT ' + c.dflt_value : '';
        out.push('  - ' + c.name + ' ' + c.type + pk + nn + dflt);
      });
    } catch (e) {
      out.push('  ERROR: ' + e.message);
    }
  });
  Logger.log(out.join('\n'));
  return out.join('\n');
}

// ----------------------------------------------------------------
// 3. COMPARE CODE'S EXPECTED COLUMNS vs ACTUAL TURSO COLUMNS
//    Surfaces the most common cause of "data not loading":
//    a column the code reads (e.g. t.priority) doesn't exist or
//    has a different name in Turso.
// ----------------------------------------------------------------
function diagCompareSchemaToCode() {
  var expected = {
    // sheet-name : columns the code reads/writes
    Tickets:       ['ticket_id','ticket_number','customer_id','contact_id','subject','priority','status','assigned_to','country_code','created_at','updated_at'],
    Orders:        ['order_id','order_number','customer_id','status','country_code','total_amount','created_at','updated_at'],
    StaffMessages: ['message_id','sender_id','room_id','content','read_by','created_at'],
    Users:         ['user_id','email','first_name','last_name','role','status','password_hash','last_login_at'],
    Customers:     ['customer_id','account_number','company_name','trading_name','status','country_code'],
    Contacts:      ['contact_id','customer_id','email','first_name','last_name','password_hash','is_portal_user','status'],
    Sessions:      ['session_id','user_id','user_type','role','token_hash','is_active','expires_at','created_at','updated_at'],
    SignupRequests:['request_id','email','company_name','first_name','status','submitted_at'],
  };
  var out = ['=== EXPECTED vs ACTUAL ==='];
  Object.keys(expected).forEach(function(sheet) {
    var table = TABLE_MAP[sheet] || sheet.toLowerCase();
    out.push('');
    out.push('# ' + sheet + ' (' + table + ')');
    try {
      var cols  = tursoSelect("PRAGMA table_info(" + table + ")");
      var have  = cols.map(function(c){ return c.name; });
      var miss  = expected[sheet].filter(function(c){ return have.indexOf(c) === -1; });
      var extra = have.filter(function(c){ return expected[sheet].indexOf(c) === -1; });
      if (!miss.length) out.push('  OK — all expected columns present');
      else              out.push('  MISSING in Turso: ' + miss.join(', '));
      if (extra.length) out.push('  Extra columns in Turso (informational): ' + extra.join(', '));
    } catch(e) {
      out.push('  ERROR: ' + e.message);
    }
  });
  Logger.log(out.join('\n'));
  return out.join('\n');
}

// ----------------------------------------------------------------
// 4. INSPECT WHAT THE DASHBOARD UI ACTUALLY RECEIVES
//    Useful when the editor backend works but the UI shows zeros.
// ----------------------------------------------------------------
function diagSimulateDashboardCall() {
  var t0 = Date.now();
  var result = handleDashboardRequest({ action: 'getDashboardSummary', affiliate: 'ALL' });
  var ms = Date.now() - t0;
  Logger.log('elapsed: ' + ms + 'ms');
  Logger.log('payload: ' + JSON.stringify(result, null, 2));
  return result;
}

// ----------------------------------------------------------------
// 5. SEED A KNOWN ROW TO CONFIRM WRITES → READS WORK
//    Inserts and then reads back a marker into AuditLog. Cleans up
//    after itself. If this fails, your Turso write path is broken.
// ----------------------------------------------------------------
function diagWriteReadRoundTrip() {
  var marker = 'DIAG-' + Utilities.getUuid();
  try {
    tursoWrite(
      "INSERT INTO audit_log (log_id, entity_type, entity_id, action, actor_type, actor_id, " +
      "actor_email, changes, metadata, country_code, created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [marker, 'DIAG', marker, 'DIAG_PING', 'SYSTEM', 'diag', '', '{}', '{}', '', new Date().toISOString()]
    );
    var rows = tursoSelect('SELECT * FROM audit_log WHERE log_id = ?', [marker]);
    Logger.log('round-trip read returned: ' + JSON.stringify(rows));
    tursoWrite('DELETE FROM audit_log WHERE log_id = ?', [marker]);
    return rows.length === 1
      ? 'PASS — write + read + delete OK'
      : 'FAIL — wrote row but could not read it back';
  } catch(e) {
    return 'FAIL — ' + e.message;
  }
}
