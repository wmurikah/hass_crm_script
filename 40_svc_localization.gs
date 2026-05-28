/**
 * 40_svc_localization.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Translation / localization key-value store.
 *
 * localization.{list, get, upsert, delete, listLocales}
 *
 * translations table:
 *   translation_id, locale_code, key_name, value,
 *   is_active, created_at, updated_at
 *
 * Locale codes follow ISO 639-1 + optional country suffix: en, sw, fr, en-KE, etc.
 */

// ── localization.listLocales ───────────────────────────────────────────────────

function _locListLocales_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var rows = TursoClient.select(
    'SELECT DISTINCT locale_code FROM translations ORDER BY locale_code', []
  );
  return rows.map(function (r) { return r.locale_code; });
}

// ── localization.list ─────────────────────────────────────────────────────────

function _locList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var locale = String(params.locale_code || 'en').trim().toLowerCase();
  var sql    = 'SELECT * FROM translations WHERE locale_code = ? AND is_active = 1';
  var args   = [locale];
  if (params.prefix) { sql += ' AND key_name LIKE ?'; args.push(params.prefix + '%'); }
  sql += ' ORDER BY key_name';
  return TursoClient.select(sql, args);
}

// ── localization.get ──────────────────────────────────────────────────────────

function _locGet_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var locale  = String(params.locale_code || 'en').trim().toLowerCase();
  var keyName = String(params.key_name    || '').trim();
  if (!keyName) throw new Errors.Validation('key_name required.');
  var rows = TursoClient.select(
    'SELECT * FROM translations WHERE locale_code = ? AND key_name = ? LIMIT 1',
    [locale, keyName]
  );
  if (!rows.length) throw new Errors.NotFound('Translation not found.');
  return rows[0];
}

// ── localization.upsert ───────────────────────────────────────────────────────

function _locUpsert_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var locale  = String(params.locale_code || '').trim().toLowerCase();
  var keyName = String(params.key_name    || '').trim();
  var value   = String(params.value       !== undefined ? params.value : '');
  if (!locale)  throw new Errors.Validation('locale_code required.');
  if (!keyName) throw new Errors.Validation('key_name required.');

  var existing = TursoClient.select(
    'SELECT translation_id FROM translations WHERE locale_code = ? AND key_name = ? LIMIT 1',
    [locale, keyName]
  );
  var now = nowIso();
  if (existing.length) {
    TursoClient.write(
      'UPDATE translations SET value = ?, is_active = 1, updated_at = ? WHERE locale_code = ? AND key_name = ?',
      [value, now, locale, keyName]
    );
  } else {
    var translationId = genId('LOC');
    TursoClient.write(
      'INSERT INTO translations (translation_id, locale_code, key_name, value, is_active, created_at, updated_at) ' +
      'VALUES (?,?,?,?,1,?,?)',
      [translationId, locale, keyName, value, now, now]
    );
  }
  Audit.log({
    actor: ctx.session.userId, action: 'TRANSLATION_UPSERTED',
    entity: 'translations', entityId: locale + ':' + keyName,
    after: { locale_code: locale, key_name: keyName, value: value },
  });
  return { success: true, locale_code: locale, key_name: keyName };
}

// ── localization.delete ───────────────────────────────────────────────────────

function _locDelete_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var locale  = String(params.locale_code || '').trim().toLowerCase();
  var keyName = String(params.key_name    || '').trim();
  if (!locale || !keyName) throw new Errors.Validation('locale_code and key_name required.');
  TursoClient.write(
    'UPDATE translations SET is_active = 0, updated_at = ? WHERE locale_code = ? AND key_name = ?',
    [nowIso(), locale, keyName]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'TRANSLATION_DELETED',
    entity: 'translations', entityId: locale + ':' + keyName,
    after: { is_active: 0 },
  });
  return { success: true };
}

// ── Registration ───────────────────────────────────────────────────────────────

(function _registerLocalization_() {
  register({ service: 'localization', action: 'listLocales', permission: 'order.view',   handler: _locListLocales_ });
  register({ service: 'localization', action: 'list',        permission: 'order.view',   handler: _locList_ });
  register({ service: 'localization', action: 'get',         permission: 'order.view',   handler: _locGet_ });
  register({ service: 'localization', action: 'upsert',      permission: 'order.manage', handler: _locUpsert_ });
  register({ service: 'localization', action: 'delete',      permission: 'order.manage', handler: _locDelete_ });
})();
