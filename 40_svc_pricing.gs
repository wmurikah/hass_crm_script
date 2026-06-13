/**
 * 40_svc_pricing.gs  —  Hass CMS rebuild  (Stage 5G, tiered pricing)
 *
 * Three pricing tiers with item-level partial override:
 *   Default  (is_default = 1, no segment, no customer)  baseline per country+currency
 *   Segment  (segment_id set)                           every customer in a segment
 *   Customer (customer_id set)                          one customer
 *
 * Resolution (Pricing.resolve) walks the tiers customer -> segment -> default and
 * returns the rate from the most specific tier that has a line item for the
 * product. A customer therefore pays negotiated rates on negotiated products and
 * standard rates on everything else.
 *
 * Scope is exactly one dimension per list (XOR), enforced in _normalizeScope_.
 * The live DB carries a partial unique index ux_price_list_default on
 * (country_code, currency_code) WHERE is_default = 1 AND status = 'ACTIVE'; the
 * create/update handlers translate that constraint violation into a clear
 * message.
 *
 * Mutations require invoice.generate (Finance); reads require order.view, the
 * same codes the original pricing handlers used.
 */

var Pricing = (function () {

  // ── Column discovery (label/status names differ from legacy assumptions) ──────

  function _nameCol_() {
    return SchemaIntrospect.pick('price_list',
      ['name', 'price_list_name', 'list_name', 'title']) || 'name';
  }
  function _statusCol_() {
    return SchemaIntrospect.pick('price_list',
      ['status', 'is_active', 'active', 'is_enabled']) || 'status';
  }
  function _segmentNameCol_() {
    return SchemaIntrospect.pick('segments',
      ['name', 'segment_name', 'segment', 'title']) || 'name';
  }
  // Works whether the status column is text ('ACTIVE') or an integer flag (1).
  function _activeClause_(col, alias) {
    var p = (alias ? alias + '.' : '') + col;
    return p + " = 'ACTIVE' OR " + p + ' = 1';
  }

  // ── Small helpers ─────────────────────────────────────────────────────────────

  function _round2_(n) {
    var v = parseFloat(n);
    if (isNaN(v)) v = 0;
    return Math.round(v * 100) / 100;
  }

  // Normalise any date-ish value to YYYY-MM-DD so string/date comparisons against
  // the (date-valued) effective_from / effective_to columns are clean.
  function _dateOnly_(v) {
    if (v === null || v === undefined || v === '') return null;
    var s = String(v);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
    return null;
  }

  function _num_(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  // ── Scope XOR enforcement ───────────────────────────────────────────────────
  // Returns { is_default (0/1), segment_id, customer_id }. Throws Validation if
  // zero or more than one scope dimension is set. A Default list clears the
  // segment and customer ids.
  function _normalizeScope_(params) {
    var isDefault, segmentId, customerId;
    var mode = params.scope ? String(params.scope).trim().toLowerCase() : null;

    if (mode) {
      if (mode === 'default') {
        isDefault = 1; segmentId = null; customerId = null;
      } else if (mode === 'segment') {
        isDefault = 0;
        segmentId  = params.segment_id ? String(params.segment_id).trim() : null;
        customerId = null;
      } else if (mode === 'customer') {
        isDefault = 0;
        customerId = params.customer_id ? String(params.customer_id).trim() : null;
        segmentId  = null;
      } else {
        throw new Errors.Validation('Invalid scope "' + params.scope + '". Use default, segment, or customer.');
      }
    } else {
      isDefault  = (params.is_default === 1 || params.is_default === '1' || params.is_default === true) ? 1 : 0;
      segmentId  = params.segment_id  ? String(params.segment_id).trim()  : null;
      customerId = params.customer_id ? String(params.customer_id).trim() : null;
    }

    var dims = [];
    if (isDefault === 1) dims.push('default');
    if (segmentId)       dims.push('segment');
    if (customerId)      dims.push('customer');

    if (dims.length === 0) {
      throw new Errors.Validation('A price list needs exactly one scope: default, segment, or customer.');
    }
    if (dims.length > 1) {
      throw new Errors.Validation('A price list can have only one scope (got ' + dims.join(' + ') + '). Choose default, segment, or customer.');
    }
    if (dims[0] === 'default') { segmentId = null; customerId = null; }
    return { is_default: isDefault, segment_id: segmentId, customer_id: customerId };
  }

  function _assertScopeRefsExist_(scope) {
    if (scope.segment_id) {
      var s = TursoClient.select('SELECT segment_id FROM segments WHERE segment_id = ? LIMIT 1', [scope.segment_id]);
      if (!s.length) throw new Errors.Validation('Segment not found: ' + scope.segment_id);
    }
    if (scope.customer_id) {
      var c = TursoClient.select('SELECT customer_id FROM customers WHERE customer_id = ? LIMIT 1', [scope.customer_id]);
      if (!c.length) throw new Errors.Validation('Customer not found: ' + scope.customer_id);
    }
  }

  // Detect the ux_price_list_default unique-index violation so we can report it
  // as a clean validation message rather than a raw integration error.
  function _isDefaultConflict_(e, isDefault) {
    if (isDefault !== 1) return false;
    var m = String((e && e.message) || '');
    return /ux_price_list_default|UNIQUE constraint failed/i.test(m);
  }

  // ── Resolver ────────────────────────────────────────────────────────────────
  //
  // resolve(customerId, productId, asOf, depotId, quantity)
  //   -> { unit_price, discount_percent, tax_rate, source_price_list_id, source_tier }
  //   -> null when no active tier prices the product for the customer's
  //      country + currency.
  function resolve(customerId, productId, asOf, depotId, quantity) {
    customerId = String(customerId || '');
    productId  = String(productId  || '');
    if (!customerId || !productId) return null;

    var cust = TursoClient.select(
      'SELECT customer_id, country_code, currency_code, segment_id FROM customers WHERE customer_id = ? LIMIT 1',
      [customerId]
    );
    if (!cust.length) return null;
    var country  = cust[0].country_code;
    var currency = cust[0].currency_code;
    var segId    = cust[0].segment_id;
    // Without a country and currency there is no list to match; do not guess.
    if (!country || !currency) return null;

    var asOfDate = _dateOnly_(asOf) || _dateOnly_(nowIso());
    var qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) qty = 1;
    var depot = depotId ? String(depotId) : null;
    var statusCol = _statusCol_();

    // Tier order: customer (most specific) -> segment -> default.
    var tiers = [{ tier: 'CUSTOMER', pred: 'pl.customer_id = ?', arg: customerId }];
    if (segId) tiers.push({ tier: 'SEGMENT', pred: 'pl.segment_id = ?', arg: segId });
    tiers.push({ tier: 'DEFAULT', pred: 'pl.is_default = 1', arg: null });

    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i];
      var sql =
        'SELECT pli.unit_price, pli.discount_percent, pli.tax_rate, ' +
        'pl.price_id AS source_price_list_id ' +
        'FROM price_list pl ' +
        'JOIN price_list_items pli ON pli.price_list_id = pl.price_id ' +
        'WHERE (' + _activeClause_(statusCol, 'pl') + ') ' +
        'AND pl.country_code = ? AND pl.currency_code = ? ' +
        'AND (pl.effective_from IS NULL OR substr(pl.effective_from,1,10) <= ?) ' +
        'AND (pl.effective_to   IS NULL OR substr(pl.effective_to,1,10)   >= ?) ' +
        'AND ' + t.pred + ' ' +
        'AND pli.product_id = ? ' +
        'AND (pli.effective_from IS NULL OR substr(pli.effective_from,1,10) <= ?) ' +
        'AND (pli.effective_to   IS NULL OR substr(pli.effective_to,1,10)   >= ?) ' +
        'AND (pli.min_quantity IS NULL OR pli.min_quantity <= ?) ' +
        'AND (pli.max_quantity IS NULL OR ? <= pli.max_quantity) ';
      var args = [country, currency, asOfDate, asOfDate];
      if (t.arg !== null) args.push(t.arg);
      args.push(productId, asOfDate, asOfDate, qty, qty);

      // Depot: when a depot is given prefer the depot-specific item, otherwise the
      // depot-agnostic (NULL) item; never borrow another depot's rate. With no
      // depot, only depot-agnostic items apply.
      if (depot) {
        sql += 'AND (pli.depot_id = ? OR pli.depot_id IS NULL) ';
        args.push(depot);
        sql += 'ORDER BY CASE WHEN pli.depot_id = ? THEN 0 ELSE 1 END, ';
        args.push(depot);
      } else {
        sql += 'AND pli.depot_id IS NULL ';
        sql += 'ORDER BY ';
      }
      // Among matching bands prefer the tighter (higher min_quantity) and the most
      // recent list; item_id keeps it deterministic.
      sql += 'COALESCE(pli.min_quantity, 0) DESC, substr(pl.effective_from,1,10) DESC, pli.item_id LIMIT 1';

      var rows = TursoClient.select(sql, args);
      if (rows.length) {
        var r = rows[0];
        return {
          unit_price:           _round2_(r.unit_price),
          discount_percent:     r.discount_percent != null ? parseFloat(r.discount_percent) : 0,
          tax_rate:             r.tax_rate != null ? parseFloat(r.tax_rate) : 0,
          source_price_list_id: r.source_price_list_id,
          source_tier:          t.tier,
        };
      }
    }
    return null;
  }

  // The most specific list in scope for a customer (customer else segment else
  // default), ignoring individual products. Stored on orders.price_list_id for
  // reference only; per-line stored rates remain the source of truth.
  function mostSpecificListId(customerId, asOf) {
    customerId = String(customerId || '');
    if (!customerId) return null;
    var cust = TursoClient.select(
      'SELECT country_code, currency_code, segment_id FROM customers WHERE customer_id = ? LIMIT 1',
      [customerId]
    );
    if (!cust.length) return null;
    var country  = cust[0].country_code;
    var currency = cust[0].currency_code;
    var segId    = cust[0].segment_id;
    if (!country || !currency) return null;

    var asOfDate  = _dateOnly_(asOf) || _dateOnly_(nowIso());
    var statusCol = _statusCol_();
    var tiers = [{ pred: 'customer_id = ?', arg: customerId }];
    if (segId) tiers.push({ pred: 'segment_id = ?', arg: segId });
    tiers.push({ pred: 'is_default = 1', arg: null });

    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i];
      var sql =
        'SELECT price_id FROM price_list ' +
        'WHERE (' + _activeClause_(statusCol, '') + ') ' +
        'AND country_code = ? AND currency_code = ? ' +
        'AND (effective_from IS NULL OR substr(effective_from,1,10) <= ?) ' +
        'AND (effective_to   IS NULL OR substr(effective_to,1,10)   >= ?) ' +
        'AND ' + t.pred + ' ORDER BY substr(effective_from,1,10) DESC LIMIT 1';
      var args = [country, currency, asOfDate, asOfDate];
      if (t.arg !== null) args.push(t.arg);
      var rows = TursoClient.select(sql, args);
      if (rows.length) return rows[0].price_id;
    }
    return null;
  }

  // Sum the stored per-line amounts for an order. Used by both the order total
  // recompute and invoice generation so an invoice always equals the resolved
  // lines. Falls back to a flat 16% VAT only when order_lines has no line_tax
  // column (older schema).
  function sumOrderLineTotals(orderId) {
    var hasTax = SchemaIntrospect.has('order_lines', 'line_tax');
    var rows;
    if (hasTax) {
      rows = TursoClient.select(
        'SELECT COALESCE(SUM(line_subtotal),0) AS sub, COALESCE(SUM(line_tax),0) AS tax, ' +
        'COALESCE(SUM(line_total),0) AS tot FROM order_lines WHERE order_id = ?', [orderId]
      );
    } else {
      rows = TursoClient.select(
        'SELECT COALESCE(SUM(line_subtotal),0) AS sub FROM order_lines WHERE order_id = ?', [orderId]
      );
    }
    var sub = rows.length ? parseFloat(rows[0].sub) || 0 : 0;
    var tax, tot;
    if (hasTax) {
      tax = rows.length ? parseFloat(rows[0].tax) || 0 : 0;
      tot = rows.length ? parseFloat(rows[0].tot) || 0 : 0;
      if (!tot) tot = sub + tax; // legacy lines may not have line_total populated
    } else {
      tax = sub * 0.16;
      tot = sub + tax;
    }
    return { subtotal: _round2_(sub), tax: _round2_(tax), total: _round2_(tot) };
  }

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function _listLists_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.view');
    var nameCol   = _nameCol_();
    var statusCol = _statusCol_();
    var segName   = _segmentNameCol_();

    var sql =
      'SELECT pl.*, pl.price_id AS list_id, pl.' + nameCol + ' AS list_name, ' +
      's.' + segName + ' AS segment_name, c.company_name AS customer_name';
    if (statusCol.toLowerCase() !== 'is_active') {
      sql += ', pl.' + statusCol + ' AS is_active';
    }
    sql +=
      ' FROM price_list pl ' +
      'LEFT JOIN segments  s ON s.segment_id  = pl.segment_id ' +
      'LEFT JOIN customers c ON c.customer_id = pl.customer_id WHERE 1=1';
    var args = [];
    if (params.country_code)  { sql += ' AND pl.country_code = ?';  args.push(String(params.country_code).toUpperCase()); }
    if (params.currency_code) { sql += ' AND pl.currency_code = ?'; args.push(String(params.currency_code).toUpperCase()); }
    if (params.scope) {
      var m = String(params.scope).toLowerCase();
      if (m === 'default')       sql += ' AND pl.is_default = 1';
      else if (m === 'segment')  sql += ' AND pl.segment_id IS NOT NULL';
      else if (m === 'customer') sql += ' AND pl.customer_id IS NOT NULL';
    }
    if (!params.include_inactive) {
      sql += ' AND (' + _activeClause_(statusCol, 'pl') + ')';
    }
    sql += ' ORDER BY pl.country_code, pl.is_default DESC, pl.' + nameCol;
    if (params.limit) sql += ' LIMIT ' + (parseInt(params.limit, 10) || 100);
    return TursoClient.select(sql, args);
  }

  function _createList_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'invoice.generate');
    var name        = String(params.name || params.price_list_name || params.list_name || '').trim();
    var countryCode = String(params.country_code  || '').trim().toUpperCase();
    var currency    = String(params.currency_code || '').trim().toUpperCase();
    if (!name)        throw new Errors.Validation('name required.');
    if (!countryCode) throw new Errors.Validation('country_code required.');
    if (!currency)    throw new Errors.Validation('currency_code required.');

    var scope = _normalizeScope_(params);
    _assertScopeRefsExist_(scope);

    var priceId   = genId('PL');
    var now       = nowIso();
    var nameCol   = _nameCol_();
    var statusCol = _statusCol_();

    var cols = ['price_id', nameCol, 'country_code', 'currency_code', 'is_default', 'segment_id', 'customer_id'];
    var vals = [priceId, name, countryCode, currency, scope.is_default, scope.segment_id, scope.customer_id];
    if (SchemaIntrospect.has('price_list', 'effective_from')) {
      cols.push('effective_from'); vals.push(_dateOnly_(params.effective_from) || _dateOnly_(now));
    }
    if (SchemaIntrospect.has('price_list', 'effective_to')) {
      cols.push('effective_to'); vals.push(_dateOnly_(params.effective_to) || null);
    }
    if (SchemaIntrospect.has('price_list', 'notes')) {
      cols.push('notes'); vals.push(params.notes ? String(params.notes) : null);
    }
    cols.push(statusCol);
    vals.push(statusCol.toLowerCase() === 'status' ? 'ACTIVE' : 1);
    if (SchemaIntrospect.has('price_list', 'created_by')) { cols.push('created_by'); vals.push(ctx.session.userId); }
    if (SchemaIntrospect.has('price_list', 'created_at')) { cols.push('created_at'); vals.push(now); }
    if (SchemaIntrospect.has('price_list', 'updated_at')) { cols.push('updated_at'); vals.push(now); }

    var ph = cols.map(function () { return '?'; }).join(',');
    try {
      TursoClient.write('INSERT INTO price_list (' + cols.join(', ') + ') VALUES (' + ph + ')', vals);
    } catch (e) {
      if (_isDefaultConflict_(e, scope.is_default)) {
        throw new Errors.Validation(
          'An active default price list already exists for ' + countryCode + ' / ' + currency +
          '. Deactivate or edit that list before adding another default.');
      }
      throw e;
    }

    Audit.log({
      actor: ctx.session.userId, action: 'PRICE_LIST_CREATED',
      entity: 'price_list', entityId: priceId,
      after: { name: name, country_code: countryCode, currency_code: currency,
               is_default: scope.is_default, segment_id: scope.segment_id, customer_id: scope.customer_id },
    });
    return { price_id: priceId, list_id: priceId };
  }

  function _updateList_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'invoice.generate');
    var priceId = String(params.price_list_id || params.price_id || params.priceId || '');
    if (!priceId) throw new Errors.Validation('price_list_id required.');

    var rows = TursoClient.select('SELECT * FROM price_list WHERE price_id = ? LIMIT 1', [priceId]);
    if (!rows.length) throw new Errors.NotFound('Price list not found.');
    var before    = rows[0];
    var statusCol = _statusCol_();
    var nameCol   = _nameCol_();

    var sets = [];
    var args = [];
    var scope = null;
    var scopeProvided = (params.scope !== undefined) || (params.is_default !== undefined) ||
                        (params.segment_id !== undefined) || (params.customer_id !== undefined);
    if (scopeProvided) {
      scope = _normalizeScope_(params);
      _assertScopeRefsExist_(scope);
      sets.push('is_default = ?');  args.push(scope.is_default);
      sets.push('segment_id = ?');  args.push(scope.segment_id);
      sets.push('customer_id = ?'); args.push(scope.customer_id);
    }
    if (params.name !== undefined || params.price_list_name !== undefined || params.list_name !== undefined) {
      var nm = String(params.name || params.price_list_name || params.list_name || '').trim();
      if (nm) { sets.push(nameCol + ' = ?'); args.push(nm); }
    }
    if (params.country_code !== undefined && String(params.country_code).trim()) {
      sets.push('country_code = ?'); args.push(String(params.country_code).trim().toUpperCase());
    }
    if (params.currency_code !== undefined && String(params.currency_code).trim()) {
      sets.push('currency_code = ?'); args.push(String(params.currency_code).trim().toUpperCase());
    }
    if (params.effective_from !== undefined && SchemaIntrospect.has('price_list', 'effective_from')) {
      sets.push('effective_from = ?'); args.push(_dateOnly_(params.effective_from) || null);
    }
    if (params.effective_to !== undefined && SchemaIntrospect.has('price_list', 'effective_to')) {
      sets.push('effective_to = ?'); args.push(_dateOnly_(params.effective_to) || null);
    }
    if (params.notes !== undefined && SchemaIntrospect.has('price_list', 'notes')) {
      sets.push('notes = ?'); args.push(params.notes ? String(params.notes) : null);
    }
    if (params.status !== undefined) {
      var st = String(params.status).trim().toUpperCase();
      if (st !== 'ACTIVE' && st !== 'INACTIVE') throw new Errors.Validation('status must be ACTIVE or INACTIVE.');
      sets.push(statusCol + ' = ?');
      args.push(statusCol.toLowerCase() === 'status' ? st : (st === 'ACTIVE' ? 1 : 0));
    }
    if (!sets.length) throw new Errors.Validation('No updatable fields provided.');
    if (SchemaIntrospect.has('price_list', 'updated_at')) { sets.push('updated_at = ?'); args.push(nowIso()); }
    args.push(priceId);

    try {
      TursoClient.write('UPDATE price_list SET ' + sets.join(', ') + ' WHERE price_id = ?', args);
    } catch (e) {
      var resultingDefault = scopeProvided ? scope.is_default : (String(before.is_default) === '1' ? 1 : 0);
      if (_isDefaultConflict_(e, resultingDefault)) {
        throw new Errors.Validation(
          'An active default price list already exists for this country and currency. ' +
          'Deactivate or edit that list first.');
      }
      throw e;
    }

    Audit.log({
      actor: ctx.session.userId, action: 'PRICE_LIST_UPDATED',
      entity: 'price_list', entityId: priceId,
      before: before,
      after: { is_default: scope ? scope.is_default : before.is_default,
               segment_id:  scope ? scope.segment_id  : before.segment_id,
               customer_id: scope ? scope.customer_id : before.customer_id,
               status: params.status !== undefined ? params.status : undefined },
    });
    return { success: true, price_id: priceId };
  }

  function _upsertItem_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'invoice.generate');
    var priceId   = String(params.price_list_id || params.priceId || '');
    var productId = String(params.product_id || '');
    var unitPrice = parseFloat(params.unit_price);
    if (!priceId)   throw new Errors.Validation('price_list_id required.');
    if (!productId) throw new Errors.Validation('product_id required.');
    if (isNaN(unitPrice) || unitPrice < 0) throw new Errors.Validation('unit_price must be >= 0.');

    var listRows = TursoClient.select('SELECT price_id FROM price_list WHERE price_id = ? LIMIT 1', [priceId]);
    if (!listRows.length) throw new Errors.NotFound('Price list not found.');

    var discount = _num_(params.discount_percent);
    var taxRate  = _num_(params.tax_rate);
    var minQty   = _num_(params.min_quantity);
    var maxQty   = _num_(params.max_quantity);
    if (minQty != null && maxQty != null && maxQty < minQty) {
      throw new Errors.Validation('max_quantity must be >= min_quantity.');
    }
    var depotId  = params.depot_id ? String(params.depot_id) : null;
    var effFrom  = _dateOnly_(params.effective_from) || null;
    var effTo    = _dateOnly_(params.effective_to)   || null;
    var now      = nowIso();

    // Edit an existing item only when an explicit item_id is supplied; otherwise
    // insert a new one. This lets one product carry several rows (quantity bands
    // and per-depot rates) without collapsing them.
    if (params.item_id) {
      var itemId = String(params.item_id);
      var ex = TursoClient.select(
        'SELECT item_id FROM price_list_items WHERE item_id = ? AND price_list_id = ? LIMIT 1',
        [itemId, priceId]
      );
      if (!ex.length) throw new Errors.NotFound('Price list item not found.');
      TursoClient.write(
        'UPDATE price_list_items SET product_id = ?, depot_id = ?, unit_price = ?, ' +
        'min_quantity = ?, max_quantity = ?, discount_percent = ?, tax_rate = ?, ' +
        'effective_from = ?, effective_to = ? WHERE item_id = ?',
        [productId, depotId, unitPrice, minQty, maxQty, discount, taxRate, effFrom, effTo, itemId]
      );
      Audit.log({
        actor: ctx.session.userId, action: 'PRICE_ITEM_UPDATED',
        entity: 'price_list_items', entityId: itemId,
        after: { price_list_id: priceId, product_id: productId, unit_price: unitPrice,
                 discount_percent: discount, tax_rate: taxRate,
                 min_quantity: minQty, max_quantity: maxQty, depot_id: depotId },
      });
      return { item_id: itemId, updated: true };
    }

    var newId = genId('PLI');
    TursoClient.write(
      'INSERT INTO price_list_items ' +
      '(item_id, price_list_id, product_id, depot_id, unit_price, min_quantity, ' +
      'max_quantity, discount_percent, tax_rate, effective_from, effective_to, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [newId, priceId, productId, depotId, unitPrice, minQty, maxQty, discount, taxRate, effFrom, effTo, now]
    );
    Audit.log({
      actor: ctx.session.userId, action: 'PRICE_ITEM_CREATED',
      entity: 'price_list_items', entityId: newId,
      after: { price_list_id: priceId, product_id: productId, unit_price: unitPrice,
               discount_percent: discount, tax_rate: taxRate,
               min_quantity: minQty, max_quantity: maxQty, depot_id: depotId },
    });
    return { item_id: newId, updated: false };
  }

  function _deleteItem_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'invoice.generate');
    var itemId = String(params.item_id || '');
    if (!itemId) throw new Errors.Validation('item_id required.');
    var rows = TursoClient.select('SELECT * FROM price_list_items WHERE item_id = ? LIMIT 1', [itemId]);
    if (!rows.length) throw new Errors.NotFound('Price list item not found.');
    TursoClient.write('DELETE FROM price_list_items WHERE item_id = ?', [itemId]);
    Audit.log({
      actor: ctx.session.userId, action: 'PRICE_ITEM_DELETED',
      entity: 'price_list_items', entityId: itemId, before: rows[0],
    });
    return { success: true };
  }

  function _deactivateList_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'invoice.generate');
    var priceId = String(params.priceId || params.price_list_id || params.price_id || '');
    if (!priceId) throw new Errors.Validation('priceId required.');
    var rows = TursoClient.select('SELECT * FROM price_list WHERE price_id = ? LIMIT 1', [priceId]);
    if (!rows.length) throw new Errors.NotFound('Price list not found.');
    var before    = rows[0];
    var statusCol = _statusCol_();
    var inactiveVal = statusCol.toLowerCase() === 'status' ? 'INACTIVE' : 0;
    var setSql = statusCol + ' = ?';
    var args   = [inactiveVal];
    if (SchemaIntrospect.has('price_list', 'updated_at')) { setSql += ', updated_at = ?'; args.push(nowIso()); }
    args.push(priceId);
    TursoClient.write('UPDATE price_list SET ' + setSql + ' WHERE price_id = ?', args);
    Audit.log({
      actor: ctx.session.userId, action: 'PRICE_LIST_DEACTIVATED',
      entity: 'price_list', entityId: priceId,
      before: before, after: { status: 'INACTIVE' },
    });
    return { success: true };
  }

  // Read-only resolver preview for the Price Lists UI (acceptance tool).
  function _previewResolve_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'order.view');
    var customerId = String(params.customer_id || params.customerId || '');
    var productId  = String(params.product_id  || params.productId  || '');
    if (!customerId) throw new Errors.Validation('customer_id required.');
    if (!productId)  throw new Errors.Validation('product_id required.');
    var asOf    = params.as_of || params.asOf || params.date || null;
    var depotId = params.depot_id || params.depotId || null;
    var qty     = (params.quantity != null && params.quantity !== '') ? params.quantity : 1;

    var res = resolve(customerId, productId, asOf, depotId, qty);
    if (!res) return null;
    try {
      var lst = TursoClient.select(
        'SELECT ' + _nameCol_() + ' AS list_name, country_code, currency_code ' +
        'FROM price_list WHERE price_id = ? LIMIT 1', [res.source_price_list_id]
      );
      if (lst.length) {
        res.list_name     = lst[0].list_name;
        res.country_code  = lst[0].country_code;
        res.currency_code = lst[0].currency_code;
      }
    } catch (_) {}
    res.line_total_each = _round2_(res.unit_price * (1 - (res.discount_percent || 0) / 100));
    return res;
  }

  return {
    resolve:            resolve,
    mostSpecificListId: mostSpecificListId,
    sumOrderLineTotals: sumOrderLineTotals,
    _listLists_:        _listLists_,
    _createList_:       _createList_,
    _updateList_:       _updateList_,
    _upsertItem_:       _upsertItem_,
    _deleteItem_:       _deleteItem_,
    _deactivateList_:   _deactivateList_,
    _previewResolve_:   _previewResolve_,
  };

})();

// ── Registration ──────────────────────────────────────────────────────────────
// Permission codes match the existing pricing handlers (read: order.view,
// mutate: invoice.generate). getPriceListItems reuses the catalog read handler.

(function _registerPricing_() {
  register({ service: 'pricing', action: 'listLists',         permission: 'order.view',      handler: Pricing._listLists_ });
  register({ service: 'pricing', action: 'getPriceListItems', permission: 'order.view',      handler: _catalogGetPriceListItems_ });
  register({ service: 'pricing', action: 'previewResolve',    permission: 'order.view',      handler: Pricing._previewResolve_ });
  register({ service: 'pricing', action: 'createList',        permission: 'invoice.generate', handler: Pricing._createList_ });
  register({ service: 'pricing', action: 'updateList',        permission: 'invoice.generate', handler: Pricing._updateList_ });
  register({ service: 'pricing', action: 'upsertItem',        permission: 'invoice.generate', handler: Pricing._upsertItem_ });
  register({ service: 'pricing', action: 'deleteItem',        permission: 'invoice.generate', handler: Pricing._deleteItem_ });
  register({ service: 'pricing', action: 'deactivateList',    permission: 'invoice.generate', handler: Pricing._deactivateList_ });
})();
