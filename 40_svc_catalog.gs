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
  // Layer 6: depots are static reference data, filtered only by the country_code
  // param (never by session), so the result is shared by a short-TTL cache keyed
  // on that param.
  var cc = String(params.country_code || '');
  return AppCache.getOrSet('ref:depots:' + cc, 600, function () {
    var sql  = 'SELECT * FROM depots WHERE 1=1';
    var args = [];
    if (cc) { sql += ' AND country_code = ?'; args.push(cc); }
    sql += ' AND is_active = 1 ORDER BY depot_name';
    return TursoClient.select(sql, args);
  });
}

function _catalogListPriceLists_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  // price_list's label/status columns differ from the legacy assumptions; discover them.
  var nameCol   = SchemaIntrospect.pick('price_list', ['name', 'price_list_name', 'list_name', 'title']) || 'name';
  var statusCol = SchemaIntrospect.pick('price_list', ['is_active', 'active', 'status', 'is_enabled']);
  var sql  = 'SELECT pl.*, pl.price_id AS list_id, pl.' + nameCol + ' AS list_name';
  if (statusCol && statusCol.toLowerCase() !== 'is_active') {
    sql += ', pl.' + statusCol + ' AS is_active';
  }
  sql += ' FROM price_list pl WHERE 1=1';
  var args = [];
  if (params.country_code) { sql += ' AND pl.country_code = ?'; args.push(params.country_code); }
  if (statusCol) {
    sql += ' AND (pl.' + statusCol + ' = 1 OR pl.' + statusCol + " = 'ACTIVE')";
  }
  sql += ' ORDER BY pl.' + nameCol;
  return TursoClient.select(sql, args);
}

function _catalogGetPriceListItems_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.view');
  var priceId = String(params.priceId || params.price_list_id || params.listId || '');
  if (!priceId) throw new Errors.Validation('priceId required.');
  var sql  = 'SELECT pli.*, p.name AS product_name, d.depot_name ' +
             'FROM price_list_items pli ' +
             'JOIN products p ON p.product_id = pli.product_id ' +
             'LEFT JOIN depots d ON d.depot_id = pli.depot_id ' +
             'WHERE pli.price_list_id = ? ' +
             'ORDER BY p.name';
  return TursoClient.select(sql, [priceId]);
}

function _catalogListSegments_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'customer.view');
  // Layer 6: segments are global, static reference data; serve from a short-TTL
  // cache. The same list is returned to every caller, so one cache entry serves all.
  return AppCache.getOrSet('ref:segments', 600, function () {
    // The segments label column may be `name` or `segment_name` depending on the
    // physical schema; discover it so the ORDER BY can never reference a missing
    // column. Also expose it as `segment_name` so existing readers keep working.
    var nameCol = SchemaIntrospect.pick('segments', ['name', 'segment_name', 'segment', 'title']) || 'segment_id';
    var sql = 'SELECT s.*';
    if (nameCol.toLowerCase() !== 'segment_name') sql += ', s.' + nameCol + ' AS segment_name';
    sql += ' FROM segments s ORDER BY s.' + nameCol;
    return TursoClient.select(sql);
  });
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
