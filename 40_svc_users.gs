/**
 * 40_svc_users.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * Registers users.* actions with the dispatcher.
 * All actions are gated by Rbac.requirePermission.
 */

// ── Handlers ──────────────────────────────────────────────────────────────────

function _usersList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.view');
  var sql  = 'SELECT user_id, email, first_name, last_name, status, country_code, team_id, last_login_at, created_at FROM users WHERE 1=1';
  var args = [];
  if (params.status)       { sql += ' AND status = ?';                         args.push(params.status); }
  if (params.country_code) { sql += ' AND country_code = ?';                   args.push(params.country_code); }
  if (params.search) {
    sql += ' AND (LOWER(email) LIKE ? OR LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ?)';
    var q = '%' + String(params.search).toLowerCase() + '%';
    args.push(q, q, q);
  }
  sql += ' ORDER BY last_name, first_name LIMIT ' + (parseInt(params.limit, 10) || 200);
  if (params.offset) sql += ' OFFSET ' + parseInt(params.offset, 10);
  return TursoClient.select(sql, args);
}

function _usersGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.view');
  var userId = String(params.userId || '');
  if (!userId) throw new Errors.Validation('userId required.');
  var rows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new Errors.NotFound('User not found.');
  var u = rows[0];
  // Omit sensitive columns.
  delete u.password_hash;
  delete u.mfa_secret;
  return u;
}

function _usersCreate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.create');
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) throw new Errors.Validation('Email is required.');
  var password = String(params.password || '').trim();
  if (!password) throw new Errors.Validation('Initial password is required.');

  Password.validatePolicy(password);
  var passwordHash = Password.hash(password);
  var userId = uuidv4();
  var now    = nowIso();

  TursoClient.write(
    'INSERT INTO users (user_id, email, first_name, last_name, status, ' +
    'password_hash, must_change_password, failed_login_attempts, country_code, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,1,0,?,?,?)',
    [
      userId,
      email,
      String(params.firstName || params.first_name || ''),
      String(params.lastName  || params.last_name  || ''),
      'ACTIVE',
      passwordHash,
      String(params.countryCode || params.country_code || ''),
      now, now,
    ]
  );

  // Record initial password in history.
  TursoClient.write(
    'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
    [uuidv4(), userId, 'STAFF', passwordHash, now]
  );

  Audit.log({ actor: ctx.actor || '', action: 'USER_CREATED', entity: 'users',
              entityId: userId, after: { email: email, role: params.role }, metadata: {} });
  return { userId: userId, email: email };
}

function _usersUpdate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.update');
  var userId = String(params.userId || '');
  if (!userId) throw new Errors.Validation('userId required.');
  var rows = TursoClient.select('SELECT * FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new Errors.NotFound('User not found.');
  var before = rows[0];
  var allowed = ['first_name', 'last_name', 'phone', 'team_id',
                 'country_code', 'countries_access', 'reports_to'];
  var patch = { updated_at: nowIso() };
  allowed.forEach(function (k) { if (params[k] !== undefined) patch[k] = params[k]; });
  if (Object.keys(patch).length <= 1) throw new Errors.Validation('No updatable fields provided.');
  Repo.update('users', userId, patch);
  Audit.log({ actor: ctx.actor || '', action: 'USER_UPDATED', entity: 'users',
              entityId: userId, before: before, after: patch, metadata: {} });
  return { success: true };
}

function _usersLock_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.update');
  var userId   = String(params.userId || '');
  var minutes  = parseInt(params.minutes, 10) || 60;
  if (!userId) throw new Errors.Validation('userId required.');
  var lockUntil = addMinutes(new Date(), minutes).toISOString();
  TursoClient.write(
    'UPDATE users SET locked_until = ?, updated_at = ? WHERE user_id = ?',
    [lockUntil, nowIso(), userId]
  );
  Audit.log({ actor: ctx.actor || '', action: 'USER_LOCKED', entity: 'users',
              entityId: userId, metadata: { locked_until: lockUntil } });
  return { success: true, locked_until: lockUntil };
}

function _usersUnlock_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.update');
  var userId = String(params.userId || '');
  if (!userId) throw new Errors.Validation('userId required.');
  TursoClient.write(
    'UPDATE users SET locked_until = NULL, failed_login_attempts = 0, updated_at = ? WHERE user_id = ?',
    [nowIso(), userId]
  );
  Audit.log({ actor: ctx.actor || '', action: 'USER_UNLOCKED', entity: 'users',
              entityId: userId, metadata: {} });
  return { success: true };
}

function _usersResetPassword_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.reset_password');
  var userId   = String(params.userId   || '');
  var newPass  = String(params.password || '');
  if (!userId || !newPass) throw new Errors.Validation('userId and password required.');
  var rows = TursoClient.select('SELECT password_hash FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new Errors.NotFound('User not found.');
  Password.validatePolicy(newPass, userId, 'STAFF');
  var oldHash = rows[0].password_hash;
  if (oldHash) {
    TursoClient.write(
      'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
      [uuidv4(), userId, 'STAFF', oldHash, nowIso()]
    );
  }
  var newHash = Password.hash(newPass);
  TursoClient.write(
    'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE user_id = ?',
    [newHash, nowIso(), userId]
  );
  Audit.log({ actor: ctx.actor || '', action: 'PASSWORD_RESET_BY_ADMIN', entity: 'users',
              entityId: userId, metadata: { resetBy: ctx.actor } });
  return { success: true };
}

function _usersInvite_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.create');
  // Create user with a temporary password and must_change_password=1.
  var tempPass = uuidv4().replace(/-/g, '').substring(0, 12) + 'Aa1!';
  return _usersCreate_(ctx, Object.assign({}, params, { password: tempPass }));
}

function _usersSetRoles_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'role.assign');
  var userId    = String(params.userId    || '');
  var roleCodes = params.roleCodes || [];
  if (!userId) throw new Errors.Validation('userId required.');
  if (!Array.isArray(roleCodes)) throw new Errors.Validation('roleCodes must be an array.');
  var now = nowIso();
  // Clear existing roles then insert new ones.
  TursoClient.write('DELETE FROM user_roles WHERE user_id = ?', [userId]);
  roleCodes.forEach(function (code) {
    TursoClient.write(
      'INSERT OR IGNORE INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
      [userId, code, ctx.actor || 'SYSTEM', now]
    );
  });
  Audit.log({ actor: ctx.actor || '', action: 'ROLES_ASSIGNED', entity: 'users',
              entityId: userId, after: { roles: roleCodes }, metadata: {} });
  return { success: true, roles: roleCodes };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerUsers_() {
  register({ service: 'users', action: 'list',          permission: 'user.view',         handler: _usersList_ });
  register({ service: 'users', action: 'get',           permission: 'user.view',         handler: _usersGet_ });
  register({ service: 'users', action: 'create',        permission: 'user.create',       handler: _usersCreate_ });
  register({ service: 'users', action: 'update',        permission: 'user.update',       handler: _usersUpdate_ });
  register({ service: 'users', action: 'lock',          permission: 'user.update',       handler: _usersLock_ });
  register({ service: 'users', action: 'unlock',        permission: 'user.update',       handler: _usersUnlock_ });
  register({ service: 'users', action: 'resetPassword', permission: 'user.reset_password', handler: _usersResetPassword_ });
  register({ service: 'users', action: 'invite',        permission: 'user.create',       handler: _usersInvite_ });
  register({ service: 'users', action: 'setRoles',      permission: 'role.assign',       handler: _usersSetRoles_ });
})();
