/**
 * AIService.gs  —  Hass CMS  (AI-powered ticket triage)
 *
 * Adds ONE classification step IN FRONT OF the existing ticket pipeline. The
 * customer describes a problem in plain language; classifyTicket() asks the
 * Anthropic Messages API to turn that into structured ticket fields (category,
 * urgency, subject, description). The customer then confirms, and the client
 * submits the draft through the EXISTING tickets.create action. This file never
 * writes a ticket itself and never touches the ticket DB schema.
 *
 * Wiring: registered with the dispatcher as the customer-facing action
 *   tickets.classifyTicket  (permission: null — any authenticated user, the same
 *   gate bot.chat uses). It is reached from the client through the normal
 *   API.call('tickets','classifyTicket',{text}) → processRequest channel; no new
 *   google.script.run endpoint is introduced.
 *
 * SECURITY: the Anthropic API key is read at call time from the Script Property
 *   ANTHROPIC_API_KEY  (Project Settings → Script Properties). It is never
 *   hardcoded, never persisted to Turso, and never returned to the client.
 */

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

var AI_ENDPOINT     = 'https://api.anthropic.com/v1/messages';
var AI_MODEL        = 'claude-sonnet-4-6';
var AI_MAX_TOKENS   = 512;
var AI_KEY_PROPERTY = 'ANTHROPIC_API_KEY';   // Script Property NAME (never the value)
var AI_CATEGORIES   = ['GENERAL', 'ORDER', 'BILLING', 'DELIVERY', 'TECHNICAL', 'COMPLAINT'];
var AI_URGENCIES    = ['LOW', 'MEDIUM', 'HIGH'];
var AI_SUBJECT_MAX  = 80;

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

function _aiSystemPrompt_() {
  return [
    'You are the support-ticket triage assistant for Hass Petroleum, a fuel and',
    'lubricants distributor. A customer will describe a problem in their own words.',
    'Classify it and draft a clean support ticket on their behalf.',
    '',
    'Respond with ONLY a single raw JSON object — no prose before or after it, and',
    'no markdown code fences. The object must contain exactly these four keys:',
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
 *   → { success:true,  draft:{category,urgency,subject,description} }
 *   | { success:false, error:'…' }
 *
 * Calls the Anthropic Messages API and parses the model's reply defensively.
 * A PARSE failure never dead-ends the flow: it falls back to a GENERAL draft
 * that carries the customer's own words as the description. Transport / config
 * failures (missing key, network, non-200) return { success:false } so the
 * client can show a clear message.
 */
function classifyTicket(userText) {
  var text = String(userText == null ? '' : userText).trim();
  if (!text) return { success: false, error: 'Please describe your issue first.' };

  var apiKey = PropertiesService.getScriptProperties().getProperty(AI_KEY_PROPERTY);
  if (!apiKey) {
    return {
      success: false,
      error: 'AI triage is not configured yet. An administrator needs to set the ' +
             AI_KEY_PROPERTY + ' script property.'
    };
  }

  var payload = {
    model:      AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    system:     _aiSystemPrompt_(),
    messages:   [{ role: 'user', content: text }]
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch(AI_ENDPOINT, {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      payload:            JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    _aiLog_('classifyTicket', 'fetch failed: ' + e.message);
    return { success: false, error: 'Could not reach the triage service. Please try again.' };
  }

  var code = resp.getResponseCode();
  if (code !== 200) {
    _aiLog_('classifyTicket', 'HTTP ' + code + ': ' + resp.getContentText().substring(0, 300));
    return { success: false, error: 'The triage service is unavailable right now (HTTP ' + code + ').' };
  }

  // Extract the assistant text from the Anthropic Messages response.
  var rawModelText = '';
  try {
    var data = JSON.parse(resp.getContentText());
    (data && data.content ? data.content : []).forEach(function (block) {
      if (block && block.type === 'text' && block.text) rawModelText += block.text;
    });
  } catch (e) {
    rawModelText = '';   // fall through to the GENERAL fallback in _aiParseDraft_
  }

  return { success: true, draft: _aiParseDraft_(rawModelText, text) };
}

// ════════════════════════════════════════════════════════════════════════════
// DEFENSIVE DRAFT PARSING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Turn the model's raw reply into a validated draft. Strips ```json fences,
 * JSON.parses inside a try/catch, and on ANY failure returns a GENERAL draft
 * whose description is the customer's original words — so the flow never
 * dead-ends. Each field is range-checked against the allowed enums / limits.
 */
function _aiParseDraft_(rawModelText, originalText) {
  var fallback = {
    category:    'GENERAL',
    urgency:     'MEDIUM',
    subject:     _aiDeriveSubject_(originalText),
    description: originalText
  };

  var cleaned = String(rawModelText == null ? '' : rawModelText).trim();
  if (!cleaned) return fallback;

  // Strip a wrapping markdown code fence (```json … ```), if the model added one.
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
    return fallback;            // parse failed → GENERAL fallback, never dead-end
  }
  if (!obj || typeof obj !== 'object') return fallback;

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
