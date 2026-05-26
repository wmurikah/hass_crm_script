/**
 * HASS PETROLEUM CMS - Permission Matrix Export (Governance G-015)
 *
 * READ-ONLY governance artefact generator.  Makes NO permission changes.
 *
 * Reads the live roles, permissions, and role_permissions tables from Turso,
 * exports the current-state permission matrix as CSV and Markdown, diffs it
 * against the canonical DEFAULT_ROLES_ definition (Section 2 of the gap
 * analysis), flags SoD-sensitive permissions, and writes a per-module
 * sign-off pack to a Google Sheet named "Permission Matrix Export".
 *
 * SoD-sensitive permissions are those whose catalog entry carries a `sod`
 * key in DEFAULT_PERMISSIONS_ (e.g. creator_ne_approver, refunder_ne_receiver).
 *
 * Public API
 *   exportPermissionMatrix()      — orchestrates everything; safe to re-run
 *   getPermissionMatrixData()     — returns { roles, permissions, matrix, divergences, sodFlags }
 *   generatePermissionMatrixCSV(data)      — returns CSV string
 *   generatePermissionMatrixMarkdown(data) — returns Markdown string
 */

// ============================================================================
// CANONICAL REFERENCE  (Section 2 of gap analysis, mirrored from PermissionService.gs)
// These are the EXPECTED grants.  We diff the live database against them.
// ============================================================================

var _PM_CANONICAL_ROLES_ = (function() {
  // Re-use the same structure as DEFAULT_ROLES_ in PermissionService.gs
  // (copied here so this file is self-contained and can run independently).
  return [
    { code: 'SUPER_ADMIN',           perms: ['*'] },
    { code: 'CEO',                   perms: ['customer.view','order.view','order.approve_high','invoice.view','statement.export','config.view','report.run'] },
    { code: 'CFO',                   perms: ['customer.view','customer.set_credit','order.view','order.approve_low','order.approve_mid','order.approve_high','invoice.view','invoice.cancel','payment.approve','payment.refund','statement.export','config.view','report.run'] },
    { code: 'RMD',                   perms: ['customer.view','customer.create','customer.update','customer.approve_kyc','order.view','order.approve_mid','invoice.view','statement.export','report.run'] },
    { code: 'CREDIT_MANAGER',        perms: ['customer.view','customer.set_credit','invoice.view','statement.export','report.run'] },
    { code: 'INTERNAL_AUDITOR',      perms: ['customer.view','order.view','ticket.view','invoice.view','statement.export','config.view','audit_log.view','report.run'] },
    { code: 'SHARED_SERVICES_MANAGER', perms: ['customer.view','order.view','invoice.view','statement.export','report.run'] },
    { code: 'SUPPLY_OPS_MANAGER',    perms: ['customer.view','order.view','order.dispatch','order.confirm_delivery','report.run'] },
    { code: 'COUNTRY_MANAGER',       perms: ['customer.view','customer.create','customer.update','customer.approve_kyc','order.view','order.approve_low','order.approve_mid','order.cancel','ticket.view','ticket.create','ticket.assign','ticket.escalate','ticket.close','ticket.reopen','invoice.view','statement.export','report.run'] },
    { code: 'REGIONAL_MANAGER',      perms: ['customer.view','customer.create','customer.update','customer.approve_kyc','order.view','order.create','order.approve_low','order.cancel','order.dispatch','order.confirm_delivery','ticket.view','ticket.create','ticket.assign','ticket.escalate','ticket.close','ticket.reopen','report.run'] },
    { code: 'CS_MANAGER',            perms: ['customer.view','customer.create','customer.update','customer.approve_kyc','order.view','order.create','order.approve_low','order.approve_mid','order.cancel','order.confirm_delivery','ticket.view','ticket.create','ticket.assign','ticket.escalate','ticket.close','ticket.reopen','invoice.view','statement.export','report.run'] },
    { code: 'CS_AGENT',              perms: ['customer.view','customer.create','customer.update','order.view','order.create','order.confirm_delivery','ticket.view','ticket.create','ticket.escalate','ticket.close','invoice.view','report.run'] },
    { code: 'BD_REP',                perms: ['customer.view','customer.create','order.view','order.create','ticket.view','ticket.create','report.run'] },
    { code: 'FINANCE_MANAGER',       perms: ['customer.view','order.view','order.approve_low','order.approve_mid','invoice.view','invoice.generate','invoice.cancel','payment.review','payment.approve','payment.refund','statement.export','report.run'] },
    { code: 'FINANCE_OFFICER',       perms: ['customer.view','order.view','order.approve_low','invoice.view','invoice.generate','payment.review','statement.export','report.run'] },
    { code: 'VIEWER',                perms: ['customer.view','order.view','invoice.view','statement.export'] },
    { code: 'CUSTOMER',              perms: [] },
  ];
}());

// SoD flags from the canonical permission catalog
var _PM_SOD_FLAGS_ = {
  'customer.set_credit':  'setter_ne_requester',
  'order.approve_low':    'creator_ne_approver',
  'order.approve_mid':    'creator_ne_approver',
  'order.approve_high':   'creator_ne_approver',
  'payment.refund':       'refunder_ne_receiver',
};

// ============================================================================
// DATA COLLECTION
// ============================================================================

/**
 * Reads the live database and builds the full matrix data structure.
 *
 * @returns {{
 *   roles:       Object[],   // live role rows
 *   permissions: Object[],   // live permission rows (canonical codes only)
 *   grantMap:    Object,     // { role_code: Set<permission_code> }
 *   divergences: Object[],   // { role_code, permission_code, type:'MISSING'|'EXTRA' }
 *   sodFlags:    Object,     // { permission_code: sod_rule }
 *   exportedAt:  string,
 * }}
 */
function getPermissionMatrixData() {
  var now = new Date().toISOString();

  // ── Live roles ────────────────────────────────────────────────────────────
  var liveRoles = [];
  try { liveRoles = tursoSelect('SELECT * FROM roles ORDER BY role_code'); }
  catch(e) { Logger.log('[PermMatrix] roles query error: ' + e.message); }

  // ── Live permissions (canonical only – ignore deprecated) ─────────────────
  var livePerms = [];
  try {
    livePerms = tursoSelect(
      'SELECT * FROM permissions WHERE category != ? ORDER BY category, permission_code',
      ['_deprecated']
    );
  } catch(e) { Logger.log('[PermMatrix] permissions query error: ' + e.message); }

  // ── Live role_permissions ─────────────────────────────────────────────────
  var liveGrants = [];
  try { liveGrants = tursoSelect('SELECT role_code, permission_code FROM role_permissions'); }
  catch(e) { Logger.log('[PermMatrix] role_permissions query error: ' + e.message); }

  // Build grant map: role_code → Set of permission_code
  var grantMap = {};
  liveGrants.forEach(function(g) {
    if (!grantMap[g.role_code]) grantMap[g.role_code] = [];
    if (grantMap[g.role_code].indexOf(g.permission_code) === -1) {
      grantMap[g.role_code].push(g.permission_code);
    }
  });
  // Normalise to sorted arrays
  Object.keys(grantMap).forEach(function(r) { grantMap[r].sort(); });

  // ── Divergence analysis ───────────────────────────────────────────────────
  var divergences = [];
  _PM_CANONICAL_ROLES_.forEach(function(canonical) {
    var role_code = canonical.code;
    var expected  = canonical.perms;
    var actual    = grantMap[role_code] || [];

    // SUPER_ADMIN with wildcard '*' is a special case – just verify '*' present.
    if (expected.indexOf('*') !== -1) {
      if (actual.indexOf('*') === -1) {
        divergences.push({
          role_code:       role_code,
          permission_code: '*',
          type:            'MISSING',
          note:            'SUPER_ADMIN should have wildcard grant',
        });
      }
      return;
    }

    // Missing: in canonical but not in live DB.
    expected.forEach(function(p) {
      if (actual.indexOf(p) === -1) {
        divergences.push({ role_code: role_code, permission_code: p, type: 'MISSING' });
      }
    });
    // Extra: in live DB but not in canonical (excluding deprecated codes).
    actual.forEach(function(p) {
      if (p === '*') return;
      if (livePerms.some(function(lp) { return lp.permission_code === p && lp.category === '_deprecated'; })) return;
      if (expected.indexOf(p) === -1) {
        divergences.push({ role_code: role_code, permission_code: p, type: 'EXTRA' });
      }
    });
  });

  // Roles in DB but not in canonical.
  var canonicalCodes = _PM_CANONICAL_ROLES_.map(function(r) { return r.code; });
  liveRoles.forEach(function(lr) {
    if (canonicalCodes.indexOf(lr.role_code) === -1) {
      divergences.push({
        role_code:       lr.role_code,
        permission_code: '*',
        type:            'EXTRA_ROLE',
        note:            'Role exists in DB but is not in the canonical Section 2 matrix',
      });
    }
  });

  return {
    roles:       liveRoles,
    permissions: livePerms,
    grantMap:    grantMap,
    divergences: divergences,
    sodFlags:    _PM_SOD_FLAGS_,
    exportedAt:  now,
  };
}

// ============================================================================
// CSV GENERATOR
// ============================================================================

/**
 * Builds the permission matrix as CSV.
 * Rows = roles, Columns = permission codes.
 * Cell value: "Y" (granted), "" (not granted), "Y*" (SoD-gated).
 *
 * @param {Object} data  - from getPermissionMatrixData()
 * @returns {string} CSV text
 */
function generatePermissionMatrixCSV(data) {
  var roles       = data.roles.map(function(r) { return r.role_code; });
  var permissions = data.permissions
    .filter(function(p) { return p.category !== '_deprecated'; })
    .map(function(p) { return p.permission_code; });

  var lines = [];

  // Header row
  var header = ['role_code', 'role_name', 'is_system'].concat(permissions).map(_csvCell_);
  lines.push(header.join(','));

  // Subheader: SoD flag row
  var sodRow = ['', '', 'SoD rule:'].concat(
    permissions.map(function(p) { return data.sodFlags[p] ? '[SoD:' + data.sodFlags[p] + ']' : ''; })
  ).map(_csvCell_);
  lines.push(sodRow.join(','));

  // Role rows
  var roleMap = {};
  data.roles.forEach(function(r) { roleMap[r.role_code] = r; });

  roles.forEach(function(roleCode) {
    var granted = data.grantMap[roleCode] || [];
    var isWildcard = granted.indexOf('*') !== -1;
    var roleInfo   = roleMap[roleCode] || {};

    var cells = [roleCode, roleInfo.role_name || '', roleInfo.is_system || 0].concat(
      permissions.map(function(p) {
        var has = isWildcard || granted.indexOf(p) !== -1;
        if (!has) return '';
        return data.sodFlags[p] ? 'Y*' : 'Y';
      })
    ).map(_csvCell_);
    lines.push(cells.join(','));
  });

  // Divergence section
  lines.push('');
  lines.push('"DIVERGENCES (live vs Section 2 canonical)"');
  lines.push(['"role_code"', '"permission_code"', '"type"', '"note"'].join(','));
  data.divergences.forEach(function(d) {
    lines.push([
      _csvCell_(d.role_code),
      _csvCell_(d.permission_code),
      _csvCell_(d.type),
      _csvCell_(d.note || ''),
    ].join(','));
  });

  return lines.join('\r\n');
}

function _csvCell_(v) {
  var s = String(v == null ? '' : v);
  if (s.search(/[,"\r\n]/) !== -1) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ============================================================================
// MARKDOWN GENERATOR
// ============================================================================

/**
 * Builds the permission matrix as Markdown (GitHub-flavored table).
 *
 * @param {Object} data  - from getPermissionMatrixData()
 * @returns {string} Markdown text
 */
function generatePermissionMatrixMarkdown(data) {
  var roles       = data.roles.map(function(r) { return r.role_code; });
  var permissions = data.permissions
    .filter(function(p) { return p.category !== '_deprecated'; });

  // Group by category for Markdown sections.
  var categories = {};
  permissions.forEach(function(p) {
    var cat = p.category || 'Other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(p);
  });

  var lines = [];

  lines.push('# Hass Petroleum CMS — Permission Matrix');
  lines.push('');
  lines.push('**Exported:** ' + data.exportedAt);
  lines.push('**Status:** Current live state (read-only export, no changes made)');
  lines.push('');
  lines.push('**Key:** `Y` = granted · `Y*` = granted with SoD gate · _(blank)_ = not granted');
  lines.push('');
  lines.push('SoD rules: `creator_ne_approver` — the order creator cannot be the approver; ' +
    '`setter_ne_requester` — credit-limit setter ≠ requester; ' +
    '`refunder_ne_receiver` — refund approver ≠ original receiver.');
  lines.push('');

  // Full matrix table.
  lines.push('## Full Permission Matrix');
  lines.push('');

  var roleMap = {};
  data.roles.forEach(function(r) { roleMap[r.role_code] = r; });

  // Per-category sub-tables.
  Object.keys(categories).forEach(function(cat) {
    if (cat === '_deprecated') return;
    var catPerms = categories[cat];

    lines.push('### Module: ' + cat);
    lines.push('');

    // Table header
    var header = ['Role'].concat(catPerms.map(function(p) {
      var sod = data.sodFlags[p.permission_code] ? ' ⚠' : '';
      return '`' + p.permission_code + '`' + sod;
    }));
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('| ' + header.map(function() { return '---'; }).join(' | ') + ' |');

    roles.forEach(function(roleCode) {
      var granted    = data.grantMap[roleCode] || [];
      var isWildcard = granted.indexOf('*') !== -1;
      var roleInfo   = roleMap[roleCode] || {};
      var sysBadge   = roleInfo.is_system ? ' _(sys)_' : '';

      var cells = ['**' + roleCode + '**' + sysBadge].concat(
        catPerms.map(function(p) {
          var has = isWildcard || granted.indexOf(p.permission_code) !== -1;
          if (!has) return '';
          return data.sodFlags[p.permission_code] ? 'Y⚠' : 'Y';
        })
      );
      lines.push('| ' + cells.join(' | ') + ' |');
    });

    lines.push('');
  });

  // Divergence section.
  lines.push('## Divergences: Live vs Section 2 Canonical');
  lines.push('');
  if (!data.divergences.length) {
    lines.push('_No divergences found — live state matches the canonical Section 2 matrix._');
  } else {
    lines.push('| Role | Permission | Type | Note |');
    lines.push('| --- | --- | --- | --- |');
    data.divergences.forEach(function(d) {
      var sodNote = data.sodFlags[d.permission_code] ? ' ⚠ SoD-gated' : '';
      lines.push('| ' + d.role_code + ' | `' + d.permission_code + '`' + sodNote +
        ' | **' + d.type + '** | ' + (d.note || '') + ' |');
    });
  }

  lines.push('');

  // Per-module sign-off pack.
  lines.push('## Per-Module Sign-Off Pack');
  lines.push('');
  lines.push('Each section below covers one business module. The business owner listed should ' +
    'review the grants for their module and confirm or flag concerns.');
  lines.push('');

  var moduleOwners = {
    'Customer':  'Country Manager / CS Manager',
    'Order':     'Supply Ops Manager / CS Manager',
    'Ticket':    'CS Manager / CS Agent Lead',
    'Finance':   'Finance Manager / CFO',
    'System':    'Super Admin / Internal Auditor',
  };

  Object.keys(categories).forEach(function(cat) {
    if (cat === '_deprecated') return;
    var catPerms = categories[cat];
    var owner = moduleOwners[cat] || 'System Administrator';

    lines.push('### Sign-off: Module — ' + cat);
    lines.push('');
    lines.push('**Business owner:** ' + owner);
    lines.push('');
    lines.push('Permissions in this module:');
    lines.push('');
    catPerms.forEach(function(p) {
      var sodNote = data.sodFlags[p.permission_code]
        ? ' _(SoD gate: ' + data.sodFlags[p.permission_code] + ')_' : '';
      lines.push('- `' + p.permission_code + '` — ' + (p.label || p.permission_code) + sodNote);
    });
    lines.push('');

    // Roles with any grant in this module.
    var relevantRoles = roles.filter(function(rc) {
      var granted    = data.grantMap[rc] || [];
      var isWildcard = granted.indexOf('*') !== -1;
      return isWildcard || catPerms.some(function(p) {
        return granted.indexOf(p.permission_code) !== -1;
      });
    });

    lines.push('Roles with access:');
    lines.push('');
    relevantRoles.forEach(function(rc) {
      var granted    = data.grantMap[rc] || [];
      var isWildcard = granted.indexOf('*') !== -1;
      var catGranted = isWildcard ? catPerms.map(function(p) { return p.permission_code; }) :
        catPerms.filter(function(p) { return granted.indexOf(p.permission_code) !== -1; })
                .map(function(p) { return p.permission_code; });
      lines.push('- **' + rc + '**: ' + catGranted.join(', '));
    });

    lines.push('');
    lines.push('**Divergences in this module:**');
    var catDivs = data.divergences.filter(function(d) {
      return catPerms.some(function(p) { return p.permission_code === d.permission_code; });
    });
    if (!catDivs.length) {
      lines.push('_None — matches canonical._');
    } else {
      catDivs.forEach(function(d) {
        lines.push('- ' + d.type + ': role `' + d.role_code + '` / permission `' + d.permission_code + '`');
      });
    }
    lines.push('');
    lines.push('**Sign-off box:**');
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    lines.push('| Reviewed by | ________________________________ |');
    lines.push('| Title       | ________________________________ |');
    lines.push('| Date        | ________________________________ |');
    lines.push('| Decision    | ☐ Approved  ☐ Approved with comments  ☐ Rejected |');
    lines.push('| Comments    | ________________________________ |');
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  return lines.join('\n');
}

// ============================================================================
// ORCHESTRATOR: exportPermissionMatrix()
// ============================================================================

/**
 * Reads the live permission state, generates CSV + Markdown, and writes both
 * to a Google Sheet tab named "Permission Matrix Export" in the CMS
 * spreadsheet (Script Property SPREADSHEET_ID).
 *
 * Also logs the export action to audit_log.
 *
 * @returns {{success:boolean, csv:string, markdown:string, divergenceCount:number}}
 */
function exportPermissionMatrix() {
  try {
    var data     = getPermissionMatrixData();
    var csv      = generatePermissionMatrixCSV(data);
    var markdown = generatePermissionMatrixMarkdown(data);

    // ── Write to spreadsheet ─────────────────────────────────────────────────
    try {
      var ss      = getSpreadsheet();
      var tabName = 'Permission Matrix Export';

      var sheet = ss.getSheetByName(tabName);
      if (!sheet) {
        sheet = ss.insertSheet(tabName);
      } else {
        sheet.clearContents();
      }

      // CSV section.
      var csvLines = csv.split('\r\n');
      csvLines.forEach(function(line, idx) {
        var cells = _parseCsvLine_(line);
        if (cells.length) sheet.getRange(idx + 1, 1, 1, cells.length).setValues([cells]);
      });

      // Markdown section — write to a separate tab.
      var mdTabName = 'Permission Matrix (Markdown)';
      var mdSheet   = ss.getSheetByName(mdTabName);
      if (!mdSheet) {
        mdSheet = ss.insertSheet(mdTabName);
      } else {
        mdSheet.clearContents();
      }
      var mdLines = markdown.split('\n');
      mdLines.forEach(function(line, idx) {
        mdSheet.getRange(idx + 1, 1).setValue(line);
      });

      Logger.log('[PermMatrix] Written to sheets: "' + tabName + '" and "' + mdTabName + '"');
    } catch (sheetErr) {
      Logger.log('[PermMatrix] Sheet write error (continuing): ' + sheetErr.message);
    }

    // ── Audit log ─────────────────────────────────────────────────────────────
    try {
      auditLogCustom(
        'System', 'permission_matrix',
        'SYSTEM',
        'PERMISSION_MATRIX_EXPORTED',
        {
          divergence_count: data.divergences.length,
          roles_count:      data.roles.length,
          permissions_count: data.permissions.length,
          exported_at:      data.exportedAt,
        },
        ''
      );
    } catch(ae) {}

    return {
      success:          true,
      csv:              csv,
      markdown:         markdown,
      divergenceCount:  data.divergences.length,
      exportedAt:       data.exportedAt,
    };

  } catch (e) {
    Logger.log('[PermMatrix] exportPermissionMatrix error: ' + e.message);
    return { success: false, error: e.message };
  }
}

// ============================================================================
// HELPER
// ============================================================================

function _parseCsvLine_(line) {
  var cells = [];
  var inQuote = false, cell = '';
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      cells.push(cell); cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}
