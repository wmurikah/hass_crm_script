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
