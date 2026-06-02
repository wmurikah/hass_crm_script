/**
 * 40_svc_pricing.gs  —  Hass CMS rebuild  (Stage 5G)
 *
 * Price list management: create/update/deactivate price lists and line items.
 * Requires invoice.generate permission for mutations (Finance team).
 * Read access requires order.view.
 */

// ── Handlers ──────────────────────────────────────────────────────────────────

// Discover price_list's real label and status columns at runtime; the physical
// table does not necessarily use price_list_name / is_active.
function _priceListNameCol_() {
  return SchemaIntrospect.pick('price_list',
    ['name', 'price_list_name', 'list_name', 'title']) || 'name';
}
function _priceListStatusCol_() {
  return SchemaIntrospect.pick('price_list',
    ['is_active', 'active', 'status', 'is_enabled']);
}
function _priceListActiveClause_(col, alias) {
  // Works whether the column is an integer flag (1) or a text status ('ACTIVE').
  var p = (alias ? alias + '.' : '') + col;
  return '(' + p + ' = 1 OR ' + p + " = 'ACTIVE')";
}

function _pricingListLists_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var nameCol   = _priceListNameCol_();
  var statusCol = _priceListStatusCol_();
  var sql  = 'SELECT pl.*, pl.price_id AS list_id, pl.' + nameCol + ' AS list_name';
  if (statusCol && statusCol.toLowerCase() !== 'is_active') {
    sql += ', pl.' + statusCol + ' AS is_active';
  }
  sql += ' FROM price_list pl WHERE 1=1';
  var args = [];
  if (params.country_code) { sql += ' AND pl.country_code = ?'; args.push(params.country_code); }
  if (!params.include_inactive && statusCol) {
    sql += ' AND ' + _priceListActiveClause_(statusCol, 'pl');
  }
  sql += ' ORDER BY pl.country_code, pl.' + nameCol;
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

  // Build the INSERT from columns that actually exist on price_list.
  var nameCol   = _priceListNameCol_();
  var statusCol = _priceListStatusCol_();
  var cols = ['price_id', nameCol, 'country_code', 'currency_code'];
  var vals = [priceId, name, countryCode, currency];
  if (SchemaIntrospect.has('price_list', 'effective_from')) {
    cols.push('effective_from'); vals.push(params.effective_from || now);
  }
  if (SchemaIntrospect.has('price_list', 'effective_to')) {
    cols.push('effective_to'); vals.push(params.effective_to || null);
  }
  if (statusCol) {
    cols.push(statusCol);
    vals.push(statusCol.toLowerCase() === 'status' ? 'ACTIVE' : 1);
  }
  if (SchemaIntrospect.has('price_list', 'created_by')) {
    cols.push('created_by'); vals.push(ctx.session.userId);
  }
  if (SchemaIntrospect.has('price_list', 'created_at')) {
    cols.push('created_at'); vals.push(now);
  }
  if (SchemaIntrospect.has('price_list', 'updated_at')) {
    cols.push('updated_at'); vals.push(now);
  }
  var ph = cols.map(function () { return '?'; }).join(',');
  TursoClient.write('INSERT INTO price_list (' + cols.join(', ') + ') VALUES (' + ph + ')', vals);

  Audit.log({
    actor: ctx.session.userId, action: 'PRICE_LIST_CREATED',
    entity: 'price_list', entityId: priceId,
    after: { name: name, country_code: countryCode },
  });
  return { price_id: priceId, list_id: priceId };
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
    'SELECT item_id FROM price_list_items WHERE price_list_id = ? AND product_id = ? LIMIT 1',
    [priceId, productId]
  );
  var now = nowIso();

  if (existing.length) {
    TursoClient.write(
      'UPDATE price_list_items SET unit_price = ? WHERE item_id = ?',
      [unitPrice, existing[0].item_id]
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
    'INSERT INTO price_list_items (item_id, price_list_id, product_id, depot_id, ' +
    'unit_price, created_at) VALUES (?,?,?,?,?,?)',
    [itemId, priceId, productId,
     params.depot_id || null, unitPrice, now]
  );
  Audit.log({
    actor: ctx.session.userId, action: 'PRICE_ITEM_CREATED',
    entity: 'price_list_items', entityId: itemId,
    after: { price_list_id: priceId, product_id: productId, unit_price: unitPrice },
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
  var before    = rows[0];
  var statusCol = _priceListStatusCol_();
  if (statusCol) {
    var inactiveVal = statusCol.toLowerCase() === 'status' ? 'INACTIVE' : 0;
    var setSql = statusCol + ' = ?';
    var args   = [inactiveVal];
    if (SchemaIntrospect.has('price_list', 'updated_at')) {
      setSql += ', updated_at = ?'; args.push(nowIso());
    }
    args.push(priceId);
    TursoClient.write('UPDATE price_list SET ' + setSql + ' WHERE price_id = ?', args);
  }
  Audit.log({
    actor: ctx.session.userId, action: 'PRICE_LIST_DEACTIVATED',
    entity: 'price_list', entityId: priceId,
    before: before, after: { status: 'INACTIVE' },
  });
  return { success: true };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerPricing_() {
  register({ service: 'pricing', action: 'listLists',         permission: 'order.view',      handler: _pricingListLists_ });
  register({ service: 'pricing', action: 'getPriceListItems', permission: 'order.view',      handler: _catalogGetPriceListItems_ });
  register({ service: 'pricing', action: 'createList',      permission: 'invoice.generate', handler: _pricingCreateList_ });
  register({ service: 'pricing', action: 'upsertItem',      permission: 'invoice.generate', handler: _pricingUpsertItem_ });
  register({ service: 'pricing', action: 'deactivateList',  permission: 'invoice.generate', handler: _pricingDeactivateList_ });
})();
