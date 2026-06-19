/**
 * 40_svc_users.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * Registers users.* actions with the dispatcher.
 * All actions are gated by Rbac.requirePermission.
 */

// ── Handlers ──────────────────────────────────────────────────────────────────

function _usersList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.view');
  // ROLE comes from user_roles; COUNTRY from users.country_code. A user may hold
  // several roles — surface the GLOBAL-scope role if present, else the first
  // assigned role_code. A correlated subquery keeps one row per user.
  var sql  = 'SELECT u.user_id, u.email, u.first_name, u.last_name, u.status, ' +
             'u.country_code, u.country_code AS country, u.last_login_at, ' +
             '(SELECT ur.role_code FROM user_roles ur ' +
             '   LEFT JOIN roles r ON r.role_code = ur.role_code ' +
             '   WHERE ur.user_id = u.user_id ' +
             "   ORDER BY CASE WHEN UPPER(COALESCE(r.scope,'')) = 'GLOBAL' THEN 0 ELSE 1 END, " +
             '            ur.assigned_at ' +
             '   LIMIT 1) AS role ' +
             'FROM users u WHERE 1=1';
  var args = [];
  if (params.status)       { sql += ' AND u.status = ?';       args.push(params.status); }
  if (params.country_code) { sql += ' AND u.country_code = ?'; args.push(params.country_code); }
  if (params.role) {
    sql += ' AND EXISTS (SELECT 1 FROM user_roles ur2 WHERE ur2.user_id = u.user_id AND ur2.role_code = ?)';
    args.push(params.role);
  }
  if (params.search) {
    sql += ' AND (LOWER(u.email) LIKE ? OR LOWER(u.first_name) LIKE ? OR LOWER(u.last_name) LIKE ?)';
    var q = '%' + String(params.search).toLowerCase() + '%';
    args.push(q, q, q);
  }
  sql += ' ORDER BY u.last_name, u.first_name LIMIT ' + (parseInt(params.limit, 10) || 200);
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

// Resolve the requested role codes for create/setRoles. Accepts the canonical
// roleCodes array plus the aliases callers have historically sent (roles as an
// array, role / roleCode as a single code, comma-separated strings). Throws
// Validation when the resolved set is empty or contains a code not present in
// roles — a caller must never be able to express "no roles" by accident.
function _usersNormalizeRoleCodes_(params) {
  var raw = params.roleCodes;
  if (raw === undefined || raw === null) raw = params.roles;
  if (raw === undefined || raw === null) raw = params.roleCode;
  if (raw === undefined || raw === null) raw = params.role;
  if (typeof raw === 'string') raw = raw.split(',');
  if (!Array.isArray(raw)) raw = [];

  var seen  = {};
  var codes = [];
  raw.forEach(function (c) {
    var code = String(c == null ? '' : c).trim();
    if (code && !seen[code]) { seen[code] = true; codes.push(code); }
  });
  if (!codes.length) {
    throw new Errors.Validation(
      'roleCodes must be a non-empty array of role codes — a user cannot be left with no role.'
    );
  }

  var placeholders = codes.map(function () { return '?'; }).join(',');
  var known = TursoClient.select(
    'SELECT role_code FROM roles WHERE role_code IN (' + placeholders + ')', codes
  ).map(function (row) { return row.role_code; });
  var knownSet = {};
  known.forEach(function (k) { knownSet[k] = true; });
  var unknown = codes.filter(function (c) { return !knownSet[c]; });
  if (unknown.length) {
    throw new Errors.Validation('Unknown role code(s): ' + unknown.join(', '));
  }
  return codes;
}

// One shared role-binding path used by BOTH create (additive) and setRoles
// (replace). A single writer here means the create and edit flows can never
// drift apart again (create used to inline its own INSERT, divergent from
// setRoles). Codes MUST already be validated by _usersNormalizeRoleCodes_.
function _usersWriteRoles_(userId, roleCodes, actor, opts) {
  var now   = nowIso();
  var stmts = [];
  if (opts && opts.replace) {
    stmts.push({ sql: 'DELETE FROM user_roles WHERE user_id = ?', args: [userId] });
  }
  roleCodes.forEach(function (code) {
    stmts.push({
      sql:  'INSERT OR IGNORE INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
      args: [userId, code, actor, now],
    });
  });
  TursoClient.batch(stmts);   // delete + inserts ride one pipeline
}

// Anti-privilege-escalation guard: an actor may only grant role(s) whose
// permissions are a subset of their OWN. SUPER_ADMIN (the '*' wildcard) may
// grant anything. This stops a lower-privileged user who happens to hold
// role.assign from minting a role that out-ranks them (e.g. handing out
// SUPER_ADMIN, or any permission they do not themselves hold).
function _usersAssertCanGrant_(ctx, roleCodes) {
  var actorId    = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || '';
  var actorPerms = Rbac.userPermissions(actorId) || [];
  if (actorPerms.indexOf('*') !== -1) return;   // SUPER_ADMIN (wildcard) - unrestricted

  var actorSet = {};
  actorPerms.forEach(function (p) { actorSet[p] = true; });

  var placeholders = roleCodes.map(function () { return '?'; }).join(',');
  var rows = TursoClient.select(
    'SELECT DISTINCT role_code, permission_code FROM role_permissions WHERE role_code IN (' + placeholders + ')',
    roleCodes
  );
  var offending = {};
  rows.forEach(function (r) {
    // '*' is never delegable by a non-wildcard actor; nor is any perm the actor lacks.
    if (r.permission_code === '*' || !actorSet[r.permission_code]) offending[r.role_code] = true;
  });
  var bad = Object.keys(offending);
  if (bad.length) {
    throw new Errors.PermissionDenied(
      'You cannot assign role(s) that grant permissions beyond your own: ' + bad.join(', ') + '.'
    );
  }
}

function _usersCreate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'user.create');
  var email = String(params.email || '').trim().toLowerCase();
  if (!email) throw new Errors.Validation('Email is required.');
  var password = String(params.password || '').trim();
  if (!password) throw new Errors.Validation('Initial password is required.');

  // A new user must start with at least one valid role, otherwise they show up
  // role-less in the list and log in to an empty dashboard. Resolve and
  // validate BEFORE any insert so a bad role never leaves a half-created
  // account behind. Granting roles is gated by the same permission that
  // users.setRoles / rbac.assignRole require.
  var roleCodes = _usersNormalizeRoleCodes_(params);
  Rbac.requirePermission(ctx.session, 'role.assign');
  _usersAssertCanGrant_(ctx, roleCodes);

  Password.validatePolicy(password);
  var passwordHash = Password.hash(password);
  var userId = uuidv4();
  var now    = nowIso();
  var actor  = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';

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
      params.countryCode || params.country_code || null,
      now, now,
    ]
  );

  // Assign the initial role(s) via the shared binding path (additive: a
  // brand-new user has nothing to replace). Codes were validated above.
  _usersWriteRoles_(userId, roleCodes, actor, { replace: false });

  // Record initial password in history.
  TursoClient.write(
    'INSERT INTO password_history (history_id, user_id, user_type, password_hash, created_at) VALUES (?,?,?,?,?)',
    [uuidv4(), userId, 'STAFF', passwordHash, now]
  );

  Audit.log({ actor: actor, action: 'USER_CREATED', entity: 'users',
              entityId: userId, after: { email: email, roles: roleCodes }, metadata: {} });
  return { userId: userId, email: email, roles: roleCodes };
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
  // Optional FK columns: coerce empty/falsy values to NULL so the FK constraint passes.
  ['team_id', 'country_code', 'reports_to'].forEach(function (k) {
    if (patch[k] !== undefined && !patch[k]) patch[k] = null;
  });

  // Email is login identity. Normalise, and reject a collision with another user
  // before writing (the column is UNIQUE; a clean message beats a raw DB error).
  if (params.email !== undefined) {
    var email = String(params.email).trim().toLowerCase();
    if (!email) throw new Errors.Validation('Email cannot be empty.');
    if (email !== String(before.email || '').toLowerCase()) {
      var dupe = TursoClient.select(
        'SELECT user_id FROM users WHERE LOWER(email) = ? AND user_id <> ? LIMIT 1', [email, userId]
      );
      if (dupe.length) throw new Errors.AppError('Email already in use by another user.', 'CONFLICT');
    }
    patch.email = email;
  }

  // Status - restrict to the known account states.
  if (params.status !== undefined) {
    var status = String(params.status).trim().toUpperCase();
    if (['ACTIVE', 'INACTIVE', 'SUSPENDED'].indexOf(status) === -1) {
      throw new Errors.Validation('Invalid status: ' + status + '.');
    }
    patch.status = status;
  }

  if (Object.keys(patch).length <= 1) throw new Errors.Validation('No updatable fields provided.');

  // Attribute the edit to the acting admin. The dispatcher sets ctx.session (not
  // ctx.actor), so derive the actor from the validated session like the other
  // mutating handlers; otherwise the audit row records an empty actor.
  var actor = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';
  Repo.update('users', userId, patch);
  Audit.log({ actor: actor, action: 'USER_UPDATED', entity: 'users',
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
  // partial_users.html sends newPassword; accept it alongside password.
  var newPass  = String(params.password || params.newPassword || '');
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
  var userId = String(params.userId || params.user_id || '');
  if (!userId) throw new Errors.Validation('userId required.');

  // Validate the requested set BEFORE touching user_roles. A missing, empty or
  // unknown set must fail loudly here — this handler used to DELETE first and
  // then insert nothing, silently stripping every role while returning success.
  var roleCodes = _usersNormalizeRoleCodes_(params);
  _usersAssertCanGrant_(ctx, roleCodes);
  var userRows = TursoClient.select('SELECT user_id FROM users WHERE user_id = ? LIMIT 1', [userId]);
  if (!userRows.length) throw new Errors.NotFound('User not found.');

  var actor = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';
  // Replace the whole set through the shared binding path; codes were validated
  // above so the inserts cannot fail after the delete and strand the user role-less.
  _usersWriteRoles_(userId, roleCodes, actor, { replace: true });

  Audit.log({ actor: actor, action: 'ROLES_ASSIGNED', entity: 'users',
              entityId: userId, after: { roles: roleCodes }, metadata: {} });
  return { success: true, roles: roleCodes };
}

// Self-service profile update (AUTH-3). The caller updates only their OWN record,
// resolved from the session, so no target id is accepted and no admin permission
// is needed (session-gated only). Works for staff (users) and portal contacts
// (contacts); email is intentionally not editable here (it is the login identity,
// changed only through the admin users.update path with its uniqueness check).
function _usersUpdateProfile_(ctx, params) {
  var sess = ctx.session;
  if (!sess || !(sess.userId || sess.user_id)) {
    throw new Errors.PermissionDenied('Authentication required.');
  }
  var userId   = sess.userId || sess.user_id;
  var userType = String(sess.userType || sess.user_type || 'STAFF').toUpperCase();
  var table    = (userType === 'CUSTOMER') ? 'contacts'   : 'users';
  var idCol    = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';

  var allowed = ['first_name', 'last_name', 'phone'];
  var patch   = {};
  allowed.forEach(function (k) { if (params[k] !== undefined) patch[k] = String(params[k]); });
  if (!Object.keys(patch).length) throw new Errors.Validation('No updatable fields provided.');
  patch.updated_at = nowIso();

  var sets = Object.keys(patch).map(function (k) { return k + ' = ?'; }).join(', ');
  var args = Object.keys(patch).map(function (k) { return patch[k]; });
  args.push(userId);
  TursoClient.write('UPDATE ' + table + ' SET ' + sets + ' WHERE ' + idCol + ' = ?', args);

  Audit.log({ actor: userId, action: 'PROFILE_UPDATED', entity: table,
              entityId: userId, after: patch, metadata: { self: true } });
  return { success: true };
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
  // AUTH-3: self-service profile update (session-gated, own record only).
  register({ service: 'users', action: 'updateProfile', permission: null,                handler: _usersUpdateProfile_ });
})();
