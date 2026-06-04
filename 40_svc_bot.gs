/**
 * 40_svc_bot.gs  —  Hass CMS rebuild  (Phase 2: server-side assistant)
 *
 * READ-ONLY conversational assistant. The bot is given a catalog of safe read
 * actions (seeded into bot_tools, is_write = 0) and may call them ONLY through
 * the same dispatcher + sessionToken as the human user — so RBAC always applies
 * and the bot has no elevated access. There is NO write path in this phase: any
 * tool row whose is_write != 0 is hard-refused before execution.
 *
 * Surface (registered with the dispatcher):
 *   bot.chat            {message, history?}      — any authenticated user
 *   bot.listConfigs     {}                       — admin (config.edit / SUPER_ADMIN)
 *   bot.getConfig       {config_id}              — admin
 *   bot.setActiveConfig {config_id}              — admin
 *   bot.saveConfig      {config_id?, ...,apiKey?}— admin
 *   bot.clearKey        {config_id}              — admin
 *
 * Provider adapters: anthropic + openai. Both are fed the SAME tool catalog,
 * each in its own wire format, generated from the enabled bot_tools rows.
 *
 * API keys NEVER live in Turso. bot_llm_configs.api_key_property holds the NAME
 * of a Script Property that holds the secret. saveConfig stores the key via
 * PropertiesService and persists only the property name; list/get return a
 * has_key boolean, never the value; clearKey deletes the property.
 *
 * Tables (pre-existing):
 *   bot_llm_configs(config_id, provider, label, model, endpoint_url,
 *     api_key_property, max_tokens, temperature, system_prompt, is_active,
 *     is_default, allowed_roles, notes, created_by, created_at, updated_at)
 *   bot_conversations(turn_id, session_id, user_id, user_role, config_id,
 *     user_message, bot_response, tool_calls_json, tokens_used, latency_ms,
 *     status, error_message, created_at)
 *   bot_tools(tool_id, service, action, description, params_schema_json,
 *     is_write, required_permission, is_enabled, created_at, UNIQUE(service,action))
 */

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

var BOT_ADMIN_PERMISSION = 'config.edit'; // SUPER_ADMIN passes via '*' wildcard
var BOT_MAX_TOOL_CALLS   = 5;             // cap tool calls per turn
var BOT_TOOL_SEP         = '__';          // service<sep>action -> provider tool name

// ════════════════════════════════════════════════════════════════════════════
// BUILD 1 — SEED bot_tools (READ-ONLY actions only; is_write = 0 for every row)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The canonical read-only tool catalog. Every entry is a SAFE read action that
 * already exists in the dispatcher. NO create/update/delete/approve/reject/
 * cancel/dispatch/setCredit/upload/generate/assign action appears here.
 *
 * `params` is a JSON-Schema object describing accepted params; it is handed to
 * the LLM (as input_schema / function.parameters) so the model knows what it may
 * pass. `permission` mirrors the dispatcher's required permission (advisory only
 * — the dispatcher is the real gate).
 */
function _botToolCatalog_() {
  var COUNTRY  = { type: 'string', description: 'ISO country code to scope results, e.g. "KE" or "TZ".' };
  var STATUS   = { type: 'string', description: 'Filter by status value.' };
  var LIMIT    = { type: 'integer', description: 'Maximum rows to return.' };
  var SEARCH   = { type: 'string', description: 'Free-text search term.' };

  return [
    // ── Dashboard ────────────────────────────────────────────────────────────
    { service: 'dashboard', action: 'summary', permission: 'order.view',
      description: 'Headline counts for the staff dashboard (customers, open tickets, pending approvals, unpaid invoices, pending payments) scoped to the user’s country.',
      params: { country_code: COUNTRY } },
    { service: 'dashboard', action: 'activityFeed', permission: 'order.view',
      description: 'Recent activity feed across orders, tickets and approvals for the dashboard.',
      params: { country_code: COUNTRY, limit: LIMIT } },

    // ── Customers ────────────────────────────────────────────────────────────
    { service: 'customers', action: 'list', permission: 'customers.view',
      description: 'List customers, optionally filtered by country or status. Use for "how many customers", "which customers".',
      params: { country_code: COUNTRY, status: STATUS, search: SEARCH, limit: LIMIT } },
    { service: 'customers', action: 'get', permission: 'customers.view',
      description: 'Get one customer by id, including profile and account details.',
      params: { customerId: { type: 'string', description: 'The customer_id to fetch.' } } },
    { service: 'customers', action: 'search', permission: 'customers.view',
      description: 'Search customers by name, account number, email or phone.',
      params: { query: SEARCH, q: SEARCH, country_code: COUNTRY, limit: LIMIT } },
    { service: 'customers', action: 'customer360', permission: 'customers.view',
      description: 'Full 360° view of a customer: profile, orders, invoices, tickets and balances. Use when asked about a specific customer’s overall situation.',
      params: { customerId: { type: 'string', description: 'The customer_id to summarise.' } } },

    // ── Orders ───────────────────────────────────────────────────────────────
    { service: 'orders', action: 'list', permission: 'order.view',
      description: 'List orders, optionally filtered by status, customer or country. Use for "how many orders", "recent orders", "pending orders".',
      params: { country_code: COUNTRY, status: STATUS, customerId: { type: 'string' }, search: SEARCH, limit: LIMIT } },
    { service: 'orders', action: 'get', permission: 'order.view',
      description: 'Get one order by id, including its lines and status history.',
      params: { orderId: { type: 'string', description: 'The order_id to fetch.' } } },

    // ── Invoices ─────────────────────────────────────────────────────────────
    { service: 'invoices', action: 'list', permission: 'invoice.view',
      description: 'List invoices, optionally filtered by payment_status (e.g. UNPAID), status, customer or country. Use for "unpaid invoices", "overdue invoices".',
      params: { country_code: COUNTRY, status: STATUS, payment_status: { type: 'string', description: 'e.g. UNPAID, PAID, PARTIAL.' }, customerId: { type: 'string' }, limit: LIMIT } },
    { service: 'invoices', action: 'get', permission: 'invoice.view',
      description: 'Get one invoice by id with its line items and payment state.',
      params: { invoiceId: { type: 'string', description: 'The invoice_id to fetch.' } } },

    // ── Payments ─────────────────────────────────────────────────────────────
    { service: 'payments', action: 'list', permission: 'invoice.view',
      description: 'List uploaded payment proofs / payment records, optionally by status. Use for "pending payments", "payments awaiting review".',
      params: { status: STATUS, customerId: { type: 'string' }, limit: LIMIT } },

    // ── Tickets ──────────────────────────────────────────────────────────────
    { service: 'tickets', action: 'list', permission: 'ticket.view',
      description: 'List support tickets, optionally by status, priority, customer or country. Use for "open tickets", "tickets for customer X".',
      params: { country_code: COUNTRY, status: STATUS, priority: { type: 'string' }, customerId: { type: 'string' }, limit: LIMIT } },
    { service: 'tickets', action: 'get', permission: 'ticket.view',
      description: 'Get one ticket by id with its comments and history.',
      params: { ticketId: { type: 'string', description: 'The ticket_id to fetch.' } } },

    // ── Approvals ────────────────────────────────────────────────────────────
    { service: 'approvals', action: 'list', permission: 'order.view',
      description: 'List approval requests, optionally by status. Use for "pending approvals", "approval history".',
      params: { status: STATUS, country_code: COUNTRY, limit: LIMIT } },
    { service: 'approvals', action: 'inbox', permission: 'order.approve_low',
      description: 'Approval requests currently awaiting the signed-in user’s decision (their inbox).',
      params: { country_code: COUNTRY, limit: LIMIT } },
    { service: 'approvals', action: 'get', permission: 'order.view',
      description: 'Get one approval request by id with its workflow context.',
      params: { requestId: { type: 'string', description: 'The approval request_id to fetch.' } } },

    // ── Documents ────────────────────────────────────────────────────────────
    { service: 'documents', action: 'list', permission: 'customer.view',
      description: 'List documents, optionally for a specific customer. Read-only metadata only.',
      params: { customerId: { type: 'string' }, status: STATUS, limit: LIMIT } },

    // ── SLA ──────────────────────────────────────────────────────────────────
    { service: 'sla', action: 'listPolicies', permission: 'order.view',
      description: 'List configured SLA policies / targets.',
      params: { country_code: COUNTRY } },
    { service: 'sla', action: 'listBreaches', permission: 'order.view',
      description: 'List recorded SLA breaches. Use for "SLA breaches", "missed SLAs".',
      params: { country_code: COUNTRY, limit: LIMIT } },

    // ── Knowledge base ───────────────────────────────────────────────────────
    { service: 'knowledge', action: 'list', permission: 'order.view',
      description: 'List knowledge-base articles, optionally by category or search term.',
      params: { categoryId: { type: 'string' }, search: SEARCH, status: STATUS, limit: LIMIT } },
    { service: 'knowledge', action: 'listCategories', permission: 'order.view',
      description: 'List knowledge-base categories.',
      params: {} },
    { service: 'knowledge', action: 'get', permission: 'order.view',
      description: 'Get one knowledge-base article by id (full body). Use to answer "how do I..." from the KB.',
      params: { articleId: { type: 'string', description: 'The article_id to fetch.' } } },

    // ── Catalog ──────────────────────────────────────────────────────────────
    { service: 'catalog', action: 'listProducts', permission: 'order.view',
      description: 'List sellable products in the catalog.',
      params: { search: SEARCH, is_active: { type: 'boolean' }, limit: LIMIT } },
    { service: 'catalog', action: 'listPriceLists', permission: 'order.view',
      description: 'List price lists, optionally by country.',
      params: { country_code: COUNTRY } },

    // ── Reports ──────────────────────────────────────────────────────────────
    { service: 'reports', action: 'summary', permission: 'order.view',
      description: 'Aggregate report of headline counts across the main domain tables, scoped to the user’s country.',
      params: { country_code: COUNTRY } },

    // ── Users & RBAC (no secrets) ────────────────────────────────────────────
    { service: 'users', action: 'list', permission: 'user.view',
      description: 'List staff users (no passwords or secrets are ever returned). Use for "who is on the team", "list users".',
      params: { country_code: COUNTRY, status: STATUS, search: SEARCH, limit: LIMIT } },
    { service: 'rbac', action: 'listRoles', permission: 'order.manage',
      description: 'List the RBAC roles defined in the system.',
      params: {} },
  ];
}

/**
 * seedBotTools() — idempotent. Inserts one bot_tools row per read-only action in
 * the catalog. is_write is ALWAYS 0 in this phase. Skips any (service,action)
 * already present. Safe to run repeatedly. Run manually from the IDE (or it is
 * invoked by reproBot()).
 */
function seedBotTools() {
  var catalog = _botToolCatalog_();
  var existing = {};
  try {
    TursoClient.select('SELECT service, action FROM bot_tools', []).forEach(function (r) {
      existing[r.service + '.' + r.action] = true;
    });
  } catch (e) {
    Log.error({ service: 'bot', action: 'seedBotTools', msg: 'read bot_tools: ' + e.message });
    throw e;
  }

  var inserted = 0, skipped = 0;
  catalog.forEach(function (t) {
    var key = t.service + '.' + t.action;
    if (existing[key]) { skipped++; return; }
    var schema = { type: 'object', properties: t.params || {} };
    TursoClient.write(
      'INSERT INTO bot_tools ' +
      '(tool_id, service, action, description, params_schema_json, is_write, required_permission, is_enabled, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [genId('BTOOL'), t.service, t.action, t.description,
       jsonStringify(schema), 0, t.permission || null, 1, nowIso()]
    );
    inserted++;
  });

  Logger.log('[bot] seedBotTools: inserted ' + inserted + ', skipped ' + skipped +
             ' (total catalog ' + catalog.length + ')');
  return { inserted: inserted, skipped: skipped, total: catalog.length };
}

// ════════════════════════════════════════════════════════════════════════════
// TOOL CATALOG (loaded from DB → provider formats)
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
      description:  String(r.description || ''),
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
        description: String(r.description || ''),
        parameters:  _botInputSchema_(r),
      },
    };
  });
}

/** Human-readable catalog for the system prompt. */
function _botToolsForPrompt_(rows) {
  return rows.map(function (r) {
    return '- ' + r.service + '.' + r.action + ': ' + (r.description || '');
  }).join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// BUILD 2 — PROVIDER ADAPTERS
//   Each returns a normalized { text, toolCalls:[{id,name,input}], tokensUsed,
//   error?, raw }. Keys are read at call time from Script Properties; a missing
//   key returns a clean error instead of crashing.
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

/**
 * Anthropic Messages API adapter.
 * @param config   bot_llm_configs row
 * @param messages [{role:'user'|'assistant', content: string|Array}]
 * @param tools    anthropic tool array
 * @param system   system prompt string
 */
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

/**
 * OpenAI Chat Completions adapter.
 * @param config   bot_llm_configs row
 * @param messages OpenAI message array (system included as a role:'system' msg)
 * @param tools    OpenAI tool (function) array
 */
function _botCallOpenai_(config, messages, tools) {
  var key = _botApiKey_(config);
  if (!key) return { error: 'API key not configured for this assistant.', text: '', toolCalls: [], tokensUsed: 0 };

  var url  = config.endpoint_url || 'https://api.openai.com/v1/chat/completions';
  var body = {
    model:       config.model,
    max_tokens:  _botNum_(config.max_tokens, 1024),
    temperature: _botNum_(config.temperature, 0),
    messages:    messages,
  };
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
// TOOL EXECUTION (read-only, hard-gated)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute a single tool call requested by the model.
 *  a. must exist in bot_tools and be enabled, else "not permitted"
 *  b. HARD GUARD: is_write != 0 → refused (read-only phase)
 *  c. runs via processRequest under the SAME sessionToken (RBAC applies)
 * Returns { content: <string fed back to model>, executed: bool, refused: bool,
 *           service, action }.
 */
function _botExecuteTool_(toolName, input, sessionToken) {
  var parsed  = _botParseToolName_(toolName);
  var service = parsed.service, action = parsed.action;
  var label   = service + '.' + action;

  if (!service || !action) {
    return { content: 'Tool "' + toolName + '" is not permitted.', refused: true, service: service, action: action };
  }

  var rows = TursoClient.select(
    'SELECT * FROM bot_tools WHERE service = ? AND action = ? LIMIT 1', [service, action]
  );
  if (!rows.length || String(rows[0].is_enabled) !== '1') {
    return { content: 'Tool ' + label + ' is not permitted.', refused: true, service: service, action: action };
  }

  // HARD GUARD — read-only phase. Never execute a write tool.
  if (String(rows[0].is_write) !== '0') {
    Log.warn({ service: 'bot', action: 'executeTool', msg: 'write tool refused: ' + label });
    return { content: 'Tool ' + label + ' performs a write and is not allowed in read-only mode.',
             refused: true, service: service, action: action };
  }

  var params = (input && typeof input === 'object') ? input : {};
  params.sessionToken = sessionToken; // same session → RBAC enforced downstream

  var resp;
  try {
    resp = processRequest({ service: service, action: action, params: params });
  } catch (e) {
    return { content: 'Tool ' + label + ' failed: ' + e.message, executed: true, service: service, action: action };
  }

  if (resp && resp.ok) {
    return { content: jsonStringify(resp.data), executed: true, service: service, action: action };
  }
  // Pass dispatcher denials/errors straight back to the model — never escalate.
  var err = (resp && resp.error) || { message: 'unknown error' };
  return { content: 'Tool ' + label + ' returned an error (' + (err.code || 'ERROR') + '): ' +
                    (err.message || ''), executed: true, service: service, action: action };
}

// ════════════════════════════════════════════════════════════════════════════
// CONVERSATION LOOPS (one per provider; share _botExecuteTool_)
//   Return { text, toolsUsed:[label...], tokensUsed, toolCallsLog:[...], error? }
// ════════════════════════════════════════════════════════════════════════════

function _botConvAnthropic_(config, system, message, history, toolRows, sessionToken) {
  var tools    = _botToolsAnthropic_(toolRows);
  var messages = [];
  (history || []).forEach(function (h) {
    if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
  });
  messages.push({ role: 'user', content: String(message) });

  var toolsUsed = [], toolCallsLog = [], tokensUsed = 0, finalText = '';

  for (var i = 0; i <= BOT_MAX_TOOL_CALLS; i++) {
    var capped = (i === BOT_MAX_TOOL_CALLS);
    var res = _botCallAnthropic_(config, messages, capped ? [] : tools, system);
    tokensUsed += res.tokensUsed || 0;
    if (res.error) return { error: res.error, text: '', toolsUsed: toolsUsed, tokensUsed: tokensUsed, toolCallsLog: toolCallsLog };

    finalText = res.text || finalText;
    if (!res.toolCalls.length || capped) break;

    // Echo the assistant's tool_use turn back, then answer with tool_result(s).
    messages.push({ role: 'assistant', content: (res.raw && res.raw.content) || [] });
    var results = [];
    res.toolCalls.forEach(function (tc) {
      var out = _botExecuteTool_(tc.name, tc.input, sessionToken);
      var label = out.service + '.' + out.action;
      toolCallsLog.push({ name: label, input: tc.input, refused: !!out.refused });
      if (out.executed && !out.refused && toolsUsed.indexOf(label) === -1) toolsUsed.push(label);
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: out.content });
    });
    messages.push({ role: 'user', content: results });
  }

  return { text: finalText, toolsUsed: toolsUsed, tokensUsed: tokensUsed, toolCallsLog: toolCallsLog };
}

function _botConvOpenai_(config, system, message, history, toolRows, sessionToken) {
  var tools    = _botToolsOpenai_(toolRows);
  var messages = [{ role: 'system', content: system }];
  (history || []).forEach(function (h) {
    if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
  });
  messages.push({ role: 'user', content: String(message) });

  var toolsUsed = [], toolCallsLog = [], tokensUsed = 0, finalText = '';

  for (var i = 0; i <= BOT_MAX_TOOL_CALLS; i++) {
    var capped = (i === BOT_MAX_TOOL_CALLS);
    var res = _botCallOpenai_(config, messages, capped ? [] : tools);
    tokensUsed += res.tokensUsed || 0;
    if (res.error) return { error: res.error, text: '', toolsUsed: toolsUsed, tokensUsed: tokensUsed, toolCallsLog: toolCallsLog };

    finalText = res.text || finalText;
    if (!res.toolCalls.length || capped) break;

    // Echo the assistant message (with tool_calls), then a tool message per call.
    messages.push({ role: 'assistant', content: res.text || null, tool_calls: (res.raw && res.raw.tool_calls) || [] });
    res.toolCalls.forEach(function (tc) {
      var out = _botExecuteTool_(tc.name, tc.input, sessionToken);
      var label = out.service + '.' + out.action;
      toolCallsLog.push({ name: label, input: tc.input, refused: !!out.refused });
      if (out.executed && !out.refused && toolsUsed.indexOf(label) === -1) toolsUsed.push(label);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.content });
    });
  }

  return { text: finalText, toolsUsed: toolsUsed, tokensUsed: tokensUsed, toolCallsLog: toolCallsLog };
}

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT + NAVIGATION
// ════════════════════════════════════════════════════════════════════════════

function _botBuildSystemPrompt_(config, session, toolRows) {
  var role    = session.role || 'user';
  var country = session.countryCode || 'all countries';
  var lines = [];
  lines.push(String(config.system_prompt || 'You are a helpful read-only assistant for the Hass CMS.'));
  lines.push('');
  lines.push('The signed-in user has role "' + role + '" and country scope "' + country + '". ' +
             'Everything you can see is limited to what this user is allowed to see; if a tool ' +
             'returns a permission error, tell the user they do not have access rather than retrying.');
  lines.push('');
  lines.push('You are READ-ONLY. You can look things up but you cannot create, change, approve, ' +
             'cancel or delete anything. If asked to perform such an action, explain that you can ' +
             'only read data and (where useful) point the user to the right page.');
  lines.push('');
  lines.push('Available tools (use them to answer with real data instead of guessing):');
  lines.push(_botToolsForPrompt_(toolRows));
  lines.push('');
  lines.push('NAVIGATION: to send the user to a page, end your reply with a fenced JSON block:');
  lines.push('```json');
  lines.push('{"navigate":{"route":"invoices","params":{"status":"UNPAID"}}}');
  lines.push('```');
  lines.push('Only include that block when the user clearly wants to go to a page. Put your ' +
             'natural-language answer before it.');
  return lines.join('\n');
}

/**
 * Extract a {"navigate":{...}} directive from the model's final answer.
 * Returns { answer: <text with the block removed>, navigate: <obj|null> }.
 */
function _botExtractNavigate_(text) {
  if (!text) return { answer: '', navigate: null };
  var navigate = null;
  var cleaned  = text;

  // Prefer a fenced ```json block containing "navigate".
  var fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  var m;
  while ((m = fence.exec(text)) !== null) {
    var obj = jsonParse(m[1].trim(), null);
    if (obj && obj.navigate) {
      navigate = obj.navigate;
      cleaned  = cleaned.replace(m[0], '');
      break;
    }
  }

  // Fallback: a bare {"navigate":{...}} object somewhere in the text.
  if (!navigate) {
    var bare = text.match(/\{\s*"navigate"\s*:\s*\{[\s\S]*?\}\s*\}/);
    if (bare) {
      var obj2 = jsonParse(bare[0], null);
      if (obj2 && obj2.navigate) {
        navigate = obj2.navigate;
        cleaned  = cleaned.replace(bare[0], '');
      }
    }
  }

  return { answer: cleaned.trim(), navigate: navigate };
}

// ════════════════════════════════════════════════════════════════════════════
// BUILD 3 — bot.chat HANDLER
// ════════════════════════════════════════════════════════════════════════════

function _botChat_(ctx, params) {
  // 1. Session — dispatcher already validated (bot.chat is non-public). Guard anyway.
  var session = ctx && ctx.session;
  if (!session || !session.userId) {
    throw new Errors.PermissionDenied('Authentication required.');
  }

  var t0      = Date.now();
  var message = String((params && params.message) || '').trim();
  var history = (params && Array.isArray(params.history)) ? params.history : [];

  if (!message) throw new Errors.Validation('message required.');

  // 2. Load active config (prefer is_default among active rows).
  var configs = TursoClient.select(
    'SELECT * FROM bot_llm_configs WHERE is_active = 1 ORDER BY is_default DESC, updated_at DESC LIMIT 1', []
  );
  if (!configs.length) {
    return { answer: 'The assistant is not configured yet. Please ask an administrator to set up a model.',
             navigate: null, toolsUsed: [], turnId: null };
  }
  var config = configs[0];

  // Role gate: if allowed_roles is set, the user's role must be listed.
  var allowed = _botParseRoles_(config.allowed_roles);
  if (allowed.length && allowed.indexOf(String(session.role)) === -1) {
    throw new Errors.PermissionDenied('Your role is not permitted to use this assistant.');
  }

  // 3 + 4 + 5. Build prompt, call provider, run the read-only tool loop.
  var toolRows = _botEnabledTools_();
  var system   = _botBuildSystemPrompt_(config, session, toolRows);
  var provider = String(config.provider || '').toLowerCase();

  var result;
  var status = 'OK', errorMessage = null;
  try {
    if (provider === 'anthropic') {
      result = _botConvAnthropic_(config, system, message, history, toolRows, ctx.sessionToken);
    } else if (provider === 'openai') {
      result = _botConvOpenai_(config, system, message, history, toolRows, ctx.sessionToken);
    } else {
      result = { error: 'Unknown provider: ' + provider, text: '', toolsUsed: [], tokensUsed: 0, toolCallsLog: [] };
    }
  } catch (e) {
    result = { error: e.message, text: '', toolsUsed: [], tokensUsed: 0, toolCallsLog: [] };
  }

  // 6. Navigation directive (parsed out; never navigated server-side).
  var nav = _botExtractNavigate_(result.text || '');
  var answer = nav.answer;
  if (result.error) {
    status       = 'ERROR';
    errorMessage = result.error;
    answer       = 'Sorry, I could not complete that request right now.';
  } else if (!answer) {
    answer = 'I could not produce an answer.';
  }

  var latency = Date.now() - t0;
  var turnId  = genId('BTRN');

  // 7. Audit the turn to bot_conversations (never logs keys; tool_calls only).
  try {
    TursoClient.write(
      'INSERT INTO bot_conversations ' +
      '(turn_id, session_id, user_id, user_role, config_id, user_message, bot_response, ' +
      'tool_calls_json, tokens_used, latency_ms, status, error_message, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [turnId, session.sessionId || null, session.userId, session.role || null, config.config_id,
       message, answer, jsonStringify(result.toolCallsLog || []),
       result.tokensUsed || 0, latency, status, errorMessage, nowIso()]
    );
  } catch (e) {
    Log.error({ service: 'bot', action: 'logTurn', msg: e.message });
  }

  // 8. Response.
  return {
    answer:    answer,
    navigate:  nav.navigate,
    toolsUsed: result.toolsUsed || [],
    turnId:    turnId,
  };
}

/** Parse allowed_roles which may be a JSON array or a comma-separated string. */
function _botParseRoles_(val) {
  if (!val) return [];
  var arr = jsonParse(val, null);
  if (Array.isArray(arr)) return arr.map(function (x) { return String(x).trim(); }).filter(Boolean);
  return String(val).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIG MANAGEMENT (admin-only). Key VALUE never returned; has_key boolean only.
// ════════════════════════════════════════════════════════════════════════════

/** Shape a config row for the client: drop nothing sensitive (no key col exists),
 *  add has_key derived from whether the named Script Property is set. */
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
 * The raw key is never written to a column, never logged, and discarded after use.
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
    TursoClient.write(
      'INSERT INTO bot_llm_configs ' +
      '(config_id, provider, label, model, endpoint_url, api_key_property, max_tokens, temperature, ' +
      'system_prompt, is_active, is_default, allowed_roles, notes, created_by, created_at, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, fields.provider, fields.label, fields.model, fields.endpoint_url, null,
       fields.max_tokens, fields.temperature, fields.system_prompt,
       0, 0, fields.allowed_roles, fields.notes, ctx.session.userId, now, now]
    );
  } else {
    var sets = [], args = [];
    Object.keys(fields).forEach(function (k) {
      if (fields[k] !== null) { sets.push(k + ' = ?'); args.push(fields[k]); }
    });
    sets.push('updated_at = ?'); args.push(now);
    args.push(id);
    if (sets.length) {
      TursoClient.write('UPDATE bot_llm_configs SET ' + sets.join(', ') + ' WHERE config_id = ?', args);
    }
  }

  // Key handling — store the secret in Script Properties, persist only the name.
  if (params.apiKey !== undefined && params.apiKey !== null && String(params.apiKey).length) {
    var propName = 'BOT_KEY_' + id;
    PropertiesService.getScriptProperties().setProperty(propName, String(params.apiKey));
    TursoClient.write('UPDATE bot_llm_configs SET api_key_property = ?, updated_at = ? WHERE config_id = ?',
                      [propName, now, id]);
    params.apiKey = null; // discard from memory; never logged
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

  var propName = rows[0].api_key_property;
  if (propName) {
    try { PropertiesService.getScriptProperties().deleteProperty(propName); } catch (_) {}
  }
  TursoClient.write('UPDATE bot_llm_configs SET api_key_property = NULL, updated_at = ? WHERE config_id = ?',
                    [nowIso(), id]);
  Audit.log({ actor: ctx.session.userId, action: 'BOT_KEY_CLEARED', entity: 'bot_llm_configs', entityId: id });
  return { success: true, config_id: id, has_key: false };
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════════════════════

(function _registerBot_() {
  // Any authenticated user may chat; the tool layer + RBAC do the gating.
  register({ service: 'bot', action: 'chat',            permission: null,                 handler: _botChat_ });

  // Admin config management (SUPER_ADMIN passes config.edit via the '*' wildcard).
  register({ service: 'bot', action: 'listConfigs',     permission: BOT_ADMIN_PERMISSION, handler: _botListConfigs_ });
  register({ service: 'bot', action: 'getConfig',       permission: BOT_ADMIN_PERMISSION, handler: _botGetConfig_ });
  register({ service: 'bot', action: 'setActiveConfig', permission: BOT_ADMIN_PERMISSION, handler: _botSetActiveConfig_ });
  register({ service: 'bot', action: 'saveConfig',      permission: BOT_ADMIN_PERMISSION, handler: _botSaveConfig_ });
  register({ service: 'bot', action: 'clearKey',        permission: BOT_ADMIN_PERMISSION, handler: _botClearKey_ });
})();
