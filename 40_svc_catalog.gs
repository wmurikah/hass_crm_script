/**
 * 40_svc_catalog.gs  -  Hass CMS rebuild  (Stage 5E)
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
  // Default to active depots; admins can pass is_active=false to surface and
  // reactivate deactivated ones (mirrors listProducts so both round-trip).
  if (params.is_active !== undefined) {
    sql += ' AND is_active = ?';
    args.push(params.is_active ? 1 : 0);
  } else {
    sql += ' AND is_active = 1';
  }
  sql += ' ORDER BY depot_name';
  return TursoClient.select(sql, args);
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
  // The segments label column may be `name` or `segment_name` depending on the
  // physical schema; discover it so the ORDER BY can never reference a missing
  // column. Also expose it as `segment_name` so existing readers keep working.
  var nameCol = SchemaIntrospect.pick('segments', ['name', 'segment_name', 'segment', 'title']) || 'segment_id';
  var sql = 'SELECT s.*';
  if (nameCol.toLowerCase() !== 'segment_name') sql += ', s.' + nameCol + ' AS segment_name';
  sql += ' FROM segments s ORDER BY s.' + nameCol;
  return TursoClient.select(sql);
}

// ── product / depot mutations (catalog administration) ─────────────────────────
//
// Products and depots are reference data shared across orders, pricing and
// logistics, but they had no write path: no role (not even SUPER_ADMIN via the
// '*' wildcard) could edit them, because the action simply did not exist. These
// create / update / status handlers close that gap so the permission-driven UI
// can expose an edit affordance for them like every other entity.
//
// They are gated by the existing order.manage permission (the broad management
// code already used for catalog-adjacent administration such as SLA, branding and
// config); no new permission code is introduced. Physical column names differ
// between deployments, so every write is filtered through SchemaIntrospect: only
// columns the table actually has are ever referenced, which keeps the INSERT /
// UPDATE safe with no schema change. All mutations are audit-logged.

function _catalogActor_(ctx) {
  return (ctx.session && (ctx.session.userId || ctx.session.user_id)) || ctx.actor || 'SYSTEM';
}

// Keep only entries whose key is a real column on `table` and whose value is
// defined, so the generated SQL can never reference a column the schema lacks.
function _catalogExistingCols_(table, obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) {
    if (obj[k] === undefined) return;
    if (SchemaIntrospect.has(table, k)) out[k] = obj[k];
  });
  return out;
}

function _catalogTruthy_(v) {
  return v === 1 || v === true || String(v) === '1' || String(v).toUpperCase() === 'ACTIVE';
}

function _catalogCreateProduct_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var name = String(params.name || '').trim();
  if (!name) throw new Errors.Validation('Product name is required.');

  var codeCol   = SchemaIntrospect.pick('products', ['product_code', 'sku', 'code']);
  var unitCol   = SchemaIntrospect.pick('products', ['unit_of_measure', 'unit', 'uom']);
  var productId = String(params.product_id || genId('PRD')).trim();
  var code      = String(params.product_code || params.sku || params.code || '').trim() || productId;
  var now       = nowIso();

  var draft = { product_id: productId, name: name, category: params.category,
                is_active: 1, created_at: now, updated_at: now };
  if (codeCol) draft[codeCol] = code;
  if (unitCol && (params.unit_of_measure !== undefined || params.unit !== undefined)) {
    draft[unitCol] = String(params.unit_of_measure || params.unit || '');
  }

  var row = _catalogExistingCols_('products', draft);
  Repo.create('products', row);
  Audit.log({ actor: _catalogActor_(ctx), action: 'PRODUCT_CREATED', entity: 'products',
              entityId: productId, after: row });
  return Repo.findById('products', productId);
}

function _catalogUpdateProduct_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var productId = String(params.productId || params.product_id || '').trim();
  if (!productId) throw new Errors.Validation('productId required.');
  var before = Repo.findById('products', productId);
  if (!before) throw new Errors.NotFound('Product not found.');

  var codeCol = SchemaIntrospect.pick('products', ['product_code', 'sku', 'code']);
  var unitCol = SchemaIntrospect.pick('products', ['unit_of_measure', 'unit', 'uom']);
  var draft = {};
  if (params.name     !== undefined) draft.name     = String(params.name);
  if (params.category !== undefined) draft.category = params.category;
  if (codeCol && (params.product_code !== undefined || params.sku !== undefined || params.code !== undefined)) {
    draft[codeCol] = String(params.product_code || params.sku || params.code || '');
  }
  if (unitCol && (params.unit_of_measure !== undefined || params.unit !== undefined)) {
    draft[unitCol] = String(params.unit_of_measure || params.unit || '');
  }
  if (params.is_active !== undefined) draft.is_active = _catalogTruthy_(params.is_active) ? 1 : 0;

  var patch = _catalogExistingCols_('products', draft);
  if (!Object.keys(patch).length) throw new Errors.Validation('No updatable fields provided.');
  if (SchemaIntrospect.has('products', 'updated_at')) patch.updated_at = nowIso();

  Repo.update('products', productId, patch);
  Audit.log({ actor: _catalogActor_(ctx), action: 'PRODUCT_UPDATED', entity: 'products',
              entityId: productId, before: before, after: patch });
  return { success: true, product_id: productId };
}

function _catalogSetProductStatus_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var productId = String(params.productId || params.product_id || '').trim();
  if (!productId) throw new Errors.Validation('productId required.');
  if (!SchemaIntrospect.has('products', 'is_active')) {
    throw new Errors.Validation('Products have no status column.');
  }
  var before = Repo.findById('products', productId);
  if (!before) throw new Errors.NotFound('Product not found.');

  var active = _catalogTruthy_(params.is_active) ? 1 : 0;
  var patch  = { is_active: active };
  if (SchemaIntrospect.has('products', 'updated_at')) patch.updated_at = nowIso();
  Repo.update('products', productId, patch);
  Audit.log({ actor: _catalogActor_(ctx),
              action: active ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED',
              entity: 'products', entityId: productId,
              before: { is_active: before.is_active }, after: { is_active: active } });
  return { success: true, is_active: active };
}

function _catalogCreateDepot_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var nameCol = SchemaIntrospect.pick('depots', ['depot_name', 'name']);
  var name    = String(params.depot_name || params.name || '').trim();
  if (!name) throw new Errors.Validation('Depot name is required.');

  var depotId = String(params.depot_id || genId('DEP')).trim();
  var codeCol = SchemaIntrospect.pick('depots', ['depot_code', 'code']);
  var now     = nowIso();

  var draft = { depot_id: depotId, country_code: params.country_code,
                is_active: 1, created_at: now, updated_at: now };
  if (nameCol) draft[nameCol] = name;
  if (codeCol && (params.depot_code !== undefined || params.code !== undefined)) {
    draft[codeCol] = String(params.depot_code || params.code || '');
  }

  var row = _catalogExistingCols_('depots', draft);
  Repo.create('depots', row);
  Audit.log({ actor: _catalogActor_(ctx), action: 'DEPOT_CREATED', entity: 'depots',
              entityId: depotId, after: row });
  return Repo.findById('depots', depotId);
}

function _catalogUpdateDepot_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var depotId = String(params.depotId || params.depot_id || '').trim();
  if (!depotId) throw new Errors.Validation('depotId required.');
  var before = Repo.findById('depots', depotId);
  if (!before) throw new Errors.NotFound('Depot not found.');

  var nameCol = SchemaIntrospect.pick('depots', ['depot_name', 'name']);
  var codeCol = SchemaIntrospect.pick('depots', ['depot_code', 'code']);
  var draft = {};
  if (nameCol && (params.depot_name !== undefined || params.name !== undefined)) {
    draft[nameCol] = String(params.depot_name || params.name || '');
  }
  if (params.country_code !== undefined) draft.country_code = params.country_code;
  if (codeCol && (params.depot_code !== undefined || params.code !== undefined)) {
    draft[codeCol] = String(params.depot_code || params.code || '');
  }
  if (params.is_active !== undefined) draft.is_active = _catalogTruthy_(params.is_active) ? 1 : 0;

  var patch = _catalogExistingCols_('depots', draft);
  if (!Object.keys(patch).length) throw new Errors.Validation('No updatable fields provided.');
  if (SchemaIntrospect.has('depots', 'updated_at')) patch.updated_at = nowIso();

  Repo.update('depots', depotId, patch);
  Audit.log({ actor: _catalogActor_(ctx), action: 'DEPOT_UPDATED', entity: 'depots',
              entityId: depotId, before: before, after: patch });
  return { success: true, depot_id: depotId };
}

function _catalogSetDepotStatus_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var depotId = String(params.depotId || params.depot_id || '').trim();
  if (!depotId) throw new Errors.Validation('depotId required.');
  if (!SchemaIntrospect.has('depots', 'is_active')) {
    throw new Errors.Validation('Depots have no status column.');
  }
  var before = Repo.findById('depots', depotId);
  if (!before) throw new Errors.NotFound('Depot not found.');

  var active = _catalogTruthy_(params.is_active) ? 1 : 0;
  var patch  = { is_active: active };
  if (SchemaIntrospect.has('depots', 'updated_at')) patch.updated_at = nowIso();
  Repo.update('depots', depotId, patch);
  Audit.log({ actor: _catalogActor_(ctx),
              action: active ? 'DEPOT_ACTIVATED' : 'DEPOT_DEACTIVATED',
              entity: 'depots', entityId: depotId,
              before: { is_active: before.is_active }, after: { is_active: active } });
  return { success: true, is_active: active };
}

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerCatalog_() {
  register({ service: 'catalog', action: 'listProducts',      permission: 'order.view',    handler: _catalogListProducts_ });
  register({ service: 'catalog', action: 'getProduct',        permission: 'order.view',    handler: _catalogGetProduct_ });
  register({ service: 'catalog', action: 'listDepots',        permission: 'order.view',    handler: _catalogListDepots_ });
  register({ service: 'catalog', action: 'listPriceLists',    permission: 'order.view',    handler: _catalogListPriceLists_ });
  register({ service: 'catalog', action: 'getPriceListItems', permission: 'order.view',    handler: _catalogGetPriceListItems_ });
  register({ service: 'catalog', action: 'listSegments',      permission: 'customer.view', handler: _catalogListSegments_ });
  register({ service: 'catalog', action: 'createProduct',     permission: 'order.manage',  handler: _catalogCreateProduct_ });
  register({ service: 'catalog', action: 'updateProduct',     permission: 'order.manage',  handler: _catalogUpdateProduct_ });
  register({ service: 'catalog', action: 'setProductStatus',  permission: 'order.manage',  handler: _catalogSetProductStatus_ });
  register({ service: 'catalog', action: 'createDepot',       permission: 'order.manage',  handler: _catalogCreateDepot_ });
  register({ service: 'catalog', action: 'updateDepot',       permission: 'order.manage',  handler: _catalogUpdateDepot_ });
  register({ service: 'catalog', action: 'setDepotStatus',    permission: 'order.manage',  handler: _catalogSetDepotStatus_ });
})();
