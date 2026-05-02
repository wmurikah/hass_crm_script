/**
 * HASS PETROLEUM CMS - PermissionService.gs
 * Version: 1.0.0
 *
 * Role-Based Access Control (RBAC) backed by Turso.
 *
 * Tables (created/verified by verifyAndMigrateRBAC()):
 *   - roles                  (role_code, role_name, description, is_system, created_at)
 *   - permissions            (permission_code, label, category, description)
 *   - role_permissions       (role_code, permission_code)            -- composite PK
 *   - user_roles             (user_id, role_code, assigned_by, assigned_at) -- composite PK
 *
 * Public API:
 *   verifyAndMigrateRBAC()                      - idempotent schema + seed
 *   handlePermissionRequest(params)             - dispatcher for the UI
 *   userHasPermission(userId, permissionCode)   - guard helper (cached per request)
 *   userPermissions(userId)                     - list all permissions for a user
 *   requirePermission(session, permissionCode)  - throws if missing (use in services)
 *
 * Notes:
 *   - SUPER_ADMIN role is treated as wildcard (*) - has every permission.
 *   - The legacy `users.role` column remains as a fallback when no rows exist
 *     in user_roles for that user. This keeps existing data working.
 */

// ============================================================================
// PERMISSION CATALOG  (default seed - editable by Super Admin via UI)
// ============================================================================

var DEFAULT_PERMISSIONS_ = [
  // Users & Roles
  { code: 'users.view',          label: 'View users',                category: 'Users & Roles' },
  { code: 'users.create',        label: 'Create users',              category: 'Users & Roles' },
  { code: 'users.edit',          label: 'Edit user details',         category: 'Users & Roles' },
  { code: 'users.delete',        label: 'Deactivate / delete users', category: 'Users & Roles' },
  { code: 'users.reset_password',label: 'Reset user passwords',      category: 'Users & Roles' },
  { code: 'roles.view',          label: 'View roles & permissions',  category: 'Users & Roles' },
  { code: 'roles.assign',        label: 'Assign roles to users',     category: 'Users & Roles' },
  { code: 'roles.manage',        label: 'Create / edit roles',       category: 'Users & Roles' },
  { code: 'permissions.manage',  label: 'Toggle permissions on roles', category: 'Users & Roles' },
  // Customers
  { code: 'customers.view',      label: 'View customers',            category: 'Customers' },
  { code: 'customers.create',    label: 'Create customers',          category: 'Customers' },
  { code: 'customers.edit',      label: 'Edit customers',            category: 'Customers' },
  { code: 'customers.delete',    label: 'Delete customers',          category: 'Customers' },
  { code: 'customers.statements',label: 'Run customer statements',   category: 'Customers' },
  // Orders
  { code: 'orders.view',         label: 'View orders',               category: 'Orders' },
  { code: 'orders.create',       label: 'Create orders',             category: 'Orders' },
  { code: 'orders.edit',         label: 'Edit orders',               category: 'Orders' },
  { code: 'orders.approve',      label: 'Approve orders',            category: 'Orders' },
  { code: 'orders.cancel',       label: 'Cancel orders',             category: 'Orders' },
  // Tickets
  { code: 'tickets.view',        label: 'View tickets',              category: 'Tickets' },
  { code: 'tickets.create',      label: 'Create tickets',            category: 'Tickets' },
  { code: 'tickets.edit',        label: 'Edit tickets',              category: 'Tickets' },
  { code: 'tickets.assign',      label: 'Assign tickets',            category: 'Tickets' },
  { code: 'tickets.resolve',     label: 'Resolve / close tickets',   category: 'Tickets' },
  // Uploads
  { code: 'uploads.la',          label: 'Upload LA (Loading Authority) data', category: 'Data Uploads' },
  { code: 'uploads.po',          label: 'Upload PO (Purchase Order) data',    category: 'Data Uploads' },
  // Integrations
  { code: 'integrations.view',     label: 'View integration config',  category: 'Integrations' },
  { code: 'integrations.configure',label: 'Configure integrations',   category: 'Integrations' },
  { code: 'integrations.run_sync', label: 'Trigger Oracle sync jobs', category: 'Integrations' },
  // Reports & Analytics
  { code: 'reports.view',        label: 'View reports',              category: 'Reports' },
  { code: 'reports.export',      label: 'Export reports',            category: 'Reports' },
  // Settings
  { code: 'settings.view',       label: 'View settings',             category: 'Settings' },
  { code: 'settings.edit',       label: 'Edit settings',             category: 'Settings' },
  { code: 'backups.run',         label: 'Run backups',               category: 'Settings' },
  // Customer portal (for CUSTOMER role members)
  { code: 'portal.view_invoices',  label: 'View own invoices',       category: 'Customer Portal' },
  { code: 'portal.run_statement',  label: 'Run own account statement', category: 'Customer Portal' },
  { code: 'portal.place_orders',   label: 'Place new orders',        category: 'Customer Portal' },
];

var DEFAULT_ROLES_ = [
  { code: 'SUPER_ADMIN',     name: 'Super Admin',     description: 'Full access (wildcard).', is_system: 1,
    perms: ['*'] },
  { code: 'ADMIN',           name: 'Administrator',   description: 'Administrative access except destructive root ops.', is_system: 1,
    perms: ['users.view','users.create','users.edit','users.reset_password','roles.view','roles.assign',
            'customers.view','customers.create','customers.edit','customers.statements',
            'orders.view','orders.create','orders.edit','orders.approve',
            'tickets.view','tickets.create','tickets.edit','tickets.assign','tickets.resolve',
            'uploads.la','uploads.po',
            'integrations.view','integrations.configure','integrations.run_sync',
            'reports.view','reports.export','settings.view','settings.edit','backups.run'] },
  { code: 'CS_MANAGER',      name: 'CS Manager',      description: 'Customer service manager.', is_system: 0,
    perms: ['users.view','customers.view','customers.edit','orders.view','orders.edit','orders.approve',
            'tickets.view','tickets.create','tickets.edit','tickets.assign','tickets.resolve','reports.view'] },
  { code: 'CS_AGENT',        name: 'CS Agent',        description: 'Customer service agent.', is_system: 0,
    perms: ['customers.view','orders.view','orders.create','tickets.view','tickets.create','tickets.edit','tickets.resolve'] },
  { code: 'BD_MANAGER',      name: 'BD Manager',      description: 'Business development manager.', is_system: 0,
    perms: ['customers.view','customers.create','customers.edit','orders.view','reports.view','reports.export'] },
  { code: 'BD_REP',          name: 'BD Representative', description: 'BD field rep.', is_system: 0,
    perms: ['customers.view','customers.create','orders.view','orders.create'] },
  { code: 'FINANCE_OFFICER', name: 'Finance Officer', description: 'Finance & invoicing.', is_system: 0,
    perms: ['customers.view','customers.statements','orders.view','orders.approve','reports.view','reports.export','uploads.la'] },
  { code: 'COUNTRY_MANAGER', name: 'Country Manager', description: 'Country-level oversight.', is_system: 0,
    perms: ['users.view','customers.view','orders.view','orders.approve','tickets.view','reports.view','reports.export'] },
  { code: 'REGIONAL_MANAGER',name: 'Regional Manager', description: 'Regional oversight.', is_system: 0,
    perms: ['users.view','customers.view','orders.view','tickets.view','reports.view','reports.export'] },
  { code: 'GROUP_HEAD',      name: 'Group Head',      description: 'Group-level executive.', is_system: 0,
    perms: ['users.view','customers.view','orders.view','tickets.view','reports.view','reports.export','integrations.view'] },
  { code: 'VIEWER',          name: 'Viewer',          description: 'Read-only.', is_system: 0,
    perms: ['users.view','customers.view','orders.view','tickets.view','reports.view'] },
  { code: 'CUSTOMER',        name: 'Customer',        description: 'External customer portal user.', is_system: 1,
    perms: ['portal.view_invoices','portal.run_statement','portal.place_orders'] },
];

// ============================================================================
// SCHEMA VERIFY + MIGRATE  (idempotent - safe to re-run)
// ============================================================================

/**
 * Verifies/creates the RBAC tables in Turso and seeds default roles/permissions.
 * Safe to call repeatedly - tables use IF NOT EXISTS, rows use INSERT OR IGNORE.
 *
 * Run once from the Apps Script IDE after deploy, OR call from the Super Admin
 * UI (action: 'verifyAndMigrateRBAC').
 *
 * Returns a report describing actions taken.
 */
function verifyAndMigrateRBAC() {
  var report = { steps: [], errors: [], success: true };

  function step(name, fn) {
    try { fn(); report.steps.push('OK: ' + name); }
    catch(e) { report.success = false; report.errors.push(name + ': ' + e.message); Logger.log('[RBAC] ' + name + ' FAILED: ' + e.message); }
  }

  step('CREATE TABLE roles', function() {
    tursoWrite(
      'CREATE TABLE IF NOT EXISTS roles (' +
      ' role_code TEXT PRIMARY KEY,' +
      ' role_name TEXT NOT NULL,' +
      ' description TEXT,' +
      ' is_system INTEGER DEFAULT 0,' +
      ' created_at TEXT,' +
      ' updated_at TEXT' +
      ')'
    );
  });

  step('CREATE TABLE permissions', function() {
    tursoWrite(
      'CREATE TABLE IF NOT EXISTS permissions (' +
      ' permission_code TEXT PRIMARY KEY,' +
      ' label TEXT NOT NULL,' +
      ' category TEXT,' +
      ' description TEXT,' +
      ' created_at TEXT' +
      ')'
    );
  });

  step('CREATE TABLE role_permissions', function() {
    tursoWrite(
      'CREATE TABLE IF NOT EXISTS role_permissions (' +
      ' role_code TEXT NOT NULL,' +
      ' permission_code TEXT NOT NULL,' +
      ' granted_at TEXT,' +
      ' PRIMARY KEY (role_code, permission_code)' +
      ')'
    );
  });

  step('CREATE TABLE user_roles', function() {
    tursoWrite(
      'CREATE TABLE IF NOT EXISTS user_roles (' +
      ' user_id TEXT NOT NULL,' +
      ' role_code TEXT NOT NULL,' +
      ' assigned_by TEXT,' +
      ' assigned_at TEXT,' +
      ' PRIMARY KEY (user_id, role_code)' +
      ')'
    );
  });

  step('CREATE INDEX ix_user_roles_user', function() {
    tursoWrite('CREATE INDEX IF NOT EXISTS ix_user_roles_user ON user_roles(user_id)');
  });

  // Seed permissions
  step('Seed default permissions', function() {
    var now = new Date().toISOString();
    var stmts = DEFAULT_PERMISSIONS_.map(function(p) {
      return {
        sql: 'INSERT OR IGNORE INTO permissions (permission_code, label, category, description, created_at) VALUES (?,?,?,?,?)',
        args: [p.code, p.label, p.category, p.description || '', now]
      };
    });
    if (stmts.length) tursoBatchWrite(stmts);
  });

  // Seed roles
  step('Seed default roles', function() {
    var now = new Date().toISOString();
    var stmts = DEFAULT_ROLES_.map(function(r) {
      return {
        sql: 'INSERT OR IGNORE INTO roles (role_code, role_name, description, is_system, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        args: [r.code, r.name, r.description, r.is_system, now, now]
      };
    });
    if (stmts.length) tursoBatchWrite(stmts);
  });

  // Seed role-permission grants
  step('Seed role permissions', function() {
    var now = new Date().toISOString();
    var stmts = [];
    DEFAULT_ROLES_.forEach(function(r) {
      r.perms.forEach(function(perm) {
        stmts.push({
          sql: 'INSERT OR IGNORE INTO role_permissions (role_code, permission_code, granted_at) VALUES (?,?,?)',
          args: [r.code, perm, now]
        });
      });
    });
    // batch in chunks of 50
    for (var i = 0; i < stmts.length; i += 50) {
      tursoBatchWrite(stmts.slice(i, i + 50));
    }
  });

  // Backfill user_roles from legacy users.role column
  step('Backfill user_roles from users.role', function() {
    var users = tursoSelect("SELECT user_id, role FROM users WHERE role IS NOT NULL AND role != ''");
    if (!users.length) return;
    var existing = tursoSelect('SELECT user_id, role_code FROM user_roles');
    var seen = {};
    existing.forEach(function(r) { seen[r.user_id + '|' + r.role_code] = true; });
    var now = new Date().toISOString();
    var stmts = [];
    users.forEach(function(u) {
      var key = u.user_id + '|' + u.role;
      if (seen[key]) return;
      stmts.push({
        sql: 'INSERT OR IGNORE INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
        args: [u.user_id, u.role, 'MIGRATION', now]
      });
    });
    for (var i = 0; i < stmts.length; i += 50) {
      tursoBatchWrite(stmts.slice(i, i + 50));
    }
    report.steps.push('   backfilled ' + stmts.length + ' user_roles rows');
  });

  Logger.log('[RBAC] verifyAndMigrateRBAC: ' + JSON.stringify(report, null, 2));
  return report;
}

// ============================================================================
// PERMISSION CHECKS
// ============================================================================

/**
 * Returns true if the user has the given permission.
 * SUPER_ADMIN role grants everything.
 * Falls back to legacy users.role string when no user_roles rows exist.
 *
 * Per-request cache via PropertiesService.getUserProperties() is intentionally
 * NOT used (Apps Script invocations are stateless); we cache in a script-scoped
 * object instead.
 */
var _PERM_CACHE_ = { ts: 0, byUser: {} };
var _PERM_CACHE_TTL_MS_ = 60 * 1000; // 60s

function userPermissions(userId) {
  if (!userId) return [];
  var now = Date.now();
  if (now - _PERM_CACHE_.ts > _PERM_CACHE_TTL_MS_) {
    _PERM_CACHE_ = { ts: now, byUser: {} };
  }
  if (_PERM_CACHE_.byUser[userId]) return _PERM_CACHE_.byUser[userId];

  var perms = [];
  try {
    // Try user_roles first
    var rows = tursoSelect(
      'SELECT DISTINCT rp.permission_code AS code FROM user_roles ur ' +
      'JOIN role_permissions rp ON rp.role_code = ur.role_code ' +
      'WHERE ur.user_id = ?', [userId]
    );
    perms = rows.map(function(r) { return r.code; });

    // Wildcard?
    var roles = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [userId]);
    var hasWildcard = roles.some(function(r) {
      var grants = tursoSelect('SELECT permission_code FROM role_permissions WHERE role_code = ? AND permission_code = ?', [r.role_code, '*']);
      return grants.length > 0;
    });
    if (hasWildcard) perms.push('*');

    // Legacy fallback: read users.role and resolve via role_permissions
    if (perms.length === 0) {
      var u = findRow('Users', 'user_id', userId);
      if (u && u.role) {
        var legacyRows = tursoSelect('SELECT permission_code FROM role_permissions WHERE role_code = ?', [u.role]);
        perms = legacyRows.map(function(r) { return r.permission_code; });
      }
    }
  } catch(e) {
    Logger.log('[Permission] userPermissions error: ' + e.message);
  }

  _PERM_CACHE_.byUser[userId] = perms;
  return perms;
}

function userHasPermission(userId, permissionCode) {
  if (!userId || !permissionCode) return false;
  var perms = userPermissions(userId);
  if (perms.indexOf('*') !== -1) return true;
  return perms.indexOf(permissionCode) !== -1;
}

/**
 * Throws an Error if the session user lacks the permission.
 * Use inside service handlers:
 *   requirePermission(params._session, 'users.create');
 */
function requirePermission(session, permissionCode) {
  if (!session || !session.userId) throw new Error('Authentication required');
  if (!userHasPermission(session.userId, permissionCode)) {
    throw new Error('Permission denied: ' + permissionCode);
  }
}

function _invalidatePermissionCache(userId) {
  if (!userId) { _PERM_CACHE_ = { ts: 0, byUser: {} }; return; }
  if (_PERM_CACHE_.byUser) delete _PERM_CACHE_.byUser[userId];
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

function listRoles() {
  try {
    var roles = tursoSelect('SELECT * FROM roles ORDER BY is_system DESC, role_name ASC');
    var grants = tursoSelect('SELECT role_code, permission_code FROM role_permissions');
    var byRole = {};
    grants.forEach(function(g) {
      if (!byRole[g.role_code]) byRole[g.role_code] = [];
      byRole[g.role_code].push(g.permission_code);
    });
    var counts = tursoSelect('SELECT role_code, COUNT(*) AS user_count FROM user_roles GROUP BY role_code');
    var countMap = {};
    counts.forEach(function(c) { countMap[c.role_code] = parseInt(c.user_count) || 0; });
    return {
      success: true,
      roles: roles.map(function(r) {
        return {
          role_code:    r.role_code,
          role_name:    r.role_name,
          description:  r.description || '',
          is_system:    parseInt(r.is_system) === 1,
          permissions:  byRole[r.role_code] || [],
          user_count:   countMap[r.role_code] || 0,
        };
      })
    };
  } catch(e) {
    return { success: false, error: e.message, roles: [] };
  }
}

function listPermissions() {
  try {
    var perms = tursoSelect('SELECT * FROM permissions ORDER BY category ASC, label ASC');
    return { success: true, permissions: perms };
  } catch(e) {
    return { success: false, error: e.message, permissions: [] };
  }
}

function getUserRoles(userId) {
  if (!userId) return { success: false, error: 'userId required' };
  try {
    var rows = tursoSelect(
      'SELECT ur.role_code, r.role_name, ur.assigned_by, ur.assigned_at ' +
      'FROM user_roles ur LEFT JOIN roles r ON r.role_code = ur.role_code ' +
      'WHERE ur.user_id = ?', [userId]
    );
    return { success: true, roles: rows, permissions: userPermissions(userId) };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// MUTATIONS
// ============================================================================

function createRole(data, actorId) {
  if (!data || !data.role_code || !data.role_name) {
    return { success: false, error: 'role_code and role_name required' };
  }
  var code = String(data.role_code).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!code) return { success: false, error: 'Invalid role_code' };
  var existing = findRow('Users', 'role', code); // best-effort dup check via roles table below
  try {
    var dup = tursoSelect('SELECT role_code FROM roles WHERE role_code = ?', [code]);
    if (dup.length) return { success: false, error: 'Role already exists: ' + code };
    var now = new Date().toISOString();
    tursoWrite(
      'INSERT INTO roles (role_code, role_name, description, is_system, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      [code, data.role_name, data.description || '', 0, now, now]
    );
    if (Array.isArray(data.permissions)) {
      var stmts = data.permissions.map(function(p) {
        return { sql: 'INSERT OR IGNORE INTO role_permissions (role_code, permission_code, granted_at) VALUES (?,?,?)',
                 args: [code, p, now] };
      });
      if (stmts.length) tursoBatchWrite(stmts);
    }
    _invalidatePermissionCache();
    return { success: true, role_code: code, message: 'Role created' };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function updateRole(roleCode, data, actorId) {
  if (!roleCode) return { success: false, error: 'roleCode required' };
  try {
    var existing = tursoSelect('SELECT * FROM roles WHERE role_code = ?', [roleCode]);
    if (!existing.length) return { success: false, error: 'Role not found' };
    var now = new Date().toISOString();
    var sets = [], args = [];
    if (data.role_name)   { sets.push('role_name = ?');   args.push(data.role_name); }
    if (data.description !== undefined) { sets.push('description = ?'); args.push(data.description); }
    if (sets.length) {
      sets.push('updated_at = ?'); args.push(now); args.push(roleCode);
      tursoWrite('UPDATE roles SET ' + sets.join(', ') + ' WHERE role_code = ?', args);
    }
    _invalidatePermissionCache();
    return { success: true, message: 'Role updated' };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function deleteRole(roleCode, actorId) {
  if (!roleCode) return { success: false, error: 'roleCode required' };
  try {
    var role = tursoSelect('SELECT is_system FROM roles WHERE role_code = ?', [roleCode]);
    if (!role.length) return { success: false, error: 'Role not found' };
    if (parseInt(role[0].is_system) === 1) return { success: false, error: 'Cannot delete system role' };
    var users = tursoSelect('SELECT COUNT(*) AS cnt FROM user_roles WHERE role_code = ?', [roleCode]);
    if (parseInt(users[0].cnt) > 0) return { success: false, error: 'Role still assigned to ' + users[0].cnt + ' user(s). Reassign first.' };
    tursoWrite('DELETE FROM role_permissions WHERE role_code = ?', [roleCode]);
    tursoWrite('DELETE FROM roles WHERE role_code = ?', [roleCode]);
    _invalidatePermissionCache();
    return { success: true, message: 'Role deleted' };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function setRolePermission(roleCode, permissionCode, granted) {
  if (!roleCode || !permissionCode) return { success: false, error: 'roleCode and permissionCode required' };
  try {
    if (granted) {
      tursoWrite('INSERT OR IGNORE INTO role_permissions (role_code, permission_code, granted_at) VALUES (?,?,?)',
        [roleCode, permissionCode, new Date().toISOString()]);
    } else {
      tursoWrite('DELETE FROM role_permissions WHERE role_code = ? AND permission_code = ?', [roleCode, permissionCode]);
    }
    _invalidatePermissionCache();
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function assignRoleToUser(userId, roleCode, actorId) {
  if (!userId || !roleCode) return { success: false, error: 'userId and roleCode required' };
  try {
    var dup = tursoSelect('SELECT 1 FROM user_roles WHERE user_id = ? AND role_code = ?', [userId, roleCode]);
    if (dup.length) return { success: true, message: 'Already assigned' };
    tursoWrite('INSERT INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
      [userId, roleCode, actorId || 'SYSTEM', new Date().toISOString()]);
    // Mirror to legacy users.role (first assigned role wins) so AuthService continues to work
    try {
      var u = findRow('Users', 'user_id', userId);
      if (u && (!u.role || u.role === '')) {
        updateRow('Users', 'user_id', userId, { role: roleCode });
      }
    } catch(e) {}
    _invalidatePermissionCache(userId);
    return { success: true, message: 'Role assigned' };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function removeRoleFromUser(userId, roleCode, actorId) {
  if (!userId || !roleCode) return { success: false, error: 'userId and roleCode required' };
  try {
    tursoWrite('DELETE FROM user_roles WHERE user_id = ? AND role_code = ?', [userId, roleCode]);
    // If legacy users.role still matches, clear it (next assignment will repopulate)
    try {
      var u = findRow('Users', 'user_id', userId);
      if (u && u.role === roleCode) {
        var remaining = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ? LIMIT 1', [userId]);
        updateRow('Users', 'user_id', userId, { role: remaining.length ? remaining[0].role_code : '' });
      }
    } catch(e) {}
    _invalidatePermissionCache(userId);
    return { success: true, message: 'Role removed' };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// REQUEST DISPATCHER
// ============================================================================

function handlePermissionRequest(params) {
  try {
    var action = params.action;
    var actor  = (params._session && params._session.userId) || 'SYSTEM';

    // All mutating actions require the corresponding permission.
    switch (action) {
      case 'verifyAndMigrate':
        if (params._session) requirePermission(params._session, 'roles.manage');
        return verifyAndMigrateRBAC();

      case 'listRoles':
        return listRoles();

      case 'listPermissions':
        return listPermissions();

      case 'getUserRoles':
        return getUserRoles(params.userId);

      case 'getMyPermissions':
        if (!params._session) return { success: false, error: 'No session' };
        return { success: true, permissions: userPermissions(params._session.userId) };

      case 'createRole':
        requirePermission(params._session, 'roles.manage');
        return createRole(params.data, actor);

      case 'updateRole':
        requirePermission(params._session, 'roles.manage');
        return updateRole(params.roleCode, params.data, actor);

      case 'deleteRole':
        requirePermission(params._session, 'roles.manage');
        return deleteRole(params.roleCode, actor);

      case 'setRolePermission':
        requirePermission(params._session, 'permissions.manage');
        return setRolePermission(params.roleCode, params.permissionCode, !!params.granted);

      case 'assignRole':
        requirePermission(params._session, 'roles.assign');
        return assignRoleToUser(params.userId, params.roleCode, actor);

      case 'removeRole':
        requirePermission(params._session, 'roles.assign');
        return removeRoleFromUser(params.userId, params.roleCode, actor);

      default:
        return { success: false, error: 'Unknown permission action: ' + action };
    }
  } catch(e) {
    Logger.log('[Permission] ' + e.message);
    return { success: false, error: e.message };
  }
}
