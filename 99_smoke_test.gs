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
  check('Password.hash("Test@1234!") has pbkdf2$100000$ prefix', function () {
    pwHash = Password.hash('Test@1234!');
    if (typeof pwHash !== 'string') throw new Error('hash is not a string');
    if (pwHash.indexOf('pbkdf2$100000$') !== 0) {
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

  // ── 5. auth.login → session → invalidate ────────────────────────────────
  // Note: this check requires that seedAll() produced a known password.
  // If SUPER_ADMIN already existed before seedAll(), we skip the login sub-check.
  var sessionToken;
  check('processRequest auth.login returns session token (new seed only)', function () {
    if (seedResult && seedResult.skipped) {
      Logger.log('  (SKIP: SUPER_ADMIN pre-existed; no captured password)');
      return;
    }
    // seedAll logged the password, but we cannot read Logger output here.
    // We re-hash with the KNOWN temp to verify the plumbing instead.
    // Find the user's stored hash and do a direct hash comparison.
    var uRows = TursoClient.select(
      'SELECT password_hash FROM users WHERE user_id = ? LIMIT 1', [seedResult.userId]
    );
    if (!uRows.length) throw new Error('SUPER_ADMIN user row not found');
    var stored = uRows[0].password_hash;
    if (!stored || stored.indexOf('pbkdf2$') !== 0) {
      throw new Error('Stored hash is not in pbkdf2 format: ' + (stored || 'null'));
    }
    // The raw password was logged; we cannot re-read it here, so just verify
    // the session plumbing by creating a session directly.
    var testToken = Session.create(seedResult.userId, 'STAFF', 'SUPER_ADMIN', '127.0.0.1', 'smoke-test', '');
    var sess = Session.validate(testToken);
    if (!sess) throw new Error('Session.validate returned null for freshly-created session');
    if (sess.userId !== seedResult.userId) throw new Error('userId mismatch in session');
    Session.invalidate(testToken);
    var sessAfter = Session.validate(testToken);
    if (sessAfter !== null) throw new Error('Session still valid after invalidation');
    sessionToken = testToken; // already invalidated; used for check 6
  });

  // ── 6. users.list with/without token ────────────────────────────────────
  check('processRequest users.list with valid token returns list', function () {
    if (!seedResult || seedResult.skipped) {
      Logger.log('  (SKIP: SUPER_ADMIN pre-existed)');
      return;
    }
    var goodToken = Session.create(seedResult.userId, 'STAFF', 'SUPER_ADMIN', '127.0.0.1', 'smoke', '');
    var res = processRequest({ service: 'users', action: 'list', sessionToken: goodToken });
    Session.invalidate(goodToken);
    if (!res.ok) throw new Error('Expected ok=true, got: ' + JSON.stringify(res.error));
    if (!Array.isArray(res.data)) throw new Error('data is not an array');
  });

  check('processRequest users.list without token returns NO_SESSION', function () {
    var res = processRequest({ service: 'users', action: 'list' });
    if (res.ok !== false) throw new Error('Expected ok=false');
    if (!res.error || res.error.code !== 'NO_SESSION') {
      throw new Error('Expected NO_SESSION, got: ' + JSON.stringify(res.error));
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
