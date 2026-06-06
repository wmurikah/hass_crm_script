/**
 * AIService.gs  —  Hass CMS  (AI-powered ticket triage)
 *
 * Adds ONE classification step IN FRONT OF the existing ticket pipeline. The
 * customer describes a problem in plain language; classifyTicket() asks an LLM
 * to turn that into structured ticket fields (category, urgency, subject,
 * description). The customer then confirms, and the client submits the draft
 * through the EXISTING tickets.create action. This file never writes a ticket
 * itself and never touches the ticket DB schema.
 *
 * RESILIENCE (provider fallback): two interchangeable providers. Anthropic
 * (Messages API) is the default primary; OpenAI (Chat Completions) is the
 * fallback. If the primary throws, times out, returns a non-2xx, or returns
 * output we cannot parse, the other provider is tried with an IDENTICAL request.
 * If BOTH fail, the call returns a GENERAL-category fallback draft so the ticket
 * flow never dead-ends. Order is set by the AI_PRIMARY Script Property. Both
 * providers are normalised to ONE response shape: the caller neither knows nor
 * cares which one answered.
 *
 * Wiring: registered with the dispatcher as the customer-facing action
 *   tickets.classifyTicket  (permission: null — any authenticated user, the same
 *   gate bot.chat uses). It is reached from the client through the normal
 *   API.call('tickets','classifyTicket',{text}) → processRequest channel; no new
 *   google.script.run endpoint is introduced.
 *
 * SECURITY: provider API keys are read at call time from Script Properties
 *   ANTHROPIC_API_KEY and OPENAI_API_KEY (Project Settings, Script Properties).
 *   They are never hardcoded, never persisted to Turso, never sent to the client.
 */

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

// Anthropic (primary by default) — Messages API.
var AI_ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
var AI_ANTHROPIC_MODEL    = 'claude-sonnet-4-6';

// OpenAI (fallback by default) — Chat Completions; response_format forces JSON.
var AI_OPENAI_ENDPOINT    = 'https://api.openai.com/v1/chat/completions';
var AI_OPENAI_MODEL       = 'gpt-4o-mini';   // current low-cost, JSON-capable model

var AI_MAX_TOKENS = 512;

// Script Property NAMES (never the values). Either key alone is enough; if both
// are present we try the primary first and fall back to the other.
var AI_ANTHROPIC_KEY_PROPERTY = 'ANTHROPIC_API_KEY';
var AI_OPENAI_KEY_PROPERTY    = 'OPENAI_API_KEY';
var AI_PRIMARY_PROPERTY       = 'AI_PRIMARY';   // 'anthropic' (default) | 'openai'

var AI_CATEGORIES  = ['GENERAL', 'ORDER', 'BILLING', 'DELIVERY', 'TECHNICAL', 'COMPLAINT'];
var AI_URGENCIES   = ['LOW', 'MEDIUM', 'HIGH'];
var AI_SUBJECT_MAX = 80;

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

function _aiSystemPrompt_() {
  return [
    'You are the support-ticket triage assistant for Hass Petroleum, a fuel and',
    'lubricants distributor. A customer will describe a problem in their own words.',
    'Classify it and draft a clean support ticket on their behalf.',
    '',
    'Respond with ONLY a single raw JSON object, with no prose before or after it,',
    'and no markdown code fences. The object must contain exactly these four keys:',
    '  "category"    one of: GENERAL, ORDER, BILLING, DELIVERY, TECHNICAL, COMPLAINT',
    '  "urgency"     one of: LOW, MEDIUM, HIGH',
    '  "subject"     a concise ticket title, at most 80 characters, on a single line',
    '  "description" a clear, complete restatement of the issue the customer reported',
    '',
    'Pick the single best-fitting category. Reserve HIGH urgency for outages, safety',
    'hazards, or work that is completely blocked. Do not invent details the customer',
    'did not provide.'
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════

/**
 * classifyTicket(userText)
 *   -> { success:true,  draft:{category,urgency,subject,description} }            (a provider answered)
 *   |  { success:false, fallback:true, draft:{category:'GENERAL', ...} }          (both providers failed)
 *   |  { success:false, error:'...' }                                             (no input / no key set)
 *
 * Tries the configured providers in order (AI_PRIMARY, default anthropic then
 * openai). A provider "succeeds" only when it returns a 2xx whose body yields a
 * parseable JSON draft; a throw, timeout, non-2xx, or unparseable body counts as
 * a failure and advances to the next provider. The returned shape is IDENTICAL
 * regardless of which provider answered, so the caller cannot tell them apart.
 */
function classifyTicket(userText) {
  var text = String(userText == null ? '' : userText).trim();
  if (!text) return { success: false, error: 'Please describe your issue first.' };

  var props = PropertiesService.getScriptProperties();
  var keys  = {
    anthropic: props.getProperty(AI_ANTHROPIC_KEY_PROPERTY),
    openai:    props.getProperty(AI_OPENAI_KEY_PROPERTY)
  };

  // No provider configured at all -> clear signal for the administrator.
  if (!keys.anthropic && !keys.openai) {
    return {
      success: false,
      error: 'AI triage is not configured yet. An administrator needs to set ' +
             AI_ANTHROPIC_KEY_PROPERTY + ' or ' + AI_OPENAI_KEY_PROPERTY +
             ' in Script Properties.'
    };
  }

  var order    = _aiProviderOrder_();
  var failures = [];

  for (var i = 0; i < order.length; i++) {
    var name = order[i];
    if (!keys[name]) continue;               // provider has no key -> skip
    var r = (name === 'anthropic')
      ? _aiCallAnthropic_(keys.anthropic, text)
      : _aiCallOpenai_(keys.openai, text);
    if (r.ok) {
      _aiLog_('classifyTicket', 'answered by ' + name);   // which provider answered (debug)
      return { success: true, draft: r.draft };
    }
    _aiLog_('classifyTicket', name + ' failed: ' + r.reason);
    failures.push(name + ' (' + r.reason + ')');
  }

  // Every configured provider failed -> GENERAL fallback so the flow never
  // dead-ends. Same draft field set as the success path; category forced GENERAL
  // and the customer's own words preserved as the description.
  _aiLog_('classifyTicket', 'all providers failed: ' + failures.join('; '));
  return {
    success:  false,
    fallback: true,
    draft: {
      category:    'GENERAL',
      urgency:     'MEDIUM',
      subject:     _aiDeriveSubject_(text),
      description: text
    }
  };
}

/** Provider try-order from the AI_PRIMARY Script Property (default anthropic). */
function _aiProviderOrder_() {
  var primary = String(
    PropertiesService.getScriptProperties().getProperty(AI_PRIMARY_PROPERTY) || 'anthropic'
  ).trim().toLowerCase();
  return primary === 'openai' ? ['openai', 'anthropic'] : ['anthropic', 'openai'];
}

// ════════════════════════════════════════════════════════════════════════════
// PROVIDER CALLS   (each returns { ok:true, draft } | { ok:false, reason })
// ════════════════════════════════════════════════════════════════════════════

/**
 * Anthropic Messages API. muteHttpExceptions keeps a non-2xx as a normal
 * response so we branch on the status instead of catching. Any failure mode
 * (throw, timeout, non-2xx, unparseable body, no JSON object) returns
 * { ok:false } so classifyTicket() can fall through to the other provider.
 */
function _aiCallAnthropic_(apiKey, text) {
  var payload = {
    model:      AI_ANTHROPIC_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system:     _aiSystemPrompt_(),
    messages:   [{ role: 'user', content: text }]
  };
  var resp;
  try {
    resp = UrlFetchApp.fetch(AI_ANTHROPIC_ENDPOINT, {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, reason: 'fetch threw: ' + (e && e.message ? e.message : e) };
  }

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    return { ok: false, reason: 'HTTP ' + code + ': ' + resp.getContentText().substring(0, 200) };
  }

  // Concatenate the text blocks of the Messages response.
  var raw = '';
  try {
    var data = JSON.parse(resp.getContentText());
    (data && data.content ? data.content : []).forEach(function (block) {
      if (block && block.type === 'text' && block.text) raw += block.text;
    });
  } catch (e) {
    return { ok: false, reason: 'response envelope unparseable' };
  }

  var draft = _aiExtractDraft_(raw, text);
  return draft ? { ok: true, draft: draft } : { ok: false, reason: 'model output was not valid JSON' };
}

/**
 * OpenAI Chat Completions. response_format:{type:'json_object'} forces a JSON
 * body, so the assistant message content IS the raw JSON string we parse. Same
 * system prompt and same required schema as the Anthropic branch; Bearer auth.
 */
function _aiCallOpenai_(apiKey, text) {
  var payload = {
    model:           AI_OPENAI_MODEL,
    max_tokens:      AI_MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: _aiSystemPrompt_() },
      { role: 'user',   content: text }
    ]
  };
  var resp;
  try {
    resp = UrlFetchApp.fetch(AI_OPENAI_ENDPOINT, {
      method:             'post',
      contentType:        'application/json',
      headers:            { Authorization: 'Bearer ' + apiKey },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, reason: 'fetch threw: ' + (e && e.message ? e.message : e) };
  }

  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    return { ok: false, reason: 'HTTP ' + code + ': ' + resp.getContentText().substring(0, 200) };
  }

  var raw = '';
  try {
    var data = JSON.parse(resp.getContentText());
    raw = (data && data.choices && data.choices[0] &&
           data.choices[0].message && data.choices[0].message.content) || '';
  } catch (e) {
    return { ok: false, reason: 'response envelope unparseable' };
  }

  var draft = _aiExtractDraft_(raw, text);
  return draft ? { ok: true, draft: draft } : { ok: false, reason: 'model output was not valid JSON' };
}

// ════════════════════════════════════════════════════════════════════════════
// DEFENSIVE DRAFT PARSING   (shared by both providers)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Turn a provider's raw reply into a validated, normalised draft, or return
 * null when it cannot be parsed at all. Strips ```json fences, isolates the
 * first {...} block, then JSON.parses inside a try/catch. A null result signals
 * an "unparseable" provider response so classifyTicket() advances to the next
 * provider. When an object IS parsed, each field is range-checked against the
 * allowed enums / limits (category coerced to GENERAL if not in the enum).
 */
function _aiExtractDraft_(rawModelText, originalText) {
  var cleaned = String(rawModelText == null ? '' : rawModelText).trim();
  if (!cleaned) return null;

  // Strip a wrapping markdown code fence (```json ... ```), if the model added one.
  cleaned = cleaned.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim();

  // If prose still surrounds the object, isolate the first {...} block.
  if (cleaned.charAt(0) !== '{') {
    var m = cleaned.match(/\{[\s\S]*\}/);
    if (m) cleaned = m[0];
  }

  var obj;
  try {
    obj = JSON.parse(cleaned);
  } catch (e) {
    return null;               // unparseable -> caller advances to the next provider
  }
  if (!obj || typeof obj !== 'object') return null;

  var description = (obj.description != null && String(obj.description).trim())
    ? String(obj.description).trim()
    : originalText;

  return {
    category:    _aiPickEnum_(obj.category, AI_CATEGORIES, 'GENERAL'),
    urgency:     _aiPickEnum_(obj.urgency,  AI_URGENCIES,  'MEDIUM'),
    subject:     _aiCleanSubject_(obj.subject, originalText),
    description: description
  };
}

/** Return value uppercased if it is in `allowed`, otherwise the default. */
function _aiPickEnum_(value, allowed, dflt) {
  var v = String(value == null ? '' : value).trim().toUpperCase();
  return allowed.indexOf(v) !== -1 ? v : dflt;
}

/** Normalise a model subject: single line, 5–80 chars, sensible fallback. */
function _aiCleanSubject_(value, originalText) {
  var s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (s.length < 5) return _aiDeriveSubject_(originalText);          // ticket needs >= 5
  if (s.length > AI_SUBJECT_MAX) s = s.substring(0, AI_SUBJECT_MAX).trim();
  return s;
}

/** Build a subject from the customer's own words when the model gives none. */
function _aiDeriveSubject_(originalText) {
  var s = String(originalText == null ? '' : originalText).replace(/\s+/g, ' ').trim();
  if (s.length < 5) return 'Support request';
  if (s.length > AI_SUBJECT_MAX) s = s.substring(0, AI_SUBJECT_MAX - 1).trim() + '…';
  return s;
}

function _aiLog_(action, msg) {
  try { Log.error({ service: 'ai', action: action, msg: msg }); }
  catch (e) { try { Logger.log('[ai] ' + action + ': ' + msg); } catch (_) {} }
}

// ════════════════════════════════════════════════════════════════════════════
// DISPATCHER REGISTRATION
// ════════════════════════════════════════════════════════════════════════════
//
// Customer-facing action: tickets.classifyTicket. permission:null means a valid
// session is required (enforced by dispatch()) but no extra RBAC grant is needed
// — the same gate bot.chat uses. Classification reads no ticket rows, so no
// ticket.* permission applies; the customer still confirms before anything is
// written through the existing tickets.create action.

function _aiClassifyTicketHandler_(ctx, params) {
  var text = (params && (params.text || params.message || params.userText)) || '';
  var result = classifyTicket(text);

  // Supply the caller's OWN customer_id so the client can submit through the
  // existing tickets.create path (which requires customer_id). This resolves it
  // in the classification step in front of the pipeline — the ticket backend and
  // schema are untouched. Omitted when it cannot be resolved (then the create
  // call behaves exactly as the prior fixed-form flow did).
  if (result && result.success && result.draft) {
    var customerId = _aiResolveCustomerId_(ctx && ctx.session);
    if (customerId) result.draft.customer_id = customerId;
  }
  return result;
}

/** Resolve a CUSTOMER session's customer_id from their contact row ('' if none). */
function _aiResolveCustomerId_(session) {
  if (!session) return '';
  var uid   = session.userId   || session.user_id   || '';
  var utype = session.userType || session.user_type || '';
  if (!uid || String(utype).toUpperCase() !== 'CUSTOMER') return '';
  try {
    var rows = TursoClient.select(
      'SELECT customer_id FROM contacts WHERE contact_id = ? LIMIT 1', [uid]
    );
    return rows.length ? String(rows[0].customer_id || '') : '';
  } catch (e) {
    return '';
  }
}

(function _registerAi_() {
  register({ service: 'tickets', action: 'classifyTicket', permission: null,
             handler: _aiClassifyTicketHandler_ });
})();
