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
  Logger.log('[Seed] seedAll() start');

  // ── 1. Idempotency check ───────────────────────────────────────────────────
  var existing = TursoClient.select(
    "SELECT ur.user_id FROM user_roles ur WHERE ur.role_code = 'SUPER_ADMIN' LIMIT 1"
  );
  if (existing.length) {
    Logger.log('[Seed] SUPER_ADMIN already seeded.');
    return;
  }

  // ── 2. Credentials ────────────────────────────────────────────────────────
  var props = PropertiesService.getScriptProperties();
  var email = (props.getProperty('SEED_SUPERADMIN_EMAIL') || 'admin@hasspetroleum.com').trim();

  // Generate a random 16-char password: 4 segments of [A-Za-z0-9@!#$]
  var chars  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@!#$';
  var rawPwd = '';
  for (var i = 0; i < 16; i++) {
    rawPwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure it satisfies the default policy: uppercase, lowercase, digit, special.
  rawPwd = 'Aa1!' + rawPwd.substring(4);

  // ── 5. One-time password block (printed before hashing) ───────────────────
  Logger.log('╔══════════════════════════════════════════════════╗');
  Logger.log('║  SUPER_ADMIN ONE-TIME PASSWORD — CAPTURE NOW     ║');
  Logger.log('║  Email:    ' + email);
  Logger.log('║  Password: ' + rawPwd);
  Logger.log('╚══════════════════════════════════════════════════╝');

  var passwordHash = Password.hash(rawPwd);
  var userId = genId('USR');
  var now    = nowIso();

  // ── 3. Insert users row (new-schema columns only) ─────────────────────────
  TursoClient.write(
    'INSERT INTO users ' +
    '(user_id, email, first_name, last_name, password_hash, password_changed_at, ' +
    'must_change_password, status, mfa_enabled, country_code, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [userId, email, 'Super', 'Admin', passwordHash, now, 1, 'ACTIVE', 0, null, now, now]
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

  // ── 6. Audit log ───────────────────────────────────────────────────────────
  Audit.log({
    actor:    'SEED',
    action:   'SUPER_ADMIN_SEEDED',
    entity:   'users',
    entityId: userId,
    after:    { email: email, role_code: 'SUPER_ADMIN' },
  });

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
