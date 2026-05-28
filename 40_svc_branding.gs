/**
 * 40_svc_branding.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Branding configuration per country scope.
 *
 * branding.{get, update}
 *
 * branding table columns (from smoke test + seeded data):
 *   scope_code, app_name, logo_url, primary_color, accent_color,
 *   footer_text, support_email, created_at, updated_at
 */

// ── branding.get ──────────────────────────────────────────────────────────────

function _brandingGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var scopeCode = String(params.scope_code || ctx.session.countryCode || 'GLOBAL').trim().toUpperCase();

  // Try country-specific first, then fall back to GLOBAL.
  var rows = TursoClient.select(
    'SELECT * FROM branding WHERE scope_code = ? LIMIT 1', [scopeCode]
  );
  if (!rows.length && scopeCode !== 'GLOBAL') {
    rows = TursoClient.select(
      "SELECT * FROM branding WHERE scope_code = 'GLOBAL' LIMIT 1", []
    );
  }
  if (!rows.length) throw new Errors.NotFound('Branding configuration not found.');
  return rows[0];
}

// ── branding.update ───────────────────────────────────────────────────────────

function _brandingUpdate_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var scopeCode = String(params.scope_code || 'GLOBAL').trim().toUpperCase();

  var rows = TursoClient.select(
    'SELECT * FROM branding WHERE scope_code = ? LIMIT 1', [scopeCode]
  );
  var before = rows.length ? rows[0] : null;
  var now    = nowIso();

  var allowed = ['app_name', 'logo_url', 'primary_color', 'accent_color', 'footer_text', 'support_email'];
  if (!before) {
    // Insert new branding row.
    var cols = ['scope_code', 'created_at', 'updated_at'];
    var vals = [scopeCode, now, now];
    allowed.forEach(function (col) {
      if (params[col] !== undefined) { cols.push(col); vals.push(params[col]); }
    });
    TursoClient.write(
      'INSERT INTO branding (' + cols.join(',') + ') VALUES (' +
      cols.map(function () { return '?'; }).join(',') + ')',
      vals
    );
  } else {
    var setParts = []; var args = [];
    allowed.forEach(function (col) {
      if (params[col] !== undefined) { setParts.push(col + ' = ?'); args.push(params[col]); }
    });
    if (!setParts.length) throw new Errors.Validation('No updatable fields provided.');
    setParts.push('updated_at = ?'); args.push(now); args.push(scopeCode);
    TursoClient.write(
      'UPDATE branding SET ' + setParts.join(', ') + ' WHERE scope_code = ?', args
    );
  }

  Audit.log({
    actor: ctx.session.userId, action: 'BRANDING_UPDATED',
    entity: 'branding', entityId: scopeCode,
    before: before, after: params,
  });
  return { success: true, scope_code: scopeCode };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerBranding_() {
  register({ service: 'branding', action: 'get',    permission: 'order.view',   handler: _brandingGet_ });
  register({ service: 'branding', action: 'update', permission: 'order.manage', handler: _brandingUpdate_ });
})();
