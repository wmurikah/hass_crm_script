/**
 * 40_svc_contacts.gs  —  Hass CMS rebuild  (Stage 5 domain services)
 *
 * Exposes global Contacts = { ... } whose properties are handler functions.
 * Registers contacts.* actions with the Dispatcher.
 *
 * Contacts have no country_code column; scope is inherited from the parent
 * customer's country_code via a JOIN or lookup on every operation.
 * Out-of-scope access throws Errors.NotFound to avoid leaking existence.
 */

var Contacts = (function () {

  // ── Scope helpers ──────────────────────────────────────────────────────────

  /**
   * Same role-scope resolution as in Customers.
   * @returns {{ isGlobal:boolean, countries:string[] }}
   */
  function _scopeData_(session) {
    if (!session) return { isGlobal: false, countries: [] };

    var isGlobal = false;
    try {
      var roleRows = TursoClient.select(
        'SELECT scope FROM roles WHERE role_code = ? LIMIT 1',
        [session.role || '']
      );
      isGlobal = roleRows.length &&
                 String(roleRows[0].scope || '').toUpperCase() === 'GLOBAL';
    } catch (_) {}

    if (isGlobal) return { isGlobal: true, countries: [] };

    var countries = [];
    var cc = String(session.countryCode || '').trim();
    if (cc) countries.push(cc);

    try {
      var uRows = TursoClient.select(
        'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1',
        [session.userId]
      );
      if (uRows.length && uRows[0].countries_access) {
        String(uRows[0].countries_access).split(',').forEach(function (c) {
          var t = c.trim();
          if (t && countries.indexOf(t) === -1) countries.push(t);
        });
      }
    } catch (_) {}

    return { isGlobal: false, countries: countries };
  }

  /**
   * Fetch the parent customer for `customerId`, assert it is in scope, and
   * return it.  Throws Errors.NotFound (never PermissionDenied) on failure.
   */
  function _assertCustomerScope_(customerId, scope, session) {
    var customer = Repo.findById('customers', customerId);
    if (!customer) {
      _auditReject_(session, 'contact', customerId, 'CUSTOMER_NOT_FOUND', {});
      throw new Errors.NotFound('Customer not found.');
    }
    if (!scope.isGlobal) {
      var cc = String(customer.country_code || '');
      if (scope.countries.indexOf(cc) === -1) {
        _auditReject_(session, 'contact', customerId, 'SCOPE_REJECT', { row_country: cc });
        throw new Errors.NotFound('Customer not found.');
      }
    }
    return customer;
  }

  /**
   * Fetch a contact by id, resolve its parent customer's country_code, and
   * assert scope.  Throws Errors.NotFound on any failure.
   * Returns the contact row.
   */
  function _assertContactScope_(contactId, scope, session) {
    var contact = Repo.findById('contacts', contactId);
    if (!contact) {
      _auditReject_(session, 'contact', contactId, 'NOT_FOUND', {});
      throw new Errors.NotFound('Contact not found.');
    }
    if (!scope.isGlobal) {
      var customer = Repo.findById('customers', contact.customer_id);
      var cc       = customer ? String(customer.country_code || '') : '';
      if (scope.countries.indexOf(cc) === -1) {
        _auditReject_(session, 'contact', contactId, 'SCOPE_REJECT', { row_country: cc });
        throw new Errors.NotFound('Contact not found.');
      }
    }
    return contact;
  }

  function _auditReject_(session, entity, id, reason, extra) {
    try {
      Audit.log({
        actor:    session && session.userId  || '',
        action:   entity.toUpperCase() + '_' + reason,
        entity:   entity,
        entityId: String(id || ''),
        ip:       session && session.ip      || '',
        ua:       session && session.ua      || '',
        metadata: Object.assign({ reason: reason }, extra || {}),
      });
    } catch (_) {}
  }

  // ── Handler helpers ────────────────────────────────────────────────────────

  function _actor_(ctx) {
    return (ctx.actor) ||
           (ctx.session && ctx.session.userId) || '';
  }

  function _ip_(ctx) { return (ctx.session && ctx.session.ip) || ''; }
  function _ua_(ctx) { return (ctx.session && ctx.session.ua) || ''; }

  function _cleanContact_(c) {
    if (!c) return c;
    var out = Object.assign({}, c);
    delete out.password_hash;
    return out;
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  function _listHandler(ctx, params) {
    var session = ctx.session;
    var scope   = _scopeData_(session);

    var sql, args;

    if (scope.isGlobal) {
      sql  = 'SELECT co.* FROM contacts co WHERE 1=1';
      args = [];
      if (params.customer_id) { sql += ' AND co.customer_id = ?'; args.push(String(params.customer_id)); }
      if (params.status)      { sql += ' AND co.status = ?';      args.push(String(params.status));      }
    } else {
      if (!scope.countries.length) return [];
      var placeholders = scope.countries.map(function () { return '?'; }).join(',');
      sql  = 'SELECT co.* FROM contacts co ' +
             'INNER JOIN customers cu ON co.customer_id = cu.customer_id ' +
             'WHERE cu.country_code IN (' + placeholders + ')';
      args = scope.countries.slice();
      if (params.customer_id) { sql += ' AND co.customer_id = ?'; args.push(String(params.customer_id)); }
      if (params.status)      { sql += ' AND co.status = ?';      args.push(String(params.status));      }
    }

    var limit  = Math.min(parseInt(params.limit, 10)  || 200, 1000);
    var offset = parseInt(params.offset, 10) || 0;
    sql += ' ORDER BY co.last_name ASC, co.first_name ASC LIMIT ' + limit;
    if (offset) sql += ' OFFSET ' + offset;

    return TursoClient.select(sql, args).map(_cleanContact_);
  }

  function _getHandler(ctx, params) {
    var session   = ctx.session;
    var contactId = String(params.contactId || params.contact_id || '').trim();
    if (!contactId) throw new Errors.Validation('contactId is required.');

    var scope   = _scopeData_(session);
    var contact = _assertContactScope_(contactId, scope, session);
    return _cleanContact_(contact);
  }

  function _createHandler(ctx, params) {
    var session    = ctx.session;
    var customerId = String(params.customer_id || '').trim();
    var firstName  = String(params.first_name  || '').trim();
    var lastName   = String(params.last_name   || '').trim();
    var email      = String(params.email       || '').trim().toLowerCase();
    var portalRole = String(params.portal_role || '').trim();

    if (!customerId) throw new Errors.Validation('customer_id is required.');
    if (!firstName)  throw new Errors.Validation('first_name is required.');
    if (!lastName)   throw new Errors.Validation('last_name is required.');
    if (!email)      throw new Errors.Validation('email is required.');
    if (!portalRole) throw new Errors.Validation('portal_role is required.');

    var scope = _scopeData_(session);
    _assertCustomerScope_(customerId, scope, session);

    var contactId = uuidv4();
    var now       = nowIso();

    var row = {
      contact_id:      contactId,
      customer_id:     customerId,
      first_name:      firstName,
      last_name:       lastName,
      email:           email,
      phone:           String(params.phone       || ''),
      job_title:       String(params.job_title   || ''),
      department:      String(params.department  || ''),
      portal_role:     portalRole,
      is_portal_user:  params.is_portal_user ? 1 : 0,
      status:          'ACTIVE',
      created_at:      now,
      updated_at:      now,
    };

    Repo.create('contacts', row);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CONTACT_CREATED',
      entity:   'contacts',
      entityId: contactId,
      before:   null,
      after:    row,
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return _cleanContact_(Repo.findById('contacts', contactId));
  }

  function _updateHandler(ctx, params) {
    var session   = ctx.session;
    var contactId = String(params.contactId || params.contact_id || '').trim();
    if (!contactId) throw new Errors.Validation('contactId is required.');

    var scope   = _scopeData_(session);
    var before  = _assertContactScope_(contactId, scope, session);

    var allowed = ['first_name', 'last_name', 'phone', 'job_title',
                   'department', 'portal_role', 'is_portal_user'];
    var patch   = { updated_at: nowIso() };
    allowed.forEach(function (k) {
      if (params[k] !== undefined) patch[k] = params[k];
    });
    if (Object.keys(patch).length <= 1) {
      throw new Errors.Validation('No updatable fields provided.');
    }

    Repo.update('contacts', contactId, patch);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CONTACT_UPDATED',
      entity:   'contacts',
      entityId: contactId,
      before:   _cleanContact_(before),
      after:    patch,
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return { success: true };
  }

  function _setPortalRoleHandler(ctx, params) {
    var session    = ctx.session;
    var contactId  = String(params.contactId  || params.contact_id  || '').trim();
    var portalRole = String(params.portal_role || '').trim();
    if (!contactId)  throw new Errors.Validation('contactId is required.');
    if (!portalRole) throw new Errors.Validation('portal_role is required.');

    var scope  = _scopeData_(session);
    var before = _assertContactScope_(contactId, scope, session);

    var patch = { portal_role: portalRole, updated_at: nowIso() };
    Repo.update('contacts', contactId, patch);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CONTACT_PORTAL_ROLE_CHANGED',
      entity:   'contacts',
      entityId: contactId,
      before:   { portal_role: before.portal_role || null },
      after:    { portal_role: portalRole },
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return { success: true, portal_role: portalRole };
  }

  function _deactivateHandler(ctx, params) {
    var session   = ctx.session;
    var contactId = String(params.contactId || params.contact_id || '').trim();
    if (!contactId) throw new Errors.Validation('contactId is required.');

    var scope  = _scopeData_(session);
    var before = _assertContactScope_(contactId, scope, session);

    var after = { status: 'INACTIVE', updated_at: nowIso() };
    Repo.update('contacts', contactId, after);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CONTACT_DEACTIVATED',
      entity:   'contacts',
      entityId: contactId,
      before:   _cleanContact_(before),
      after:    after,
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return { success: true };
  }

  // ── Public namespace ───────────────────────────────────────────────────────

  return {
    _listHandler:          _listHandler,
    _getHandler:           _getHandler,
    _createHandler:        _createHandler,
    _updateHandler:        _updateHandler,
    _setPortalRoleHandler: _setPortalRoleHandler,
    _deactivateHandler:    _deactivateHandler,
  };

})();

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerContacts_() {
  // Ensure portal_role column exists (not in original contacts schema).
  try { TursoClient.write('ALTER TABLE contacts ADD COLUMN portal_role TEXT'); } catch (_) {}

  register({ service: 'contacts', action: 'list',          permission: 'contacts.manage', handler: Contacts._listHandler          });
  register({ service: 'contacts', action: 'get',           permission: 'contacts.manage', handler: Contacts._getHandler           });
  register({ service: 'contacts', action: 'create',        permission: 'contacts.manage', handler: Contacts._createHandler        });
  register({ service: 'contacts', action: 'update',        permission: 'contacts.manage', handler: Contacts._updateHandler        });
  register({ service: 'contacts', action: 'setPortalRole', permission: 'contacts.manage', handler: Contacts._setPortalRoleHandler });
  register({ service: 'contacts', action: 'deactivate',    permission: 'contacts.manage', handler: Contacts._deactivateHandler    });
})();
