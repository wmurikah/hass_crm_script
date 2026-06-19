/**
 * 40_svc_tickets.gs  -  Hass CMS rebuild  (Stage 7)
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

    // TKT-1 / SLA-2 linchpin: start the SLA clock. Stamp the response/resolve
    // deadlines from the matching sla_config policy (by priority + country).
    // No matching policy leaves the deadlines null; never blocks ticket create.
    _stampSlaDeadlines_(ticketId, priority, customer.country_code, now);

    // TKT-2: persist the description as the first comment on the REAL author_*
    // columns. The write is no longer swallowed, so a failure surfaces instead
    // of vanishing while the handler falsely reports success.
    if (params.description) {
      _insertComment_(ctx, ticketId, String(params.description), { now: now });
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
    // NOT-2: notify the assignee. Best-effort; never blocks the assignment.
    try {
      Notify.emit({
        recipient_id: assignedTo, recipient_type: 'STAFF',
        channel: 'EMAIL', event_key: 'TICKET_ASSIGNED',
        vars: { ticket_number: before.ticket_number, subject: before.subject, ticket_id: ticketId },
        subject: 'Ticket assigned to you: ' + (before.ticket_number || ticketId),
        body:    'Ticket ' + (before.ticket_number || ticketId) + ' (' + (before.subject || '') + ') has been assigned to you.',
        entity_type: 'tickets', entity_id: ticketId, country_code: before.country_code,
      });
    } catch (_) {}
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

    var now       = nowIso();
    var commentId = _insertComment_(ctx, ticketId, content, { now: now, isInternal: isInternal });

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

    // TKT-3: real escalation. Reassign to the next tier, notify the new owner
    // (and the requester), record the move; not just a counter bump. The same
    // core is reused by the SLA breach sweep (50_jobs.gs).
    var res = _escalateTicketCore_(before, (ctx.session.userId || ctx.session.user_id || ''),
                                   { reason: 'MANUAL', notifyRequester: params.notify_requester !== false });
    return { success: true, escalation_level: res.escalation_level, reassigned_to: res.reassigned_to };
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

    // TKT-2: persist the resolution note on the REAL author_* columns, flagged
    // is_resolution = 1. The write is no longer swallowed, so a failed note
    // surfaces instead of silently vanishing while the resolve reports success.
    _insertComment_(ctx, ticketId, 'Resolved: ' + summary, { now: now, isResolution: true });

    _recordHistory_(ticketId, 'status', before.status, 'RESOLVED', ctx.session.userId);
    Audit.log({
      actor: ctx.session.userId, action: 'TICKET_RESOLVED',
      entity: 'tickets', entityId: ticketId,
      before: { status: before.status },
      after:  { status: 'RESOLVED', resolution_type: resolutionType, resolution_summary: summary },
    });
    // NOT-2: notify the requester (the staff member who logged the ticket).
    // Best-effort; never blocks the resolution.
    try {
      Notify.emit({
        recipient_id: before.created_by, recipient_type: 'STAFF',
        channel: 'EMAIL', event_key: 'TICKET_RESOLVED',
        vars: { ticket_number: before.ticket_number, resolution_summary: summary, ticket_id: ticketId },
        subject: 'Ticket resolved: ' + (before.ticket_number || ticketId),
        body:    'Ticket ' + (before.ticket_number || ticketId) + ' has been resolved. Resolution: ' + summary,
        entity_type: 'tickets', entity_id: ticketId, country_code: before.country_code,
      });
    } catch (_) {}
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

  // --- comment writer (TKT-2) ---------------------------------------------------
  //
  // The single ticket_comments writer. All three comment paths (create
  // description, addComment, resolution note) go through here so the column set
  // matches the live table (author_type / author_id / author_name, the columns
  // the ticket UI reads back) exactly once, and a failed write is never
  // swallowed: it surfaces to the caller instead of vanishing.
  function _insertComment_(ctx, ticketId, content, opts) {
    opts = opts || {};
    var session    = (ctx && ctx.session) || {};
    var actorId    = session.userId || session.user_id || '';
    var authorType = String(session.userType || 'STAFF').toUpperCase();
    var now        = opts.now || nowIso();
    var commentId  = opts.commentId || genId('TCM');
    TursoClient.write(
      'INSERT INTO ticket_comments ' +
      '(comment_id, ticket_id, content, is_internal, is_resolution, ' +
      'author_type, author_id, author_name, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [commentId, ticketId, String(content),
       opts.isInternal ? 1 : 0, opts.isResolution ? 1 : 0,
       authorType, actorId, null, now]
    );
    return commentId;
  }

  // --- SLA deadline stamping (TKT-1) --------------------------------------------
  //
  // Stamp the response/resolve deadlines from the matching sla_config policy via
  // the shared _slaComputeDeadlines_ helper (40_svc_sla.gs), writing only the
  // ticket SLA columns that actually exist. Best-effort by design: a missing
  // policy leaves the deadlines null and any unexpected failure is logged, never
  // thrown, so a ticket can always be created even when SLA config is absent.
  function _stampSlaDeadlines_(ticketId, priority, countryCode, fromIso) {
    try {
      var hasResp = SchemaIntrospect.has('tickets', 'sla_response_by');
      var hasRes  = SchemaIntrospect.has('tickets', 'sla_resolve_by');
      if (!hasResp && !hasRes) return;
      if (typeof _slaComputeDeadlines_ !== 'function') return;
      var d = _slaComputeDeadlines_(priority, countryCode, fromIso);
      if (!d.response_by && !d.resolve_by) return;
      var sets = [];
      var args = [];
      if (hasResp) { sets.push('sla_response_by = ?'); args.push(d.response_by); }
      if (hasRes)  { sets.push('sla_resolve_by = ?');  args.push(d.resolve_by); }
      sets.push('updated_at = ?'); args.push(nowIso());
      args.push(ticketId);
      TursoClient.write('UPDATE tickets SET ' + sets.join(', ') + ' WHERE ticket_id = ?', args);
    } catch (e) {
      try { Log.warn({ service: 'tickets', action: 'stampSla', msg: (e && e.message) || String(e), data: { ticket_id: ticketId } }); } catch (_) {}
    }
  }

  // --- escalation core (TKT-3) --------------------------------------------------
  //
  // Pick the next escalation owner: an active manager in the ticket's country
  // scope (the next role tier) who is not the current assignee. Best-effort;
  // returns a user_id or null when there is no eligible target.
  function _resolveEscalationTarget_(ticket) {
    try {
      var cc = String(ticket.country_code || '');
      var rows = TursoClient.select(
        'SELECT DISTINCT u.user_id FROM users u ' +
        'JOIN user_roles ur ON ur.user_id = u.user_id ' +
        'JOIN role_permissions rp ON rp.role_code = ur.role_code ' +
        'LEFT JOIN roles r ON r.role_code = ur.role_code ' +
        'WHERE rp.permission_code IN (?, ?) ' +
        "AND UPPER(COALESCE(u.status,'ACTIVE')) = 'ACTIVE' " +
        'AND u.user_id != ? ' +
        "AND (UPPER(COALESCE(r.scope,'')) = 'GLOBAL' OR u.country_code = ? " +
        "OR (',' || COALESCE(u.countries_access,'') || ',') LIKE ?) " +
        'LIMIT 1',
        ['order.manage', '*', String(ticket.assigned_to || ''), cc, '%,' + cc + ',%']
      );
      return rows.length ? rows[0].user_id : null;
    } catch (e) {
      try { Log.warn({ service: 'tickets', action: 'escalationTarget', msg: (e && e.message) || String(e) }); } catch (_) {}
      return null;
    }
  }

  // The shared escalation effect, used by the manual escalate handler AND the
  // SLA breach sweep (50_jobs.gs). Reassigns to the next tier when one exists,
  // bumps the level, records history + audit, and emits notifications through
  // the step-1 path (Notify.emit). Notifications are best-effort, never block.
  function _escalateTicketCore_(ticket, actorId, opts) {
    opts = opts || {};
    var now        = nowIso();
    var prevLevel  = parseInt(ticket.escalation_level, 10) || 0;
    var newLevel   = prevLevel + 1;
    var target     = _resolveEscalationTarget_(ticket);
    var reassigned = (target && target !== ticket.assigned_to) ? target : null;
    var newStatus  = (reassigned && ticket.status === 'NEW') ? 'OPEN' : ticket.status;

    var setCols = [];
    var args    = [];
    if (reassigned)                  { setCols.push('assigned_to = ?'); args.push(reassigned); }
    if (newStatus !== ticket.status) { setCols.push('status = ?');      args.push(newStatus); }
    setCols.push('escalation_level = ?'); args.push(newLevel);
    setCols.push('updated_at = ?');       args.push(now);
    args.push(ticket.ticket_id);
    TursoClient.write('UPDATE tickets SET ' + setCols.join(', ') + ' WHERE ticket_id = ?', args);

    _recordHistory_(ticket.ticket_id, 'escalation_level', prevLevel, newLevel, actorId);
    if (reassigned) {
      _recordHistory_(ticket.ticket_id, 'assigned_to', ticket.assigned_to, reassigned, actorId);
    }
    Audit.log({
      actor: actorId || 'SYSTEM', action: 'TICKET_ESCALATED',
      entity: 'tickets', entityId: ticket.ticket_id,
      before: { escalation_level: prevLevel, assigned_to: ticket.assigned_to, status: ticket.status },
      after:  { escalation_level: newLevel, assigned_to: reassigned || ticket.assigned_to,
                status: newStatus, reason: opts.reason || 'MANUAL' },
    });

    var reasonLabel = opts.reason === 'SLA_BREACH' ? 'an SLA breach' : 'manual escalation';
    if (reassigned) {
      try {
        Notify.emit({
          recipient_id: reassigned, recipient_type: 'STAFF', channel: 'EMAIL',
          event_key: 'TICKET_ESCALATED',
          vars: { ticket_number: ticket.ticket_number, subject: ticket.subject,
                  ticket_id: ticket.ticket_id, escalation_level: newLevel },
          subject: 'Ticket escalated to you: ' + (ticket.ticket_number || ticket.ticket_id),
          body: 'Ticket ' + (ticket.ticket_number || ticket.ticket_id) + ' (' + (ticket.subject || '') +
                ') was escalated to you (level ' + newLevel + ', ' + reasonLabel + ').',
          entity_type: 'tickets', entity_id: ticket.ticket_id, country_code: ticket.country_code,
        });
      } catch (_) {}
    }
    if (opts.notifyRequester && ticket.created_by && ticket.created_by !== reassigned) {
      try {
        Notify.emit({
          recipient_id: ticket.created_by, recipient_type: 'STAFF', channel: 'EMAIL',
          event_key: 'TICKET_ESCALATED',
          vars: { ticket_number: ticket.ticket_number, subject: ticket.subject,
                  ticket_id: ticket.ticket_id, escalation_level: newLevel },
          subject: 'Ticket escalated: ' + (ticket.ticket_number || ticket.ticket_id),
          body: 'Ticket ' + (ticket.ticket_number || ticket.ticket_id) +
                ' was escalated (level ' + newLevel + ', ' + reasonLabel + ').',
          entity_type: 'tickets', entity_id: ticket.ticket_id, country_code: ticket.country_code,
        });
      } catch (_) {}
    }

    return { escalation_level: newLevel, reassigned_to: reassigned };
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
    // Shared escalation effect, reused by the SLA breach sweep (50_jobs.gs).
    escalateCore:       _escalateTicketCore_,
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
