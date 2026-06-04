/**
 * 99_dev_seed.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * seedAll()  —  idempotent bootstrap for development/staging.
 *
 *   1. Returns early if a SUPER_ADMIN binding already exists in user_roles.
 *   2. Creates ONE SUPER_ADMIN user if no SUPER_ADMIN exists in user_roles.
 *      Email from Script Property SEED_SUPERADMIN_EMAIL
 *      (default: admin@hasspetroleum.com).
 *   3. Generates a random 16-char password, prints it ONCE to Logger.log.
 *      must_change_password = 1.
 *   4. Inserts user_roles binding to SUPER_ADMIN role.
 */

function seedAll() {
  // ── 1. Idempotency check ───────────────────────────────────────────────────
  var existing = TursoClient.select(
    "SELECT user_id FROM user_roles WHERE role_code = 'SUPER_ADMIN' LIMIT 1"
  );
  if (existing.length) {
    Logger.log('[Seed] SUPER_ADMIN already seeded - skipping');
    return { userId: existing[0].user_id };
  }

  // ── 2. Credentials ────────────────────────────────────────────────────────
  var props = PropertiesService.getScriptProperties();
  var email = (props.getProperty('SEED_SUPERADMIN_EMAIL') || 'admin@hasspetroleum.com').trim();

  // ── 3. Generate 16-char password with upper, lower, digit, symbol mix ─────
  var chars    = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@!#$';
  var password = 'Aa1!';
  for (var i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  // ── 4. Hash password ───────────────────────────────────────────────────────
  var passwordHash = Password.hash(password);
  var userId = genId('USR');
  var now    = nowIso();

  // ── 5. Insert ONE row into users (only rebuilt-schema columns) ─────────────
  TursoClient.write(
    'INSERT INTO users ' +
    '(user_id, email, first_name, last_name, password_hash, password_changed_at, ' +
    'must_change_password, status, mfa_enabled, country_code, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, email, 'Super', 'Admin', passwordHash, now, 1, 'ACTIVE', 0, null, now, now]
  );

  // ── 6. Insert ONE row into user_roles ──────────────────────────────────────
  TursoClient.write(
    'INSERT INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
    [userId, 'SUPER_ADMIN', 'SEED', now]
  );

  // ── 7. Audit log ───────────────────────────────────────────────────────────
  Audit.log({
    actor:    'SEED',
    action:   'SUPER_ADMIN_SEEDED',
    entity:   'users',
    entityId: userId,
    after:    { email: email },
  });

  // ── 8. Print one-time password ─────────────────────────────────────────────
  Logger.log('╔════════════════════════════════════════╗');
  Logger.log('║ SUPER_ADMIN ONE-TIME PASSWORD          ║');
  Logger.log('║ Email:    ' + email);
  Logger.log('║ Password: ' + password);
  Logger.log('╚════════════════════════════════════════╝');
  return { userId: userId };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * Server-side reproduction of the browser login → dashboard round-trip.
 *
 * Run manually from the Apps Script IDE (never auto-invoked). It performs a real
 * login, extracts the token exactly as the client does, then validates it the
 * same way getStaffDashboardPage() does. A NON-NULL "VALIDATE RESULT" means the
 * session is issued and immediately usable; the recent-session dump confirms a
 * single active row whose token_hash matches the returned token.
 */
function reproLoginThenValidate() {
  // 1. Perform a real login exactly as the browser does.
  var loginResp = processRequest({
    service: 'auth', action: 'login',
    params: {
      email: 'wilberforce.murikah@hasspetroleum.com',
      password: 'Aa1!aM$K!5EuXxSv'
    }
  });
  Logger.log('LOGIN RESP: ' + JSON.stringify(loginResp));

  // 2. Extract the token the SAME way the client does.
  var token = loginResp && loginResp.data &&
              (loginResp.data.token || loginResp.data.sessionToken);
  Logger.log('EXTRACTED TOKEN: ' + token);

  // 3. Immediately validate it the way getStaffDashboardPage does.
  var session = Session.validate(token);
  Logger.log('VALIDATE RESULT: ' + JSON.stringify(session));

  // 4. Check active session rows for this user.
  var rows = TursoClient.select(
    "SELECT session_id, is_active, expires_at, last_activity_at, " +
    "idle_timeout_minutes, token_hash FROM sessions " +
    "WHERE user_id = (SELECT user_id FROM user_roles " +
    "WHERE role_code='SUPER_ADMIN' LIMIT 1) ORDER BY created_at DESC LIMIT 5",
    []
  );
  Logger.log('RECENT SESSIONS: ' + JSON.stringify(rows));

  return { validate: session, login: loginResp };
}

/**
 * reproAllPages()  —  Manual verification harness (run from the Apps Script IDE).
 *
 * Mints a real SUPER_ADMIN session, then drives processRequest() for every
 * staff-dashboard list/summary action that this fix repointed at the real Turso
 * tables. Logs one line per action: ok:true with a row count, or ok:false with
 * the error. NEVER auto-invoked — safe to leave in the project.
 */
function reproAllPages() {
  var sa = TursoClient.select(
    "SELECT user_id FROM user_roles WHERE role_code = 'SUPER_ADMIN' LIMIT 1"
  );
  if (!sa.length) { Logger.log('reproAllPages: no SUPER_ADMIN seeded — run seedAll() first'); return; }
  var userId = sa[0].user_id;
  var sess   = Session.create(userId, 'STAFF', 'SUPER_ADMIN', null, 'reproAllPages', null);
  var token  = sess.token;

  var calls = [
    { service: 'invoices',  action: 'list',           params: {} },
    { service: 'approvals', action: 'list',           params: {} },
    { service: 'pricing',   action: 'listLists',      params: {} },
    { service: 'catalog',   action: 'listPriceLists', params: {} },
    { service: 'rbac',      action: 'listRoles',      params: {} },
    { service: 'users',     action: 'list',           params: {} },
    { service: 'documents', action: 'list',           params: {} },   // no customerId
    { service: 'payments',  action: 'list',           params: {} },
    { service: 'sla',       action: 'listPolicies',   params: {} },
    { service: 'sla',       action: 'listBreaches',   params: {} },
    { service: 'knowledge', action: 'list',           params: {} },
    { service: 'knowledge', action: 'listCategories', params: {} },
    { service: 'reports',   action: 'summary',        params: {} },
  ];

  var allOk = true;
  calls.forEach(function (c) {
    var key = c.service + '.' + c.action;
    var resp;
    try {
      var p = c.params || {};
      p.sessionToken = token;
      resp = processRequest({ service: c.service, action: c.action, params: p });
    } catch (e) {
      resp = { ok: false, error: { message: 'threw: ' + e.message } };
    }
    if (resp && resp.ok) {
      var d = resp.data;
      var n = Array.isArray(d) ? d.length
            : (d && typeof d === 'object') ? Object.keys(d).length : 0;
      Logger.log(key + ' -> ok:true rows/keys=' + n);
    } else {
      allOk = false;
      Logger.log(key + ' -> ok:false error=' +
                 JSON.stringify(resp && resp.error ? resp.error : resp));
    }
  });

  try { Session.invalidate(token); } catch (_) {}
  Logger.log('reproAllPages: ' + (allOk ? 'ALL ok:true ✅' : 'SOME FAILED ❌'));
  return { allOk: allOk };
}

/**
 * reproRbac()  —  Manual verification harness for the Roles & Perms editor
 * (run from the Apps Script IDE; NEVER auto-invoked — safe to leave in place).
 *
 * Mints a real SUPER_ADMIN session, then exercises the newly registered rbac.*
 * actions exactly as partial_rbac.html does:
 *   • getRole for an existing role (prefers 'CFO', falls back to the first
 *     non-SUPER_ADMIN role if CFO is absent)
 *   • listPermissions
 *   • a NO-OP updateRole that re-saves that role's existing permissions verbatim
 *     (idempotent — the delete-then-insert reconcile is safe to repeat)
 * Logs ok:true + shape for each. All three must be ok:true.
 */
function reproRbac() {
  var sa = TursoClient.select(
    "SELECT user_id FROM user_roles WHERE role_code = 'SUPER_ADMIN' LIMIT 1"
  );
  if (!sa.length) { Logger.log('reproRbac: no SUPER_ADMIN seeded — run seedAll() first'); return; }

  var sess  = Session.create(sa[0].user_id, 'STAFF', 'SUPER_ADMIN', null, 'reproRbac', null);
  var token = sess.token;

  function call(action, params) {
    var p = params || {}; p.sessionToken = token;
    try { return processRequest({ service: 'rbac', action: action, params: p }); }
    catch (e) { return { ok: false, error: { message: 'threw: ' + e.message } }; }
  }

  var out = {};

  // getRole — prefer CFO, else first non-SUPER_ADMIN role from listRoles.
  var roleResp   = call('getRole', { roleId: 'CFO' });
  if (!roleResp.ok) {
    var roles = call('listRoles', {});
    if (roles.ok && roles.data && roles.data.length) {
      var pick = roles.data.filter(function (r) { return r.role_code !== 'SUPER_ADMIN'; })[0] || roles.data[0];
      roleResp = call('getRole', { roleId: pick.role_code });
    }
  }
  out.getRole = roleResp.ok
    ? { ok: true, role_code: roleResp.data.role_code, label: roleResp.data.label,
        scope: roleResp.data.scope, permCount: (roleResp.data.permissions || []).length }
    : { ok: false, error: roleResp.error };

  // listPermissions
  var permsResp = call('listPermissions', {});
  out.listPermissions = permsResp.ok
    ? { ok: true, count: (permsResp.data || []).length, sample: (permsResp.data || [])[0] || null }
    : { ok: false, error: permsResp.error };

  // updateRole — no-op re-save of the role's EXISTING permission set.
  if (roleResp.ok) {
    var upResp = call('updateRole', {
      roleCode:    roleResp.data.role_code,
      roleId:      roleResp.data.role_id,
      label:       roleResp.data.label,
      scope:       roleResp.data.scope,
      permissions: roleResp.data.permissions || [],
    });
    out.updateRole = upResp.ok
      ? { ok: true, role_code: upResp.data.role_code, permCount: (upResp.data.permissions || []).length }
      : { ok: false, error: upResp.error };
  } else {
    out.updateRole = { ok: false, error: 'skipped — getRole failed' };
  }

  try { Session.invalidate(token); } catch (_) {}

  var allOk = out.getRole.ok && out.listPermissions.ok && out.updateRole.ok;
  Logger.log('reproRbac results: ' + JSON.stringify(out, null, 2));
  Logger.log('reproRbac: ' + (allOk ? 'ALL ok:true ✅' : 'SOME FAILED ❌'));
  return { allOk: allOk, results: out };
}

/**
 * reproBot()  —  Manual verification harness for the Phase-2 read-only assistant
 * (run from the Apps Script IDE; NEVER auto-invoked — temporary, safe to remove).
 *
 * It proves the bot.chat path end-to-end WITHOUT spending LLM tokens:
 *   1. Mints a real SUPER_ADMIN session.
 *   2. Seeds bot_tools (idempotent) and asserts every row is is_write = 0.
 *   3. Saves a test bot_llm_configs row with NO key (must succeed — regression
 *      guard for the api_key_property NOT NULL bug; has_key=false), activates it,
 *      then saves a DUMMY key and confirms has_key flips to true. The dummy-key
 *      provider call is expected to fail gracefully on auth — proving the request
 *      path without burning tokens. If BOT_ANTHROPIC_KEY is set in Script
 *      Properties you may point the config at it for a real call instead.
 *   4. Calls bot.chat('How many unpaid invoices are there?') and logs the
 *      answer + toolsUsed, then confirms the turn was written to
 *      bot_conversations.
 *   5. Calls bot.chat with a message trying to CANCEL an order and confirms
 *      toolsUsed contains no write action.
 *   6. Directly exercises the HARD WRITE GUARD: temporarily inserts a write
 *      bot_tools row (is_write = 1), calls _botExecuteTool_ on it, asserts it is
 *      REFUSED and never executed, then removes the temp row.
 */
function reproBot() {
  var sa = TursoClient.select(
    "SELECT user_id FROM user_roles WHERE role_code = 'SUPER_ADMIN' LIMIT 1"
  );
  if (!sa.length) { Logger.log('reproBot: no SUPER_ADMIN seeded — run seedAll() first'); return; }

  var sess  = Session.create(sa[0].user_id, 'STAFF', 'SUPER_ADMIN', '127.0.0.1', 'reproBot', 'KE');
  var token = sess.token;
  var out   = {};

  function call(action, params) {
    var p = params || {}; p.sessionToken = token;
    try { return processRequest({ service: 'bot', action: action, params: p }); }
    catch (e) { return { ok: false, error: { message: 'threw: ' + e.message } }; }
  }

  // ── 2. Seed read-only tools and assert is_write = 0 everywhere ─────────────
  var seedRes = seedBotTools();
  var writeRows = TursoClient.select('SELECT service, action FROM bot_tools WHERE is_write != 0', []);
  out.seed = { seedRes: seedRes, writeToolRows: writeRows.length };
  Logger.log('reproBot seed: ' + JSON.stringify(out.seed) +
             (writeRows.length ? ' ❌ WRITE TOOL PRESENT' : ' ✅ all read-only'));

  // ── 3a. Save a config with NO key — must SUCCEED (regression: the NOT NULL
  //        constraint on api_key_property used to make this fail). has_key=false.
  var saveNoKey = call('saveConfig', {
    config_id:     'REPRO_BOT_CFG',
    provider:      'anthropic',
    label:         'Repro Test Config',
    model:         'claude-sonnet-4-6',
    system_prompt: 'You are the Hass CMS read-only assistant.',
    // intentionally NO apiKey
  });
  out.saveNoKey = saveNoKey.ok
    ? { config_id: saveNoKey.data.config_id, has_key: saveNoKey.data.has_key }
    : { error: saveNoKey.error };
  Logger.log('reproBot saveConfig(no key): ' + JSON.stringify(out.saveNoKey) +
             (saveNoKey.ok && saveNoKey.data.has_key === false ? ' ✅ saved, no key' : ' ❌'));

  // 3b. Activate + getConfig must succeed with has_key=false and never expose a raw key.
  call('setActiveConfig', { config_id: 'REPRO_BOT_CFG' });
  var getNoKey = call('getConfig', { config_id: 'REPRO_BOT_CFG' });
  out.getNoKey = getNoKey.ok
    ? { has_key: getNoKey.data.has_key, exposesRawKey: ('apiKey' in getNoKey.data) || ('api_key' in getNoKey.data) }
    : { error: getNoKey.error };
  Logger.log('reproBot getConfig(no key): ' + JSON.stringify(out.getNoKey) +
             (getNoKey.ok && getNoKey.data.has_key === false ? ' ✅ active, has_key=false' : ' ❌'));

  // 3c. Now save a DUMMY key — has_key must flip to true (the provider call will
  //     still fail gracefully on auth, proving the path without burning tokens).
  var save = call('saveConfig', {
    config_id: 'REPRO_BOT_CFG',
    apiKey:    'sk-ant-DUMMY-key-for-repro-only',
  });
  out.saveConfig = save.ok ? { config_id: save.data.config_id, has_key: save.data.has_key } : { error: save.error };
  // Confirm the raw key NEVER comes back, only has_key (now true).
  var getCfg = call('getConfig', { config_id: 'REPRO_BOT_CFG' });
  out.keyNeverReturned = getCfg.ok
    ? { has_key: getCfg.data.has_key, exposesRawKey: ('apiKey' in getCfg.data) || ('api_key' in getCfg.data) }
    : { error: getCfg.error };
  Logger.log('reproBot config(with key): ' + JSON.stringify(out.saveConfig) +
             ' keyCheck=' + JSON.stringify(out.keyNeverReturned) +
             (save.ok && save.data.has_key === true ? ' ✅ key set' : ' ❌'));

  // ── 4. Ask a read question (dummy key → provider fails gracefully) ─────────
  var ask = call('chat', { message: 'How many unpaid invoices are there?' });
  out.chatRead = ask.ok
    ? { answer: ask.data.answer, toolsUsed: ask.data.toolsUsed, turnId: ask.data.turnId }
    : { error: ask.error };
  Logger.log('reproBot chat(read): ' + JSON.stringify(out.chatRead));

  // Confirm the turn was persisted to bot_conversations.
  if (ask.ok && ask.data.turnId) {
    var turn = TursoClient.select(
      'SELECT turn_id, status, tokens_used FROM bot_conversations WHERE turn_id = ? LIMIT 1',
      [ask.data.turnId]
    );
    out.turnLogged = turn.length ? { found: true, status: turn[0].status } : { found: false };
  } else {
    out.turnLogged = { found: false };
  }
  Logger.log('reproBot turn logged: ' + JSON.stringify(out.turnLogged));

  // ── 5. Try to make it cancel an order — confirm NO write action ran ───────
  var cancel = call('chat', { message: 'Please cancel order ORD-123 right now.' });
  var cancelTools = cancel.ok ? (cancel.data.toolsUsed || []) : [];
  var ranWrite = false;
  cancelTools.forEach(function (label) {
    var parts = String(label).split('.');
    if (parts.length === 2) {
      var w = TursoClient.select('SELECT is_write FROM bot_tools WHERE service = ? AND action = ? LIMIT 1',
                                 [parts[0], parts[1]]);
      if (w.length && String(w[0].is_write) !== '0') ranWrite = true;
    }
  });
  out.chatCancel = { toolsUsed: cancelTools, ranWriteAction: ranWrite };
  Logger.log('reproBot chat(cancel): ' + JSON.stringify(out.chatCancel) +
             (ranWrite ? ' ❌ WRITE EXECUTED' : ' ✅ no write executed'));

  // ── 6. Directly prove the HARD WRITE GUARD refuses an is_write = 1 tool ────
  var guardRefused = false, guardExecuted = true;
  try {
    TursoClient.write(
      'INSERT INTO bot_tools (tool_id, service, action, description, params_schema_json, is_write, required_permission, is_enabled, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [genId('BTOOL'), '__repro', 'writeProbe', 'temp write probe',
       '{"type":"object","properties":{}}', 1, null, 1, nowIso()]
    );
    var guard = _botExecuteTool_('__repro' + BOT_TOOL_SEP + 'writeProbe', {}, token);
    guardRefused  = !!guard.refused;
    guardExecuted = !!guard.executed;
  } catch (e) {
    out.guardError = e.message;
  } finally {
    try { TursoClient.write("DELETE FROM bot_tools WHERE service = '__repro' AND action = 'writeProbe'", []); } catch (_) {}
  }
  out.writeGuard = { refused: guardRefused, executed: guardExecuted };
  Logger.log('reproBot write guard: ' + JSON.stringify(out.writeGuard) +
             (guardRefused && !guardExecuted ? ' ✅ guard refused write' : ' ❌ guard FAILED'));

  try { Session.invalidate(token); } catch (_) {}

  var pass = out.seed.writeToolRows === 0 &&
             out.saveNoKey.has_key === false &&
             out.getNoKey.has_key === false && out.getNoKey.exposesRawKey === false &&
             out.saveConfig.has_key === true &&
             out.turnLogged.found === true &&
             out.chatCancel.ranWriteAction === false &&
             out.writeGuard.refused === true && out.writeGuard.executed === false &&
             out.keyNeverReturned.exposesRawKey === false;
  Logger.log('reproBot results: ' + JSON.stringify(out, null, 2));
  Logger.log('reproBot: ' + (pass ? 'ALL CHECKS PASS ✅' : 'SOME CHECKS FAILED ❌'));
  return { pass: pass, results: out };
}

// ── One-off migrations ────────────────────────────────────────────────────────

/**
 * Run once from the IDE to backfill the role column added to the sessions table.
 * Safe to run again — catches the "duplicate column" error silently.
 */
function migrateAddSessionRole() {
  try {
    TursoClient.write('ALTER TABLE sessions ADD COLUMN role TEXT');
    Logger.log('sessions.role column added OK');
  } catch (e) {
    Logger.log('sessions.role migration: ' + e.message);
  }
}

// ── Internal helper ───────────────────────────────────────────────────────────

function _seedAddColumnIfMissing_(tableName, columnName, columnDef) {
  try {
    var cols = TursoClient.select('PRAGMA table_info(' + tableName + ')');
    var exists = cols.some(function (c) {
      return String(c.name).toLowerCase() === columnName.toLowerCase();
    });
    if (!exists) {
      TursoClient.write('ALTER TABLE ' + tableName + ' ADD COLUMN ' + columnName + ' ' + columnDef);
      Logger.log('[Seed] Added column ' + tableName + '.' + columnName);
    }
  } catch (e) {
    Logger.log('[Seed] WARNING: could not add ' + tableName + '.' + columnName + ': ' + e.message);
  }
}

function resetSuperAdminPassword() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('SEED_SUPERADMIN_EMAIL')
              || 'admin@hasspetroleum.com';
  var pwd   = props.getProperty('SMOKE_SUPERADMIN_PASSWORD') || '';
  if (!pwd) { Logger.log('Set SMOKE_SUPERADMIN_PASSWORD first'); return; }
  var newHash = Password.hash(pwd);
  TursoClient.write(
    'UPDATE users SET password_hash=? WHERE email=?', [newHash, email]
  );
  Logger.log('Done. New hash prefix: ' + newHash.substring(0, 20));
}
