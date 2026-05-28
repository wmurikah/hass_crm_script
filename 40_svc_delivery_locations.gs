/**
 * 40_svc_delivery_locations.gs  —  Hass CMS rebuild  (Stage 5D)
 *
 * CRUD for delivery_locations, scoped to the customer's country.
 * All mutations require customer.manage permission.
 */

var DeliveryLocations = (function () {

  function _assertCustomerScope_(session, customerId) {
    var rows = TursoClient.select(
      'SELECT country_code FROM customers WHERE customer_id = ? LIMIT 1',
      [customerId]
    );
    if (!rows.length) throw new Errors.NotFound('Customer not found.');
    var cc = rows[0].country_code;

    var scopeRows = TursoClient.select(
      'SELECT scope FROM roles WHERE role_code = ? LIMIT 1',
      [session.role || '']
    );
    var isGlobal = scopeRows.length &&
                   String(scopeRows[0].scope || '').toUpperCase() === 'GLOBAL';
    if (isGlobal) return cc;

    var allowed = [session.countryCode || ''];
    try {
      var uRows = TursoClient.select(
        'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1',
        [session.userId]
      );
      if (uRows.length && uRows[0].countries_access) {
        String(uRows[0].countries_access).split(',').forEach(function (c) {
          var t = c.trim();
          if (t && allowed.indexOf(t) === -1) allowed.push(t);
        });
      }
    } catch (_) {}

    if (allowed.indexOf(cc) === -1) throw new Errors.NotFound('Customer not found.');
    return cc;
  }

  // ── list ────────────────────────────────────────────────────────────────────

  function _list_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.view');
    var customerId = String(params.customerId || '');
    if (!customerId) throw new Errors.Validation('customerId required.');
    _assertCustomerScope_(ctx.session, customerId);

    var rows = TursoClient.select(
      'SELECT * FROM delivery_locations WHERE customer_id = ? AND is_active = 1 ORDER BY location_name',
      [customerId]
    );
    return rows;
  }

  // ── get ─────────────────────────────────────────────────────────────────────

  function _get_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.view');
    var locationId = String(params.locationId || '');
    if (!locationId) throw new Errors.Validation('locationId required.');
    var rows = TursoClient.select(
      'SELECT * FROM delivery_locations WHERE location_id = ? LIMIT 1',
      [locationId]
    );
    if (!rows.length) throw new Errors.NotFound('Delivery location not found.');
    var row = rows[0];
    _assertCustomerScope_(ctx.session, row.customer_id);
    return row;
  }

  // ── create ──────────────────────────────────────────────────────────────────

  function _create_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.manage');
    var customerId   = String(params.customerId   || '');
    var locationName = String(params.location_name || params.locationName || '').trim();
    if (!customerId)   throw new Errors.Validation('customerId required.');
    if (!locationName) throw new Errors.Validation('location_name required.');

    var countryCode = _assertCustomerScope_(ctx.session, customerId);
    var locationId  = genId('LOC');
    var now         = nowIso();

    TursoClient.write(
      'INSERT INTO delivery_locations ' +
      '(location_id, customer_id, location_name, address_line1, address_line2, ' +
      'city, country_code, gps_lat, gps_lng, contact_name, contact_phone, ' +
      'is_default, is_active, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
      [
        locationId, customerId, locationName,
        String(params.address_line1 || ''),
        String(params.address_line2 || ''),
        String(params.city          || ''),
        countryCode,
        params.gps_lat   != null ? parseFloat(params.gps_lat)  : null,
        params.gps_lng   != null ? parseFloat(params.gps_lng)  : null,
        String(params.contact_name  || ''),
        String(params.contact_phone || ''),
        params.is_default ? 1 : 0,
        now, now,
      ]
    );

    Audit.log({
      actor: ctx.session.userId, action: 'DELIVERY_LOCATION_CREATED',
      entity: 'delivery_locations', entityId: locationId,
      after: { location_name: locationName, customer_id: customerId },
    });
    return { location_id: locationId, location_name: locationName };
  }

  // ── update ──────────────────────────────────────────────────────────────────

  function _update_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.manage');
    var locationId = String(params.locationId || '');
    if (!locationId) throw new Errors.Validation('locationId required.');
    var rows = TursoClient.select(
      'SELECT * FROM delivery_locations WHERE location_id = ? LIMIT 1',
      [locationId]
    );
    if (!rows.length) throw new Errors.NotFound('Delivery location not found.');
    var before = rows[0];
    _assertCustomerScope_(ctx.session, before.customer_id);

    var allowed = ['location_name', 'address_line1', 'address_line2', 'city',
                   'gps_lat', 'gps_lng', 'contact_name', 'contact_phone', 'is_default'];
    var patch = { updated_at: nowIso() };
    allowed.forEach(function (k) { if (params[k] !== undefined) patch[k] = params[k]; });
    if (Object.keys(patch).length <= 1) throw new Errors.Validation('No updatable fields provided.');
    Repo.update('delivery_locations', locationId, patch);

    Audit.log({
      actor: ctx.session.userId, action: 'DELIVERY_LOCATION_UPDATED',
      entity: 'delivery_locations', entityId: locationId,
      before: before, after: patch,
    });
    return { success: true };
  }

  // ── softDelete ──────────────────────────────────────────────────────────────

  function _softDelete_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'customer.manage');
    var locationId = String(params.locationId || '');
    if (!locationId) throw new Errors.Validation('locationId required.');
    var rows = TursoClient.select(
      'SELECT * FROM delivery_locations WHERE location_id = ? LIMIT 1',
      [locationId]
    );
    if (!rows.length) throw new Errors.NotFound('Delivery location not found.');
    var before = rows[0];
    _assertCustomerScope_(ctx.session, before.customer_id);

    TursoClient.write(
      'UPDATE delivery_locations SET is_active = 0, updated_at = ? WHERE location_id = ?',
      [nowIso(), locationId]
    );
    Audit.log({
      actor: ctx.session.userId, action: 'DELIVERY_LOCATION_DELETED',
      entity: 'delivery_locations', entityId: locationId,
      before: before, after: { is_active: 0 },
    });
    return { success: true };
  }

  return { _list_: _list_, _get_: _get_, _create_: _create_,
           _update_: _update_, _softDelete_: _softDelete_ };

})();

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerDeliveryLocations_() {
  register({ service: 'delivery_locations', action: 'list',       permission: 'customer.view',   handler: DeliveryLocations._list_ });
  register({ service: 'delivery_locations', action: 'get',        permission: 'customer.view',   handler: DeliveryLocations._get_ });
  register({ service: 'delivery_locations', action: 'create',     permission: 'customer.manage', handler: DeliveryLocations._create_ });
  register({ service: 'delivery_locations', action: 'update',     permission: 'customer.manage', handler: DeliveryLocations._update_ });
  register({ service: 'delivery_locations', action: 'softDelete',  permission: 'customer.manage', handler: DeliveryLocations._softDelete_ });
})();
