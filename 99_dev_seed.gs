/**
 * 99_dev_seed.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * seedAll()  —  idempotent bootstrap for development/staging.
 *
 *   1. Adds missing columns to existing tables (graceful ALTER TABLE).
 *   2. Creates ONE SUPER_ADMIN user if no SUPER_ADMIN exists in user_roles.
 *      Email from Script Property SEED_SUPERADMIN_EMAIL
 *      (default: admin@hasspetroleum.com).
 *   3. Generates a random 16-char password, prints it ONCE to Logger.log.
 *      must_change_password = 1.
 *   4. Inserts user_roles binding to SUPER_ADMIN role.
 */

function seedAll() {
  Logger.log('[Seed] seedAll() start');

  // ── 1. Schema migrations ───────────────────────────────────────────────────
  _seedAddColumnIfMissing_('users',   'must_change_password', 'INTEGER DEFAULT 0');
  _seedAddColumnIfMissing_('users',   'password_changed_at',  'TEXT');
  _seedAddColumnIfMissing_('contacts','must_change_password',  'INTEGER DEFAULT 0');
  _seedAddColumnIfMissing_('contacts','password_changed_at',   'TEXT');
  _seedAddColumnIfMissing_('roles',   'mfa_required',         'INTEGER DEFAULT 0');
  // Seed mfa_required on known high-privilege roles.
  var mfaRoles = ['SUPER_ADMIN','CEO','CFO','RMD','INTERNAL_AUDITOR','FINANCE_MANAGER'];
  mfaRoles.forEach(function (r) {
    try {
      TursoClient.write('UPDATE roles SET mfa_required = 1 WHERE role_code = ?', [r]);
    } catch (_) {}
  });

  // ── 2. Check for existing SUPER_ADMIN ─────────────────────────────────────
  var existing = TursoClient.select(
    "SELECT ur.user_id FROM user_roles ur WHERE ur.role_code = 'SUPER_ADMIN' LIMIT 1"
  );
  if (existing.length) {
    Logger.log('[Seed] SUPER_ADMIN already exists (user_id=' + existing[0].user_id + '). Nothing to do.');
    return { skipped: true, userId: existing[0].user_id };
  }

  // ── 3. Create SUPER_ADMIN user ────────────────────────────────────────────
  var props = PropertiesService.getScriptProperties();
  var email = (props.getProperty('SEED_SUPERADMIN_EMAIL') || 'admin@hasspetroleum.com').trim();

  // Generate a random 16-char password: 4 segments of [A-Za-z0-9@!#]
  var chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@!#$';
  var rawPwd = '';
  for (var i = 0; i < 16; i++) {
    rawPwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure it satisfies the default policy: uppercase, lowercase, digit, special.
  rawPwd = 'Aa1!' + rawPwd.substring(4);

  Logger.log('╔══════════════════════════════════════════════════╗');
  Logger.log('║  SUPER_ADMIN ONE-TIME PASSWORD — CAPTURE NOW     ║');
  Logger.log('║  Email:    ' + email);
  Logger.log('║  Password: ' + rawPwd);
  Logger.log('╚══════════════════════════════════════════════════╝');

  var passwordHash = Password.hash(rawPwd);
  var userId = uuidv4();
  var now    = nowIso();

  TursoClient.write(
    'INSERT INTO users (user_id, email, first_name, last_name, role, status, ' +
    'password_hash, must_change_password, failed_login_attempts, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,1,0,?,?)',
    [userId, email, 'Super', 'Admin', 'SUPER_ADMIN', 'ACTIVE', passwordHash, now, now]
  );

  // Record in password_history.
  TursoClient.write(
    'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
    [uuidv4(), userId, 'STAFF', passwordHash, now]
  );

  // ── 4. Bind to SUPER_ADMIN role ────────────────────────────────────────────
  TursoClient.write(
    'INSERT OR IGNORE INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
    [userId, 'SUPER_ADMIN', 'SEED', now]
  );

  Logger.log('[Seed] Created SUPER_ADMIN user_id=' + userId + ' email=' + email);
  return { created: true, userId: userId, email: email };
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
