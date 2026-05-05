/**
 * HASS PETROLEUM CMS - RoleService.gs
 * Version: 1.0.0
 *
 * Granular Super Admin role reassignment service.
 *
 * Closes the operational gap where every role grant/revoke required a manual
 * SQL update against `user_roles`. This service exposes single-role mutators
 * with the protection rules from the gap analysis (last SUPER_ADMIN, last
 * role on an active user, system-reserved role gating, idempotency) and an
 * audit_log entry for every change.
 *
 * Public API (called from the page UI through the `roles` doPost service):
 *   RoleService.assignRole(targetUserId, roleCode, reason, actorUserId)
 *   RoleService.revokeRole(targetUserId, roleCode, reason, actorUserId)
 *   RoleService.getUserRoles(userId)         -> ['CS_AGENT', 'BD_REP', ...]
 *   RoleService.getRoleUsers(roleCode)       -> [{ user_id, email, name, country_code, status }, ...]
 *
 * Permission required for any mutator: `role.assign`.
 */

// ----------------------------------------------------------------
// Typed errors
// ----------------------------------------------------------------

function LastSuperAdminError(msg) {
  var e = new Error(msg || 'There must be at least one Super Administrator. Grant SUPER_ADMIN to another user first.');
  e.name = 'LastSuperAdminError';
  e.code = 'LAST_SUPER_ADMIN';
  return e;
}

function LastRoleError(msg) {
  var e = new Error(msg || "Cannot remove the user's only role. Either grant another role first or change user status to INACTIVE.");
  e.name = 'LastRoleError';
  e.code = 'LAST_ROLE';
  return e;
}

// Roles that are flagged is_system=1 in the canonical staff role list.
// Only SUPER_ADMIN may grant or revoke these.
var ROLE_SERVICE_SYSTEM_ROLES_ = ['SUPER_ADMIN', 'CEO', 'CFO', 'RMD', 'INTERNAL_AUDITOR'];
var ROLE_SERVICE_REASON_MIN_CHARS_ = 10;

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function _roleService_isSystemRole_(roleCode) {
  if (!roleCode) return false;
  if (ROLE_SERVICE_SYSTEM_ROLES_.indexOf(roleCode) !== -1) return true;
  try {
    var rows = tursoSelect('SELECT is_system FROM roles WHERE role_code = ?', [roleCode]);
    return rows.length > 0 && parseInt(rows[0].is_system) === 1;
  } catch(e) {
    return false;
  }
}

function _roleService_actorIsSuperAdmin_(actorUserId) {
  if (!actorUserId) return false;
  try {
    var rows = tursoSelect(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ? LIMIT 1',
      [actorUserId, 'SUPER_ADMIN']
    );
    return rows.length > 0;
  } catch(e) {
    return false;
  }
}

function _roleService_userExists_(userId) {
  try {
    var rows = tursoSelect('SELECT user_id FROM users WHERE user_id = ? LIMIT 1', [userId]);
    return rows.length > 0;
  } catch(e) {
    return false;
  }
}

function _roleService_roleExists_(roleCode) {
  try {
    var rows = tursoSelect('SELECT role_code FROM roles WHERE role_code = ? LIMIT 1', [roleCode]);
    return rows.length > 0;
  } catch(e) {
    return false;
  }
}

function _roleService_writeAudit_(action, targetUserId, roleCode, reason, actorUserId) {
  try {
    if (typeof audit_log === 'function') {
      audit_log({
        entity_type:   'user_role',
        entity_id:     String(targetUserId || ''),
        action:        action,
        actor_user_id: actorUserId || '',
        changes:       { role_code: roleCode, reason: String(reason || '') },
      });
    } else if (typeof logAudit === 'function') {
      logAudit('user_role', targetUserId, action, 'STAFF', actorUserId || '', '',
        { role_code: roleCode, reason: String(reason || '') }, {});
    }
  } catch(e) {
    Logger.log('[RoleService] audit write failed: ' + e.message);
  }
}

// ----------------------------------------------------------------
// Public service (namespace)
// ----------------------------------------------------------------

var RoleService = {

  /**
   * Grants `roleCode` to `targetUserId`. Idempotent: returns success without
   * inserting a duplicate row when the user already holds the role.
   *
   * Throws:
   *   PermissionDeniedError  - actor lacks `role.assign`
   *   Error                  - actor isn't SUPER_ADMIN and role is system-reserved
   *   Error                  - reason missing / < 10 chars on system-role grants
   *   Error                  - unknown user / unknown role
   */
  assignRole: function(targetUserId, roleCode, reason, actorUserId) {
    targetUserId = String(targetUserId || '').trim();
    roleCode     = String(roleCode || '').trim();
    reason       = String(reason || '').trim();
    actorUserId  = String(actorUserId || '').trim();

    if (!targetUserId)               throw new Error('targetUserId required');
    if (!roleCode)                   throw new Error('roleCode required');
    if (!actorUserId)                throw new Error('actorUserId required');

    if (!userHasPermission(actorUserId, 'role.assign')) {
      throw (typeof PermissionDeniedError === 'function'
        ? PermissionDeniedError('Permission denied: role.assign', 'role.assign')
        : new Error('Permission denied: role.assign'));
    }

    if (!_roleService_userExists_(targetUserId)) throw new Error('Target user not found: ' + targetUserId);
    if (!_roleService_roleExists_(roleCode))     throw new Error('Role not found: ' + roleCode);

    var isSystem = _roleService_isSystemRole_(roleCode);
    if (isSystem && !_roleService_actorIsSuperAdmin_(actorUserId)) {
      throw new Error('Only a Super Administrator can grant the system-reserved role: ' + roleCode + '.');
    }
    if (isSystem && reason.length < ROLE_SERVICE_REASON_MIN_CHARS_) {
      throw new Error('Granting a system-reserved role requires a reason of at least ' +
        ROLE_SERVICE_REASON_MIN_CHARS_ + ' characters.');
    }

    // Idempotent: if the user already holds the role, log and return.
    var existing = tursoSelect(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ? LIMIT 1',
      [targetUserId, roleCode]
    );
    if (existing.length) {
      return { success: true, message: 'Role already assigned', alreadyAssigned: true };
    }

    var now = new Date().toISOString();
    tursoWrite(
      'INSERT INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
      [targetUserId, roleCode, actorUserId, now]
    );

    // Mirror to legacy users.role for AuthService compatibility when blank.
    try {
      var u = findRow('Users', 'user_id', targetUserId);
      if (u && (!u.role || u.role === '')) {
        updateRow('Users', 'user_id', targetUserId, { role: roleCode });
      }
    } catch(e) { /* non-fatal */ }

    _roleService_writeAudit_('ROLE_GRANTED', targetUserId, roleCode, reason, actorUserId);
    if (typeof _invalidatePermissionCache === 'function') _invalidatePermissionCache(targetUserId);

    return { success: true, message: 'Role granted', role_code: roleCode };
  },

  /**
   * Revokes `roleCode` from `targetUserId`.
   *
   * Throws:
   *   PermissionDeniedError  - actor lacks `role.assign`
   *   LastSuperAdminError    - removing the only remaining SUPER_ADMIN
   *   LastRoleError          - target is ACTIVE and this is their last role
   *   Error                  - actor isn't SUPER_ADMIN and role is system-reserved
   *   Error                  - reason missing / < 10 chars on system-role revokes
   */
  revokeRole: function(targetUserId, roleCode, reason, actorUserId) {
    targetUserId = String(targetUserId || '').trim();
    roleCode     = String(roleCode || '').trim();
    reason       = String(reason || '').trim();
    actorUserId  = String(actorUserId || '').trim();

    if (!targetUserId)  throw new Error('targetUserId required');
    if (!roleCode)      throw new Error('roleCode required');
    if (!actorUserId)   throw new Error('actorUserId required');

    if (!userHasPermission(actorUserId, 'role.assign')) {
      throw (typeof PermissionDeniedError === 'function'
        ? PermissionDeniedError('Permission denied: role.assign', 'role.assign')
        : new Error('Permission denied: role.assign'));
    }

    var isSystem = _roleService_isSystemRole_(roleCode);
    if (isSystem && !_roleService_actorIsSuperAdmin_(actorUserId)) {
      throw new Error('Only a Super Administrator can revoke the system-reserved role: ' + roleCode + '.');
    }
    if (isSystem && reason.length < ROLE_SERVICE_REASON_MIN_CHARS_) {
      throw new Error('Revoking a system-reserved role requires a reason of at least ' +
        ROLE_SERVICE_REASON_MIN_CHARS_ + ' characters.');
    }

    // Verify the user actually holds the role; if not, treat as idempotent success.
    var holding = tursoSelect(
      'SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ? LIMIT 1',
      [targetUserId, roleCode]
    );
    if (!holding.length) {
      return { success: true, message: 'User does not hold this role', alreadyRevoked: true };
    }

    // Constraint: cannot remove the LAST SUPER_ADMIN.
    if (roleCode === 'SUPER_ADMIN') {
      var totalSupers = tursoSelect(
        'SELECT COUNT(*) AS n FROM user_roles WHERE role_code = ?', ['SUPER_ADMIN']
      );
      if ((parseInt(totalSupers[0].n) || 0) <= 1) {
        throw LastSuperAdminError();
      }
    }

    // Constraint: cannot remove the user's last role if their status is ACTIVE.
    var allRoles = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [targetUserId]);
    if (allRoles.length <= 1) {
      var u = findRow('Users', 'user_id', targetUserId) || {};
      if (String(u.status || '').toUpperCase() === 'ACTIVE') {
        throw LastRoleError();
      }
    }

    tursoWrite(
      'DELETE FROM user_roles WHERE user_id = ? AND role_code = ?',
      [targetUserId, roleCode]
    );

    // If legacy users.role still pointed at this role, refresh it.
    try {
      var u2 = findRow('Users', 'user_id', targetUserId);
      if (u2 && u2.role === roleCode) {
        var remaining = tursoSelect(
          'SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [targetUserId]
        );
        updateRow('Users', 'user_id', targetUserId, { role: remaining.length ? remaining[0].role_code : '' });
      }
    } catch(e) { /* non-fatal */ }

    _roleService_writeAudit_('ROLE_REVOKED', targetUserId, roleCode, reason, actorUserId);
    if (typeof _invalidatePermissionCache === 'function') _invalidatePermissionCache(targetUserId);

    return { success: true, message: 'Role revoked', role_code: roleCode };
  },

  /**
   * Returns the role_codes the given user currently holds.
   */
  getUserRoles: function(userId) {
    if (!userId) return [];
    var rows = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [userId]);
    return rows.map(function(r) { return r.role_code; });
  },

  /**
   * Returns the users currently holding `roleCode`.
   */
  getRoleUsers: function(roleCode) {
    if (!roleCode) return [];
    var rows = tursoSelect(
      'SELECT u.user_id, u.email, u.first_name, u.last_name, u.country_code, u.status ' +
      'FROM user_roles ur JOIN users u ON u.user_id = ur.user_id ' +
      'WHERE ur.role_code = ? ' +
      'ORDER BY u.last_name, u.first_name',
      [roleCode]
    );
    return rows.map(function(r) {
      return {
        user_id:      r.user_id,
        email:        r.email || '',
        name:         ((r.first_name || '') + ' ' + (r.last_name || '')).trim(),
        country_code: r.country_code || '',
        status:       r.status || '',
      };
    });
  },
};

// ----------------------------------------------------------------
// Page data + dispatcher (called from doPost via service: 'roles')
// ----------------------------------------------------------------

/**
 * Returns the data the role-assignment page needs in one call:
 *   - all roles (with is_system flag) ordered for display
 *   - all staff users with current role assignments
 */
function listRoleAssignmentData(filters) {
  filters = filters || {};
  try {
    var roles = tursoSelect(
      'SELECT role_code, role_name, description, is_system FROM roles ' +
      "WHERE role_code != 'CUSTOMER' " +
      'ORDER BY is_system DESC, role_name ASC'
    ).map(function(r) {
      return {
        role_code:   r.role_code,
        role_name:   r.role_name,
        description: r.description || '',
        is_system:   parseInt(r.is_system) === 1,
      };
    });

    var sql = 'SELECT user_id, email, first_name, last_name, country_code, status FROM users WHERE 1=1';
    var args = [];
    if (filters.search) {
      sql += ' AND (LOWER(email) LIKE ? OR LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ?)';
      var q = '%' + String(filters.search).toLowerCase() + '%';
      args.push(q, q, q);
    }
    sql += ' ORDER BY last_name, first_name LIMIT 500';
    var users = tursoSelect(sql, args);

    var assignments = tursoSelect('SELECT user_id, role_code FROM user_roles');
    var byUser = {};
    assignments.forEach(function(a) {
      (byUser[a.user_id] = byUser[a.user_id] || []).push(a.role_code);
    });

    return {
      success: true,
      roles: roles,
      users: users.map(function(u) {
        return {
          user_id:      u.user_id,
          email:        u.email || '',
          name:         ((u.first_name || '') + ' ' + (u.last_name || '')).trim(),
          country_code: u.country_code || '',
          status:       u.status || '',
          roles:        byUser[u.user_id] || [],
        };
      }),
    };
  } catch(e) {
    Logger.log('[RoleService] listRoleAssignmentData error: ' + e.message);
    return { success: false, error: e.message };
  }
}

function handleRoleRequest(params) {
  try {
    var session = params && params._session;
    var actor   = (session && session.userId) || '';
    var action  = params && params.action;

    switch (action) {
      case 'listAssignmentData':
        if (typeof requirePermission === 'function') requirePermission(session, 'role.assign');
        return listRoleAssignmentData(params.filters || {});

      case 'getUserRoles':
        if (typeof requirePermission === 'function') requirePermission(session, 'role.assign');
        return { success: true, roles: RoleService.getUserRoles(params.userId) };

      case 'getRoleUsers':
        if (typeof requirePermission === 'function') requirePermission(session, 'role.assign');
        return { success: true, users: RoleService.getRoleUsers(params.roleCode) };

      case 'assignRole':
        return RoleService.assignRole(params.targetUserId, params.roleCode, params.reason, actor);

      case 'revokeRole':
        return RoleService.revokeRole(params.targetUserId, params.roleCode, params.reason, actor);

      default:
        return { success: false, error: 'Unknown roles action: ' + action };
    }
  } catch(e) {
    Logger.log('[RoleService] handleRoleRequest error: ' + e.message);
    return {
      success: false,
      error:   e.message,
      code:    e.code || (e.name === 'PermissionDeniedError' ? 'PERMISSION_DENIED' : ''),
    };
  }
}
