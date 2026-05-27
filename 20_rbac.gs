/**
 * 20_rbac.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * global Rbac = { userHasPermission(userId, code),
 *                 requirePermission(session, code),
 *                 userPermissions(userId),
 *                 isMfaRequiredForRole(roleCode) }
 *
 * SUPER_ADMIN holds the '*' wildcard permission.
 * Per-request permission set is cached in a module-scope map (cleared between
 * GAS invocations naturally; module var lives for the duration of one request).
 */

var Rbac = (function () {

  // Module-scope per-request cache (GAS is stateless per invocation).
  var _cache_ = {};

  // Fallback MFA-required roles if roles.mfa_required column is absent.
  var _MFA_ROLES_ = ['SUPER_ADMIN', 'CEO', 'CFO', 'RMD', 'INTERNAL_AUDITOR', 'FINANCE_MANAGER'];

  function userPermissions(userId) {
    if (!userId) return [];
    if (_cache_[userId]) return _cache_[userId];

    var perms = [];
    try {
      // Collect role codes for this user.
      var roles = TursoClient.select(
        'SELECT role_code FROM user_roles WHERE user_id = ?', [userId]
      );

      if (!roles.length) {
        // Legacy fallback: read users.role directly.
        var uRows = TursoClient.select(
          'SELECT role FROM users WHERE user_id = ? LIMIT 1', [userId]
        );
        if (uRows.length && uRows[0].role) {
          roles = [{ role_code: uRows[0].role }];
        }
      }

      var hasWildcard = false;
      var seen = {};
      roles.forEach(function (r) {
        var grants = TursoClient.select(
          'SELECT permission_code FROM role_permissions WHERE role_code = ?',
          [r.role_code]
        );
        grants.forEach(function (g) {
          if (g.permission_code === '*') { hasWildcard = true; }
          else if (!seen[g.permission_code]) {
            seen[g.permission_code] = true;
            perms.push(g.permission_code);
          }
        });
      });
      if (hasWildcard) perms.push('*');
    } catch (e) {
      Log.error({ service: 'Rbac', action: 'userPermissions', msg: e.message });
    }

    _cache_[userId] = perms;
    return perms;
  }

  function userHasPermission(userId, code) {
    if (!userId || !code) return false;
    var perms = userPermissions(userId);
    return perms.indexOf('*') !== -1 || perms.indexOf(code) !== -1;
  }

  function requirePermission(session, code) {
    if (!session || !session.userId) {
      throw new Errors.PermissionDenied('Authentication required.');
    }
    if (!userHasPermission(session.userId, code)) {
      throw new Errors.PermissionDenied('Missing permission: ' + code);
    }
  }

  function isMfaRequiredForRole(roleCode) {
    if (!roleCode) return false;
    try {
      var rows = TursoClient.select(
        'SELECT mfa_required FROM roles WHERE role_code = ? LIMIT 1', [roleCode]
      );
      if (rows.length && rows[0].mfa_required !== null && rows[0].mfa_required !== undefined) {
        return String(rows[0].mfa_required) === '1' || rows[0].mfa_required === true;
      }
    } catch (e) {
      // Column may not exist yet; fall through to hardcoded list.
    }
    return _MFA_ROLES_.indexOf(String(roleCode).toUpperCase()) !== -1;
  }

  // Expose cache-clearing for tests.
  function _clearCache_() { _cache_ = {}; }

  return {
    userPermissions:      userPermissions,
    userHasPermission:    userHasPermission,
    requirePermission:    requirePermission,
    isMfaRequiredForRole: isMfaRequiredForRole,
    _clearCache_:         _clearCache_,
  };

})();
