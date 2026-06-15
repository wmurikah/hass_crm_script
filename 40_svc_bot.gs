/**
 * 40_svc_bot.gs  -  Hass CMS  (proactive, action-capable assistant)
 *
 * The assistant is a co-pilot: it opens with role-aware suggestions, runs
 * reports and lookups, drafts text, navigates the app, and can carry out GATED
 * writes on explicit confirmation. It never elevates the caller's access.
 *
 * Safety model (non negotiable):
 *   - The model NEVER emits SQL. It selects from the curated bot_tools catalog
 *     and supplies typed parameters; the server runs only the matching
 *     parameterised query or dispatcher action.
 *   - Every tool runs through the SAME dispatcher + sessionToken as the human
 *     user, so RBAC and country scope always apply. The bot has no elevated
 *     access.
 *   - READ tools (is_write = 0) execute and return results.
 *   - WRITE tools (is_write = 1) are NEVER executed automatically. The bot
 *     prepares a human-readable PROPOSAL with a preview; the server executes it
 *     only after the user clicks Confirm (bot.confirmAction), at which point the
 *     permission is re-checked.
 *   - Every turn and every tool call is logged to bot_conversations and
 *     audit_log; confirmed writes are flagged.
 *
 * Surface (registered with the dispatcher):
 *   bot.chat            {message, history?, route?}  - any authenticated user
 *   bot.suggestions     {route?}                     - any authenticated user
 *   bot.confirmAction   {tool, params}               - any authenticated user (re-gated)
 *   bot.emailResult     {title, summary?, columns, rows} - any authenticated user
 *   bot.listConfigs / getConfig / setActiveConfig / saveConfig / clearKey - admin
 *
 * Provider adapters: anthropic + openai, fed the SAME tool catalog. Provider
 * fallback is kept: the active config is tried first, then a different-provider
 * config if the first errors. API keys live only in Script Properties.
 *
 * Tables (pre-existing): bot_llm_configs, bot_conversations, bot_tools.
 */

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

var BOT_ADMIN_PERMISSION   = 'config.edit'; // SUPER_ADMIN passes via '*' wildcard
var BOT_MAX_TOOL_CALLS     = 6;             // cap tool calls per turn
var BOT_TOOL_SEP           = '__';          // service<sep>action -> provider tool name
var BOT_MODEL_CONTENT_CAP  = 6000;          // max chars of a tool result fed back to the model
var BOT_EMAIL_ROW_CAP      = 500;           // max rows in an emailed result table

// ════════════════════════════════════════════════════════════════════════════
// TOOL CATALOG (seeded into bot_tools as data; the model only ever sees this)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The canonical tool catalog. Read tools (is_write 0) execute under the caller's
 * session; write tools (is_write 1) are proposed for confirmation, never run
 * automatically. `permission` mirrors the destination action's dispatcher gate
 * (the dispatcher remains the real gate). `params` is a JSON-Schema properties
 * object handed to the model so it knows the typed criteria it may supply.
 */
function _botToolCatalog_() {
  var COUNTRY = { type: 'string', description: 'ISO country code to scope results, e.g. "KE" or "TZ".' };
  var STATUS  = { type: 'string', description: 'Filter by status value.' };
  var LIMIT   = { type: 'integer', description: 'Maximum rows to return.' };
  var SEARCH  = { type: 'string', description: 'Free-text search term.' };
  var CUST    = { type: 'string', description: 'The customer_id.' };
  var FROM    = { type: 'string', description: 'Start date, YYYY-MM-DD.' };
  var TO      = { type: 'string', description: 'End date, YYYY-MM-DD.' };
  var CCY     = { type: 'string', description: 'Currency code, e.g. "KES". Reports keep money per currency.' };

  return [
    // ── Dashboard ──────────────────────────────────────────────────────────
    { service: 'dashboard', action: 'summary', is_write: 0, permission: 'order.view',
      description: 'Headline counts (customers, open tickets, pending approvals, unpaid invoices, pending payments) scoped to the user.',
      params: { country_code: COUNTRY } },
    { service: 'dashboard', action: 'activityFeed', is_write: 0, permission: 'order.view',
      description: 'Recent activity across orders, tickets and approvals. Use for "summarise today\'s activity".',
      params: { country_code: COUNTRY, limit: LIMIT } },

    // ── Customers ──────────────────────────────────────────────────────────
    { service: 'customers', action: 'list', is_write: 0, permission: 'customers.view',
      description: 'List customers, optionally filtered by country, segment or type.',
      params: { country_code: COUNTRY, segment_id: { type: 'string' }, customer_type: { type: 'string' }, limit: LIMIT } },
    { service: 'customers', action: 'search', is_write: 0, permission: 'customers.view',
      description: 'Search customers by name, account number or trading name.',
      params: { q: SEARCH, query: SEARCH, limit: LIMIT } },
    { service: 'customers', action: 'get', is_write: 0, permission: 'customers.view',
      description: 'Get one customer by id (profile and account details).',
      params: { customerId: CUST } },
    { service: 'customers', action: 'customer360', is_write: 0, permission: 'customers.view',
      description: 'Full 360 view of one customer: profile, orders, invoices, tickets, balances. Use for "customer 360".',
      params: { customerId: CUST } },

    // ── Orders ─────────────────────────────────────────────────────────────
    { service: 'orders', action: 'list', is_write: 0, permission: 'order.view',
      description: 'List orders, optionally by status, customer or country. Use for "stuck orders by status", "recent orders".',
      params: { country_code: COUNTRY, status: STATUS, customer_id: CUST, limit: LIMIT } },
    { service: 'orders', action: 'get', is_write: 0, permission: 'order.view',
      description: 'Get one order by id with its lines and status history.',
      params: { orderId: { type: 'string', description: 'The order_id.' } } },

    // ── Invoices ───────────────────────────────────────────────────────────
    { service: 'invoices', action: 'list', is_write: 0, permission: 'invoice.view',
      description: 'List invoices, optionally by payment_status (UNPAID/PAID/PARTIAL), status, customer or country. Use for "unpaid invoices", "overdue invoices".',
      params: { country_code: COUNTRY, status: STATUS, payment_status: { type: 'string' }, customer_id: CUST, limit: LIMIT } },
    { service: 'invoices', action: 'get', is_write: 0, permission: 'invoice.view',
      description: 'Get one invoice by id with line items and payment state.',
      params: { invoiceId: { type: 'string', description: 'The invoice_id.' } } },

    // ── Payments ───────────────────────────────────────────────────────────
    { service: 'payments', action: 'list', is_write: 0, permission: 'invoice.view',
      description: 'List uploaded payment proofs, optionally by status. Use for "payments awaiting review".',
      params: { status: STATUS, customerId: CUST, limit: LIMIT } },

    // ── Tickets ────────────────────────────────────────────────────────────
    { service: 'tickets', action: 'list', is_write: 0, permission: 'ticket.view',
      description: 'List tickets, optionally by status, priority, customer or country. Use for "my open tickets", "tickets for customer X".',
      params: { country_code: COUNTRY, status: STATUS, priority: { type: 'string' }, customer_id: CUST, assigned_to: { type: 'string' }, limit: LIMIT } },
    { service: 'tickets', action: 'get', is_write: 0, permission: 'ticket.view',
      description: 'Get one ticket by id with its comments and history. Use to summarise a ticket thread.',
      params: { ticketId: { type: 'string', description: 'The ticket_id.' } } },

    // ── Approvals ──────────────────────────────────────────────────────────
    { service: 'approvals', action: 'list', is_write: 0, permission: 'order.view',
      description: 'List approval requests, optionally by status.',
      params: { status: STATUS, limit: LIMIT } },
    { service: 'approvals', action: 'inbox', is_write: 0, permission: 'order.approve_low',
      description: 'Approval requests awaiting the signed-in user (their inbox).',
      params: { limit: LIMIT } },

    // ── Documents ──────────────────────────────────────────────────────────
    { service: 'documents', action: 'list', is_write: 0, permission: 'customer.view',
      description: 'List KYC documents (metadata only), optionally for one customer or by status.',
      params: { customerId: CUST, status: STATUS, limit: LIMIT } },

    // ── SLA / knowledge / catalog / users / rbac (reference reads) ──────────
    { service: 'sla', action: 'listBreaches', is_write: 0, permission: 'order.view',
      description: 'List recorded SLA breaches.',
      params: { country_code: COUNTRY, limit: LIMIT } },
    { service: 'knowledge', action: 'list', is_write: 0, permission: 'order.view',
      description: 'List knowledge-base articles, optionally by category or search term.',
      params: { categoryId: { type: 'string' }, search: SEARCH, limit: LIMIT } },
    { service: 'knowledge', action: 'get', is_write: 0, permission: 'order.view',
      description: 'Get one knowledge-base article (full body) to answer how-to questions.',
      params: { articleId: { type: 'string' } } },
    { service: 'catalog', action: 'listProducts', is_write: 0, permission: 'order.view',
      description: 'List sellable products in the catalog.',
      params: { search: SEARCH, limit: LIMIT } },
    { service: 'users', action: 'list', is_write: 0, permission: 'user.view',
      description: 'List staff users (no secrets). Use for "who is on the team".',
      params: { country_code: COUNTRY, search: SEARCH, limit: LIMIT } },

    // ── Report catalog (curated, parameterised; see 40_svc_bot_reports.gs) ──
    { service: 'reports', action: 'kyc', is_write: 0, permission: 'customer.view',
      description: 'KYC and compliance report: customers with documents missing, pending, expired or rejected. Filter by country, segment, issue.',
      params: { country_code: COUNTRY, segment_id: { type: 'string' }, issue: { type: 'string', description: 'any|missing|pending|expired|rejected|all' } } },
    { service: 'reports', action: 'ordersByCriteria', is_write: 0, permission: 'order.view',
      description: 'Orders report with typed criteria and per-currency totals.',
      params: { status: STATUS, country_code: COUNTRY, customer_id: CUST, currency_code: CCY, from_date: FROM, to_date: TO, min_value: { type: 'number' }, product_id: { type: 'string' } } },
    { service: 'reports', action: 'receivablesAging', is_write: 0, permission: 'invoice.view',
      description: 'Receivables aging (0-30, 31-60, 61-90, 90+) by customer, per currency.',
      params: { country_code: COUNTRY, customer_id: CUST, currency_code: CCY } },
    { service: 'reports', action: 'salesRevenue', is_write: 0, permission: 'order.view',
      description: 'Sales and revenue by month, country, segment or product, per currency. Never sums across currencies.',
      params: { group_by: { type: 'string', description: 'month|country|segment|product' }, country_code: COUNTRY, from_date: FROM, to_date: TO } },
    { service: 'reports', action: 'ticketSla', is_write: 0, permission: 'ticket.view',
      description: 'Ticket and SLA report by status, priority, team or agent, with breach counts and average resolution time.',
      params: { group_by: { type: 'string', description: 'status|priority|team|agent' }, country_code: COUNTRY, from_date: FROM, to_date: TO } },
    { service: 'reports', action: 'customerStatement', is_write: 0, permission: 'customers.view',
      description: 'Customer financial statement: outstanding invoices per currency and credit position.',
      params: { customerId: CUST } },
    { service: 'reports', action: 'approvals', is_write: 0, permission: 'order.view',
      description: 'Approvals report: pending and overdue by tier.',
      params: { overdue_days: { type: 'integer' } } },
    { service: 'reports', action: 'payments', is_write: 0, permission: 'invoice.view',
      description: 'Payments report: uploads by status, per currency.',
      params: { status: STATUS } },
    { service: 'reports', action: 'creditExposure', is_write: 0, permission: 'customers.view',
      description: 'Credit exposure: customers at or over their credit limit.',
      params: { country_code: COUNTRY, threshold_percent: { type: 'number' } } },
    { service: 'reports', action: 'retentionChurn', is_write: 0, permission: 'customers.view',
      description: 'Retention and churn summary from CRM tables.',
      params: {} },
    { service: 'reports', action: 'pricing', is_write: 0, permission: 'order.view',
      description: 'Pricing report: active price lists and item counts by tier.',
      params: {} },

    // ── WRITE tools (is_write 1): proposed only, executed after Confirm ─────
    { service: 'tickets', action: 'create', is_write: 1, permission: 'ticket.create',
      description: 'Create a support ticket for a customer. Proposed for confirmation before it runs.',
      params: { customer_id: CUST, subject: { type: 'string' }, category: { type: 'string' }, priority: { type: 'string', description: 'LOW|MEDIUM|HIGH|CRITICAL' }, description: { type: 'string' } } },
    { service: 'tickets', action: 'assign', is_write: 1, permission: 'ticket.assign',
      description: 'Assign a ticket to a staff user. Proposed for confirmation before it runs.',
      params: { ticketId: { type: 'string' }, assigned_to: { type: 'string', description: 'The user_id to assign.' } } },
    { service: 'tickets', action: 'addComment', is_write: 1, permission: 'ticket.view',
      description: 'Add a comment to a ticket. Proposed for confirmation before it runs.',
      params: { ticketId: { type: 'string' }, content: { type: 'string' }, is_internal: { type: 'boolean' } } },
    { service: 'invoices', action: 'generate', is_write: 1, permission: 'invoice.generate',
      description: 'Generate an invoice for a DELIVERED order. Proposed for confirmation before it runs.',
      params: { orderId: { type: 'string' } } },
  ];
}

/**
 * seedBotTools() - idempotent UPSERT. Inserts new (service,action) rows and
 * keeps existing rows' description / schema / is_write / required_permission /
 * is_enabled in sync with the catalog above. Safe to run repeatedly. Run
 * manually from the IDE (or via reproBotV2()).
 */
function seedBotTools() {
  var catalog = _botToolCatalog_();
  var existing = {};
  try {
    TursoClient.select('SELECT tool_id, service, action FROM bot_tools', []).forEach(function (r) {
      existing[r.service + '.' + r.action] = r.tool_id;
    });
  } catch (e) {
    Log.error({ service: 'bot', action: 'seedBotTools', msg: 'read bot_tools: ' + e.message });
    throw e;
  }

  var inserted = 0, updated = 0;
  catalog.forEach(function (t) {
    var key    = t.service + '.' + t.action;
    var schema = jsonStringify({ type: 'object', properties: t.params || {} });
    var isW    = t.is_write ? 1 : 0;
    if (existing[key]) {
      TursoClient.write(
        'UPDATE bot_tools SET description = ?, params_schema_json = ?, is_write = ?, ' +
        'required_permission = ?, is_enabled = 1 WHERE service = ? AND action = ?',
        [t.description, schema, isW, t.permission || null, t.service, t.action]
      );
      updated++;
    } else {
      TursoClient.write(
        'INSERT INTO bot_tools ' +
        '(tool_id, service, action, description, params_schema_json, is_write, required_permission, is_enabled, created_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?)',
        [genId('BTOOL'), t.service, t.action, t.description, schema, isW, t.permission || null, 1, nowIso()]
      );
      inserted++;
    }
  });

  Logger.log('[bot] seedBotTools: inserted ' + inserted + ', updated ' + updated +
             ' (total catalog ' + catalog.length + ')');
  return { inserted: inserted, updated: updated, total: catalog.length };
}

// ════════════════════════════════════════════════════════════════════════════
// TOOL CATALOG (loaded from DB -> provider formats)
// ════════════════════════════════════════════════════════════════════════════

/** Load enabled bot_tools rows (the live catalog the bot is allowed to see). */
function _botEnabledTools_() {
  return TursoClient.select(
    'SELECT * FROM bot_tools WHERE is_enabled = 1 ORDER BY service, action', []
  );
}

/** Provider-neutral tool name from a row: "customers__list". */
function _botToolName_(row) {
  return String(row.service) + BOT_TOOL_SEP + String(row.action);
}

/** Parse a provider tool name back to {service, action}. */
function _botParseToolName_(name) {
  var idx = String(name).indexOf(BOT_TOOL_SEP);
  if (idx === -1) return { service: '', action: '' };
  return {
    service: String(name).substring(0, idx),
    action:  String(name).substring(idx + BOT_TOOL_SEP.length),
  };
}

/** JSON-Schema input object for a tool row (always a valid object schema). */
function _botInputSchema_(row) {
  var schema = jsonParse(row.params_schema_json, null);
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') {
    schema = { type: 'object', properties: (schema && schema.properties) || {} };
  }
  if (!schema.properties) schema.properties = {};
  return schema;
}

/** Anthropic tool format: [{name, description, input_schema}]. */
function _botToolsAnthropic_(rows) {
  return rows.map(function (r) {
    return {
      name:         _botToolName_(r),
      description:  String(r.description || '') + (String(r.is_write) !== '0' ? ' (write action: will be proposed for confirmation, not run directly)' : ''),
      input_schema: _botInputSchema_(r),
    };
  });
}

/** OpenAI tool format: [{type:'function', function:{name, description, parameters}}]. */
function _botToolsOpenai_(rows) {
  return rows.map(function (r) {
    return {
      type: 'function',
      function: {
        name:        _botToolName_(r),
        description: String(r.description || '') + (String(r.is_write) !== '0' ? ' (write action: will be proposed for confirmation, not run directly)' : ''),
        parameters:  _botInputSchema_(r),
      },
    };
  });
}

/** Human-readable catalog for the system prompt. */
function _botToolsForPrompt_(rows) {
  return rows.map(function (r) {
    return '- ' + r.service + '.' + r.action + (String(r.is_write) !== '0' ? ' [write]' : '') + ': ' + (r.description || '');
  }).join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// PROVIDER ADAPTERS
//   Each returns { text, toolCalls:[{id,name,input}], tokensUsed, error?, raw }.
// ════════════════════════════════════════════════════════════════════════════

/** Read the configured API key from Script Properties; '' if unset. */
function _botApiKey_(config) {
  var propName = config && config.api_key_property;
  if (!propName) return '';
  var v = PropertiesService.getScriptProperties().getProperty(propName);
  return v || '';
}

function _botNum_(v, dflt) {
  var n = parseFloat(v);
  return isNaN(n) ? dflt : n;
}

/** Anthropic Messages API adapter. */
function _botCallAnthropic_(config, messages, tools, system) {
  var key = _botApiKey_(config);
  if (!key) return { error: 'API key not configured for this assistant.', text: '', toolCalls: [], tokensUsed: 0 };

  var url  = config.endpoint_url || 'https://api.anthropic.com/v1/messages';
  var body = {
    model:       config.model,
    max_tokens:  _botNum_(config.max_tokens, 1024),
    temperature: _botNum_(config.temperature, 0),
    system:      system || '',
    messages:    messages,
    tools:       tools || [],
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload:            JSON.stringify(body),
      muteHttpExceptions: true,
    });
  } catch (e) {
    return { error: 'Provider request failed: ' + e.message, text: '', toolCalls: [], tokensUsed: 0 };
  }

  var code = resp.getResponseCode();
  if (code !== 200) {
    return { error: 'Anthropic HTTP ' + code + ': ' + resp.getContentText().substring(0, 300),
             text: '', toolCalls: [], tokensUsed: 0 };
  }

  var data = jsonParse(resp.getContentText(), null);
  if (!data) return { error: 'Anthropic returned unparseable response.', text: '', toolCalls: [], tokensUsed: 0 };

  var text = '', toolCalls = [];
  (data.content || []).forEach(function (block) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
  });
  var usage = data.usage || {};
  var tokensUsed = (usage.input_tokens || 0) + (usage.output_tokens || 0);

  return { text: text, toolCalls: toolCalls, tokensUsed: tokensUsed, raw: data };
}

/** OpenAI Chat Completions adapter. */
function _botCallOpenai_(config, messages, tools) {
  var key = _botApiKey_(config);
  if (!key) return { error: 'API key not configured for this assistant.', text: '', toolCalls: [], tokensUsed: 0 };

  var url   = config.endpoint_url || 'https://api.openai.com/v1/chat/completions';
  var model = String(config.model || '');

  // GPT-5 / o-series use the newer Chat Completions shape:
  //  - the token-limit field is `max_completion_tokens`.
  //  - they only accept the default temperature, so omit a custom one.
  var isNewShape = /^(gpt-5|o\d)/i.test(model);

  var body = {
    model:    config.model,
    messages: messages,
  };
  body.max_completion_tokens = _botNum_(config.max_tokens, 1024);
  if (!isNewShape) body.temperature = _botNum_(config.temperature, 0);
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
      headers:            { Authorization: 'Bearer ' + key },
      payload:            JSON.stringify(body),
      muteHttpExceptions: true,
    });
  } catch (e) {
    return { error: 'Provider request failed: ' + e.message, text: '', toolCalls: [], tokensUsed: 0 };
  }

  var code = resp.getResponseCode();
  if (code !== 200) {
    return { error: 'OpenAI HTTP ' + code + ': ' + resp.getContentText().substring(0, 300),
             text: '', toolCalls: [], tokensUsed: 0 };
  }

  var data = jsonParse(resp.getContentText(), null);
  if (!data || !data.choices || !data.choices.length) {
    return { error: 'OpenAI returned no choices.', text: '', toolCalls: [], tokensUsed: 0 };
  }

  var msg = data.choices[0].message || {};
  var toolCalls = (msg.tool_calls || []).map(function (tc) {
    return {
      id:    tc.id,
      name:  tc.function && tc.function.name,
      input: jsonParse(tc.function && tc.function.arguments, {}) || {},
    };
  });
  var usage = data.usage || {};
  var tokensUsed = usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));

  return { text: msg.content || '', toolCalls: toolCalls, tokensUsed: tokensUsed, raw: msg };
}

// ════════════════════════════════════════════════════════════════════════════
// TOOL EXECUTION (RBAC-gated; writes proposed, never auto-run)
// ════════════════════════════════════════════════════════════════════════════

function _botTruncate_(str, cap) {
  var s = String(str == null ? '' : str);
  return s.length > cap ? s.substring(0, cap) + '\n...[truncated; the full result is shown to the user]' : s;
}

/**
 * Execute (read) or PROPOSE (write) a single tool call.
 *  - unknown / disabled tool   -> refused
 *  - write tool (is_write != 0) -> NOT executed; returns a proposal (after an
 *    RBAC pre-check) with a human-readable preview for the user to confirm
 *  - read tool                  -> runs via processRequest under the SAME
 *    sessionToken (RBAC + scope apply); returns parsed data + a capped text
 *    summary fed back to the model
 * auth = { sessionToken, session }.
 */
function _botExecuteTool_(toolName, input, auth) {
  var parsed  = _botParseToolName_(toolName);
  var service = parsed.service, action = parsed.action;
  var label   = service + '.' + action;
  var session = auth && auth.session;
  var token   = auth && auth.sessionToken;

  if (!service || !action) {
    return { content: 'Tool "' + toolName + '" is not permitted.', refused: true, service: service, action: action };
  }

  var rows = TursoClient.select(
    'SELECT * FROM bot_tools WHERE service = ? AND action = ? LIMIT 1', [service, action]
  );
  if (!rows.length || String(rows[0].is_enabled) !== '1') {
    return { content: 'Tool ' + label + ' is not available.', refused: true, service: service, action: action };
  }
  var row    = rows[0];
  var params = (input && typeof input === 'object') ? input : {};

  // ── WRITE: propose, never execute here ──────────────────────────────────
  if (String(row.is_write) !== '0') {
    var perm = row.required_permission;
    var userId = (session && (session.userId || session.user_id)) || '';
    if (perm && !Rbac.userHasPermission(userId, perm)) {
      return { content: 'The user does not have permission to ' + label + ', so it cannot be proposed.',
               refused: true, service: service, action: action };
    }
    var clean = {};
    Object.keys(params).forEach(function (k) { if (k !== 'sessionToken') clean[k] = params[k]; });
    var preview = _botPreviewWrite_(service, action, clean);
    return {
      proposed: true,
      service:  service,
      action:   action,
      action_proposal: { tool: toolName, service: service, action: action, params: clean,
                         permission: perm || null, preview: preview },
      content:  'Prepared a proposed write (' + label + ') for the user to confirm: ' + preview +
                ' It will run only after the user clicks Confirm. Do not call it again; tell the user what you have prepared.',
    };
  }

  // ── READ: execute under the caller's session ────────────────────────────
  params = (input && typeof input === 'object') ? input : {};
  params.sessionToken = token;
  var resp;
  try {
    resp = processRequest({ service: service, action: action, params: params });
  } catch (e) {
    return { content: 'Tool ' + label + ' failed: ' + e.message, executed: true, service: service, action: action };
  }

  if (resp && resp.ok) {
    return { content: _botTruncate_(jsonStringify(resp.data), BOT_MODEL_CONTENT_CAP),
             data: resp.data, executed: true, service: service, action: action };
  }
  var err = (resp && resp.error) || { message: 'unknown error' };
  return { content: 'Tool ' + label + ' returned an error (' + (err.code || 'ERROR') + '): ' +
                    (err.message || ''), executed: true, service: service, action: action };
}

/** Friendly, human-readable preview for a proposed write. No raw SQL. */
function _botPreviewWrite_(service, action, p) {
  var key = service + '.' + action;
  function s(v) { return (v === undefined || v === null || v === '') ? '(not set)' : String(v); }
  if (key === 'tickets.create') {
    return 'Create a ticket for customer ' + s(p.customer_id) + ': "' + s(p.subject) +
           '" (category ' + s(p.category) + ', priority ' + s(p.priority || 'MEDIUM') + ').';
  }
  if (key === 'tickets.assign') {
    return 'Assign ticket ' + s(p.ticketId) + ' to user ' + s(p.assigned_to) + '.';
  }
  if (key === 'tickets.addComment') {
    var c = String(p.content || '');
    if (c.length > 140) c = c.substring(0, 140) + '...';
    return 'Add a ' + (p.is_internal ? 'internal ' : '') + 'comment to ticket ' + s(p.ticketId) + ': "' + c + '".';
  }
  if (key === 'invoices.generate') {
    return 'Generate an invoice for order ' + s(p.orderId) + '.';
  }
  return 'Run ' + key + ' with ' + jsonStringify(p) + '.';
}

// ════════════════════════════════════════════════════════════════════════════
// CONVERSATION LOOPS (one per provider; share _botExecuteTool_)
//   Return { text, toolsUsed, tokensUsed, toolCallsLog, dataResults,
//            proposedActions, error? }
// ════════════════════════════════════════════════════════════════════════════

function _botConvAnthropic_(config, system, message, history, toolRows, auth) {
  var tools    = _botToolsAnthropic_(toolRows);
  var messages = [];
  (history || []).forEach(function (h) {
    if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
  });
  messages.push({ role: 'user', content: String(message) });

  var toolsUsed = [], toolCallsLog = [], dataResults = [], proposedActions = [], tokensUsed = 0, finalText = '';

  for (var i = 0; i <= BOT_MAX_TOOL_CALLS; i++) {
    var capped = (i === BOT_MAX_TOOL_CALLS);
    var res = _botCallAnthropic_(config, messages, capped ? [] : tools, system);
    tokensUsed += res.tokensUsed || 0;
    if (res.error) return { error: res.error, text: '', toolsUsed: toolsUsed, tokensUsed: tokensUsed,
                            toolCallsLog: toolCallsLog, dataResults: dataResults, proposedActions: proposedActions };

    finalText = res.text || finalText;
    if (!res.toolCalls.length || capped) break;

    messages.push({ role: 'assistant', content: (res.raw && res.raw.content) || [] });
    var results = [];
    res.toolCalls.forEach(function (tc) {
      var out = _botExecuteTool_(tc.name, tc.input, auth);
      _botCollect_(out, tc, toolsUsed, toolCallsLog, dataResults, proposedActions);
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: out.content });
    });
    messages.push({ role: 'user', content: results });
  }

  return { text: finalText, toolsUsed: toolsUsed, tokensUsed: tokensUsed, toolCallsLog: toolCallsLog,
           dataResults: dataResults, proposedActions: proposedActions };
}

function _botConvOpenai_(config, system, message, history, toolRows, auth) {
  var tools    = _botToolsOpenai_(toolRows);
  var messages = [{ role: 'system', content: system }];
  (history || []).forEach(function (h) {
    if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
  });
  messages.push({ role: 'user', content: String(message) });

  var toolsUsed = [], toolCallsLog = [], dataResults = [], proposedActions = [], tokensUsed = 0, finalText = '';

  for (var i = 0; i <= BOT_MAX_TOOL_CALLS; i++) {
    var capped = (i === BOT_MAX_TOOL_CALLS);
    var res = _botCallOpenai_(config, messages, capped ? [] : tools);
    tokensUsed += res.tokensUsed || 0;
    if (res.error) return { error: res.error, text: '', toolsUsed: toolsUsed, tokensUsed: tokensUsed,
                            toolCallsLog: toolCallsLog, dataResults: dataResults, proposedActions: proposedActions };

    finalText = res.text || finalText;
    if (!res.toolCalls.length || capped) break;

    messages.push({ role: 'assistant', content: res.text || null, tool_calls: (res.raw && res.raw.tool_calls) || [] });
    res.toolCalls.forEach(function (tc) {
      var out = _botExecuteTool_(tc.name, tc.input, auth);
      _botCollect_(out, tc, toolsUsed, toolCallsLog, dataResults, proposedActions);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.content });
    });
  }

  return { text: finalText, toolsUsed: toolsUsed, tokensUsed: tokensUsed, toolCallsLog: toolCallsLog,
           dataResults: dataResults, proposedActions: proposedActions };
}

/** Fold one tool-call outcome into the per-turn accumulators. */
function _botCollect_(out, tc, toolsUsed, toolCallsLog, dataResults, proposedActions) {
  var label = out.service + '.' + out.action;
  toolCallsLog.push({ name: label, input: tc.input, refused: !!out.refused, proposed: !!out.proposed, executed: !!out.executed });
  if (out.executed && !out.refused) {
    if (toolsUsed.indexOf(label) === -1) toolsUsed.push(label);
    if (out.data !== undefined) dataResults.push({ service: out.service, action: out.action, input: tc.input || {}, data: out.data });
  }
  if (out.proposed && out.action_proposal) proposedActions.push(out.action_proposal);
}

/** Dispatch to the right provider loop. */
function _botConverse_(config, system, message, history, toolRows, auth) {
  var provider = String(config.provider || '').toLowerCase();
  if (provider === 'anthropic') return _botConvAnthropic_(config, system, message, history, toolRows, auth);
  if (provider === 'openai')    return _botConvOpenai_(config, system, message, history, toolRows, auth);
  return { error: 'Unknown provider: ' + provider, text: '', toolsUsed: [], tokensUsed: 0,
           toolCallsLog: [], dataResults: [], proposedActions: [] };
}

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT + RESPONSE DIRECTIVES
// ════════════════════════════════════════════════════════════════════════════

function _botBuildSystemPrompt_(config, session, toolRows, route) {
  var role    = session.role || 'user';
  var country = session.countryCode || 'all countries';
  var lines = [];
  lines.push(String(config.system_prompt || 'You are the Hass CMS assistant, a proactive co-pilot for staff.'));
  lines.push('');
  lines.push('The signed-in user has role "' + role + '" and country scope "' + country + '". ' +
             'Everything you can see and do is limited to what this user is allowed to do. ' +
             'If a tool returns a permission error, tell the user they do not have access rather than retrying.');
  if (route) lines.push('The user is currently on the "' + route + '" page; prefer answers relevant to it.');
  lines.push('');
  lines.push('You can look things up, run reports, summarise records, draft text, navigate the app, ' +
             'and PROPOSE changes. Use a tool to answer with real data instead of guessing.');
  lines.push('Read tools run immediately and return data. Write tools (marked [write]) are never run ' +
             'by you: when the user asks for a change, call the matching write tool with typed ' +
             'parameters; it becomes a proposal the user confirms. After proposing, briefly tell the ' +
             'user what you prepared and that they need to confirm it. Do not claim a change is done.');
  lines.push('');
  lines.push('When a report or list tool returns rows, keep your prose short: a one line summary is ' +
             'enough because the table is shown to the user with export and deep-link buttons.');
  lines.push('');
  lines.push('If a request is missing one key criterion, ask ONE short clarifying question and offer ' +
             'choices by ending your reply with a fenced json block:');
  lines.push('```json');
  lines.push('{"clarify":{"question":"Which country?","chips":["KE","TZ","UG"]}}');
  lines.push('```');
  lines.push('To send the user to a page, end your reply with a fenced json block:');
  lines.push('```json');
  lines.push('{"navigate":{"route":"invoices","params":{"payment_status":"UNPAID"}}}');
  lines.push('```');
  lines.push('Valid routes: dashboard, customers, orders, invoices, payments, tickets, approvals, ' +
             'documents, pricing, catalog, knowledge, reports, users. Put your natural-language ' +
             'answer before any json block, and include at most one block.');
  lines.push('');
  lines.push('Available tools:');
  lines.push(_botToolsForPrompt_(toolRows));
  return lines.join('\n');
}

/**
 * Pull {"navigate":{...}} and/or {"clarify":{...}} directives out of the
 * model's final answer. Returns { answer, navigate, clarify } with the blocks
 * removed from the answer.
 */
function _botExtractDirectives_(text) {
  var out = { answer: String(text || ''), navigate: null, clarify: null };
  if (!text) { out.answer = ''; return out; }

  var fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  var m;
  while ((m = fence.exec(text)) !== null) {
    var obj = jsonParse(m[1].trim(), null);
    if (obj && (obj.navigate || obj.clarify)) {
      if (obj.navigate && !out.navigate) out.navigate = obj.navigate;
      if (obj.clarify  && !out.clarify)  out.clarify  = obj.clarify;
      out.answer = out.answer.replace(m[0], '');
    }
  }
  // Bare-object fallbacks.
  if (!out.navigate) {
    var bn = text.match(/\{\s*"navigate"\s*:\s*\{[\s\S]*?\}\s*\}/);
    if (bn) { var o1 = jsonParse(bn[0], null); if (o1 && o1.navigate) { out.navigate = o1.navigate; out.answer = out.answer.replace(bn[0], ''); } }
  }
  if (!out.clarify) {
    var bc = text.match(/\{\s*"clarify"\s*:\s*\{[\s\S]*?\}\s*\}/);
    if (bc) { var o2 = jsonParse(bc[0], null); if (o2 && o2.clarify) { out.clarify = o2.clarify; out.answer = out.answer.replace(bc[0], ''); } }
  }
  out.answer = out.answer.trim();
  return out;
}

// ── Turn a captured tool result into a renderable table result ──────────────

var _BOT_SECTION_BY_SERVICE_ = {
  invoices: 'invoices', orders: 'orders', tickets: 'tickets', customers: 'customers',
  payments: 'payments', approvals: 'approvals', documents: 'documents',
  knowledge: 'knowledge', users: 'users', catalog: 'catalog',
};

function _botGuessColType_(key) {
  var k = String(key).toLowerCase();
  if (/(amount|total|balance|price|limit|used|revenue|subtotal|tax)/.test(k)) return 'money';
  if (/(date|_at)$/.test(k) || /_date/.test(k)) return 'date';
  if (/(count|qty|quantity|items|level|n_|^n$|escalation)/.test(k)) return 'number';
  return 'text';
}

/** Build a generic table from an array of row objects (capped columns). */
function _botArrayToTable_(arr) {
  var SKIP = { updated_at: 1, password_hash: 1, token_hash: 1, params_schema_json: 1,
               metadata: 1, before_json: 1, after_json: 1, description: 1, body: 1, content: 1 };
  var first = arr[0] || {};
  var cols = [];
  Object.keys(first).forEach(function (k) {
    if (cols.length >= 8) return;
    if (SKIP[k]) return;
    if (first[k] !== null && typeof first[k] === 'object') return; // skip nested
    cols.push({ key: k, label: k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }), type: _botGuessColType_(k) });
  });
  return cols;
}

/**
 * Choose the most relevant captured tool result and shape it for the client:
 * { kind, title, summary, columns, rows, totals, currencyNote, deepLink, source }.
 * Prefers a report object (has columns+rows); else the last array result.
 */
function _botBuildResult_(dataResults) {
  if (!dataResults || !dataResults.length) return null;

  // Prefer the last report-shaped result.
  for (var i = dataResults.length - 1; i >= 0; i--) {
    var d = dataResults[i].data;
    if (d && typeof d === 'object' && Array.isArray(d.columns) && Array.isArray(d.rows)) {
      return {
        kind: 'report', title: d.title || 'Report', summary: d.summary || '',
        columns: d.columns, rows: d.rows, totals: d.totals || null,
        currencyNote: d.currency_note || null, deepLink: d.deepLink || null,
        source: dataResults[i].service + '.' + dataResults[i].action,
      };
    }
  }
  // Else the last non-empty array result.
  for (var j = dataResults.length - 1; j >= 0; j--) {
    var arr = dataResults[j].data;
    if (Array.isArray(arr) && arr.length && typeof arr[0] === 'object') {
      var svc = dataResults[j].service;
      var section = _BOT_SECTION_BY_SERVICE_[svc] || null;
      var input = dataResults[j].input || {};
      var dl = null;
      if (section) {
        var p = {};
        ['status', 'payment_status', 'country_code', 'customer_id', 'priority'].forEach(function (k) {
          if (input[k] !== undefined && input[k] !== null && String(input[k]).length) p[k] = input[k];
        });
        dl = { route: section, params: p };
      }
      return {
        kind: 'table',
        title: (svc.charAt(0).toUpperCase() + svc.slice(1)) + ' results',
        summary: arr.length + ' row' + (arr.length === 1 ? '' : 's') + '.',
        columns: _botArrayToTable_(arr),
        rows: arr.slice(0, 500),
        totals: null, currencyNote: null, deepLink: dl,
        source: svc + '.' + dataResults[j].action,
      };
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// bot.chat  (provider fallback kept)
// ════════════════════════════════════════════════════════════════════════════

/** Active config first, then a different-provider config, all role-gated. */
function _botPickConfigs_(session) {
  var rows;
  try {
    rows = TursoClient.select('SELECT * FROM bot_llm_configs ORDER BY is_active DESC, is_default DESC, updated_at DESC', []);
  } catch (e) { return []; }
  var role = String(session.role || '');
  var allowed = rows.filter(function (c) {
    var ar = _botParseRoles_(c.allowed_roles);
    return !ar.length || ar.indexOf(role) !== -1;
  });
  if (!allowed.length) return [];
  var primary = allowed[0];
  var ordered = [primary];
  allowed.slice(1).forEach(function (c) { if (c.provider !== primary.provider) ordered.push(c); });
  allowed.slice(1).forEach(function (c) { if (c.provider === primary.provider) ordered.push(c); });
  return ordered;
}

function _botChat_(ctx, params) {
  var session = ctx && ctx.session;
  if (!session || !session.userId) throw new Errors.PermissionDenied('Authentication required.');

  var t0      = Date.now();
  var message = String((params && params.message) || '').trim();
  var history = (params && Array.isArray(params.history)) ? params.history : [];
  var route   = String((params && params.route) || '').trim();
  if (!message) throw new Errors.Validation('message required.');

  var configs = _botPickConfigs_(session);
  if (!configs.length) {
    // Distinguish "no config at all" from "your role is not allowed".
    var any = [];
    try { any = TursoClient.select('SELECT config_id FROM bot_llm_configs LIMIT 1', []); } catch (_) {}
    return { answer: any.length
               ? 'Your role is not permitted to use this assistant.'
               : 'The assistant is not configured yet. Please ask an administrator to set up a model under Admin then Bot Assistant.',
             navigate: null, result: null, actions: [], clarify: null, toolsUsed: [], turnId: null };
  }

  var toolRows = _botEnabledTools_();
  var auth     = { sessionToken: ctx.sessionToken, session: session };

  var result = null, usedConfig = null, tokensUsed = 0;
  for (var i = 0; i < configs.length; i++) {
    var system = _botBuildSystemPrompt_(configs[i], session, toolRows, route);
    var r;
    try { r = _botConverse_(configs[i], system, message, history, toolRows, auth); }
    catch (e) { r = { error: e.message, text: '', toolsUsed: [], tokensUsed: 0, toolCallsLog: [], dataResults: [], proposedActions: [] }; }
    tokensUsed += r.tokensUsed || 0;
    usedConfig = configs[i];
    if (!r.error) { result = r; break; }
    result = r; // keep last error for logging
  }

  var dir    = _botExtractDirectives_(result.text || '');
  var answer = dir.answer;
  var status = 'OK', errorMessage = null;
  if (result.error) {
    status = 'ERROR'; errorMessage = result.error;
    answer = 'Sorry, I could not complete that request right now.';
  } else if (!answer && !(result.proposedActions || []).length && !_botBuildResult_(result.dataResults)) {
    answer = 'I could not produce an answer.';
  }

  var tableResult = result.error ? null : _botBuildResult_(result.dataResults);
  var actions     = result.error ? [] : (result.proposedActions || []);
  var latency     = Date.now() - t0;
  var turnId      = genId('BTRN');

  // Audit: bot_conversations (the turn) + audit_log (every tool call this turn).
  try {
    TursoClient.write(
      'INSERT INTO bot_conversations ' +
      '(turn_id, session_id, user_id, user_role, config_id, user_message, bot_response, ' +
      'tool_calls_json, tokens_used, latency_ms, status, error_message, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [turnId, session.sessionId || null, session.userId, session.role || null,
       usedConfig ? usedConfig.config_id : null, message, answer,
       jsonStringify(result.toolCallsLog || []), tokensUsed, latency, status, errorMessage, nowIso()]
    );
  } catch (e) { Log.error({ service: 'bot', action: 'logTurn', msg: e.message }); }

  try {
    Audit.log({
      actor: session.userId, action: 'BOT_CHAT', entity: 'bot_conversations', entityId: turnId,
      countryCode: session.countryCode,
      metadata: {
        route: route,
        tools_used: result.toolsUsed || [],
        proposed: actions.map(function (a) { return a.service + '.' + a.action; }),
        status: status,
      },
    });
  } catch (_) {}

  return {
    answer:    answer || '',
    navigate:  dir.navigate || null,
    clarify:   dir.clarify || null,
    result:    tableResult,
    actions:   actions,
    toolsUsed: result.toolsUsed || [],
    turnId:    turnId,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// bot.confirmAction  (execute a proposed write, re-checking permission)
// ════════════════════════════════════════════════════════════════════════════

function _botConfirmAction_(ctx, params) {
  var session = ctx && ctx.session;
  if (!session || !session.userId) throw new Errors.PermissionDenied('Authentication required.');

  var tool  = String((params && params.tool) || '');
  var input = (params && params.params && typeof params.params === 'object') ? params.params : {};
  var parsed = _botParseToolName_(tool);
  var service = parsed.service, action = parsed.action, label = service + '.' + action;
  if (!service || !action) throw new Errors.Validation('A valid tool is required.');

  var rows = TursoClient.select(
    'SELECT * FROM bot_tools WHERE service = ? AND action = ? LIMIT 1', [service, action]);
  if (!rows.length || String(rows[0].is_enabled) !== '1') throw new Errors.Validation('Tool ' + label + ' is not available.');
  var row = rows[0];
  if (String(row.is_write) === '0') throw new Errors.Validation('Only write actions are confirmed; ' + label + ' is a read tool.');

  // Re-check RBAC at confirm time (in addition to the destination handler's own
  // check, which the dispatcher also enforces below).
  if (row.required_permission && !Rbac.userHasPermission(session.userId, row.required_permission)) {
    Audit.log({ actor: session.userId, action: 'BOT_ACTION_DENIED', entity: 'bot_tools', entityId: label,
                metadata: { required: row.required_permission } });
    throw new Errors.PermissionDenied('You do not have permission to perform ' + label + '.');
  }

  // Run via the dispatcher under the caller's own session (no elevation).
  var callParams = {};
  Object.keys(input).forEach(function (k) { if (k !== 'sessionToken') callParams[k] = input[k]; });
  callParams.sessionToken = ctx.sessionToken;

  var resp = processRequest({ service: service, action: action, params: callParams });
  var ok   = !!(resp && resp.ok);
  var turnId = genId('BTRN');

  // Log the confirmed write to bot_conversations and audit_log.
  try {
    TursoClient.write(
      'INSERT INTO bot_conversations ' +
      '(turn_id, session_id, user_id, user_role, config_id, user_message, bot_response, ' +
      'tool_calls_json, tokens_used, latency_ms, status, error_message, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [turnId, session.sessionId || null, session.userId, session.role || null, null,
       'CONFIRM ' + label, ok ? 'confirmed and executed' : 'confirm failed',
       jsonStringify([{ name: label, input: callParams, confirmed: true, executed: ok }]),
       0, 0, ok ? 'OK' : 'ERROR', ok ? null : ((resp && resp.error && resp.error.message) || 'error'), nowIso()]
    );
  } catch (_) {}
  Audit.log({ actor: session.userId, action: 'BOT_ACTION_CONFIRMED', entity: service, entityId: action,
              countryCode: session.countryCode,
              metadata: { tool: label, ok: ok, params: _botMaskParams_(callParams) } });

  if (!ok) {
    var err = (resp && resp.error) || { message: 'The action could not be completed.' };
    throw new Errors.AppError(err.message || 'The action could not be completed.', err.code || 'ACTION_FAILED');
  }
  return { success: true, tool: label, message: _botConfirmMessage_(service, action, resp.data), data: resp.data };
}

function _botMaskParams_(p) {
  var out = {};
  Object.keys(p || {}).forEach(function (k) {
    if (k === 'sessionToken' || /password|secret|token/i.test(k)) out[k] = '***'; else out[k] = p[k];
  });
  return out;
}

function _botConfirmMessage_(service, action, data) {
  var key = service + '.' + action;
  if (key === 'tickets.create')     return 'Ticket created' + (data && data.ticket_number ? ' (' + data.ticket_number + ').' : '.');
  if (key === 'tickets.assign')     return 'Ticket assigned.';
  if (key === 'tickets.addComment') return 'Comment added to the ticket.';
  if (key === 'invoices.generate')  return 'Invoice generated' + (data && data.invoice_number ? ' (' + data.invoice_number + ').' : '.');
  return 'Done.';
}

// ════════════════════════════════════════════════════════════════════════════
// bot.suggestions  (proactive, role and page aware prompt starters)
// ════════════════════════════════════════════════════════════════════════════

function _botSuggestions_(ctx, params) {
  var session = ctx && ctx.session;
  if (!session || !session.userId) throw new Errors.PermissionDenied('Authentication required.');
  return _botSuggestionsFor_(session, String((params && params.route) || ''));
}

/** Build grouped, permission-filtered starters for a route. */
function _botSuggestionsFor_(session, route) {
  var uid = session.userId || session.user_id || '';
  function can(code) { return Rbac.userHasPermission(uid, code); }
  var r = String(route || '').toLowerCase();

  var firstName = '';
  try {
    var u = TursoClient.select('SELECT first_name FROM users WHERE user_id = ? LIMIT 1', [uid]);
    if (u.length) firstName = String(u[0].first_name || '');
  } catch (_) {}

  // Groups keyed by header; we drop empty ones at the end.
  var G = { Reports: [], Lookups: [], Drafts: [], Actions: [] };
  function add(group, label, prompt) { G[group].push({ label: label, prompt: prompt || label }); }

  // ── Route-specific starters first (context aware) ──
  if (r === 'customers') {
    if (can('customers.view')) {
      add('Lookups', 'Customer 360 for an account', 'Give me a customer 360 for ');
      add('Lookups', 'Outstanding balance and credit exposure', 'Show outstanding balance and credit exposure for ');
      add('Lookups', 'Recent orders and invoices', 'Show recent orders and invoices for ');
    }
  } else if (r === 'orders') {
    if (can('order.view')) {
      add('Reports', 'Orders report by criteria', 'Run an orders report. Ask me for the criteria you need.');
      add('Lookups', 'Stuck orders by status', 'List orders stuck in SUBMITTED or PROCESSING.');
      add('Reports', 'Top customers by volume this quarter', 'Show top customers by order volume this quarter.');
    }
  } else if (r === 'invoices' || r === 'payments') {
    if (can('invoice.view')) {
      add('Lookups', 'Show overdue invoices', 'List overdue unpaid invoices.');
      add('Reports', 'Receivables aging', 'Run the receivables aging report.');
      add('Reports', 'Payments awaiting review', 'Run the payments report for items awaiting review.');
    }
  } else if (r === 'tickets') {
    if (can('ticket.view')) {
      add('Lookups', 'Tickets breaching SLA today', 'List tickets breaching SLA today.');
      add('Lookups', 'My open tickets', 'List my open tickets.');
      add('Drafts', 'Draft a ticket reply', 'Draft a reply for ticket ');
    }
  } else if (r === 'documents') {
    if (can('customer.view')) {
      add('Reports', 'KYC status report', 'Run the KYC and compliance report.');
      add('Lookups', 'Documents pending review', 'List KYC documents pending review.');
    }
  } else if (r === 'approvals') {
    if (can('order.view')) add('Reports', 'Pending and overdue approvals', 'Run the approvals report by tier.');
    if (can('order.approve_low')) add('Lookups', 'My approval inbox', 'Show my approval inbox.');
  } else if (r === 'pricing' || r === 'catalog') {
    if (can('order.view')) add('Reports', 'Active price lists by tier', 'Run the pricing report.');
  }

  // ── General starters by capability (dashboard and elsewhere) ──
  if (can('invoice.view')) {
    add('Reports', 'Receivables aging', 'Run the receivables aging report.');
    add('Lookups', 'Show overdue invoices', 'List overdue unpaid invoices.');
    add('Drafts', 'Draft a payment reminder', 'Draft a payment reminder for an overdue invoice. Ask me which one.');
  }
  if (can('customer.view')) add('Reports', 'Generate KYC status report', 'Run the KYC and compliance report.');
  if (can('ticket.view')) {
    add('Reports', 'Tickets and SLA report', 'Run the ticket and SLA report.');
    add('Lookups', 'Tickets breaching SLA today', 'List tickets breaching SLA today.');
    add('Lookups', 'My open tickets', 'List my open tickets.');
  }
  if (can('order.view')) {
    add('Reports', 'Orders report by criteria', 'Run an orders report. Ask me for the criteria.');
    add('Lookups', "Summarise today's activity", "Summarise today's activity across orders, tickets and approvals.");
  }
  if (can('customers.view')) add('Reports', 'Credit exposure', 'Run the credit exposure report.');

  // ── Action (write) starters, gated by write permissions ──
  if (can('ticket.create')) add('Actions', 'Create a ticket', 'Help me create a ticket. Ask me for the details.');
  if (can('ticket.assign')) add('Actions', 'Assign a ticket', 'Help me assign a ticket to an agent.');
  if (can('invoice.generate')) add('Actions', 'Generate an invoice', 'Generate an invoice for a delivered order. Ask me which order.');

  // De-duplicate by label within each group and cap per group.
  var groups = [];
  Object.keys(G).forEach(function (header) {
    var seen = {}, items = [];
    G[header].forEach(function (it) {
      if (seen[it.label]) return; seen[it.label] = 1;
      if (items.length < 5) items.push(it);
    });
    if (items.length) groups.push({ header: header, items: items });
  });

  var greeting = (firstName ? 'Hi ' + firstName + '. ' : 'Hi. ') +
    'I am your Hass assistant. I can run reports, look things up, draft messages, and prepare ' +
    'changes for you to confirm. Pick a starter or just type what you need.';

  return { greeting: greeting, groups: groups, route: route };
}

// ════════════════════════════════════════════════════════════════════════════
// bot.emailResult  (email a result table to the signed-in user only)
// ════════════════════════════════════════════════════════════════════════════

function _botEmailResult_(ctx, params) {
  var session = ctx && ctx.session;
  if (!session || !session.userId) throw new Errors.PermissionDenied('Authentication required.');

  var email = _botResolveUserEmail_(session);
  if (!email) throw new Errors.Validation('No email address is on file for your account.');

  var title   = String((params && params.title) || 'Hass report');
  var summary = String((params && params.summary) || '');
  var columns = (params && Array.isArray(params.columns)) ? params.columns : [];
  var rows    = (params && Array.isArray(params.rows)) ? params.rows.slice(0, BOT_EMAIL_ROW_CAP) : [];
  if (!columns.length || !rows.length) throw new Errors.Validation('There is nothing to email.');

  var html = _botResultToHtml_(title, summary, columns, rows);
  EmailInteg.send(email, '[Hass CMS] ' + title, html, summary);
  Audit.log({ actor: session.userId, action: 'BOT_RESULT_EMAILED', entity: 'bot_conversations', entityId: '',
              metadata: { title: title, rows: rows.length, to: email } });
  return { success: true, to: email };
}

function _botResolveUserEmail_(session) {
  var uid = session.userId || session.user_id || '';
  var type = String(session.userType || session.user_type || 'STAFF').toUpperCase();
  try {
    if (type === 'CUSTOMER') {
      var c = TursoClient.select('SELECT email FROM contacts WHERE contact_id = ? LIMIT 1', [uid]);
      return c.length ? String(c[0].email || '') : '';
    }
    var u = TursoClient.select('SELECT email FROM users WHERE user_id = ? LIMIT 1', [uid]);
    return u.length ? String(u[0].email || '') : '';
  } catch (_) { return ''; }
}

function _botResultToHtml_(title, summary, columns, rows) {
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  var th = columns.map(function (c) {
    return '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #1F2D5C;background:#f3f4f6">' +
           escHtml(c.label || c.key) + '</th>';
  }).join('');
  var tr = rows.map(function (row) {
    var tds = columns.map(function (c) {
      return '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">' + escHtml(row[c.key]) + '</td>';
    }).join('');
    return '<tr>' + tds + '</tr>';
  }).join('');
  return '<div style="font-family:Arial,sans-serif;color:#111">' +
         '<h2 style="color:#1F2D5C;margin:0 0 6px">' + escHtml(title) + '</h2>' +
         (summary ? '<p style="color:#374151;margin:0 0 14px">' + escHtml(summary) + '</p>' : '') +
         '<table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr>' + th +
         '</tr></thead><tbody>' + tr + '</tbody></table>' +
         '<p style="color:#9ca3af;font-size:12px;margin-top:16px">Generated by the Hass CMS assistant.</p></div>';
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG MANAGEMENT (admin-only). Key VALUE never returned; has_key boolean only.
// ════════════════════════════════════════════════════════════════════════════

/** Shape a config row for the client; add has_key from the named Script Property. */
function _botShapeConfig_(row) {
  var hasKey = false;
  try {
    if (row.api_key_property) {
      var v = PropertiesService.getScriptProperties().getProperty(row.api_key_property);
      hasKey = !!(v && v.length);
    }
  } catch (_) {}
  return {
    config_id:        row.config_id,
    provider:         row.provider,
    label:            row.label,
    model:            row.model,
    endpoint_url:     row.endpoint_url,
    api_key_property: row.api_key_property, // NAME only, never the value
    has_key:          hasKey,
    max_tokens:       row.max_tokens,
    temperature:      row.temperature,
    system_prompt:    row.system_prompt,
    is_active:        row.is_active,
    is_default:       row.is_default,
    allowed_roles:    row.allowed_roles,
    notes:            row.notes,
    created_by:       row.created_by,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
  };
}

function _botListConfigs_(ctx, params) {
  Rbac.requirePermission(ctx.session, BOT_ADMIN_PERMISSION);
  var rows = TursoClient.select('SELECT * FROM bot_llm_configs ORDER BY is_default DESC, label', []);
  return rows.map(_botShapeConfig_);
}

function _botGetConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, BOT_ADMIN_PERMISSION);
  var id = String((params && params.config_id) || '');
  if (!id) throw new Errors.Validation('config_id required.');
  var rows = TursoClient.select('SELECT * FROM bot_llm_configs WHERE config_id = ? LIMIT 1', [id]);
  if (!rows.length) throw new Errors.NotFound('Config not found.');
  return _botShapeConfig_(rows[0]);
}

function _botSetActiveConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, BOT_ADMIN_PERMISSION);
  var id = String((params && params.config_id) || '');
  if (!id) throw new Errors.Validation('config_id required.');
  var rows = TursoClient.select('SELECT config_id FROM bot_llm_configs WHERE config_id = ? LIMIT 1', [id]);
  if (!rows.length) throw new Errors.NotFound('Config not found.');

  TursoClient.write('UPDATE bot_llm_configs SET is_active = 0, updated_at = ?', [nowIso()]);
  TursoClient.write('UPDATE bot_llm_configs SET is_active = 1, updated_at = ? WHERE config_id = ?', [nowIso(), id]);
  Audit.log({ actor: ctx.session.userId, action: 'BOT_CONFIG_ACTIVATED', entity: 'bot_llm_configs', entityId: id });
  return { success: true, config_id: id };
}

/**
 * Create or update a config. Optional apiKey is stored in a Script Property
 * (name = 'BOT_KEY_' + config_id); ONLY the property name is persisted in Turso.
 */
function _botSaveConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, BOT_ADMIN_PERMISSION);
  params = params || {};
  var now = nowIso();
  var id  = String(params.config_id || '').trim();

  var fields = {
    provider:      params.provider !== undefined ? String(params.provider) : null,
    label:         params.label !== undefined ? String(params.label) : null,
    model:         params.model !== undefined ? String(params.model) : null,
    endpoint_url:  params.endpoint_url !== undefined ? String(params.endpoint_url) : null,
    max_tokens:    params.max_tokens !== undefined ? params.max_tokens : null,
    temperature:   params.temperature !== undefined ? params.temperature : null,
    system_prompt: params.system_prompt !== undefined ? String(params.system_prompt) : null,
    allowed_roles: params.allowed_roles !== undefined
                     ? (Array.isArray(params.allowed_roles) ? jsonStringify(params.allowed_roles) : String(params.allowed_roles))
                     : null,
    notes:         params.notes !== undefined ? String(params.notes) : null,
  };

  var existing = null;
  if (id) {
    var rows = TursoClient.select('SELECT * FROM bot_llm_configs WHERE config_id = ? LIMIT 1', [id]);
    existing = rows.length ? rows[0] : null;
  }
  if (!id || !existing) {
    if (!id) id = genId('BOTCFG');
    if (!fields.provider) throw new Errors.Validation('provider required for a new config.');
    var propName = 'BOT_KEY_' + id;
    TursoClient.write(
      'INSERT INTO bot_llm_configs ' +
      '(config_id, provider, label, model, endpoint_url, api_key_property, max_tokens, temperature, ' +
      'system_prompt, is_active, is_default, allowed_roles, notes, created_by, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, fields.provider, fields.label, fields.model, fields.endpoint_url, propName,
       fields.max_tokens, fields.temperature, fields.system_prompt,
       0, 0, fields.allowed_roles, fields.notes, ctx.session.userId, now, now]
    );
  } else {
    var sets = [], args = [];
    Object.keys(fields).forEach(function (k) {
      if (fields[k] !== null) { sets.push(k + ' = ?'); args.push(fields[k]); }
    });
    sets.push('api_key_property = ?'); args.push('BOT_KEY_' + id);
    sets.push('updated_at = ?'); args.push(now);
    args.push(id);
    TursoClient.write('UPDATE bot_llm_configs SET ' + sets.join(', ') + ' WHERE config_id = ?', args);
  }

  if (params.apiKey !== undefined && params.apiKey !== null && String(params.apiKey).length) {
    PropertiesService.getScriptProperties().setProperty('BOT_KEY_' + id, String(params.apiKey));
    params.apiKey = null;
    delete params.apiKey;
  }

  Audit.log({ actor: ctx.session.userId, action: existing ? 'BOT_CONFIG_UPDATED' : 'BOT_CONFIG_CREATED',
              entity: 'bot_llm_configs', entityId: id });

  var saved = TursoClient.select('SELECT * FROM bot_llm_configs WHERE config_id = ? LIMIT 1', [id]);
  return _botShapeConfig_(saved[0]);
}

/** Delete the Script Property holding the key; leave the config row intact. */
function _botClearKey_(ctx, params) {
  Rbac.requirePermission(ctx.session, BOT_ADMIN_PERMISSION);
  var id = String((params && params.config_id) || '');
  if (!id) throw new Errors.Validation('config_id required.');
  var rows = TursoClient.select('SELECT * FROM bot_llm_configs WHERE config_id = ? LIMIT 1', [id]);
  if (!rows.length) throw new Errors.NotFound('Config not found.');

  var propName = rows[0].api_key_property || ('BOT_KEY_' + id);
  try { PropertiesService.getScriptProperties().deleteProperty(propName); } catch (_) {}
  TursoClient.write('UPDATE bot_llm_configs SET updated_at = ? WHERE config_id = ?', [nowIso(), id]);
  Audit.log({ actor: ctx.session.userId, action: 'BOT_KEY_CLEARED', entity: 'bot_llm_configs', entityId: id });
  return { success: true, config_id: id, has_key: false };
}

/** Parse allowed_roles which may be a JSON array or a comma-separated string. */
function _botParseRoles_(val) {
  if (!val) return [];
  var arr = jsonParse(val, null);
  if (Array.isArray(arr)) return arr.map(function (x) { return String(x).trim(); }).filter(Boolean);
  return String(val).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════════════════════

(function _registerBot_() {
  // Any authenticated user may chat / get starters / confirm / email; the tool
  // layer + RBAC do the gating.
  register({ service: 'bot', action: 'chat',            permission: null,                 handler: _botChat_ });
  register({ service: 'bot', action: 'suggestions',     permission: null,                 handler: _botSuggestions_ });
  register({ service: 'bot', action: 'confirmAction',   permission: null,                 handler: _botConfirmAction_ });
  register({ service: 'bot', action: 'emailResult',     permission: null,                 handler: _botEmailResult_ });

  // Admin config management (SUPER_ADMIN passes config.edit via the '*' wildcard).
  register({ service: 'bot', action: 'listConfigs',     permission: BOT_ADMIN_PERMISSION, handler: _botListConfigs_ });
  register({ service: 'bot', action: 'getConfig',       permission: BOT_ADMIN_PERMISSION, handler: _botGetConfig_ });
  register({ service: 'bot', action: 'setActiveConfig', permission: BOT_ADMIN_PERMISSION, handler: _botSetActiveConfig_ });
  register({ service: 'bot', action: 'saveConfig',      permission: BOT_ADMIN_PERMISSION, handler: _botSaveConfig_ });
  register({ service: 'bot', action: 'clearKey',        permission: BOT_ADMIN_PERMISSION, handler: _botClearKey_ });
})();
