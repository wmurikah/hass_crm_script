/**
 * 40_svc_tickets.gs  —  Hass CMS rebuild  (Stage 7)
 *
 * Exposes global Tickets = { ... } for handler functions.
 * Registers tickets.* actions with the Dispatcher.
 *
 * Status flow:
 *   NEW → OPEN → PENDING → RESOLVED → CLOSED
 *   Any open status → CANCELLED
 *
 * Row-level scope: GLOBAL roles see all; COUNTRY roles scoped to countryCode.
 * Audit: every mutation logs before/after.
 */

var Tickets = (function () {

  // ── Scope helpers ─────────────────────────────────────────────────────────────

  function _scopeData_(session) {
    if (!session) return { isGlobal: false, countries: [] };
    var isGlobal = false;
    try {
      var r = TursoClient.select(
        'SELECT scope FROM roles WHERE role_code = ? LIMIT 1', [session.role || '']
      );
      isGlobal = r.length && String(r[0].scope || '').toUpperCase() === 'GLOBAL';
    } catch (_) {}
    if (isGlobal) return { isGlobal: true, countries: [] };
    var countries = [];
    var cc = String(session.countryCode || '').trim();
    if (cc) countries.push(cc);
    try {
      var u = TursoClient.select(
        'SELECT countries_access FROM users WHERE user_id = ? LIMIT 1', [session.userId]
      );
      if (u.length && u[0].countries_access) {
        String(u[0].countries_access).split(',').forEach(function (c) {
          var t = c.trim();
          if (t && countries.indexOf(t) === -1) countries.push(t);
        });
      }
    } catch (_) {}
    return { isGlobal: false, countries: countries };
  }

  function _assertTicketScope_(row, session, scope) {
    if (!row) throw new Errors.NotFound('Ticket not found.');
    if (scope.isGlobal) return;
    if (scope.countries.indexOf(row.country_code) === -1) {
      Audit.log({
        actor: session.userId, action: 'TICKET_SCOPE_REJECTED',
        entity: 'tickets', entityId: row.ticket_id,
        metadata: { country_code: row.country_code, session_country: session.countryCode },
      });
      throw new Errors.NotFound('Ticket not found.');
    }
  }

  function _generateTicketNumber_(countryCode) {
    return 'TKT-' + String(countryCode).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
  }

  // ── list ──────────────────────────────────────────────────────────────────────

  function _listHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.view');
    var scope = _scopeData_(ctx.session);
    var sql   = 'SELECT t.*, c.company_name FROM tickets t ' +
                'LEFT JOIN customers c ON c.customer_id = t.customer_id WHERE 1=1';
    var args  = [];
    if (!scope.isGlobal) {
      if (!scope.countries.length) return [];
      var ph = scope.countries.map(function () { return '?'; }).join(',');
      sql += ' AND t.country_code IN (' + ph + ')';
      args = args.concat(scope.countries);
    }
    if (params.status)       { sql += ' AND t.status = ?';       args.push(params.status); }
    if (params.customer_id)  { sql += ' AND t.customer_id = ?';  args.push(params.customer_id); }
    if (params.assigned_to)  { sql += ' AND t.assigned_to = ?';  args.push(params.assigned_to); }
    if (params.priority)     { sql += ' AND t.priority = ?';     args.push(params.priority); }
    if (params.category)     { sql += ' AND t.category = ?';     args.push(params.category); }
    if (params.country_code) { sql += ' AND t.country_code = ?'; args.push(params.country_code); }
    sql += ' ORDER BY t.created_at DESC LIMIT ' + (parseInt(params.limit, 10) || 100);
    if (params.offset) sql += ' OFFSET ' + parseInt(params.offset, 10);
    return TursoClient.select(sql, args);
  }

  // ── get ───────────────────────────────────────────────────────────────────────

  function _getHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.view');
    var ticketId = String(params.ticketId || '');
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var ticket = rows[0];
    ticket.comments = TursoClient.select(
      'SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at',
      [ticketId]
    );
    ticket.history = TursoClient.select(
      'SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at DESC',
      [ticketId]
    );
    return ticket;
  }

  // ── create ────────────────────────────────────────────────────────────────────

  function _createHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.create');

    var customerId = String(params.customer_id || '');
    var subject    = String(params.subject     || '').trim();
    var category   = String(params.category    || '').trim().toUpperCase();
    if (!customerId) throw new Errors.Validation('customer_id required.');
    if (!subject || subject.length < 5) throw new Errors.Validation('subject must be at least 5 characters.');
    if (!category)   throw new Errors.Validation('category required.');

    var custRows = TursoClient.select(
      'SELECT customer_id, country_code, status FROM customers WHERE customer_id = ? LIMIT 1',
      [customerId]
    );
    if (!custRows.length) throw new Errors.NotFound('Customer not found.');
    var customer = custRows[0];

    var scope = _scopeData_(ctx.session);
    if (!scope.isGlobal && scope.countries.indexOf(customer.country_code) === -1) {
      throw new Errors.NotFound('Customer not found.');
    }

    var priority = String(params.priority || 'MEDIUM').toUpperCase();
    if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(priority) === -1) {
      priority = 'MEDIUM';
    }

    var ticketId     = genId('TKT');
    var ticketNumber = _generateTicketNumber_(customer.country_code);
    var now          = nowIso();

    TursoClient.write(
      'INSERT INTO tickets ' +
      '(ticket_id, ticket_number, customer_id, contact_id, category, subcategory, ' +
      'subject, description, priority, status, assigned_to, assigned_team_id, ' +
      'country_code, escalation_level, created_by, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)',
      [
        ticketId, ticketNumber,
        customerId,
        params.contact_id || null,
        category,
        String(params.subcategory    || ''),
        subject,
        String(params.description    || ''),
        priority,
        'NEW',
        params.assigned_to      || null,
        params.assigned_team_id || null,
        customer.country_code,
        ctx.session.userId,
        now, now,
      ]
    );

    // Add first comment (description body) if provided.
    if (params.description) {
      try {
        TursoClient.write(
          'INSERT INTO ticket_comments ' +
          '(comment_id, ticket_id, content, is_internal, is_resolution, ' +
          'created_by, created_by_type, created_at, updated_at) VALUES (?,?,?,0,0,?,?,?,?)',
          [genId('TCM'), ticketId, String(params.description),
           ctx.session.userId, ctx.session.userType, now, now]
        );
      } catch (_) {}
    }

    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_CREATED',
      entity: 'tickets', entityId: ticketId,
      after: { ticket_number: ticketNumber, customer_id: customerId,
               category: category, priority: priority },
    });
    return { ticket_id: ticketId, ticket_number: ticketNumber, status: 'NEW', priority: priority };
  }

  // ── update ────────────────────────────────────────────────────────────────────

  function _updateHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.view');
    var ticketId = String(params.ticketId || '');
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var before = rows[0];
    if (['CLOSED', 'CANCELLED'].indexOf(before.status) !== -1) {
      throw new Errors.Validation('Cannot update a ' + before.status + ' ticket.');
    }

    var allowed = ['subject', 'description', 'priority', 'subcategory', 'category'];
    var patch   = { updated_at: nowIso() };
    allowed.forEach(function (k) { if (params[k] !== undefined) patch[k] = params[k]; });
    if (Object.keys(patch).length <= 1) throw new Errors.Validation('No updatable fields provided.');
    Repo.update('tickets', ticketId, patch);

    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_UPDATED',
      entity: 'tickets', entityId: ticketId,
      before: before, after: patch,
    });
    return { success: true };
  }

  // ── assign ────────────────────────────────────────────────────────────────────

  function _assignHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.assign');
    var ticketId   = String(params.ticketId   || '');
    var assignedTo = String(params.assigned_to || '');
    if (!ticketId)   throw new Errors.Validation('ticketId required.');
    if (!assignedTo) throw new Errors.Validation('assigned_to required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var before = rows[0];

    var now = nowIso();
    TursoClient.write(
      'UPDATE tickets SET assigned_to = ?, status = ?, updated_at = ? WHERE ticket_id = ?',
      [assignedTo, before.status === 'NEW' ? 'OPEN' : before.status, now, ticketId]
    );
    _recordHistory_(ticketId, 'assigned_to', before.assigned_to, assignedTo, ctx.session.userId);
    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_ASSIGNED',
      entity: 'tickets', entityId: ticketId,
      before: { assigned_to: before.assigned_to },
      after:  { assigned_to: assignedTo },
    });
    return { success: true };
  }

  // ── addComment ────────────────────────────────────────────────────────────────

  function _addCommentHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.view');
    var ticketId  = String(params.ticketId  || '');
    var content   = String(params.content   || '').trim();
    var isInternal = params.is_internal ? 1 : 0;
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    if (!content)  throw new Errors.Validation('content required.');
    var rows = TursoClient.select(
      'SELECT ticket_id, status, country_code FROM tickets WHERE ticket_id = ? LIMIT 1',
      [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var ticket = rows[0];
    if (['CLOSED', 'CANCELLED'].indexOf(ticket.status) !== -1) {
      throw new Errors.Validation('Cannot comment on a ' + ticket.status + ' ticket.');
    }

    var commentId = genId('TCM');
    var now       = nowIso();
    var actorId   = ctx.session.user_id || ctx.session.userId || '';
    TursoClient.write(
      'INSERT INTO ticket_comments ' +
      '(comment_id, ticket_id, content, is_internal, is_resolution, ' +
      'author_type, author_id, author_name, created_at) VALUES (?,?,?,?,0,?,?,?,?)',
      [commentId, ticketId, content, isInternal,
       'STAFF', actorId, null, now]
    );

    // Re-open if PENDING and customer is commenting.
    if (ticket.status === 'PENDING' && ctx.session.userType === 'CUSTOMER') {
      TursoClient.write(
        'UPDATE tickets SET status = ?, updated_at = ? WHERE ticket_id = ?',
        ['OPEN', now, ticketId]
      );
    } else {
      TursoClient.write(
        'UPDATE tickets SET updated_at = ? WHERE ticket_id = ?', [now, ticketId]
      );
    }

    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_COMMENT_ADDED',
      entity: 'tickets', entityId: ticketId,
      after: { comment_id: commentId, is_internal: isInternal },
    });
    return { comment_id: commentId };
  }

  // ── escalate ──────────────────────────────────────────────────────────────────

  function _escalateHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.escalate');
    var ticketId = String(params.ticketId || '');
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var before = rows[0];
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].indexOf(before.status) !== -1) {
      throw new Errors.Validation('Cannot escalate a ' + before.status + ' ticket.');
    }

    var newLevel = (parseInt(before.escalation_level, 10) || 0) + 1;
    var now      = nowIso();
    TursoClient.write(
      'UPDATE tickets SET escalation_level = ?, updated_at = ? WHERE ticket_id = ?',
      [newLevel, now, ticketId]
    );
    _recordHistory_(ticketId, 'escalation_level', before.escalation_level, newLevel, ctx.session.userId);
    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_ESCALATED',
      entity: 'tickets', entityId: ticketId,
      before: { escalation_level: before.escalation_level },
      after:  { escalation_level: newLevel },
    });
    return { success: true, escalation_level: newLevel };
  }

  // ── resolve ───────────────────────────────────────────────────────────────────

  function _resolveHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.close');
    var ticketId       = String(params.ticketId          || '');
    var resolutionType = String(params.resolution_type   || 'RESOLVED').toUpperCase();
    var summary        = String(params.resolution_summary || '').trim();
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    if (!summary)  throw new Errors.Validation('resolution_summary required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var before = rows[0];
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].indexOf(before.status) !== -1) {
      throw new Errors.Validation('Ticket is already ' + before.status + '.');
    }

    var now = nowIso();
    TursoClient.write(
      'UPDATE tickets SET status = ?, resolved_at = ?, resolution_type = ?, ' +
      'resolution_summary = ?, root_cause = ?, root_cause_category = ?, updated_at = ? ' +
      'WHERE ticket_id = ?',
      [
        'RESOLVED', now, resolutionType, summary,
        String(params.root_cause          || ''),
        String(params.root_cause_category || ''),
        now, ticketId,
      ]
    );

    // Add resolution comment.
    try {
      TursoClient.write(
        'INSERT INTO ticket_comments ' +
        '(comment_id, ticket_id, content, is_internal, is_resolution, ' +
        'created_by, created_by_type, created_at, updated_at) VALUES (?,?,?,0,1,?,?,?,?)',
        [genId('TCM'), ticketId, 'Resolved: ' + summary,
         ctx.session.userId, ctx.session.userType, now, now]
      );
    } catch (_) {}

    _recordHistory_(ticketId, 'status', before.status, 'RESOLVED', ctx.session.userId);
    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_RESOLVED',
      entity: 'tickets', entityId: ticketId,
      before: { status: before.status },
      after:  { status: 'RESOLVED', resolution_type: resolutionType, resolution_summary: summary },
    });
    return { success: true, status: 'RESOLVED' };
  }

  // ── close ─────────────────────────────────────────────────────────────────────

  function _closeHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.close');
    var ticketId = String(params.ticketId || '');
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var before = rows[0];
    if (before.status === 'CLOSED') throw new Errors.Validation('Ticket is already CLOSED.');
    if (before.status === 'CANCELLED') throw new Errors.Validation('Cannot close a CANCELLED ticket.');

    var now = nowIso();
    TursoClient.write(
      'UPDATE tickets SET status = ?, closed_at = ?, resolved_at = ?, updated_at = ? WHERE ticket_id = ?',
      ['CLOSED', now, before.resolved_at || now, now, ticketId]
    );
    _recordHistory_(ticketId, 'status', before.status, 'CLOSED', ctx.session.userId);
    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_CLOSED',
      entity: 'tickets', entityId: ticketId,
      before: { status: before.status }, after: { status: 'CLOSED' },
    });
    return { success: true, status: 'CLOSED' };
  }

  // ── reopen ────────────────────────────────────────────────────────────────────

  function _reopenHandler_(ctx, params) {
    Rbac.requirePermission(ctx.session, 'ticket.reopen');
    var ticketId = String(params.ticketId || '');
    if (!ticketId) throw new Errors.Validation('ticketId required.');
    var rows = TursoClient.select(
      'SELECT * FROM tickets WHERE ticket_id = ? LIMIT 1', [ticketId]
    );
    var scope = _scopeData_(ctx.session);
    _assertTicketScope_(rows[0] || null, ctx.session, scope);
    var before = rows[0];
    if (['RESOLVED', 'CLOSED'].indexOf(before.status) === -1) {
      throw new Errors.Validation('Only RESOLVED or CLOSED tickets can be reopened.');
    }

    var now = nowIso();
    TursoClient.write(
      'UPDATE tickets SET status = ?, resolved_at = NULL, closed_at = NULL, ' +
      'resolution_type = NULL, resolution_summary = NULL, updated_at = ? WHERE ticket_id = ?',
      ['OPEN', now, ticketId]
    );
    _recordHistory_(ticketId, 'status', before.status, 'OPEN', ctx.session.userId);
    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_REOPENED',
      entity: 'tickets', entityId: ticketId,
      before: { status: before.status }, after: { status: 'OPEN' },
    });
    return { success: true, status: 'OPEN' };
  }

  // ── ticket_history helper ─────────────────────────────────────────────────────

  function _recordHistory_(ticketId, field, oldVal, newVal, actorId) {
    try {
      TursoClient.write(
        'INSERT INTO ticket_history ' +
        '(history_id, ticket_id, field, old_value, new_value, changed_by, created_at) ' +
        'VALUES (?,?,?,?,?,?,?)',
        [genId('TKH'), ticketId, field,
         oldVal != null ? String(oldVal) : null,
         newVal != null ? String(newVal) : null,
         actorId, nowIso()]
      );
    } catch (_) {}
  }

  return {
    _listHandler_:      _listHandler_,
    _getHandler_:       _getHandler_,
    _createHandler_:    _createHandler_,
    _updateHandler_:    _updateHandler_,
    _assignHandler_:    _assignHandler_,
    _addCommentHandler_: _addCommentHandler_,
    _escalateHandler_:  _escalateHandler_,
    _resolveHandler_:   _resolveHandler_,
    _closeHandler_:     _closeHandler_,
    _reopenHandler_:    _reopenHandler_,
  };

})();

// ── Registration ──────────────────────────────────────────────────────────────

(function _registerTickets_() {
  register({ service: 'tickets', action: 'list',       permission: 'ticket.view',     handler: Tickets._listHandler_ });
  register({ service: 'tickets', action: 'get',        permission: 'ticket.view',     handler: Tickets._getHandler_ });
  register({ service: 'tickets', action: 'create',     permission: 'ticket.create',   handler: Tickets._createHandler_ });
  register({ service: 'tickets', action: 'update',     permission: 'ticket.view',     handler: Tickets._updateHandler_ });
  register({ service: 'tickets', action: 'assign',     permission: 'ticket.assign',   handler: Tickets._assignHandler_ });
  register({ service: 'tickets', action: 'addComment', permission: 'ticket.view',     handler: Tickets._addCommentHandler_ });
  register({ service: 'tickets', action: 'escalate',   permission: 'ticket.escalate', handler: Tickets._escalateHandler_ });
  register({ service: 'tickets', action: 'resolve',    permission: 'ticket.close',    handler: Tickets._resolveHandler_ });
  register({ service: 'tickets', action: 'close',      permission: 'ticket.close',    handler: Tickets._closeHandler_ });
  register({ service: 'tickets', action: 'reopen',     permission: 'ticket.reopen',   handler: Tickets._reopenHandler_ });
})();
