/**
 * 40_svc_customers.gs  —  Hass CMS rebuild  (Stage 5 domain services)
 *
 * Exposes global Customers = { ... } whose properties are handler functions.
 * Registers customers.* actions with the Dispatcher.
 *
 * Row-level scoping: roles with scope='GLOBAL' see every country; roles with
 * scope='COUNTRY' are limited to session.countryCode + users.countries_access.
 * Out-of-scope row fetches throw Errors.NotFound (never PermissionDenied) to
 * avoid existence leakage. Every rejection is written to audit_log.
 */

var Customers = (function () {

  // ── Scope helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve whether the session's role is GLOBAL-scoped and, if not, which
   * country codes the caller may access.
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
   * Build the SQL fragment and positional args to append to a WHERE clause
   * for country_code scoping on the customers table.
   */
  function _countryFilter_(scope) {
    if (scope.isGlobal) return { clause: '', args: [] };
    if (!scope.countries.length) return { clause: 'AND 1=0', args: [] };
    var placeholders = scope.countries.map(function () { return '?'; }).join(',');
    return {
      clause: 'AND country_code IN (' + placeholders + ')',
      args:   scope.countries.slice(),
    };
  }

  /**
   * Assert that `row` exists and is within the caller's scope.
   * Throws Errors.NotFound (never PermissionDenied) in both the
   * genuinely-missing and out-of-scope cases to avoid leaking existence.
   */
  function _assertRowScope_(row, entity, id, scope, session) {
    if (!row) {
      _auditReject_(session, entity, id, 'NOT_FOUND', {});
      throw new Errors.NotFound(entity + ' not found.');
    }
    if (!scope.isGlobal) {
      var rowCc = String(row.country_code || '');
      if (scope.countries.indexOf(rowCc) === -1) {
        _auditReject_(session, entity, id, 'SCOPE_REJECT', { row_country: rowCc });
        throw new Errors.NotFound(entity + ' not found.');
      }
    }
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

  // ── Handlers ──────────────────────────────────────────────────────────────

  function _listHandler(ctx, params) {
    var session = ctx.session;
    var scope   = _scopeData_(session);
    var cf      = _countryFilter_(scope);

    var sql  = 'SELECT * FROM customers WHERE 1=1';
    var args = [];

    if (!params.include_inactive) {
      sql += " AND status != 'INACTIVE'";
    }

    if (cf.clause) { sql += ' ' + cf.clause; args = args.concat(cf.args); }

    if (params.customer_type) { sql += ' AND customer_type = ?'; args.push(String(params.customer_type)); }
    if (params.segment_id)    { sql += ' AND segment_id = ?';    args.push(String(params.segment_id));    }
    if (params.country_code)  { sql += ' AND country_code = ?';  args.push(String(params.country_code));  }

    var limit  = Math.min(parseInt(params.limit, 10)  || 200, 1000);
    var offset = parseInt(params.offset, 10) || 0;
    sql += ' ORDER BY company_name ASC LIMIT ' + limit;
    if (offset) sql += ' OFFSET ' + offset;

    return TursoClient.select(sql, args);
  }

  function _getHandler(ctx, params) {
    var session    = ctx.session;
    var customerId = String(params.customerId || params.customer_id || '').trim();
    if (!customerId) throw new Errors.Validation('customerId is required.');

    var row   = Repo.findById('customers', customerId);
    var scope = _scopeData_(session);
    _assertRowScope_(row, 'customer', customerId, scope, session);
    // Attach the READ-ONLY Oracle credit/hold mirror when present. Additive and
    // defensive: the app never edits these fields, and any failure (mirror not
    // present yet) simply leaves customers.get exactly as before.
    try { if (row && typeof OracleCustomers !== 'undefined') row.oracle = OracleCustomers.forCustomer(row); } catch (_) {}
    return row;
  }

  function _createHandler(ctx, params) {
    var session       = ctx.session;
    var accountNumber = String(params.account_number || '').trim();
    var companyName   = String(params.company_name   || '').trim();
    var countryCode   = String(params.country_code   || '').trim();
    var customerType  = String(params.customer_type  || '').trim();

    if (!accountNumber) throw new Errors.Validation('account_number is required.');
    if (!companyName)   throw new Errors.Validation('company_name is required.');
    if (!countryCode)   throw new Errors.Validation('country_code is required.');
    if (!customerType)  throw new Errors.Validation('customer_type is required.');

    var customerId = uuidv4();
    var now        = nowIso();

    var row = {
      customer_id:            customerId,
      account_number:         accountNumber,
      company_name:           companyName,
      trading_name:           String(params.trading_name   || ''),
      customer_type:          customerType,
      segment_id:             params.segment_id            || null,
      country_code:           countryCode,
      currency_code:          String(params.currency_code  || ''),
      credit_limit:           parseFloat(params.credit_limit || 0),
      credit_used:            0,
      payment_terms:          String(params.payment_terms  || ''),
      status:                 'ACTIVE',
      relationship_owner_id:  params.relationship_owner_id || null,
      parent_customer_id:     params.parent_customer_id    || null,
      created_at:             now,
      updated_at:             now,
    };

    Repo.create('customers', row);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CUSTOMER_CREATED',
      entity:   'customers',
      entityId: customerId,
      before:   null,
      after:    row,
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return Repo.findById('customers', customerId);
  }

  function _updateHandler(ctx, params) {
    var session    = ctx.session;
    var customerId = String(params.customerId || params.customer_id || '').trim();
    if (!customerId) throw new Errors.Validation('customerId is required.');

    var before = Repo.findById('customers', customerId);
    var scope  = _scopeData_(session);
    _assertRowScope_(before, 'customer', customerId, scope, session);

    var allowed = [
      'company_name', 'trading_name', 'customer_type', 'segment_id',
      'currency_code', 'payment_terms', 'risk_score', 'risk_level',
      'relationship_owner_id', 'parent_customer_id',
    ];
    var patch = { updated_at: nowIso() };
    allowed.forEach(function (k) {
      if (params[k] !== undefined) patch[k] = params[k];
    });
    if (Object.keys(patch).length <= 1) {
      throw new Errors.Validation('No updatable fields provided.');
    }

    Repo.update('customers', customerId, patch);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CUSTOMER_UPDATED',
      entity:   'customers',
      entityId: customerId,
      before:   before,
      after:    patch,
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return { success: true };
  }

  function _softDeleteHandler(ctx, params) {
    var session    = ctx.session;
    var customerId = String(params.customerId || params.customer_id || '').trim();
    if (!customerId) throw new Errors.Validation('customerId is required.');

    var before = Repo.findById('customers', customerId);
    var scope  = _scopeData_(session);
    _assertRowScope_(before, 'customer', customerId, scope, session);

    var after = { status: 'INACTIVE', updated_at: nowIso() };
    Repo.update('customers', customerId, after);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CUSTOMER_SOFT_DELETED',
      entity:   'customers',
      entityId: customerId,
      before:   before,
      after:    after,
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
    });

    return { success: true };
  }

  function _searchHandler(ctx, params) {
    var session = ctx.session;
    var q       = String(params.q || params.query || '').trim();
    if (!q) throw new Errors.Validation('q (search query) is required.');

    var scope = _scopeData_(session);
    var cf    = _countryFilter_(scope);

    var pct  = '%' + q.toLowerCase() + '%';
    var sql  = 'SELECT * FROM customers WHERE ' +
               '(LOWER(company_name) LIKE ? OR LOWER(account_number) LIKE ? OR LOWER(trading_name) LIKE ?)';
    var args = [pct, pct, pct];

    if (cf.clause) { sql += ' ' + cf.clause; args = args.concat(cf.args); }
    if (!params.include_inactive) { sql += " AND status != 'INACTIVE'"; }

    var limit = Math.min(parseInt(params.limit, 10) || 50, 200);
    sql += ' ORDER BY company_name ASC LIMIT ' + limit;

    return TursoClient.select(sql, args);
  }

  function _customer360Handler(ctx, params) {
    var session    = ctx.session;
    var customerId = String(params.customerId || params.customer_id || '').trim();
    if (!customerId) throw new Errors.Validation('customerId is required.');

    var customer = Repo.findById('customers', customerId);
    var scope    = _scopeData_(session);
    _assertRowScope_(customer, 'customer', customerId, scope, session);

    // Layer 5: the five related-record reads are independent, so they cross the
    // network once as a single Turso pipeline batch instead of five sequential
    // round-trips. Same SQL, same args, same ordering, same decoded rows; only
    // the number of HTTP calls changes (six reads collapse to two).
    var rs = TursoClient.batch([
      { sql: "SELECT * FROM contacts WHERE customer_id = ? AND status != 'DELETED' ORDER BY created_at ASC", args: [customerId] },
      { sql: 'SELECT * FROM delivery_locations WHERE customer_id = ? ORDER BY created_at ASC', args: [customerId] },
      { sql: 'SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', args: [customerId] },
      { sql: 'SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10', args: [customerId] },
      { sql: "SELECT * FROM invoices WHERE customer_id = ? AND status != 'PAID' ORDER BY due_date ASC", args: [customerId] }
    ]);
    var contacts            = rs[0].rows;
    var deliveryLocations   = rs[1].rows;
    var recentOrders        = rs[2].rows;
    var recentTickets       = rs[3].rows;
    var outstandingInvoices = rs[4].rows;

    var creditLimit = parseFloat(customer.credit_limit || 0);
    var creditUsed  = parseFloat(customer.credit_used  || 0);

    return {
      customer:             customer,
      contacts:             contacts,
      delivery_locations:   deliveryLocations,
      recent_orders:        recentOrders,
      recent_tickets:       recentTickets,
      outstanding_invoices: outstandingInvoices,
      credit: {
        limit:     creditLimit,
        used:      creditUsed,
        available: Math.max(0, creditLimit - creditUsed),
      },
      // Read-only Oracle credit/hold mirror (null when not synced). Additive.
      oracle: (function () { try { return OracleCustomers.forCustomer(customer); } catch (_) { return null; } })(),
    };
  }

  function _setCreditHandler(ctx, params) {
    var session     = ctx.session;
    var customerId  = String(params.customerId || params.customer_id || '').trim();
    var rawLimit    = params.credit_limit;
    if (!customerId) throw new Errors.Validation('customerId is required.');
    if (rawLimit === undefined || rawLimit === null) {
      throw new Errors.Validation('credit_limit is required.');
    }
    var limit = parseFloat(rawLimit);
    if (isNaN(limit) || limit < 0) {
      throw new Errors.Validation('credit_limit must be a non-negative number.');
    }

    var before = Repo.findById('customers', customerId);
    var scope  = _scopeData_(session);
    _assertRowScope_(before, 'customer', customerId, scope, session);

    var patch = { credit_limit: limit, updated_at: nowIso() };
    Repo.update('customers', customerId, patch);

    Audit.log({
      actor:    _actor_(ctx),
      action:   'CUSTOMER_CREDIT_CHANGED',
      entity:   'customers',
      entityId: customerId,
      before:   { credit_limit: parseFloat(before.credit_limit || 0) },
      after:    { credit_limit: limit },
      ip:       _ip_(ctx),
      ua:       _ua_(ctx),
      metadata: { changed_by: _actor_(ctx) },
    });

    return { success: true, credit_limit: limit };
  }

  // ── Public namespace ───────────────────────────────────────────────────────

  return {
    _listHandler:        _listHandler,
    _getHandler:         _getHandler,
    _createHandler:      _createHandler,
    _updateHandler:      _updateHandler,
    _softDeleteHandler:  _softDeleteHandler,
    _searchHandler:      _searchHandler,
    _customer360Handler: _customer360Handler,
    _setCreditHandler:   _setCreditHandler,
  };

})();

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerCustomers_() {
  register({ service: 'customers', action: 'list',        permission: 'customers.view',       handler: Customers._listHandler        });
  register({ service: 'customers', action: 'get',         permission: 'customers.view',       handler: Customers._getHandler         });
  register({ service: 'customers', action: 'create',      permission: 'customers.create',     handler: Customers._createHandler      });
  register({ service: 'customers', action: 'update',      permission: 'customers.edit',       handler: Customers._updateHandler      });
  register({ service: 'customers', action: 'softDelete',  permission: 'customers.edit',       handler: Customers._softDeleteHandler  });
  register({ service: 'customers', action: 'search',      permission: 'customers.view',       handler: Customers._searchHandler      });
  register({ service: 'customers', action: 'customer360', permission: 'customers.view',       handler: Customers._customer360Handler });
  register({ service: 'customers', action: 'setCredit',   permission: 'customers.set_credit', handler: Customers._setCreditHandler   });
})();
