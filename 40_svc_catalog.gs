/**
 * 40_svc_catalog.gs  —  Hass CMS rebuild  (Stage 5E)
 *
 * Read-only catalog: products, depots, price_list, price_list_items, segments.
 * All handlers require order.view permission (catalog is used primarily in
 * order creation). Segments require customer.view.
 */

// ── Handlers ──────────────────────────────────────────────────────────────────

function _catalogListProducts_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql  = 'SELECT * FROM products WHERE 1=1';
  var args = [];
  if (params.is_active !== undefined) {
    sql += ' AND is_active = ?';
    args.push(params.is_active ? 1 : 0);
  } else {
    sql += ' AND is_active = 1';
  }
  if (params.search) {
    sql += ' AND (LOWER(name) LIKE ? OR LOWER(product_code) LIKE ?)';
    var q = '%' + String(params.search).toLowerCase() + '%';
    args.push(q, q);
  }
  sql += ' ORDER BY name LIMIT ' + (parseInt(params.limit, 10) || 200);
  return TursoClient.select(sql, args);
}

function _catalogGetProduct_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var productId = String(params.productId || '');
  if (!productId) throw new Errors.Validation('productId required.');
  var rows = TursoClient.select('SELECT * FROM products WHERE product_id = ? LIMIT 1', [productId]);
  if (!rows.length) throw new Errors.NotFound('Product not found.');
  return rows[0];
}

function _catalogListDepots_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql  = 'SELECT * FROM depots WHERE 1=1';
  var args = [];
  if (params.country_code) {
    sql += ' AND country_code = ?';
    args.push(params.country_code);
  }
  sql += ' AND is_active = 1 ORDER BY depot_name';
  return TursoClient.select(sql, args);
}

function _catalogListPriceLists_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var sql  = 'SELECT * FROM price_list WHERE 1=1';
  var args = [];
  if (params.country_code) { sql += ' AND country_code = ?'; args.push(params.country_code); }
  sql += ' AND is_active = 1 ORDER BY price_list_name';
  return TursoClient.select(sql, args);
}

function _catalogGetPriceListItems_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var priceId = String(params.priceId || params.price_list_id || '');
  if (!priceId) throw new Errors.Validation('priceId required.');
  var sql  = 'SELECT pli.*, p.name AS product_name, d.depot_name ' +
             'FROM price_list_items pli ' +
             'JOIN products p ON p.product_id = pli.product_id ' +
             'LEFT JOIN depots d ON d.depot_id = pli.depot_id ' +
             'WHERE pli.price_id = ? AND pli.is_active = 1 ' +
             'ORDER BY p.name';
  return TursoClient.select(sql, [priceId]);
}

function _catalogListSegments_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'customer.view');
  return TursoClient.select('SELECT * FROM segments ORDER BY segment_name');
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerCatalog_() {
  register({ service: 'catalog', action: 'listProducts',      permission: 'order.view',    handler: _catalogListProducts_ });
  register({ service: 'catalog', action: 'getProduct',        permission: 'order.view',    handler: _catalogGetProduct_ });
  register({ service: 'catalog', action: 'listDepots',        permission: 'order.view',    handler: _catalogListDepots_ });
  register({ service: 'catalog', action: 'listPriceLists',    permission: 'order.view',    handler: _catalogListPriceLists_ });
  register({ service: 'catalog', action: 'getPriceListItems', permission: 'order.view',    handler: _catalogGetPriceListItems_ });
  register({ service: 'catalog', action: 'listSegments',      permission: 'customer.view', handler: _catalogListSegments_ });
})();
