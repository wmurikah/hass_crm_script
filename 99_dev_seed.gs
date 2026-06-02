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
