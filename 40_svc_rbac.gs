/**
 * 40_svc_rbac.gs  —  Hass CMS rebuild
 *
 * Dashboard RBAC read/assign endpoints used by partial_rbac.html.
 * The client calls rbac.listRoles / rbac.assignRole, but only users.setRoles
 * existed previously. These handlers read the real roles / role_permissions /
 * user_roles tables (see 20_rbac.gs for the permission-resolution logic).
 *
 *   rbac.listRoles       → all roles + their permission list
 *   rbac.getRole         → one role (flat) + its permission_codes  (Edit button)
 *   rbac.listPermissions → permission catalogue for the picker
 *   rbac.assignRole      → insert a (user_id, role_code) binding into user_roles
 *   rbac.updateRole      → update a role + reconcile its permission set  (Save)
 *   rbac.createRole      → insert a new role + its permission set       (+ New Role)
 *
 * Verified schema (no runtime introspection):
 *   roles(role_code, role_name, description, scope, is_system, mfa_required,
 *         is_active, created_at, updated_at)
 *   role_permissions(role_code, permission_code, granted_at)  PK(role_code, permission_code)
 *   permissions(permission_code, label, category, description, created_at)
 */

// ── rbac.listRoles ─────────────────────────────────────────────────────────────

function _rbacListRoles_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');

  // roles.role_name is the label; there is no role_id column, so the client's
  // role_id is aliased from role_code. country_code is not stored on roles
  // (returned null → the UI renders "ALL"). GROUP_CONCAT gives a permission
  // list/count via the LEFT JOIN to role_permissions.
  var rows = TursoClient.select(
    'SELECT r.role_code, ' +
    '       r.role_name AS label, ' +
    '       r.scope, ' +
    '       r.is_system, ' +
    '       r.is_active, ' +
    '       r.role_code AS role_id, ' +
    '       GROUP_CONCAT(rp.permission_code) AS perm_csv ' +
    'FROM roles r ' +
    'LEFT JOIN role_permissions rp ON rp.role_code = r.role_code ' +
    'GROUP BY r.role_code, r.role_name, r.scope, r.is_system, r.is_active ' +
    'ORDER BY r.role_code',
    []
  );

  // The client renders a permission COUNT plus a short category summary per row
  // (it maps these codes against the rbac.listPermissions catalogue), and shows
  // the full grouped matrix only on Edit. is_system lets the client disable the
  // Delete control for built-in roles (delete is also refused server-side).
  return rows.map(function (r) {
    var perms = r.perm_csv ? String(r.perm_csv).split(',').filter(Boolean) : [];
    return {
      role_code:        r.role_code,
      role_id:          r.role_id,
      label:            r.label,
      role_name:        r.label,
      scope:            r.scope,
      country_code:     null,
      is_system:        r.is_system,
      is_active:        r.is_active,
      permissions:      perms,
      permission_count: perms.length,
    };
  });
}

// ── rbac.assignRole ─────────────────────────────────────────────────────────────

function _rbacAssignRole_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'role.assign');
  var userId   = String(params.userId   || params.user_id   || '');
  var roleCode = String(params.roleCode || params.role_code || '').trim();
  if (!userId)   throw new Errors.Validation('userId required.');
  if (!roleCode) throw new Errors.Validation('roleCode required.');

  var actor = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';
  TursoClient.write(
    'INSERT OR IGNORE INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
    [userId, roleCode, actor, nowIso()]
  );

  Audit.log({
    actor: actor, action: 'ROLE_ASSIGNED', entity: 'user_roles',
    entityId: userId, after: { user_id: userId, role_code: roleCode },
  });
  return { success: true, user_id: userId, role_code: roleCode };
}

// ── rbac.getRole ────────────────────────────────────────────────────────────────

function _rbacGetRole_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');

  // The client passes roleId, which listRoles aliases from role_code (roles has no
  // role_id column — role_code is the PK).
  var roleCode = String(params.roleId || params.roleCode || params.role_code || '').trim();
  if (!roleCode) throw new Errors.Validation('roleId required.');

  var rows = TursoClient.select(
    'SELECT role_code, role_name, description, scope, is_system, mfa_required, is_active ' +
    'FROM roles WHERE role_code = ? LIMIT 1',
    [roleCode]
  );
  if (!rows.length) throw new Errors.NotFound('Role not found: ' + roleCode);
  var r = rows[0];

  var permRows = TursoClient.select(
    'SELECT permission_code FROM role_permissions WHERE role_code = ? ORDER BY permission_code',
    [roleCode]
  );
  var perms = permRows.map(function (p) { return p.permission_code; }).filter(Boolean);

  // Return a FLAT role object (not a nested {role, permissions, allPermissions}):
  // rbacRoleModal() in partial_rbac.html reads role.role_code / role.label /
  // role.scope / role.description / role.mfa_required / role.permissions /
  // role.role_id directly.
  return {
    role_code:    r.role_code,
    role_id:      r.role_code,   // alias, keeps parity with listRoles
    label:        r.role_name,
    role_name:    r.role_name,
    description:  r.description,
    scope:        r.scope,
    is_system:    r.is_system,
    mfa_required: r.mfa_required,
    is_active:    r.is_active,
    country_code: null,
    permissions:  perms,
  };
}

// ── rbac.listPermissions ────────────────────────────────────────────────────────
//
// Catalogue of assignable permission codes. partial_rbac.html currently uses a
// free-text textarea and does not call this yet, but it is registered per the
// Roles & Perms editor spec and is read-only.

function _rbacListPermissions_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  // description feeds the per-toggle tooltip in the grouped permission matrix.
  return TursoClient.select(
    'SELECT permission_code, label, category, description FROM permissions ORDER BY category, label',
    []
  );
}

// ── permission-set helpers ──────────────────────────────────────────────────────

// Normalise a permissions param into a unique, trimmed code array, and reject any
// code that is not a real permission. role_permissions.permission_code is a FK
// (the pipeline runs PRAGMA foreign_keys = ON), so an unknown code would otherwise
// surface as an opaque Turso error instead of a clean validation message. '*' (the
// wildcard SUPER_ADMIN holds) passes only if it exists as a real permission row.
function _rbacNormalizePerms_(permsParam) {
  var raw = permsParam;
  if (typeof raw === 'string') raw = raw.split(',');
  if (!Array.isArray(raw)) raw = [];

  var seen  = {};
  var codes = [];
  raw.forEach(function (c) {
    var code = String(c == null ? '' : c).trim();
    if (code && !seen[code]) { seen[code] = true; codes.push(code); }
  });
  if (!codes.length) return [];

  var placeholders = codes.map(function () { return '?'; }).join(',');
  var known = TursoClient.select(
    'SELECT permission_code FROM permissions WHERE permission_code IN (' + placeholders + ')',
    codes
  ).map(function (row) { return row.permission_code; });

  var knownSet = {};
  known.forEach(function (k) { knownSet[k] = true; });
  var unknown = codes.filter(function (c) { return !knownSet[c]; });
  if (unknown.length) {
    throw new Errors.Validation('Unknown permission code(s): ' + unknown.join(', '));
  }
  return codes;
}

// Reconcile a role's permission_codes against role_permissions:
//   • delete granted rows no longer in the desired set
//   • insert desired rows not already granted (OR IGNORE → idempotent on repeat)
// PK(role_code, permission_code) makes this delete-then-insert safe to repeat,
// which matters because permission writes are not auto-retried client-side.
function _rbacReconcilePermissions_(roleCode, desired) {
  var stmts = [];
  if (desired.length) {
    var now          = nowIso();
    var placeholders = desired.map(function () { return '?'; }).join(',');
    stmts.push({
      sql:  'DELETE FROM role_permissions WHERE role_code = ? AND permission_code NOT IN (' + placeholders + ')',
      args: [roleCode].concat(desired),
    });
    desired.forEach(function (code) {
      stmts.push({
        sql:  'INSERT OR IGNORE INTO role_permissions (role_code, permission_code, granted_at) VALUES (?,?,?)',
        args: [roleCode, code, now],
      });
    });
  } else {
    stmts.push({ sql: 'DELETE FROM role_permissions WHERE role_code = ?', args: [roleCode] });
  }
  TursoClient.batch(stmts);
}

function _rbacIsTruthyFlag_(v) {
  return v === 1 || v === true || String(v) === '1';
}

// ── rbac.updateRole ──────────────────────────────────────────────────────────────

function _rbacUpdateRole_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'role.assign');

  // role_code is the PK and is rendered readonly in the Edit form — we never rename
  // it, only use it to locate the row.
  var roleCode = String(params.roleCode || params.roleId || params.role_code || '').trim();
  if (!roleCode) throw new Errors.Validation('roleCode required.');

  var rows = TursoClient.select(
    'SELECT role_code, role_name, description, scope, is_system, mfa_required FROM roles WHERE role_code = ? LIMIT 1',
    [roleCode]
  );
  if (!rows.length) throw new Errors.NotFound('Role not found: ' + roleCode);
  var existing = rows[0];

  var label = (params.label    !== undefined) ? String(params.label    || '').trim()
            : (params.roleName  !== undefined) ? String(params.roleName  || '').trim()
            : existing.role_name;
  var scope = (params.scope !== undefined) ? String(params.scope || '').trim() : existing.scope;
  var description = (params.description !== undefined)
    ? (params.description == null ? null : String(params.description))
    : existing.description;
  // Accept the camelCase form the modal sends and the snake_case alias; fall back
  // to the stored value when the field is not supplied at all.
  var mfaRequired = (params.mfaRequired  !== undefined) ? (_rbacIsTruthyFlag_(params.mfaRequired)  ? 1 : 0)
                  : (params.mfa_required !== undefined) ? (_rbacIsTruthyFlag_(params.mfa_required) ? 1 : 0)
                  : (_rbacIsTruthyFlag_(existing.mfa_required) ? 1 : 0);

  var permsSupplied = (params.permissions !== undefined) || (params.permissionCodes !== undefined);
  var perms = permsSupplied
    ? _rbacNormalizePerms_(params.permissions !== undefined ? params.permissions : params.permissionCodes)
    : [];

  // ── SUPER_ADMIN lockout guard ────────────────────────────────────────────────
  // SUPER_ADMIN's power comes from the '*' wildcard grant (is_system role). Never
  // let an edit strip it — that would lock every super-admin out of the whole
  // system. If a permission set is supplied for SUPER_ADMIN it MUST still contain
  // '*'; otherwise refuse.
  var isSuperAdmin = String(existing.role_code).toUpperCase() === 'SUPER_ADMIN';
  if (isSuperAdmin && permsSupplied && perms.indexOf('*') === -1) {
    throw new Errors.Validation(
      'SUPER_ADMIN must retain full access (the "*" permission) — refusing to remove it.'
    );
  }

  var actor = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';

  TursoClient.write(
    'UPDATE roles SET role_name = ?, description = ?, scope = ?, mfa_required = ?, updated_at = ? WHERE role_code = ?',
    [label, description, scope, mfaRequired, nowIso(), roleCode]
  );

  // Only reconcile when the caller actually supplied a permission set.
  if (permsSupplied) _rbacReconcilePermissions_(roleCode, perms);

  Audit.log({
    actor: actor, action: 'ROLE_UPDATED', entity: 'roles', entityId: roleCode,
    after: { role_code: roleCode, role_name: label, description: description, scope: scope,
             mfa_required: mfaRequired, permissions: (permsSupplied ? perms : undefined) },
  });

  return { success: true, role_code: roleCode, label: label, description: description,
           scope: scope, mfa_required: mfaRequired, permissions: perms };
}

// ── rbac.createRole ──────────────────────────────────────────────────────────────

function _rbacCreateRole_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'role.assign');

  var roleCode = String(params.roleCode || params.role_code || '').trim();
  var label    = String(params.label || params.roleName || '').trim();
  var scope    = String(params.scope || 'COUNTRY').trim();
  if (!roleCode) throw new Errors.Validation('roleCode required.');
  if (!label)    throw new Errors.Validation('label required.');

  // Reject a duplicate cleanly (CONFLICT is non-retryable client-side) rather than
  // crashing on the PK constraint.
  var dupe = TursoClient.select('SELECT role_code FROM roles WHERE role_code = ? LIMIT 1', [roleCode]);
  if (dupe.length) throw new Errors.AppError('Role already exists: ' + roleCode, 'CONFLICT');

  var perms = _rbacNormalizePerms_(params.permissions !== undefined ? params.permissions : params.permissionCodes);
  var actor = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';
  var now   = nowIso();
  var description = (params.description != null && params.description !== '') ? String(params.description) : null;
  var mfaRequired = (_rbacIsTruthyFlag_(params.mfaRequired) || _rbacIsTruthyFlag_(params.mfa_required)) ? 1 : 0;

  // New roles are never system roles (is_system = 0), which also keeps them
  // deletable; built-in roles are seeded with is_system = 1.
  TursoClient.write(
    'INSERT INTO roles ' +
    '(role_code, role_name, description, scope, is_system, mfa_required, is_active, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)',
    [roleCode, label, description, scope, 0, mfaRequired, 1, now, now]
  );

  if (perms.length) _rbacReconcilePermissions_(roleCode, perms);

  Audit.log({
    actor: actor, action: 'ROLE_CREATED', entity: 'roles', entityId: roleCode,
    after: { role_code: roleCode, role_name: label, description: description, scope: scope,
             mfa_required: mfaRequired, permissions: perms },
  });

  return { success: true, role_code: roleCode, label: label, description: description,
           scope: scope, mfa_required: mfaRequired, permissions: perms };
}

// ── deleteRole ───────────────────────────────────────────────────────────────────

// Hard-delete a role plus its role_permissions rows, behind two guards so the
// RBAC model can never be left inconsistent:
//   1. A system role (roles.is_system = 1, e.g. SUPER_ADMIN) is never deletable.
//   2. A role still referenced by any user_roles row is refused; those users must
//      be reassigned first (the message names the count so the admin knows).
// Gated by the existing role.assign permission, the same code that guards
// create/update; SUPER_ADMIN's '*' covers it. The delete is audit-logged.
function _rbacDeleteRole_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'role.assign');

  var roleCode = String(params.roleCode || params.roleId || params.role_code || '').trim();
  if (!roleCode) throw new Errors.Validation('roleCode required.');

  var rows = TursoClient.select(
    'SELECT role_code, role_name, scope, is_system FROM roles WHERE role_code = ? LIMIT 1',
    [roleCode]
  );
  if (!rows.length) throw new Errors.NotFound('Role not found: ' + roleCode);
  var existing = rows[0];

  if (_rbacIsTruthyFlag_(existing.is_system)) {
    throw new Errors.Validation('System roles cannot be deleted.');
  }

  var usage = TursoClient.select(
    'SELECT COUNT(*) AS n FROM user_roles WHERE role_code = ?', [roleCode]
  );
  var assigned = usage.length ? (parseInt(usage[0].n, 10) || 0) : 0;
  if (assigned > 0) {
    throw new Errors.Validation(
      'Role is still assigned to ' + assigned + ' user' + (assigned === 1 ? '' : 's') +
      '. Reassign them before deleting this role.'
    );
  }

  var actor = (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';

  // Drop the grant rows first, then the role itself (FK-safe in one round-trip).
  TursoClient.batch([
    { sql: 'DELETE FROM role_permissions WHERE role_code = ?', args: [roleCode] },
    { sql: 'DELETE FROM roles WHERE role_code = ?',            args: [roleCode] },
  ]);

  Audit.log({
    actor: actor, action: 'ROLE_DELETED', entity: 'roles', entityId: roleCode,
    before: { role_code: existing.role_code, role_name: existing.role_name, scope: existing.scope },
  });

  return { success: true, role_code: roleCode };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerRbac_() {
  register({ service: 'rbac', action: 'listRoles',       permission: 'order.manage', handler: _rbacListRoles_ });
  register({ service: 'rbac', action: 'getRole',         permission: 'order.manage', handler: _rbacGetRole_ });
  register({ service: 'rbac', action: 'listPermissions', permission: 'order.manage', handler: _rbacListPermissions_ });
  register({ service: 'rbac', action: 'assignRole',      permission: 'role.assign',  handler: _rbacAssignRole_ });
  register({ service: 'rbac', action: 'updateRole',      permission: 'role.assign',  handler: _rbacUpdateRole_ });
  register({ service: 'rbac', action: 'createRole',      permission: 'role.assign',  handler: _rbacCreateRole_ });
  register({ service: 'rbac', action: 'deleteRole',      permission: 'role.assign',  handler: _rbacDeleteRole_ });
})();
