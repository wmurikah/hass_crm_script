/**
 * 40_svc_pricing.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Price list management: create/update/deactivate price lists and line items.
 * Requires invoice.generate permission for mutations (Finance team).
 * Read access requires order.view.
 */

// ── Handlers ──────────────────────────────────────────────────────────────────

function _pricingListLists_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql  = 'SELECT * FROM price_list WHERE 1=1';
  var args = [];
  if (params.country_code) { sql += ' AND country_code = ?'; args.push(params.country_code); }
  if (!params.include_inactive) { sql += ' AND is_active = 1'; }
  sql += ' ORDER BY country_code, price_list_name';
  return TursoClient.select(sql, args);
}

function _pricingCreateList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.generate');
  var name        = String(params.price_list_name || '').trim();
  var countryCode = String(params.country_code    || '').trim().toUpperCase();
  var currency    = String(params.currency_code   || '').trim().toUpperCase();
  if (!name)        throw new Errors.Validation('price_list_name required.');
  if (!countryCode) throw new Errors.Validation('country_code required.');
  if (!currency)    throw new Errors.Validation('currency_code required.');

  var priceId = genId('PL');
  var now     = nowIso();
  TursoClient.write(
    'INSERT INTO price_list (price_id, price_list_name, country_code, currency_code, ' +
    'effective_from, effective_to, is_active, created_by, created_at, updated_at) ' +
    'VALUES (?,?,?,?,?,?,1,?,?,?)',
    [priceId, name, countryCode, currency,
     params.effective_from || now,
     params.effective_to   || null,
     ctx.session.userId, now, now]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'PRICE_LIST_CREATED',
    entity: 'price_list', entityId: priceId,
    after: { price_list_name: name, country_code: countryCode },
  });
  return { price_id: priceId };
}

function _pricingUpsertItem_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.generate');
  var priceId   = String(params.price_list_id || params.priceId || '');
  var productId = String(params.product_id    || '');
  var unitPrice = parseFloat(params.unit_price);
  if (!priceId)      throw new Errors.Validation('price_list_id required.');
  if (!productId)    throw new Errors.Validation('product_id required.');
  if (isNaN(unitPrice) || unitPrice < 0) throw new Errors.Validation('unit_price must be >= 0.');

  var existing = TursoClient.select(
    'SELECT item_id FROM price_list_items WHERE price_id = ? AND product_id = ? LIMIT 1',
    [priceId, productId]
  );
  var now = nowIso();

  if (existing.length) {
    TursoClient.write(
      'UPDATE price_list_items SET unit_price = ?, updated_at = ? WHERE item_id = ?',
      [unitPrice, now, existing[0].item_id]
    );
    Audit.log({
      actor: ctx.session.userId, action: 'PRICE_ITEM_UPDATED',
      entity: 'price_list_items', entityId: existing[0].item_id,
      after: { unit_price: unitPrice },
    });
    return { item_id: existing[0].item_id, updated: true };
  }

  var itemId = genId('PLI');
  TursoClient.write(
    'INSERT INTO price_list_items (item_id, price_id, product_id, depot_id, ' +
    'unit_price, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)',
    [itemId, priceId, productId,
     params.depot_id || null, unitPrice, now, now]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'PRICE_ITEM_CREATED',
    entity: 'price_list_items', entityId: itemId,
    after: { price_id: priceId, product_id: productId, unit_price: unitPrice },
  });
  return { item_id: itemId, updated: false };
}

function _pricingDeactivateList_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'invoice.generate');
  var priceId = String(params.priceId || params.price_list_id || '');
  if (!priceId) throw new Errors.Validation('priceId required.');
  var rows = TursoClient.select(
    'SELECT * FROM price_list WHERE price_id = ? LIMIT 1', [priceId]
  );
  if (!rows.length) throw new Errors.NotFound('Price list not found.');
  var before = rows[0];
  TursoClient.write(
    'UPDATE price_list SET is_active = 0, updated_at = ? WHERE price_id = ?',
    [nowIso(), priceId]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'PRICE_LIST_DEACTIVATED',
    entity: 'price_list', entityId: priceId,
    before: before, after: { is_active: 0 },
  });
  return { success: true };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerPricing_() {
  register({ service: 'pricing', action: 'listLists',       permission: 'order.view',      handler: _pricingListLists_ });
  register({ service: 'pricing', action: 'createList',      permission: 'invoice.generate', handler: _pricingCreateList_ });
  register({ service: 'pricing', action: 'upsertItem',      permission: 'invoice.generate', handler: _pricingUpsertItem_ });
  register({ service: 'pricing', action: 'deactivateList',  permission: 'invoice.generate', handler: _pricingDeactivateList_ });
})();
