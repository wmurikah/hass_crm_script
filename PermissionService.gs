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

      // --- Stage 1/2/5 actions for canonical staff roles ---------------------
      case 'runStaffRolesBaseline':
        requirePermission(params._session, 'roles.view');
        return runStaffRolesBaseline();

      case 'applyCanonicalStaffRolesMigration':
        requirePermission(params._session, 'roles.manage');
        return applyCanonicalStaffRolesMigration(actor);

      case 'staffHeadcountReconciliation':
        requirePermission(params._session, 'roles.view');
        return staffHeadcountReconciliation();

      // --- Stage 4: admin UI primary actions --------------------------------
      case 'listUsersForRoleAdmin':
        requirePermission(params._session, 'roles.assign');
        return listUsersForRoleAdmin(params.filters || {});

      case 'setUserRoles':
        requirePermission(params._session, 'roles.assign');
        return setUserRoles(params.userId, params.roleCodes || [], params.reason || '', actor);

      default:
        return { success: false, error: 'Unknown permission action: ' + action };
    }
  } catch(e) {
    Logger.log('[Permission] ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// CANONICAL STAFF ROLES (per gap analysis §2.1)
// ============================================================================

var CANONICAL_STAFF_ROLES_ = [
  { code: 'SUPER_ADMIN',  name: 'Super Administrator',     scope: 'GLOBAL',       is_system: 1, target_min: 2,  target_max: 2,
    description: 'Group IT lead and designated CTO delegate. Full system access. Country scope: All.' },
  { code: 'ADMIN',        name: 'Administrator',           scope: 'COUNTRY',      is_system: 1, target_min: 4,  target_max: 6,
    description: 'Country IT and system administrators. Country-bound.' },
  { code: 'CEO',          name: 'Chief Executive',         scope: 'GLOBAL',       is_system: 1, target_min: 1,  target_max: 1,
    description: 'Group Chief Executive. Read-write across all countries. Final approver for high-value orders.' },
  { code: 'CFO',          name: 'Chief Financial Officer', scope: 'GLOBAL',       is_system: 1, target_min: 1,  target_max: 1,
    description: 'Group Chief Financial Officer. Finance approvals, refunds, credit limits.' },
  { code: 'COUNTRY_HEAD', name: 'Country General Manager', scope: 'COUNTRY',      is_system: 0, target_min: 4,  target_max: 4,
    description: 'Country General Manager. Country-bound. Approves operations within country scope.' },
  { code: 'MANAGER',      name: 'Department Manager',      scope: 'COUNTRY',      is_system: 0, target_min: 8,  target_max: 12,
    description: 'Department Manager. Country-bound. Approves orders and team operations.' },
  { code: 'SUPERVISOR',   name: 'Team Supervisor',         scope: 'COUNTRY_TEAM', is_system: 0, target_min: 12, target_max: 18,
    description: 'Team Supervisor. Country + team-bound. Manages team queue, escalations, and SLA.' },
  { code: 'AGENT',        name: 'Customer Service Agent',  scope: 'COUNTRY_TEAM', is_system: 0, target_min: 20, target_max: 40,
    description: 'Customer Service Agent. Country + team-bound. Frontline ticket and order handling.' },
  { code: 'FINANCE',      name: 'Finance Officer',         scope: 'COUNTRY',      is_system: 0, target_min: 10, target_max: 15,
    description: 'Finance Officer. Country-bound. Invoice, payment, and reconciliation operations.' },
  { code: 'KYC_OFFICER',  name: 'KYC Compliance Officer',  scope: 'COUNTRY',      is_system: 0, target_min: 4,  target_max: 6,
    description: 'KYC Compliance Officer. Country-bound. Customer onboarding and document verification.' },
  { code: 'OPS',          name: 'Operations Officer',      scope: 'COUNTRY',      is_system: 0, target_min: 15, target_max: 25,
    description: 'Operations Officer. Country-bound. Dispatch, depot, and fleet operations.' },
  { code: 'AUDIT_VIEWER', name: 'Audit Read-Only',         scope: 'GLOBAL',       is_system: 1, target_min: 2,  target_max: 4,
    description: 'Audit Read-Only. All countries. Read-only access for internal and external auditors.' },
];

function _canonicalStaffCodes_() {
  return CANONICAL_STAFF_ROLES_.map(function(r) { return r.code; });
}

function _canonicalStaffByCode_(code) {
  for (var i = 0; i < CANONICAL_STAFF_ROLES_.length; i++) {
    if (CANONICAL_STAFF_ROLES_[i].code === code) return CANONICAL_STAFF_ROLES_[i];
  }
  return null;
}

// ============================================================================
// STAGE 1 - BASELINE VERIFICATION (read-only)
// ============================================================================

function runStaffRolesBaseline() {
  try {
    var canonical = CANONICAL_STAFF_ROLES_;
    var canonicalRows = [];
    var dbRoles = tursoSelect('SELECT role_code, role_name, description, is_system FROM roles');
    var dbByCode = {};
    dbRoles.forEach(function(r) { dbByCode[r.role_code] = r; });

    canonical.forEach(function(c) {
      var r = dbByCode[c.code];
      var perms = tursoSelect('SELECT COUNT(*) AS n FROM role_permissions WHERE role_code = ?', [c.code]);
      var users = tursoSelect('SELECT COUNT(*) AS n FROM user_roles       WHERE role_code = ?', [c.code]);
      canonicalRows.push({
        canonical_code: c.code,
        canonical_name: c.name,
        exists_in_db:   !!r,
        db_role_name:   r ? r.role_name : null,
        name_mismatch:  !!r && r.role_name !== c.name,
        perms_count:    parseInt(perms[0].n) || 0,
        users_count:    parseInt(users[0].n) || 0,
      });
    });

    var canonicalCodes = _canonicalStaffCodes_();
    var extras = dbRoles.filter(function(r) { return canonicalCodes.indexOf(r.role_code) === -1; })
      .map(function(r) {
        var perms = tursoSelect('SELECT COUNT(*) AS n FROM role_permissions WHERE role_code = ?', [r.role_code]);
        var users = tursoSelect('SELECT COUNT(*) AS n FROM user_roles       WHERE role_code = ?', [r.role_code]);
        return {
          role_code:   r.role_code,
          role_name:   r.role_name,
          is_system:   parseInt(r.is_system) === 1,
          perms_count: parseInt(perms[0].n) || 0,
          users_count: parseInt(users[0].n) || 0,
        };
      });

    var orphans = tursoSelect(
      'SELECT u.user_id, u.email, u.first_name, u.last_name, u.country_code, u.status ' +
      'FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.user_id ' +
      'WHERE ur.role_code IS NULL'
    );

    return {
      success: true,
      generated_at: new Date().toISOString(),
      canonical: canonicalRows,
      extras: extras,
      orphans: orphans,
      summary: {
        canonical_present: canonicalRows.filter(function(r) { return r.exists_in_db; }).length,
        canonical_missing: canonicalRows.filter(function(r) { return !r.exists_in_db; }).length,
        canonical_name_mismatch: canonicalRows.filter(function(r) { return r.name_mismatch; }).length,
        extras_count: extras.length,
        orphan_users: orphans.length,
      }
    };
  } catch(e) {
    Logger.log('[Permission] runStaffRolesBaseline error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// STAGE 2 - CANONICAL ROLES MIGRATION (idempotent)
// ============================================================================

/**
 * Brings the DB into line with the canonical 12 staff roles. Safe to re-run.
 *
 * Steps performed (in order):
 *   1. ALTER TABLE roles ADD COLUMN scope (if not present).
 *   2. INSERT OR IGNORE each canonical role.
 *   3. UPDATE role_name and description where they differ from canonical.
 *   4. UPDATE scope and is_system to canonical values.
 *   5. Identify (do NOT delete) any extras for human review.
 */
function applyCanonicalStaffRolesMigration(actorId) {
  var report = { success: true, steps: [], updates: [], inserts: [], extras: [], errors: [] };

  function step(name, fn) {
    try { fn(); report.steps.push('OK: ' + name); }
    catch(e) {
      report.success = false;
      report.errors.push(name + ': ' + e.message);
      Logger.log('[RBAC.canon] ' + name + ' FAILED: ' + e.message);
    }
  }

  // 1) Schema: add scope column (best-effort; SQLite raises if it exists, ignore).
  step('Add roles.scope column if missing', function() {
    try {
      var cols = tursoSelect("PRAGMA table_info(roles)");
      var hasScope = cols.some(function(c) { return String(c.name).toLowerCase() === 'scope'; });
      if (!hasScope) {
        tursoWrite("ALTER TABLE roles ADD COLUMN scope TEXT DEFAULT 'COUNTRY'");
      }
    } catch(e) {
      // SQLite ALTER TABLE doesn't support IF NOT EXISTS; swallow if column exists.
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  });

  var now = new Date().toISOString();

  // 2) Insert any missing roles.
  step('Insert missing canonical roles', function() {
    CANONICAL_STAFF_ROLES_.forEach(function(c) {
      var existing = tursoSelect('SELECT role_code FROM roles WHERE role_code = ?', [c.code]);
      if (!existing.length) {
        tursoWrite(
          'INSERT OR IGNORE INTO roles (role_code, role_name, description, is_system, scope, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?)',
          [c.code, c.name, c.description, c.is_system, c.scope, now, now]
        );
        report.inserts.push(c.code);
      }
    });
  });

  // 3+4) Update existing canonical roles to match policy.
  step('Update canonical role metadata', function() {
    CANONICAL_STAFF_ROLES_.forEach(function(c) {
      var existing = tursoSelect('SELECT role_code, role_name, description, is_system, scope FROM roles WHERE role_code = ?', [c.code]);
      if (!existing.length) return;
      var r = existing[0];
      var diff = {};
      if (r.role_name   !== c.name)        diff.role_name   = { from: r.role_name,   to: c.name };
      if ((r.description || '') !== c.description) diff.description = { from: r.description || '', to: c.description };
      if (parseInt(r.is_system) !== c.is_system)   diff.is_system   = { from: parseInt(r.is_system) || 0, to: c.is_system };
      if ((r.scope || '') !== c.scope)             diff.scope       = { from: r.scope || '', to: c.scope };
      if (Object.keys(diff).length === 0) return;
      tursoWrite(
        'UPDATE roles SET role_name = ?, description = ?, is_system = ?, scope = ?, updated_at = ? WHERE role_code = ?',
        [c.name, c.description, c.is_system, c.scope, now, c.code]
      );
      report.updates.push({ role_code: c.code, diff: diff });
    });
  });

  // 5) Identify extras (do NOT delete).
  step('Flag extra (non-canonical) roles', function() {
    var canonicalCodes = _canonicalStaffCodes_();
    var rows = tursoSelect('SELECT role_code, role_name FROM roles');
    rows.forEach(function(r) {
      if (canonicalCodes.indexOf(r.role_code) !== -1) return;
      // Skip the customer portal role - it's intentional, scoped to portal users.
      if (r.role_code === 'CUSTOMER') return;
      var u = tursoSelect('SELECT COUNT(*) AS n FROM user_roles WHERE role_code = ?', [r.role_code]);
      var p = tursoSelect('SELECT COUNT(*) AS n FROM role_permissions WHERE role_code = ?', [r.role_code]);
      report.extras.push({
        role_code: r.role_code,
        role_name: r.role_name,
        users_count: parseInt(u[0].n) || 0,
        perms_count: parseInt(p[0].n) || 0,
        action: 'REVIEW_WITH_AUDIT',
      });
    });
  });

  // Audit log
  try {
    logAudit('Role', 'CANONICAL_MIGRATION', 'MIGRATE', 'STAFF', actorId || 'SYSTEM', '',
      { inserts: report.inserts, updates: report.updates, extras_flagged: report.extras.length },
      { migration: '20260503_001_canonical_staff_roles' });
  } catch(e) { /* logAudit errors are non-fatal */ }

  _invalidatePermissionCache();
  return report;
}

// ============================================================================
// SCOPE + SoD HELPERS (Stage 3)
// ============================================================================

/**
 * Returns the effective scope for a user as
 *   { role: 'BEST_ROLE', scope: 'GLOBAL'|'COUNTRY'|'COUNTRY_TEAM',
 *     country_code: 'KE', team_id: 'TM-...' }
 * The "best" role is the broadest scope the user holds (GLOBAL > COUNTRY > COUNTRY_TEAM).
 */
function getUserScope(userId) {
  if (!userId) return { role: null, scope: null, country_code: '', team_id: '' };
  var u = findRow('Users', 'user_id', userId) || {};
  var rows = tursoSelect(
    'SELECT ur.role_code, COALESCE(r.scope, "COUNTRY") AS scope ' +
    'FROM user_roles ur LEFT JOIN roles r ON r.role_code = ur.role_code ' +
    'WHERE ur.user_id = ?', [userId]
  );
  if (!rows.length && u.role) {
    var single = tursoSelect('SELECT COALESCE(scope, "COUNTRY") AS scope FROM roles WHERE role_code = ?', [u.role]);
    rows = single.length ? [{ role_code: u.role, scope: single[0].scope }] : [{ role_code: u.role, scope: 'COUNTRY' }];
  }
  var rank = { 'GLOBAL': 3, 'COUNTRY': 2, 'COUNTRY_TEAM': 1 };
  var best = rows.reduce(function(acc, r) {
    var s = String(r.scope || 'COUNTRY').toUpperCase();
    if (!acc || (rank[s] || 0) > (rank[acc.scope] || 0)) {
      return { role: r.role_code, scope: s };
    }
    return acc;
  }, null) || { role: null, scope: null };

  return {
    role:         best.role,
    scope:        best.scope,
    country_code: u.country_code || '',
    team_id:      u.team_id || '',
  };
}

function PermissionDeniedError(msg, requiredPermission) {
  var e = new Error(msg || 'Permission denied');
  e.name = 'PermissionDeniedError';
  e.code = 'PERMISSION_DENIED';
  e.required_permission = requiredPermission || null;
  return e;
}

function ScopeDeniedError(msg) {
  var e = new Error(msg || 'Out-of-scope action');
  e.name = 'ScopeDeniedError';
  e.code = 'SCOPE_DENIED';
  return e;
}

function SoDViolationError(msg) {
  var e = new Error(msg || 'Segregation of duties violation');
  e.name = 'SoDViolationError';
  e.code = 'SOD_VIOLATION';
  return e;
}

/**
 * Throws ScopeDeniedError if a country/team-bound user is acting outside their scope.
 * Pass requestedTeamId = null for non-team-scoped resources.
 */
function requireScope(userId, requestedCountryCode, requestedTeamId) {
  var s = getUserScope(userId);
  if (!s.scope || s.scope === 'GLOBAL') return; // unrestricted
  if (s.scope === 'COUNTRY' || s.scope === 'COUNTRY_TEAM') {
    if (requestedCountryCode && s.country_code && s.country_code !== requestedCountryCode) {
      _logPermissionDenied(userId, 'SCOPE_COUNTRY', requestedCountryCode, '', null);
      throw ScopeDeniedError('Action is outside your country scope (' + s.country_code + ' vs ' + requestedCountryCode + ').');
    }
  }
  if (s.scope === 'COUNTRY_TEAM' && requestedTeamId) {
    if (s.team_id && s.team_id !== requestedTeamId) {
      _logPermissionDenied(userId, 'SCOPE_TEAM', '', requestedTeamId, null);
      throw ScopeDeniedError('Action is outside your team scope.');
    }
  }
}

/**
 * Order approval amount tiers (KES-equivalent):
 *   <=   100,000  -> order.approve_low
 *   <= 1,000,000  -> order.approve_mid
 *   >  1,000,000  -> order.approve_high
 */
function _exchangeRateToKES_(currencyCode) {
  var c = String(currencyCode || 'KES').toUpperCase();
  if (c === 'KES') return { rate: 1, stale: false };
  var key = 'EXCHANGE.' + c + '_TO_KES';
  var defaults = { 'UGX_TO_KES': 0.034, 'TZS_TO_KES': 0.052, 'RWF_TO_KES': 0.10 };
  var rate = null, stale = false;
  try {
    var rows = tursoSelect('SELECT value, updated_at FROM config WHERE key = ?', [key]);
    if (rows.length) {
      rate = parseFloat(rows[0].value);
      var updated = rows[0].updated_at ? new Date(rows[0].updated_at).getTime() : 0;
      stale = (Date.now() - updated) > (7 * 24 * 60 * 60 * 1000);
    }
  } catch(e) { /* fall through to default */ }
  if (!rate || isNaN(rate)) {
    rate = defaults[c + '_TO_KES'] || 1;
    stale = true;
  }
  if (stale) Logger.log('[Permission] WARNING: exchange rate ' + key + ' is missing or > 7 days old; using ' + rate);
  return { rate: rate, stale: stale };
}

function requireOrderApprovalPermission(userId, orderAmount, currencyCode) {
  var amt = parseFloat(orderAmount) || 0;
  var fx = _exchangeRateToKES_(currencyCode);
  var kesAmount = amt * fx.rate;
  var perm;
  if (kesAmount <= 100000)        perm = 'order.approve_low';
  else if (kesAmount <= 1000000)  perm = 'order.approve_mid';
  else                            perm = 'order.approve_high';
  if (!userHasPermission(userId, perm)) {
    _logPermissionDenied(userId, 'order.approve', '', '', perm);
    throw PermissionDeniedError(
      'You don\'t have permission to approve an order of this size.',
      perm
    );
  }
  return { tier: perm, kesAmount: kesAmount, fx: fx };
}

/**
 * Segregation of duties: a user cannot self-approve a resource they created.
 */
function requireDifferentActor(creatorId, currentUserId, what) {
  if (creatorId && currentUserId && String(creatorId) === String(currentUserId)) {
    throw SoDViolationError('Cannot ' + (what || 'approve own resource') + '. Must be actioned by a different user.');
  }
}

function _logPermissionDenied(userId, action, country, team, requiredPerm) {
  try {
    logAudit('Permission', userId || 'UNKNOWN', 'PERMISSION_DENIED', 'STAFF', userId || '', '',
      { action: action, country_code: country || '', team_id: team || '', required_permission: requiredPerm || '' },
      { countryCode: country || '' });
  } catch(e) { /* non-fatal */ }
}

// ============================================================================
// STAGE 4 - ADMIN UI HELPERS
// ============================================================================

/**
 * Lists users with their current role assignments for the admin UI.
 * Filters: { country_code?, search? }
 */
function listUsersForRoleAdmin(filters) {
  filters = filters || {};
  try {
    var sql = 'SELECT user_id, email, first_name, last_name, country_code, team_id, status, last_login_at FROM users WHERE 1=1';
    var args = [];
    if (filters.country_code) { sql += ' AND country_code = ?'; args.push(filters.country_code); }
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
      users: users.map(function(u) {
        return {
          user_id:       u.user_id,
          email:         u.email,
          name:          ((u.first_name || '') + ' ' + (u.last_name || '')).trim(),
          country_code:  u.country_code || '',
          team_id:       u.team_id || '',
          status:        u.status || '',
          last_login_at: u.last_login_at || null,
          roles:         byUser[u.user_id] || [],
        };
      })
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

/**
 * Replaces a user's role assignments with `roleCodes`.
 * Enforces:
 *   - SUPER_ADMIN can only be granted by another SUPER_ADMIN
 *   - System roles require a `reason`
 *   - Cannot remove the last SUPER_ADMIN in the system
 */
function setUserRoles(targetUserId, roleCodes, reason, actorId) {
  if (!targetUserId) return { success: false, error: 'userId required' };
  if (!Array.isArray(roleCodes)) return { success: false, error: 'roleCodes must be an array' };
  try {
    var actor = findRow('Users', 'user_id', actorId) || {};
    var actorRoles = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [actorId]);
    var actorRoleCodes = actorRoles.map(function(r) { return r.role_code; });
    var actorIsSuper = actorRoleCodes.indexOf('SUPER_ADMIN') !== -1;

    var targetRolesNow = tursoSelect('SELECT role_code FROM user_roles WHERE user_id = ?', [targetUserId])
      .map(function(r) { return r.role_code; });

    var requested = roleCodes.slice();
    var toAdd    = requested.filter(function(c) { return targetRolesNow.indexOf(c) === -1; });
    var toRemove = targetRolesNow.filter(function(c) { return requested.indexOf(c) === -1; });

    // Constraint: only SUPER_ADMIN can grant SUPER_ADMIN.
    if (toAdd.indexOf('SUPER_ADMIN') !== -1 && !actorIsSuper) {
      return { success: false, error: 'Only a Super Administrator can grant the SUPER_ADMIN role.' };
    }

    // Constraint: cannot remove the last SUPER_ADMIN.
    if (toRemove.indexOf('SUPER_ADMIN') !== -1) {
      var totalSupers = tursoSelect('SELECT COUNT(*) AS n FROM user_roles WHERE role_code = ?', ['SUPER_ADMIN']);
      if ((parseInt(totalSupers[0].n) || 0) <= 1) {
        return { success: false, error: 'There must be at least one Super Administrator. Grant SUPER_ADMIN to another user before removing this one.' };
      }
    }

    // Constraint: system roles require a reason.
    var systemBeingChanged = toAdd.concat(toRemove).some(function(code) {
      var c = _canonicalStaffByCode_(code);
      return c && c.is_system === 1;
    });
    if (systemBeingChanged && !String(reason || '').trim()) {
      return { success: false, error: 'A reason is required when granting or revoking system-reserved roles.' };
    }

    // Apply.
    var now = new Date().toISOString();
    toAdd.forEach(function(code) {
      tursoWrite('INSERT OR IGNORE INTO user_roles (user_id, role_code, assigned_by, assigned_at) VALUES (?,?,?,?)',
        [targetUserId, code, actorId || 'SYSTEM', now]);
      logAudit('user_role', targetUserId, 'ROLE_GRANTED', 'STAFF', actorId || '', actor.email || '',
        { role_code: code, granted_by: actorId, reason: reason || '' }, {});
    });
    toRemove.forEach(function(code) {
      tursoWrite('DELETE FROM user_roles WHERE user_id = ? AND role_code = ?', [targetUserId, code]);
      logAudit('user_role', targetUserId, 'ROLE_REVOKED', 'STAFF', actorId || '', actor.email || '',
        { role_code: code, revoked_by: actorId, reason: reason || '' }, {});
    });

    // Mirror primary role on legacy users.role for AuthService backwards compatibility.
    try {
      var primary = requested.length ? requested[0] : '';
      updateRow('Users', 'user_id', targetUserId, { role: primary });
    } catch(e) {}

    _invalidatePermissionCache(targetUserId);
    return { success: true, added: toAdd, removed: toRemove };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ============================================================================
// STAGE 5 - HEADCOUNT RECONCILIATION
// ============================================================================

function staffHeadcountReconciliation() {
  try {
    var sections = { generated_at: new Date().toISOString(), targetVsActual: [], userClassification: [], recommendations: [] };
    var critical = 0, under = 0, ok = 0, over = 0;

    CANONICAL_STAFF_ROLES_.forEach(function(c) {
      var cnt = tursoSelect('SELECT COUNT(DISTINCT user_id) AS n FROM user_roles WHERE role_code = ?', [c.code]);
      var actual = parseInt(cnt[0].n) || 0;
      var status = 'OK';
      if (actual === 0)                 { status = 'CRITICAL'; critical++; }
      else if (actual < c.target_min)   { status = 'UNDER';    under++; }
      else if (actual > c.target_max)   { status = 'OVER';     over++; }
      else                              { status = 'OK';       ok++; }
      sections.targetVsActual.push({
        role_code:  c.code,
        role_name:  c.name,
        target_min: c.target_min,
        target_max: c.target_max,
        actual:     actual,
        variance:   actual - c.target_min,
        status:     status,
      });
    });

    // User classification
    var users = tursoSelect('SELECT user_id, email, first_name, last_name, last_login_at, status FROM users');
    var realDomains = /@hass\.co\.(ke|ug|tz|rw)$/i;
    users.forEach(function(u) {
      var email = u.email || '';
      var classification;
      if (!email || !realDomains.test(email))   classification = 'TEST_OR_SEED';
      else if (!u.last_login_at)                classification = 'NEVER_LOGGED_IN';
      else                                      classification = 'REAL';
      sections.userClassification.push({
        user_id:       u.user_id,
        email:         email,
        name:          ((u.first_name || '') + ' ' + (u.last_name || '')).trim(),
        last_login_at: u.last_login_at || null,
        status:        u.status || '',
        classification: classification,
      });
    });

    // Recommendations
    var crits = sections.targetVsActual.filter(function(r) { return r.status === 'CRITICAL'; });
    var unders = sections.targetVsActual.filter(function(r) { return r.status === 'UNDER'; });
    if (crits.length) {
      sections.recommendations.push({
        urgency: 'IMMEDIATE',
        text: 'Provision at least one user for each role with status CRITICAL: ' + crits.map(function(r) { return r.role_code; }).join(', ') + '.'
      });
    }
    if (unders.length) {
      sections.recommendations.push({
        urgency: 'WEEK_1',
        text: 'Top up roles below minimum target: ' + unders.map(function(r) { return r.role_code; }).join(', ') + '.'
      });
    }
    sections.recommendations.push({
      urgency: 'TIMELINE',
      text: 'Suggested provisioning order: Week 1 - roles with target 1-2 (SUPER_ADMIN, CEO, CFO, AUDIT_VIEWER); Week 2 - roles with target 3-10 (ADMIN, COUNTRY_HEAD, MANAGER, KYC_OFFICER, FINANCE); Month 1 - SUPERVISOR, AGENT, OPS.'
    });

    sections.summary = { critical: critical, under: under, ok: ok, over: over,
                         total_real_users: sections.userClassification.filter(function(u) { return u.classification === 'REAL'; }).length,
                         total_test_or_seed: sections.userClassification.filter(function(u) { return u.classification !== 'REAL'; }).length };
    sections.success = true;
    return sections;
  } catch(e) {
    return { success: false, error: e.message };
  }
}

