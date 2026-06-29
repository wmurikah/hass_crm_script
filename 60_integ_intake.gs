/**
 * 60_integ_intake.gs  -  Hass CMS  (shared inbound intake pipeline)
 *
 * ONE pipeline that both inbound channels feed (email scan + WhatsApp webhook):
 *   receive a message -> deduplicate -> classify (subject + priority + category)
 *   -> create a ticket through the EXISTING ticket path (Tickets.intakeCreate)
 *   with the body and the sender as requester -> link a known customer if the
 *   sender matches -> notify the admin (via the existing EmailInteg path).
 *
 * Classification is rule-based (keywords + sender) by default, with an OPTIONAL
 * pass through the existing LLM adapter (AIService.classifyTicket). It is
 * pluggable and FAIL-SAFE: any classification failure still creates a ticket
 * with a sensible default priority rather than dropping the message.
 *
 * Deduplication is rigorous: every processed message is recorded by
 * (channel, external_id) in intake_messages, so a retried webhook or a
 * re-scanned email never creates a second ticket.
 *
 * message shape: { channel:'EMAIL'|'WHATSAPP', external_id, from, from_name,
 *                  subject, body, received_at }
 */

var Intake = (function () {

  var T_DEDUP = 'intake_messages';
  var DEFAULT_PRIORITY = 'MEDIUM';
  var SENTINEL_ID = 'INTAKE-UNMATCHED';

  function _ensureTable_() {
    try {
      TursoClient.write(
        'CREATE TABLE IF NOT EXISTS ' + T_DEDUP +
        ' (channel TEXT NOT NULL, external_id TEXT NOT NULL, ticket_id TEXT, sender TEXT, created_at TEXT, ' +
        'PRIMARY KEY (channel, external_id))', []);
    } catch (e) { throw new Errors.Integration('Could not prepare the intake dedup table: ' + e.message); }
  }

  function alreadyProcessed(channel, externalId) {
    if (!externalId) return false;
    try {
      var r = TursoClient.select(
        'SELECT 1 AS x FROM ' + T_DEDUP + ' WHERE channel = ? AND external_id = ? LIMIT 1',
        [channel, String(externalId)]);
      return r.length > 0;
    } catch (_) { return false; }   // table missing -> treat as not processed
  }

  function _recordProcessed_(channel, externalId, ticketId, sender) {
    if (!externalId) return;
    try {
      TursoClient.write(
        'INSERT OR IGNORE INTO ' + T_DEDUP + ' (channel, external_id, ticket_id, sender, created_at) VALUES (?,?,?,?,?)',
        [channel, String(externalId), ticketId || null, String(sender || '').substring(0, 200), nowIso()]);
    } catch (_) {}
  }

  function _logInteg_(integration, action, status, req, resp, err) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), integration, action, status,
         String(req || '').substring(0, 500), String(resp || '').substring(0, 500), (err || null), nowIso()]);
    } catch (_) {}
  }

  function _esc_(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Classification (rule-based + optional LLM; never throws) ────────────────
  function classify(msg, cfg) {
    var base;
    try { base = _ruleClassify_(msg, cfg); }
    catch (_) { base = { subject: _fallbackSubject_(msg), priority: DEFAULT_PRIORITY, category: 'GENERAL', classified_by: 'DEFAULT' }; }
    if (cfg && cfg.use_llm) {
      try {
        var llm = _llmClassify_(msg);
        if (llm) {
          if (llm.subject)  base.subject  = llm.subject;
          if (llm.priority) base.priority = llm.priority;
          if (llm.category) base.category = llm.category;
          base.classified_by = 'LLM';
        }
      } catch (_) { /* fail-safe: keep the rule-based result */ }
    }
    return base;
  }

  function _fallbackSubject_(msg) {
    var s = String((msg && msg.subject) || '').trim();
    if (s) return s.slice(0, 120);
    s = String((msg && msg.body) || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return s || ('Inbound ' + ((msg && msg.channel) === 'WHATSAPP' ? 'WhatsApp message' : 'email'));
  }

  function _ruleClassify_(msg, cfg) {
    var text = (String((msg && msg.subject) || '') + ' ' + String((msg && msg.body) || '')).toLowerCase();
    var priority = DEFAULT_PRIORITY;

    // Admin keyword -> priority rules take precedence.
    var kw = (cfg && cfg.keyword_rules) || [];
    for (var i = 0; i < kw.length; i++) {
      var k = kw[i] && kw[i].keyword ? String(kw[i].keyword).toLowerCase() : '';
      if (k && text.indexOf(k) !== -1) {
        var p = String(kw[i].priority || '').toUpperCase();
        if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(p) !== -1) { priority = p; break; }
      }
    }
    // Built-in defaults when no admin rule matched.
    if (priority === DEFAULT_PRIORITY) {
      if (/(urgent|asap|immediately|critical|emergency|outage|down|cannot|complaint|escalate)/.test(text)) priority = 'HIGH';
      if (/(fire|safety|spill|leak|fraud|legal|injury|severe)/.test(text)) priority = 'CRITICAL';
    }

    var category = 'GENERAL';
    if (/(invoice|payment|billing|statement|credit|refund)/.test(text)) category = 'BILLING';
    else if (/(order|delivery|deliver|dispatch|shipment|fuel|stock)/.test(text)) category = 'ORDERS';
    else if (/(account|login|password|access|portal)/.test(text)) category = 'ACCOUNT';

    return { subject: _fallbackSubject_(msg), priority: priority, category: category, classified_by: 'RULES' };
  }

  // Optional pass through the existing LLM adapter (AIService.classifyTicket).
  function _llmClassify_(msg) {
    if (typeof classifyTicket !== 'function') return null;
    var text = (msg.subject ? (msg.subject + '\n\n') : '') + String(msg.body || '');
    var r = classifyTicket(text);
    if (!r || !r.draft) return null;
    var d = r.draft;
    return {
      subject:  d.subject ? String(d.subject).slice(0, 200) : (msg.subject || ''),
      priority: _urgencyToPriority_(d.urgency),
      category: d.category ? String(d.category).toUpperCase() : null
    };
  }
  function _urgencyToPriority_(u) {
    var s = String(u || '').toUpperCase();
    if (s.indexOf('CRIT') !== -1) return 'CRITICAL';
    if (s.indexOf('HIGH') !== -1 || s === 'URGENT') return 'HIGH';
    if (s.indexOf('LOW') !== -1) return 'LOW';
    if (s.indexOf('MED') !== -1) return 'MEDIUM';
    return null;   // unknown -> let the rule/default priority stand
  }

  // ── Customer linkage (match by email / phone; else fallback; else sentinel) ──
  function resolveCustomer(msg, cfg) {
    var cid = _matchCustomer_(msg);
    if (cid) return { customer_id: cid, matched: true };
    var fallback = (cfg && cfg.default_customer_id) ? String(cfg.default_customer_id) : '';
    if (fallback) {
      try {
        var ok = TursoClient.select('SELECT customer_id FROM customers WHERE customer_id = ? LIMIT 1', [fallback]);
        if (ok.length) return { customer_id: fallback, matched: false };
      } catch (_) {}
    }
    return { customer_id: _ensureSentinel_(), matched: false };
  }

  function _matchCustomer_(msg) {
    try {
      if (!msg || !msg.from) return null;
      if (msg.channel === 'EMAIL' && (typeof SchemaIntrospect === 'undefined' || SchemaIntrospect.has('contacts', 'email'))) {
        var r = TursoClient.select(
          'SELECT customer_id FROM contacts WHERE LOWER(email) = ? AND customer_id IS NOT NULL LIMIT 1',
          [String(msg.from).toLowerCase()]);
        if (r.length && r[0].customer_id) return r[0].customer_id;
      }
      if (msg.channel === 'WHATSAPP' && (typeof SchemaIntrospect === 'undefined' || SchemaIntrospect.has('contacts', 'phone'))) {
        var tail = String(msg.from).replace(/[^0-9]/g, '').slice(-9);   // last 9 digits, tolerate country-code formatting
        if (tail) {
          var r2 = TursoClient.select(
            "SELECT customer_id FROM contacts WHERE customer_id IS NOT NULL AND REPLACE(REPLACE(phone,'+',''),' ','') LIKE ? LIMIT 1",
            ['%' + tail]);
          if (r2.length && r2[0].customer_id) return r2[0].customer_id;
        }
      }
    } catch (_) {}
    return null;
  }

  // A single system customer so unmatched intake still becomes a ticket through
  // the existing path. Created once, idempotently. Configure default_customer_id
  // to route unmatched intake elsewhere.
  function _ensureSentinel_() {
    try {
      var r = TursoClient.select('SELECT customer_id FROM customers WHERE customer_id = ? LIMIT 1', [SENTINEL_ID]);
      if (r.length) return SENTINEL_ID;
      var now = nowIso();
      TursoClient.write(
        'INSERT INTO customers (customer_id, account_number, company_name, customer_type, country_code, ' +
        'credit_limit, credit_used, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [SENTINEL_ID, 'INTAKE', 'Unmatched intake', 'DIRECT', 'KE', 0, 0, 'ACTIVE', now, now]);
    } catch (_) {}
    return SENTINEL_ID;
  }

  function _buildDescription_(msg, who) {
    var lines = [];
    lines.push('Received via ' + (msg.channel === 'WHATSAPP' ? 'WhatsApp' : 'email') + ' intake.');
    lines.push('From: ' + (msg.from_name ? (msg.from_name + ' <' + (msg.from || '') + '>') : (msg.from || 'unknown')));
    if (msg.received_at) lines.push('Received: ' + msg.received_at);
    lines.push(who.matched ? ('Matched to customer ' + who.customer_id) : 'Sender not matched to a known customer.');
    lines.push('');
    lines.push(String(msg.body || '').slice(0, 8000));
    return lines.join('\n');
  }

  function _notifyAdmin_(ticket, msg, cls, cfg) {
    var to = (cfg && cfg.notify_email) ? String(cfg.notify_email) : '';
    if (!to) { try { to = PropertiesService.getScriptProperties().getProperty('GRAPH_SENDER_EMAIL') || ''; } catch (_) {} }
    if (!to) return;   // nowhere to notify; the ticket still exists
    var chan = (msg.channel === 'WHATSAPP') ? 'WhatsApp' : 'email';
    var subject = 'New ' + chan + ' ticket ' + ticket.ticket_number + ' (' + ticket.priority + ')';
    var html = '<p>A new ticket was raised from an inbound ' + chan + ' message.</p>' +
      '<ul><li>Ticket: ' + _esc_(ticket.ticket_number) + '</li>' +
      '<li>Priority: ' + _esc_(ticket.priority) + '</li>' +
      '<li>From: ' + _esc_(msg.from || '') + '</li>' +
      '<li>Subject: ' + _esc_(cls.subject) + '</li></ul>';
    try { if (typeof EmailInteg !== 'undefined') EmailInteg.send(to, subject, html, html.replace(/<[^>]+>/g, ' ')); } catch (_) {}
  }

  /**
   * process(msg, cfg) -> result
   * The full pipeline for one message. Deduplicates first; a classification or
   * customer-match failure still produces a ticket with a default priority. Only
   * a genuine ticket-insert failure is propagated (and dedup is NOT recorded, so
   * the next retry can try again).
   */
  function process(msg, cfg) {
    cfg = cfg || {};
    if (!msg || !msg.channel) throw new Errors.Validation('intake message missing channel.');
    _ensureTable_();

    if (alreadyProcessed(msg.channel, msg.external_id)) {
      return { ok: true, deduped: true, external_id: msg.external_id };
    }

    var cls;
    try { cls = classify(msg, cfg); }
    catch (_) { cls = { subject: _fallbackSubject_(msg), priority: DEFAULT_PRIORITY, category: 'GENERAL', classified_by: 'DEFAULT' }; }

    var who;
    try { who = resolveCustomer(msg, cfg); }
    catch (_) { who = { customer_id: _ensureSentinel_(), matched: false }; }

    var ticket;
    try {
      ticket = Tickets.intakeCreate({
        customer_id: who.customer_id,
        subject:     cls.subject,
        description: _buildDescription_(msg, who),
        priority:    cls.priority,
        category:    cls.category,
        actor:       'SYSTEM',
        source:      msg.channel
      });
    } catch (e) {
      _logInteg_(msg.channel.toLowerCase() + '_intake', 'createTicket', 'FAILED', msg.external_id, '', String(e && e.message ? e.message : e));
      throw e;   // do NOT record dedup -> a retry can re-attempt
    }

    _recordProcessed_(msg.channel, msg.external_id, ticket.ticket_id, msg.from);
    try { _notifyAdmin_(ticket, msg, cls, cfg); } catch (_) {}
    _logInteg_(msg.channel.toLowerCase() + '_intake', 'createTicket', 'SUCCESS', msg.external_id,
      'ticket=' + ticket.ticket_number + ' priority=' + ticket.priority + ' by=' + cls.classified_by, null);

    return {
      ok: true, deduped: false, ticket_id: ticket.ticket_id, ticket_number: ticket.ticket_number,
      priority: ticket.priority, matched: who.matched, classified_by: cls.classified_by
    };
  }

  return {
    process: process, classify: classify, resolveCustomer: resolveCustomer,
    alreadyProcessed: alreadyProcessed, ensureTable: _ensureTable_,
    DEFAULT_PRIORITY: DEFAULT_PRIORITY, SENTINEL_ID: SENTINEL_ID
  };
})();
