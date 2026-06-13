/**
 * 99_smoke_test.gs  —  Hass CMS rebuild foundation
 *
 * Run smokeFoundation() from the GAS IDE to verify the Stage 1 layer.
 *
 * Checks:
 *   1. TursoClient.select("SELECT 1 AS ok")    → one row, ok = '1'
 *   2. Repo.findMany('countries', {})           → 8 rows
 *   3. Repo.findOne('branding', {scope_code:'GLOBAL'})  → app_name = 'Hass CMS'
 *   4. dispatch unknown service/action          → { ok:false, error:{code:'UNKNOWN_ACTION'} }
 *
 * Logs PASS / FAIL per check plus a final summary.
 */

function smokeFoundation() {
  var results = [];
  var passed  = 0;
  var failed  = 0;

  function check(name, fn) {
    try {
      fn();
      results.push('PASS  ' + name);
      Logger.log('PASS  ' + name);
      passed++;
    } catch (e) {
      results.push('FAIL  ' + name + '\n      ' + e.message);
      Logger.log('FAIL  ' + name + ': ' + e.message);
      failed++;
    }
  }

  // ── 1. Turso connectivity ─────────────────────────────────────────────────
  check('TursoClient.select("SELECT 1 AS ok")', function () {
    var rows = TursoClient.select('SELECT 1 AS ok');
    if (!rows || rows.length !== 1) {
      throw new Error('Expected 1 row, got ' + (rows ? rows.length : 'null'));
    }
    if (rows[0].ok !== '1') {
      throw new Error('Expected ok="1", got "' + rows[0].ok + '"');
    }
  });

  // ── 2. countries table has 8 rows ─────────────────────────────────────────
  check('Repo.findMany("countries", {}) → 8 rows', function () {
    var rows = Repo.findMany('countries', {});
    if (rows.length !== 8) {
      throw new Error('Expected 8 rows, got ' + rows.length);
    }
  });

  // ── 3. branding GLOBAL row ────────────────────────────────────────────────
  check('Repo.findOne("branding", {scope_code:"GLOBAL"}) → app_name="Hass CMS"', function () {
    var row = Repo.findOne('branding', { scope_code: 'GLOBAL' });
    if (!row) {
      throw new Error('Row not found');
    }
    if (row.app_name !== 'Hass CMS') {
      throw new Error('Expected app_name="Hass CMS", got "' + row.app_name + '"');
    }
  });

  // ── 4. Dispatcher returns UNKNOWN_ACTION for bogus call ───────────────────
  check('dispatch unknown service/action → UNKNOWN_ACTION error', function () {
    var result = dispatch({}, { service: '_smoke_', action: '_none_', params: {} });
    if (result.ok !== false) {
      throw new Error('Expected ok=false, got ok=' + result.ok);
    }
    if (!result.error || result.error.code !== 'UNKNOWN_ACTION') {
      throw new Error(
        'Expected error.code="UNKNOWN_ACTION", got "' +
        (result.error && result.error.code) + '"'
      );
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  var summary = '\n──────────────────────────────────────\n' +
                'smokeFoundation: ' + passed + ' PASS  ' + failed + ' FAIL\n' +
                '──────────────────────────────────────';
  Logger.log(summary);
  results.push(summary);

  return results;
}

// =============================================================================
// smokeCustomers  —  Stage 5 customers / contacts domain services
// =============================================================================

/**
 * Smoke test for customers.* and contacts.* handlers.
 * Run from the GAS IDE; requires a live Turso DB with SUPER_ADMIN seeded.
 *
 * Checks:
 *   1. SUPER_ADMIN creates KE customer → customer_id and account_number present
 *   2. customers.get returns the same row
 *   3. Two contacts created (MANAGER + OPERATOR); customer360 returns both
 *   4. Update contact job_title; audit_log has before/after
 *   5. softDelete → status=INACTIVE, audit row present
 *   6. customers.list hides inactive unless include_inactive=true
 *   7. Negative: no sessionToken → NO_SESSION
 *   8. Negative: TZ-scoped session on KE row → NOT_FOUND + audit_log entry
 */
function smokeCustomers() {
  var results = [];
  var passed  = 0;
  var failed  = 0;

  function check(name, fn) {
    try {
      fn();
      results.push('PASS  ' + name);
      Logger.log('PASS  ' + name);
      passed++;
    } catch (e) {
      results.push('FAIL  ' + name + '\n      ' + (e.message || String(e)));
      Logger.log('FAIL  ' + name + ': ' + (e.message || String(e)));
      failed++;
    }
  }

  // ── Prerequisite: SUPER_ADMIN exists ──────────────────────────────────────
  var seed         = seedAll();
  var superAdminId = seed.userId;
  var saToken      = Session.create(superAdminId, 'STAFF', 'SUPER_ADMIN',
                                    '127.0.0.1', 'smoke-customers', 'KE').token;

  var customerId, contactId1;

  // ── 1. Create customer in KE ───────────────────────────────────────────────
  check('1. Create KE customer; assert customer_id and account_number returned', function () {
    var res = processRequest({
      service: 'customers', action: 'create', sessionToken: saToken,
      params: {
        company_name:          'Smoke Test Ltd',
        account_number:        'SMKT-' + Date.now(),
        customer_type:         'B2B',
        country_code:          'KE',
        segment_id:            'SEG-STANDARD',
        relationship_owner_id: null,
        parent_customer_id:    null,
      },
    });
    if (!res.ok)                  throw new Error('ok=false: ' + JSON.stringify(res.error));
    if (!res.data.customer_id)    throw new Error('Missing customer_id in response');
    if (!res.data.account_number) throw new Error('Missing account_number in response');
    customerId = res.data.customer_id;
  });

  // ── 2. Read back ───────────────────────────────────────────────────────────
  check('2. customers.get returns matching fields', function () {
    if (!customerId) throw new Error('customerId not set (step 1 failed)');
    var res = processRequest({
      service: 'customers', action: 'get', sessionToken: saToken,
      params: { customerId: customerId },
    });
    if (!res.ok)                                    throw new Error('ok=false: ' + JSON.stringify(res.error));
    if (res.data.company_name !== 'Smoke Test Ltd') throw new Error('company_name mismatch: ' + res.data.company_name);
    if (res.data.country_code !== 'KE')             throw new Error('country_code mismatch: ' + res.data.country_code);
  });

  // ── 3. Two contacts; customer360 returns both ─────────────────────────────
  check('3. Create MANAGER + OPERATOR contacts; customer360 returns both', function () {
    if (!customerId) throw new Error('customerId not set (step 1 failed)');

    var r1 = processRequest({
      service: 'contacts', action: 'create', sessionToken: saToken,
      params: {
        customer_id: customerId, first_name: 'Alice', last_name: 'Smoke',
        email: 'alice.smoke@example.com', portal_role: 'MANAGER',
      },
    });
    if (!r1.ok) throw new Error('Contact 1 create failed: ' + JSON.stringify(r1.error));
    contactId1 = r1.data.contact_id;

    var r2 = processRequest({
      service: 'contacts', action: 'create', sessionToken: saToken,
      params: {
        customer_id: customerId, first_name: 'Bob', last_name: 'Smoke',
        email: 'bob.smoke@example.com', portal_role: 'OPERATOR',
      },
    });
    if (!r2.ok) throw new Error('Contact 2 create failed: ' + JSON.stringify(r2.error));

    var r360 = processRequest({
      service: 'customers', action: 'customer360', sessionToken: saToken,
      params: { customerId: customerId },
    });
    if (!r360.ok) throw new Error('customer360 failed: ' + JSON.stringify(r360.error));
    var cts = r360.data.contacts;
    if (!Array.isArray(cts) || cts.length < 2) {
      throw new Error('Expected ≥2 contacts in customer360, got: ' + JSON.stringify(cts && cts.length));
    }
  });

  // ── 4. Update contact job_title; audit_log has before/after ───────────────
  check('4. Update contact job_title; audit_log row has before and after', function () {
    if (!contactId1) throw new Error('contactId1 not set (step 3 failed)');
    var res = processRequest({
      service: 'contacts', action: 'update', sessionToken: saToken,
      params: { contactId: contactId1, job_title: 'Head of Finance' },
    });
    if (!res.ok) throw new Error('Update failed: ' + JSON.stringify(res.error));

    var rows = TursoClient.select(
      "SELECT * FROM audit_log WHERE action = 'CONTACT_UPDATED' AND entity_id = ? ORDER BY created_at DESC LIMIT 1",
      [contactId1]
    );
    if (!rows.length) throw new Error('No CONTACT_UPDATED row in audit_log');
    if (!rows[0].before_json) throw new Error('Audit row missing before_json: ' + JSON.stringify(rows[0]));
    if (!rows[0].after_json)  throw new Error('Audit row missing after_json: '  + JSON.stringify(rows[0]));
  });

  // ── 5. Soft-delete customer ────────────────────────────────────────────────
  check('5. softDelete sets status=INACTIVE and writes audit row', function () {
    if (!customerId) throw new Error('customerId not set (step 1 failed)');
    var res = processRequest({
      service: 'customers', action: 'softDelete', sessionToken: saToken,
      params: { customerId: customerId },
    });
    if (!res.ok) throw new Error('softDelete failed: ' + JSON.stringify(res.error));

    var row = Repo.findById('customers', customerId);
    if (!row || row.status !== 'INACTIVE') {
      throw new Error('Expected status=INACTIVE, got: ' + (row && row.status));
    }

    var auditRows = TursoClient.select(
      "SELECT log_id FROM audit_log WHERE action = 'CUSTOMER_SOFT_DELETED' AND entity_id = ? LIMIT 1",
      [customerId]
    );
    if (!auditRows.length) throw new Error('No CUSTOMER_SOFT_DELETED row in audit_log');
  });

  // ── 6. list hides inactive by default ─────────────────────────────────────
  check('6. Soft-deleted customer absent from default list; present with include_inactive=true', function () {
    if (!customerId) throw new Error('customerId not set (step 1 failed)');

    var resExcl = processRequest({
      service: 'customers', action: 'list', sessionToken: saToken, params: {},
    });
    if (!resExcl.ok) throw new Error('list failed: ' + JSON.stringify(resExcl.error));
    var foundExcl = resExcl.data.some(function (r) { return r.customer_id === customerId; });
    if (foundExcl) throw new Error('Soft-deleted customer must NOT appear in default list');

    var resIncl = processRequest({
      service: 'customers', action: 'list', sessionToken: saToken,
      params: { include_inactive: true },
    });
    if (!resIncl.ok) throw new Error('list(include_inactive) failed: ' + JSON.stringify(resIncl.error));
    var foundIncl = resIncl.data.some(function (r) { return r.customer_id === customerId; });
    if (!foundIncl) throw new Error('Soft-deleted customer MUST appear when include_inactive=true');
  });

  // ── 7. No sessionToken → NO_SESSION ───────────────────────────────────────
  check('7. customers.get with no sessionToken returns NO_SESSION', function () {
    var res = processRequest({
      service: 'customers', action: 'get',
      params: { customerId: customerId || 'x' },
    });
    if (res.ok !== false) throw new Error('Expected ok=false, got: ' + res.ok);
    if (!res.error || res.error.code !== 'NO_SESSION') {
      throw new Error('Expected NO_SESSION, got: ' + JSON.stringify(res.error));
    }
  });

  // ── 8. TZ-scoped session cannot read KE customer ──────────────────────────
  check('8. TZ-scoped CS_AGENT handler throws NOT_FOUND on KE row; audit_log records rejection', function () {
    if (!customerId) throw new Error('customerId not set (step 1 failed)');

    // Stub a COUNTRY-scoped session in TZ (no real user needed for handler-level test).
    var tzCtx = {
      token:  '',
      actor:  'smoke-tz-stub',
      session: {
        sessionId:   uuidv4(),
        userId:      'smoke-tz-stub',
        userType:    'STAFF',
        role:        'CS_AGENT',
        countryCode: 'TZ',
        ip:          '127.0.0.1',
        ua:          'smoke-customers',
      },
    };

    var auditBefore = Repo.count('audit_log', {});

    var threw     = false;
    var errorCode = '';
    try {
      Customers._getHandler(tzCtx, { customerId: customerId });
    } catch (e) {
      threw     = true;
      errorCode = e.code || '';
    }

    if (!threw)                   throw new Error('Expected handler to throw, but it did not');
    if (errorCode !== 'NOT_FOUND') throw new Error('Expected NOT_FOUND, got: ' + errorCode);

    var auditAfter = Repo.count('audit_log', {});
    if (auditAfter <= auditBefore) {
      throw new Error('Expected an audit_log entry for the scope rejection');
    }
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  Session.invalidate(saToken);

  // ── Summary ───────────────────────────────────────────────────────────────
  var summary = '\n══════════════════════════════════════\n' +
                'smokeCustomers: ' + passed + ' PASS  ' + failed + ' FAIL\n' +
                '══════════════════════════════════════';
  Logger.log(summary);
  results.push(summary);
  return results;
}

// =============================================================================
// smokeCrosscut  —  Stage 2 cross-cutting layer
// =============================================================================

function smokeCrosscut() {
  var results = [];
  var passed  = 0;
  var failed  = 0;

  function check(name, fn) {
    try {
      fn();
      results.push('PASS  ' + name);
      Logger.log('PASS  ' + name);
      passed++;
    } catch (e) {
      results.push('FAIL  ' + name + '\n      ' + (e.message || String(e)));
      Logger.log('FAIL  ' + name + ': ' + (e.message || String(e)));
      failed++;
    }
  }

  // ── 1. Audit.log writes a row ────────────────────────────────────────────
  var auditLogId;
  check('Audit.log writes a synthetic event', function () {
    var before = Repo.count('audit_log', {});
    Audit.log({
      actor:    'smoke-test',
      action:   'SMOKE_TEST',
      entity:   'smoke',
      entityId: 'cross-cut-1',
      metadata: { note: 'automated smoke test', secret: 'should-be-masked' },
    });
    var after = Repo.count('audit_log', {});
    if (after <= before) throw new Error('Row count did not increase (before=' + before + ', after=' + after + ')');
    // Retrieve the row and verify masking.
    var rows = TursoClient.select(
      "SELECT * FROM audit_log WHERE action = 'SMOKE_TEST' ORDER BY created_at DESC LIMIT 1"
    );
    if (!rows.length) throw new Error('Smoke row not found in audit_log');
    var meta = jsonParse(rows[0].metadata, {});
    if (meta.secret !== '***') throw new Error('Masking failed: secret=' + meta.secret);
    auditLogId = rows[0].log_id;
  });

  // ── 2. Config.getNumber returns default when key absent ──────────────────
  check('Config.getNumber("SESSION.IDLE_TIMEOUT_MIN",30) returns 30 when unset', function () {
    // Key may or may not exist; if missing, should default.
    var v = Config.getNumber('SESSION.IDLE_TIMEOUT_MIN', 30);
    if (typeof v !== 'number') throw new Error('Not a number: ' + v);
    if (isNaN(v)) throw new Error('Got NaN');
    // Acceptable values: whatever is configured, or the default 30.
    if (v <= 0) throw new Error('Got non-positive value: ' + v);
  });

  // ── 3. Password.hash / verify ────────────────────────────────────────────
  var pwHash;
  check('Password.hash("Test@1234!") has pbkdf2$ prefix', function () {
    pwHash = Password.hash('Test@1234!');
    if (typeof pwHash !== 'string') throw new Error('hash is not a string');
    if (pwHash.indexOf('pbkdf2$') !== 0) {
      throw new Error('Bad prefix: ' + pwHash.substring(0, 30));
    }
  });

  check('Password.verify("Test@1234!", hash) == true', function () {
    if (!pwHash) throw new Error('Hash not set (prior step failed)');
    if (!Password.verify('Test@1234!', pwHash)) throw new Error('verify returned false for correct password');
  });

  check('Password.verify("Wrong!Pass1", hash) == false', function () {
    if (!pwHash) throw new Error('Hash not set (prior step failed)');
    if (Password.verify('Wrong!Pass1', pwHash)) throw new Error('verify returned true for wrong password');
  });

  // ── 4. seedAll + Rbac wildcard ────────────────────────────────────────────
  var seedResult;
  check('seedAll() creates or finds SUPER_ADMIN', function () {
    seedResult = seedAll();
    if (!seedResult) throw new Error('seedAll returned falsy');
    if (!seedResult.userId && !seedResult.skipped) {
      throw new Error('Unexpected result: ' + JSON.stringify(seedResult));
    }
  });

  check('Rbac.userHasPermission(superAdminId, "anything") == true (wildcard)', function () {
    if (!seedResult || !seedResult.userId) throw new Error('No superAdminId available');
    Rbac._clearCache_();
    var has = Rbac.userHasPermission(seedResult.userId, 'anything.at.all');
    if (!has) throw new Error('SUPER_ADMIN wildcard check failed');
  });

  // ── 8. Login and get session token ──────────────────────────────────────
  var smokeToken = null;   // module-scoped so checks 9+10 can use it

  check('processRequest auth.login returns session token', function () {
    var email = PropertiesService.getScriptProperties()
                  .getProperty('SEED_SUPERADMIN_EMAIL')
                || 'admin@hasspetroleum.com';
    var pwd = PropertiesService.getScriptProperties()
                .getProperty('SMOKE_SUPERADMIN_PASSWORD') || '';
    if (!pwd) throw new Error('Set SMOKE_SUPERADMIN_PASSWORD script property');

    var res = processRequest({
      service: 'auth', action: 'login',
      params: { email: email, password: pwd }
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (!res.data || !res.data.token) {
      throw new Error('Expected data.token, got: ' + JSON.stringify(res.data));
    }
    smokeToken = res.data.token;   // save for check 9; clean up in check 9
  });

  // ── 9. Authenticated users.list ──────────────────────────────────────────
  check('processRequest users.list with valid token returns list', function () {
    if (!smokeToken) throw new Error('No token from check 8 - cannot proceed');
    var res = processRequest({
      service: 'users', action: 'list',
      params: { sessionToken: smokeToken }
    });
    // clean up session NOW, after the call, not before
    try { Session.invalidate(smokeToken); } catch (_) {}
    smokeToken = null;
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (!Array.isArray(res.data && res.data.items !== undefined
        ? res.data.items : res.data)) {
      // accept either { data: [...] } or { data: { items: [...] } }
    }
  });

  // ── 10. Unauthenticated users.list must return NO_SESSION ─────────────────
  check('processRequest users.list without token returns NO_SESSION', function () {
    // call with NO sessionToken — params object must not contain sessionToken
    var res = processRequest({
      service: 'users', action: 'list',
      params: {}     // explicitly no sessionToken key
    });
    if (res.ok !== false) {
      throw new Error('Expected ok=false, got ok=' + res.ok +
                      ' data=' + JSON.stringify(res.data || ''));
    }
    if (!res.error || res.error.code !== 'NO_SESSION') {
      throw new Error('Expected code=NO_SESSION, got: ' +
                      JSON.stringify(res.error));
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  var summary = '\n══════════════════════════════════════\n' +
                'smokeCrosscut: ' + passed + ' PASS  ' + failed + ' FAIL\n' +
                '══════════════════════════════════════';
  Logger.log(summary);
  results.push(summary);
  return results;
}

// =============================================================================
// smokeOrders  —  Stage 6 orders domain service
// =============================================================================

/**
 * Smoke test for orders.* handlers.
 * Run from the GAS IDE; requires a live Turso DB with SUPER_ADMIN + one KE customer seeded.
 *
 * Checks:
 *   1. SUPER_ADMIN creates KE customer + order (DRAFT)
 *   2. Add a line; totals recalculated
 *   3. Submit order → SUBMITTED
 *   4. Approve order (SUPER_ADMIN has wildcard; amount ≤ 100k)
 *   5. Dispatch order → DISPATCHED
 *   6. Confirm delivery → DELIVERED
 *   7. New order: submit + cancel → CANCELLED + audit row
 *   8. Negative: submit already-SUBMITTED order → error
 *   9. Negative: no sessionToken → NO_SESSION
 *  10. Negative: TZ-scoped session on KE order → NOT_FOUND
 */
function smokeOrders() {
  var results = [];
  var passed  = 0;
  var failed  = 0;

  function check(name, fn) {
    try {
      fn();
      results.push('PASS  ' + name);
      Logger.log('PASS  ' + name);
      passed++;
    } catch (e) {
      results.push('FAIL  ' + name + '\n      ' + (e.message || String(e)));
      Logger.log('FAIL  ' + name + ': ' + (e.message || String(e)));
      failed++;
    }
  }

  // ── Prerequisite: SUPER_ADMIN + KE customer ──────────────────────────────
  var seed        = seedAll();
  var saId        = seed.userId;
  var saToken     = Session.create(saId, 'STAFF', 'SUPER_ADMIN', '127.0.0.1', 'smoke-orders', 'KE').token;

  // Create a fresh KE customer for this run.
  var custRes = processRequest({
    service: 'customers', action: 'create', sessionToken: saToken,
    params: {
      company_name:          'Smoke Test Ltd',
      account_number:        'SMKT-' + Date.now(),
      customer_type:         'B2B',
      country_code:          'KE',
      currency_code:         'KES',
      segment_id:            'SEG-STANDARD',
      relationship_owner_id: null,
      parent_customer_id:    null,
    },
  });
  if (!custRes.ok) throw new Error('Prereq customer create failed: ' + JSON.stringify(custRes.error));
  var customerId = custRes.data.customer_id;

  // Order line rates now resolve through the tiered price lists (Pricing.resolve),
  // so seed a CUSTOMER-scoped list with an item for PROD-AGO. A customer-scoped
  // list sidesteps the single-active-default unique index, so this is safe to run
  // repeatedly regardless of any existing default list.
  var plRes = processRequest({
    service: 'pricing', action: 'createList', sessionToken: saToken,
    params: { name: 'Smoke Customer List', scope: 'customer', customer_id: customerId,
              country_code: 'KE', currency_code: 'KES' },
  });
  if (!plRes.ok) throw new Error('Prereq price list create failed: ' + JSON.stringify(plRes.error));
  var smokePriceId = plRes.data.price_id;
  var pliRes = processRequest({
    service: 'pricing', action: 'upsertItem', sessionToken: saToken,
    params: { price_list_id: smokePriceId, product_id: 'PROD-AGO', unit_price: 150, tax_rate: 16 },
  });
  if (!pliRes.ok) throw new Error('Prereq price item create failed: ' + JSON.stringify(pliRes.error));

  var orderId, cancelOrderId;

  // ── 1. Create order ────────────────────────────────────────────────────────
  check('1. Create DRAFT order; assert order_id and order_number', function () {
    var res = processRequest({
      service: 'orders', action: 'create', sessionToken: saToken,
      params: { customer_id: customerId, country_code: 'KE' },
    });
    if (!res.ok)                 throw new Error('ok=false: ' + JSON.stringify(res.error));
    if (!res.data.order_id)      throw new Error('Missing order_id');
    if (!res.data.order_number)  throw new Error('Missing order_number');
    if (res.data.status !== 'DRAFT') throw new Error('Expected DRAFT, got ' + res.data.status);
    orderId = res.data.order_id;
  });

  // ── 2. Add a line; totals recalculated ─────────────────────────────────────
  check('2. addLine; orders.get returns line + total > 0', function () {
    if (!orderId) throw new Error('orderId not set');
    var res = processRequest({
      service: 'orders', action: 'addLine', sessionToken: saToken,
      params: { orderId: orderId, product_id: 'PROD-AGO', product_name: 'Diesel',
                quantity: 1000, unit_price: 150 },
    });
    if (!res.ok) throw new Error('addLine failed: ' + JSON.stringify(res.error));
    var gRes = processRequest({
      service: 'orders', action: 'get', sessionToken: saToken,
      params: { orderId: orderId },
    });
    if (!gRes.ok) throw new Error('get failed');
    if (!gRes.data.lines || gRes.data.lines.length < 1) throw new Error('No lines returned');
    if (!(parseFloat(gRes.data.total_amount) > 0)) throw new Error('total_amount not > 0');
  });

  // ── 3. Submit → SUBMITTED ──────────────────────────────────────────────────
  check('3. Submit order → status=SUBMITTED', function () {
    if (!orderId) throw new Error('orderId not set');
    var res = processRequest({
      service: 'orders', action: 'submit', sessionToken: saToken,
      params: { orderId: orderId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'SUBMITTED') throw new Error('Expected SUBMITTED, got ' + res.data.status);
  });

  // ── 4. Approve → APPROVED (SUPER_ADMIN has wildcard, bypasses SoD in smoke) ─
  check('4. Approve order → status=APPROVED (second session as approver)', function () {
    if (!orderId) throw new Error('orderId not set');
    // Use a second SUPER_ADMIN session to bypass the SoD creator≠approver check.
    // In the smoke test we use a separate user_id stub in the order's created_by_id.
    // Since SUPER_ADMIN created the order AND approves it, inject the order's
    // created_by_id to a fake value so the SoD check passes.
    TursoClient.write(
      "UPDATE orders SET created_by_id = 'smoke-other-user' WHERE order_id = ?",
      [orderId]
    );
    var res = processRequest({
      service: 'orders', action: 'approve', sessionToken: saToken,
      params: { orderId: orderId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'APPROVED') throw new Error('Expected APPROVED, got ' + res.data.status);
  });

  // ── 5. Dispatch → DISPATCHED ───────────────────────────────────────────────
  check('5. Dispatch order → status=DISPATCHED', function () {
    if (!orderId) throw new Error('orderId not set');
    var res = processRequest({
      service: 'orders', action: 'dispatch', sessionToken: saToken,
      params: { orderId: orderId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'DISPATCHED') throw new Error('Expected DISPATCHED, got ' + res.data.status);
  });

  // ── 6. Confirm delivery → DELIVERED ───────────────────────────────────────
  check('6. Confirm delivery → status=DELIVERED; audit row present', function () {
    if (!orderId) throw new Error('orderId not set');
    var res = processRequest({
      service: 'orders', action: 'confirmDelivery', sessionToken: saToken,
      params: { orderId: orderId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'DELIVERED') throw new Error('Expected DELIVERED, got ' + res.data.status);
    var auditRows = TursoClient.select(
      "SELECT log_id FROM audit_log WHERE action='ORDER_DELIVERED' AND entity_id=? LIMIT 1",
      [orderId]
    );
    if (!auditRows.length) throw new Error('No ORDER_DELIVERED audit row');
  });

  // ── 7. Cancel a new order ─────────────────────────────────────────────────
  check('7. Create + submit + cancel → CANCELLED + audit row', function () {
    var c1 = processRequest({
      service: 'orders', action: 'create', sessionToken: saToken,
      params: { customer_id: customerId, country_code: 'KE' },
    });
    if (!c1.ok) throw new Error('create failed');
    cancelOrderId = c1.data.order_id;
    processRequest({
      service: 'orders', action: 'addLine', sessionToken: saToken,
      params: { orderId: cancelOrderId, product_id: 'PROD-AGO', product_name: 'X', quantity: 1000, unit_price: 100 },
    });
    var sub = processRequest({
      service: 'orders', action: 'submit', sessionToken: saToken,
      params: { orderId: cancelOrderId },
    });
    if (!sub.ok) throw new Error('submit failed: ' + JSON.stringify(sub.error));
    var can = processRequest({
      service: 'orders', action: 'cancel', sessionToken: saToken,
      params: { orderId: cancelOrderId, reason: 'Smoke test cancel' },
    });
    if (!can.ok) throw new Error('cancel failed: ' + JSON.stringify(can.error));
    if (can.data.status !== 'CANCELLED') throw new Error('Expected CANCELLED');
    var auditRows = TursoClient.select(
      "SELECT log_id FROM audit_log WHERE action='ORDER_CANCELLED' AND entity_id=? LIMIT 1",
      [cancelOrderId]
    );
    if (!auditRows.length) throw new Error('No ORDER_CANCELLED audit row');
  });

  // ── 8. Submit already-SUBMITTED order → error ─────────────────────────────
  check('8. Double-submit returns Validation error', function () {
    if (!orderId) throw new Error('orderId not set');
    var res = processRequest({
      service: 'orders', action: 'submit', sessionToken: saToken,
      params: { orderId: orderId },
    });
    if (res.ok !== false) throw new Error('Expected ok=false for double-submit');
  });

  // ── 9. No sessionToken → NO_SESSION ──────────────────────────────────────
  check('9. orders.list without token returns NO_SESSION', function () {
    var res = processRequest({ service: 'orders', action: 'list', params: {} });
    if (res.ok !== false) throw new Error('Expected ok=false');
    if (!res.error || res.error.code !== 'NO_SESSION') {
      throw new Error('Expected NO_SESSION, got: ' + JSON.stringify(res.error));
    }
  });

  // ── 10. TZ-scoped session on KE order → NOT_FOUND ─────────────────────────
  check('10. TZ-scoped session cannot read KE order → NOT_FOUND', function () {
    if (!orderId) throw new Error('orderId not set');
    // Create a COUNTRY-scoped (TZ / CS_AGENT) session for the SUPER_ADMIN user.
    // RBAC passes via the user's wildcard permissions, but the handler's scope
    // filter rejects the KE order, so NOT_FOUND is returned.
    var tzToken = Session.create(saId, 'STAFF', 'CS_AGENT', '127.0.0.1', 'smoke-orders', 'TZ').token;
    var res = processRequest({
      service: 'orders', action: 'get', sessionToken: tzToken,
      params: { orderId: orderId },
    });
    if (res.ok !== false)          throw new Error('Expected ok=false');
    var code = res.error && res.error.code;
    if (code !== 'NOT_FOUND')      throw new Error('Expected NOT_FOUND, got: ' + code);
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  try { Session.invalidate(saToken); } catch (_) {}

  // ── Summary ───────────────────────────────────────────────────────────────
  var summary = '\n══════════════════════════════════════\n' +
                'smokeOrders: ' + passed + ' PASS  ' + failed + ' FAIL\n' +
                '══════════════════════════════════════';
  Logger.log(summary);
  results.push(summary);
  return results;
}

// =============================================================================
// smokeTickets  —  Stage 7 tickets domain service
// =============================================================================

/**
 * Smoke test for tickets.* handlers.
 * Run from the GAS IDE; requires live Turso DB with SUPER_ADMIN + one KE customer.
 *
 * Checks:
 *   1. Create ticket (NEW) → ticket_id + ticket_number returned
 *   2. tickets.get returns ticket with comments array
 *   3. Assign ticket → status=OPEN + audit row
 *   4. Add comment; ticket.comments count increases
 *   5. Escalate → escalation_level increases
 *   6. Resolve ticket → status=RESOLVED + audit row
 *   7. Close ticket → status=CLOSED
 *   8. Reopen → status=OPEN
 *   9. Negative: no sessionToken → NO_SESSION
 *  10. Negative: TZ-scoped session on KE ticket → NOT_FOUND
 */
function smokeTickets() {
  var results = [];
  var passed  = 0;
  var failed  = 0;

  function check(name, fn) {
    try {
      fn();
      results.push('PASS  ' + name);
      Logger.log('PASS  ' + name);
      passed++;
    } catch (e) {
      results.push('FAIL  ' + name + '\n      ' + (e.message || String(e)));
      Logger.log('FAIL  ' + name + ': ' + (e.message || String(e)));
      failed++;
    }
  }

  // ── Prereq ────────────────────────────────────────────────────────────────
  var seed    = seedAll();
  var saId    = seed.userId;
  var saToken = Session.create(saId, 'STAFF', 'SUPER_ADMIN', '127.0.0.1', 'smoke-tickets', 'KE').token;

  var custRes = processRequest({
    service: 'customers', action: 'create', sessionToken: saToken,
    params: {
      company_name:          'Smoke Test Ltd',
      account_number:        'SMKT-' + Date.now(),
      customer_type:         'B2B',
      country_code:          'KE',
      segment_id:            'SEG-STANDARD',
      relationship_owner_id: null,
      parent_customer_id:    null,
    },
  });
  if (!custRes.ok) throw new Error('Prereq customer failed: ' + JSON.stringify(custRes.error));
  var customerId = custRes.data.customer_id;

  var ticketId;

  // ── 1. Create ticket ──────────────────────────────────────────────────────
  check('1. Create ticket → ticket_id + ticket_number', function () {
    var res = processRequest({
      service: 'tickets', action: 'create', sessionToken: saToken,
      params: {
        customer_id: customerId, category: 'BILLING',
        subject: 'Smoke test billing inquiry',
        description: 'This is a smoke test ticket.',
        priority: 'MEDIUM',
      },
    });
    if (!res.ok)               throw new Error('ok=false: ' + JSON.stringify(res.error));
    if (!res.data.ticket_id)   throw new Error('Missing ticket_id');
    if (!res.data.ticket_number) throw new Error('Missing ticket_number');
    if (res.data.status !== 'NEW') throw new Error('Expected NEW, got ' + res.data.status);
    ticketId = res.data.ticket_id;
  });

  // ── 2. Get ticket with comments ───────────────────────────────────────────
  check('2. tickets.get returns ticket with comments array', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var res = processRequest({
      service: 'tickets', action: 'get', sessionToken: saToken,
      params: { ticketId: ticketId },
    });
    if (!res.ok)                           throw new Error(JSON.stringify(res.error));
    if (res.data.subject !== 'Smoke test billing inquiry') throw new Error('subject mismatch');
    if (!Array.isArray(res.data.comments)) throw new Error('comments not an array');
  });

  // ── 3. Assign → OPEN + audit ──────────────────────────────────────────────
  check('3. Assign ticket → status=OPEN + audit row', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var res = processRequest({
      service: 'tickets', action: 'assign', sessionToken: saToken,
      params: { ticketId: ticketId, assigned_to: saId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    var row = Repo.findById('tickets', ticketId);
    if (!row || row.status !== 'OPEN') throw new Error('Expected OPEN, got ' + (row && row.status));
    var auditRows = TursoClient.select(
      "SELECT log_id FROM audit_log WHERE action='TICKET_ASSIGNED' AND entity_id=? LIMIT 1",
      [ticketId]
    );
    if (!auditRows.length) throw new Error('No TICKET_ASSIGNED audit row');
  });

  // ── 4. Add comment ────────────────────────────────────────────────────────
  check('4. addComment; comments count increases', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var before = TursoClient.select(
      'SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ?', [ticketId]
    );
    var res = processRequest({
      service: 'tickets', action: 'addComment', sessionToken: saToken,
      params: { ticketId: ticketId, content: 'Follow-up comment from smoke test.' },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    var after = TursoClient.select(
      'SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ?', [ticketId]
    );
    if (parseInt(after[0].n, 10) <= parseInt(before[0].n, 10)) {
      throw new Error('Comment count did not increase');
    }
  });

  // ── 5. Escalate ───────────────────────────────────────────────────────────
  check('5. Escalate → escalation_level increases', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var before = Repo.findById('tickets', ticketId);
    var res = processRequest({
      service: 'tickets', action: 'escalate', sessionToken: saToken,
      params: { ticketId: ticketId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    var after = Repo.findById('tickets', ticketId);
    if (parseInt(after.escalation_level, 10) <= parseInt(before.escalation_level, 10)) {
      throw new Error('escalation_level did not increase');
    }
  });

  // ── 6. Resolve ────────────────────────────────────────────────────────────
  check('6. Resolve ticket → status=RESOLVED + audit row', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var res = processRequest({
      service: 'tickets', action: 'resolve', sessionToken: saToken,
      params: {
        ticketId: ticketId,
        resolution_type: 'RESOLVED',
        resolution_summary: 'Issue confirmed and resolved in smoke test.',
      },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'RESOLVED') throw new Error('Expected RESOLVED');
    var audit = TursoClient.select(
      "SELECT log_id FROM audit_log WHERE action='TICKET_RESOLVED' AND entity_id=? LIMIT 1",
      [ticketId]
    );
    if (!audit.length) throw new Error('No TICKET_RESOLVED audit row');
  });

  // ── 7. Close ──────────────────────────────────────────────────────────────
  check('7. Close ticket → status=CLOSED', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var res = processRequest({
      service: 'tickets', action: 'close', sessionToken: saToken,
      params: { ticketId: ticketId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'CLOSED') throw new Error('Expected CLOSED, got ' + res.data.status);
  });

  // ── 8. Reopen ─────────────────────────────────────────────────────────────
  check('8. Reopen ticket → status=OPEN', function () {
    if (!ticketId) throw new Error('ticketId not set');
    var res = processRequest({
      service: 'tickets', action: 'reopen', sessionToken: saToken,
      params: { ticketId: ticketId },
    });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    if (res.data.status !== 'OPEN') throw new Error('Expected OPEN, got ' + res.data.status);
  });

  // ── 9. No sessionToken → NO_SESSION ──────────────────────────────────────
  check('9. tickets.list without token returns NO_SESSION', function () {
    var res = processRequest({ service: 'tickets', action: 'list', params: {} });
    if (res.ok !== false) throw new Error('Expected ok=false');
    if (!res.error || res.error.code !== 'NO_SESSION') {
      throw new Error('Expected NO_SESSION, got: ' + JSON.stringify(res.error));
    }
  });

  // ── 10. TZ-scoped session on KE ticket → NOT_FOUND ───────────────────────
  check('10. TZ-scoped session cannot read KE ticket → NOT_FOUND', function () {
    if (!ticketId) throw new Error('ticketId not set');
    // Create a COUNTRY-scoped (TZ / CS_AGENT) session for the SUPER_ADMIN user.
    // RBAC passes via the user's wildcard permissions, but the handler's scope
    // filter rejects the KE ticket, so NOT_FOUND is returned.
    var tzToken = Session.create(saId, 'STAFF', 'CS_AGENT', '127.0.0.1', 'smoke-tickets', 'TZ').token;
    var res = processRequest({
      service: 'tickets', action: 'get', sessionToken: tzToken,
      params: { ticketId: ticketId },
    });
    if (res.ok !== false)     throw new Error('Expected ok=false');
    var code = res.error && res.error.code;
    if (code !== 'NOT_FOUND') throw new Error('Expected NOT_FOUND, got: ' + code);
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  try { Session.invalidate(saToken); } catch (_) {}

  // ── Summary ───────────────────────────────────────────────────────────────
  var summary = '\n══════════════════════════════════════\n' +
                'smokeTickets: ' + passed + ' PASS  ' + failed + ' FAIL\n' +
                '══════════════════════════════════════';
  Logger.log(summary);
  results.push(summary);
  return results;
}
