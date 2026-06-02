/**
 * 40_svc_rbac.gs  —  Hass CMS rebuild
 *
 * Dashboard RBAC read/assign endpoints used by partial_rbac.html.
 * The client calls rbac.listRoles / rbac.assignRole, but only users.setRoles
 * existed previously. These handlers read the real roles / role_permissions /
 * user_roles tables (see 20_rbac.gs for the permission-resolution logic).
 *
 *   rbac.listRoles  → all roles + their permission list
 *   rbac.assignRole → insert a (user_id, role_code) binding into user_roles
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
    '       r.is_active, ' +
    '       r.role_code AS role_id, ' +
    '       GROUP_CONCAT(rp.permission_code) AS perm_csv ' +
    'FROM roles r ' +
    'LEFT JOIN role_permissions rp ON rp.role_code = r.role_code ' +
    'GROUP BY r.role_code, r.role_name, r.scope, r.is_active ' +
    'ORDER BY r.role_code',
    []
  );

  return rows.map(function (r) {
    var perms = r.perm_csv ? String(r.perm_csv).split(',').filter(Boolean) : [];
    return {
      role_code:        r.role_code,
      role_id:          r.role_id,
      label:            r.label,
      role_name:        r.label,
      scope:            r.scope,
      country_code:     null,
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

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerRbac_() {
  register({ service: 'rbac', action: 'listRoles',  permission: 'order.manage', handler: _rbacListRoles_ });
  register({ service: 'rbac', action: 'assignRole', permission: 'role.assign',  handler: _rbacAssignRole_ });
})();
