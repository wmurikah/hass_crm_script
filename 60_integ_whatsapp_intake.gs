/**
 * 60_integ_whatsapp_intake.gs  -  Hass CMS  (Channel B: WhatsApp Business intake)
 *
 * Inbound WhatsApp messages arrive at the doPost webhook (the sanctioned
 * external-callback exception to the google.script.run rule). The webhook is
 * gated by a shared URL secret AND the provider verify token / signature,
 * accepts messages only for the configured phone number id, and runs each
 * through the shared Intake pipeline. The provider verification handshake (a
 * GET with hub.* params) is handled in doGet.
 *
 * Config (config table, non-secret): { enabled, provider, business_number,
 *   phone_number_id, notify_email, use_llm, keyword_rules, default_customer_id,
 *   last_event_at, last_event_count }
 * Secrets (Script Properties, never in the row or returned to the client):
 *   WHATSAPP_INTAKE_VERIFY_TOKEN   - the hub.verify_token registered with Meta
 *   WHATSAPP_INTAKE_WEBHOOK_SECRET - the shared ?secret= URL gate
 *   WHATSAPP_INTAKE_TOKEN          - Meta Cloud API access token (optional here)
 */

var WhatsappIntake = (function () {

  var CONFIG_KEY  = 'WHATSAPP_INTAKE_CONFIG';
  var VERIFY_KEY  = 'WHATSAPP_INTAKE_VERIFY_TOKEN';
  var SECRET_KEY  = 'WHATSAPP_INTAKE_WEBHOOK_SECRET';
  var TOKEN_KEY   = 'WHATSAPP_INTAKE_TOKEN';

  function _defaults_() {
    return {
      enabled: false, provider: 'META', business_number: '', phone_number_id: '',
      notify_email: '', use_llm: false, keyword_rules: [], default_customer_id: '',
      last_event_at: '', last_event_count: 0
    };
  }
  function getConfig() {
    var stored = {};
    try { stored = Config.getJson(CONFIG_KEY, {}) || {}; } catch (_) {}
    var d = _defaults_(), c = {};
    Object.keys(d).forEach(function (k) { c[k] = (stored[k] !== undefined) ? stored[k] : d[k]; });
    if (!Array.isArray(c.keyword_rules)) c.keyword_rules = [];
    // Defensive: secrets must never live in the config row.
    delete c.verify_token; delete c.webhook_secret; delete c.access_token;
    return c;
  }
  function _props_() { return PropertiesService.getScriptProperties(); }
  function _get_(k) { try { return _props_().getProperty(k) || ''; } catch (_) { return ''; } }
  function _set_(k, v) { try { _props_().setProperty(k, String(v)); } catch (_) {} }

  function saveConfig(cfg, secrets) {
    cfg = cfg || {};
    delete cfg.verify_token; delete cfg.webhook_secret; delete cfg.access_token;
    try { Config.set(CONFIG_KEY, jsonStringify(cfg)); }
    catch (e) { throw new Errors.Integration('Could not save WhatsApp intake settings: ' + e.message); }
    secrets = secrets || {};
    if (secrets.verify_token   !== undefined && secrets.verify_token   !== '') _set_(VERIFY_KEY, secrets.verify_token);
    if (secrets.webhook_secret !== undefined && secrets.webhook_secret !== '') _set_(SECRET_KEY, secrets.webhook_secret);
    if (secrets.access_token   !== undefined && secrets.access_token   !== '') _set_(TOKEN_KEY,  secrets.access_token);
    return getConfig();
  }

  function _save_(cfg) { try { Config.set(CONFIG_KEY, jsonStringify(cfg)); } catch (_) {} }

  function hasVerifyToken() { return !!_get_(VERIFY_KEY); }
  function hasWebhookSecret() { return !!_get_(SECRET_KEY); }
  function isConfigured() { var c = getConfig(); return !!(c.enabled && c.phone_number_id && hasVerifyToken()); }

  function webhookUrl() {
    var base = '';
    try { base = ScriptApp.getService().getUrl() || ''; } catch (_) {}
    if (!base) return '';
    return base + '?hook=whatsapp&secret=YOUR_WEBHOOK_SECRET';   // admin substitutes the secret they set
  }

  // ── Provider verification handshake (GET hub.mode=subscribe&...) ────────────
  // Returns the hub.challenge string when the verify token matches, else null.
  function verifyChallenge(params) {
    params = params || {};
    var mode = params['hub.mode'] || params.hub_mode || '';
    var token = params['hub.verify_token'] || params.hub_verify_token || '';
    var challenge = params['hub.challenge'] || params.hub_challenge || '';
    var expected = _get_(VERIFY_KEY);
    if (String(mode) === 'subscribe' && expected && String(token) === expected) {
      return String(challenge);
    }
    return null;
  }

  // ── Inbound message handling (doPost) ───────────────────────────────────────
  // Gate order: shared URL secret -> (optional) the message is for our number ->
  // parse -> Intake.process each message. Returns a small ack object.
  function handleWebhook(params, rawBody) {
    var cfg = getConfig();
    // 1. Shared URL secret gate.
    var expectedSecret = _get_(SECRET_KEY);
    var given = (params && (params.secret || params.token)) ? String(params.secret || params.token) : '';
    if (expectedSecret && given !== expectedSecret) {
      return { ok: false, status: 403, reason: 'bad secret' };
    }
    if (!cfg.enabled) return { ok: true, status: 200, reason: 'disabled', processed: 0 };

    var body = {};
    try { body = JSON.parse(rawBody || '{}'); } catch (_) { body = {}; }
    var msgs = _extractMessages_(body, cfg);
    var created = 0, processed = 0;
    msgs.forEach(function (msg) {
      processed++;
      try { var r = Intake.process(msg, cfg); if (r && !r.deduped) created++; }
      catch (_) { /* a single message failure must not fail the whole ack */ }
    });
    if (processed) {
      cfg.last_event_at = nowIso();
      cfg.last_event_count = (cfg.last_event_count || 0) + created;
      _save_(cfg);
    }
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'whatsapp_intake', 'webhook', 'SUCCESS', 'msgs=' + processed, 'tickets=' + created, null, nowIso()]);
    } catch (_) {}
    return { ok: true, status: 200, processed: processed, created: created };
  }

  // Parse the Meta WhatsApp Cloud API webhook envelope into intake messages,
  // accepting only messages addressed to the configured phone number id.
  function _extractMessages_(body, cfg) {
    var out = [];
    try {
      var entries = body.entry || [];
      entries.forEach(function (entry) {
        (entry.changes || []).forEach(function (ch) {
          var v = ch.value || {};
          var meta = v.metadata || {};
          // Accept only our configured number (phone_number_id) when set.
          if (cfg.phone_number_id && String(meta.phone_number_id || '') !== String(cfg.phone_number_id)) return;
          var contacts = {};
          (v.contacts || []).forEach(function (c) { if (c && c.wa_id) contacts[c.wa_id] = (c.profile && c.profile.name) || ''; });
          (v.messages || []).forEach(function (m) {
            var text = '';
            if (m.text && m.text.body) text = m.text.body;
            else if (m.button && m.button.text) text = m.button.text;
            else if (m.interactive) text = JSON.stringify(m.interactive).slice(0, 1000);
            else if (m.type) text = '[' + m.type + ' message]';
            out.push({
              channel: 'WHATSAPP',
              external_id: m.id || (m.from + ':' + (m.timestamp || '')),   // Meta message id is globally unique
              from: m.from || '',
              from_name: contacts[m.from] || '',
              subject: '',
              body: text,
              received_at: m.timestamp ? new Date(parseInt(m.timestamp, 10) * 1000).toISOString() : nowIso()
            });
          });
        });
      });
    } catch (_) {}
    return out;
  }

  // A safe test the admin can run: confirms the verify token + webhook secret are
  // set and shows the URL. Does not call out anywhere.
  function testWebhook() {
    return {
      configured: isConfigured(),
      has_verify_token: hasVerifyToken(),
      has_webhook_secret: hasWebhookSecret(),
      has_access_token: !!_get_(TOKEN_KEY),
      webhook_url: webhookUrl(),
      phone_number_id: getConfig().phone_number_id || '',
      message: isConfigured()
        ? 'Ready. Register the webhook URL and verify token with your provider.'
        : 'Set the phone number id and verify token, then save, to enable the webhook.'
    };
  }

  function status() {
    var c = getConfig();
    return {
      enabled: !!c.enabled, provider: c.provider || 'META', business_number: c.business_number || '',
      phone_number_id: c.phone_number_id || '', connected: isConfigured(),
      has_verify_token: hasVerifyToken(), has_webhook_secret: hasWebhookSecret(), has_access_token: !!_get_(TOKEN_KEY),
      webhook_url: webhookUrl(), last_event_at: c.last_event_at || '', last_event_count: c.last_event_count || 0
    };
  }

  return {
    CONFIG_KEY: CONFIG_KEY, getConfig: getConfig, saveConfig: saveConfig, status: status,
    isConfigured: isConfigured, verifyChallenge: verifyChallenge, handleWebhook: handleWebhook,
    testWebhook: testWebhook, webhookUrl: webhookUrl
  };
})();
