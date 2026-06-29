/**
 * 40_svc_intake.gs  -  Hass CMS  (intake channel admin actions)
 *
 * Config actions for both inbound channels, all gated 'order.manage' and audited.
 * Secrets are write-only (sent in, never returned). Tickets are created only by
 * the shared Intake pipeline; these actions just configure and trigger it.
 *
 *   emailIntake.getConfig / saveConfig / connect / scanNow
 *   whatsappIntake.getConfig / saveConfig / testWebhook
 *
 * The scheduled email scan is runEmailIntakeScan() in 50_jobs.gs; the WhatsApp
 * webhook is the doPost hook=whatsapp branch in 30_router.gs.
 */

// ── Email intake ─────────────────────────────────────────────────────────────
function _emailIntakeMerge_(cur, incoming) {
  cur = cur || {}; incoming = incoming || {};
  function s(v, d) { return (v !== undefined && v !== null) ? String(v) : (d || ''); }
  function n(v, d) { var x = parseInt(v, 10); return isNaN(x) ? d : x; }
  var rules = Array.isArray(incoming.keyword_rules) ? incoming.keyword_rules
    .map(function (r) { return { keyword: s(r && r.keyword), priority: s(r && r.priority).toUpperCase() }; })
    .filter(function (r) { return r.keyword; }) : (cur.keyword_rules || []);
  return {
    enabled: (incoming.enabled !== undefined) ? !!incoming.enabled : !!cur.enabled,
    mailbox: s(incoming.mailbox, cur.mailbox),
    folder: s(incoming.folder, cur.folder || 'inbox') || 'inbox',
    frequency_minutes: Math.max(5, Math.min(1440, n(incoming.frequency_minutes, cur.frequency_minutes || 15))),
    notify_email: s(incoming.notify_email, cur.notify_email),
    use_llm: (incoming.use_llm !== undefined) ? !!incoming.use_llm : !!cur.use_llm,
    keyword_rules: rules,
    default_customer_id: s(incoming.default_customer_id, cur.default_customer_id),
    // server-managed fields preserved
    checkpoint: cur.checkpoint || '', last_scan_at: cur.last_scan_at || '',
    last_scan_count: cur.last_scan_count || 0, last_scan_status: cur.last_scan_status || '',
    last_scan_error: cur.last_scan_error || ''
  };
}

function _emailIntakeGetConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  return { config: EmailIntake.getConfig(), status: EmailIntake.status(), consent_url: EmailIntake.consentUrl() };
}
function _emailIntakeSaveConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var incoming = (params && params.config) ? params.config : (params || {});
  var next = _emailIntakeMerge_(EmailIntake.getConfig(), incoming);
  EmailIntake.saveConfig(next);
  Audit.log({ actor: ctx.session.userId, action: 'EMAIL_INTAKE_CONFIG_SAVE', entity: 'integration_config',
    entityId: EmailIntake.CONFIG_KEY, metadata: { enabled: next.enabled, mailbox: next.mailbox, folder: next.folder, frequency_minutes: next.frequency_minutes } });
  return { config: EmailIntake.getConfig(), status: EmailIntake.status() };
}
function _emailIntakeConnect_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var test = EmailIntake.testAccess(EmailIntake.getConfig());
  Audit.log({ actor: ctx.session.userId, action: 'EMAIL_INTAKE_CONNECT', entity: 'integration_config',
    entityId: EmailIntake.CONFIG_KEY, metadata: { ok: !!test.ok, status: test.status } });
  return { consent_url: EmailIntake.consentUrl(), test: test, status: EmailIntake.status() };
}
function _emailIntakeScanNow_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var res = EmailIntake.scanNow(ctx.session.userId);
  Audit.log({ actor: ctx.session.userId, action: 'EMAIL_INTAKE_SCAN', entity: 'tickets',
    entityId: 'email_intake', metadata: { ran: !!res.ran, created: res.count || 0, connected: !!res.connected } });
  return { result: res, status: EmailIntake.status() };
}

// ── WhatsApp intake ──────────────────────────────────────────────────────────
function _whatsappIntakeMerge_(cur, incoming) {
  cur = cur || {}; incoming = incoming || {};
  function s(v, d) { return (v !== undefined && v !== null) ? String(v) : (d || ''); }
  var rules = Array.isArray(incoming.keyword_rules) ? incoming.keyword_rules
    .map(function (r) { return { keyword: s(r && r.keyword), priority: s(r && r.priority).toUpperCase() }; })
    .filter(function (r) { return r.keyword; }) : (cur.keyword_rules || []);
  return {
    enabled: (incoming.enabled !== undefined) ? !!incoming.enabled : !!cur.enabled,
    provider: s(incoming.provider, cur.provider || 'META') || 'META',
    business_number: s(incoming.business_number, cur.business_number),
    phone_number_id: s(incoming.phone_number_id, cur.phone_number_id),
    notify_email: s(incoming.notify_email, cur.notify_email),
    use_llm: (incoming.use_llm !== undefined) ? !!incoming.use_llm : !!cur.use_llm,
    keyword_rules: rules,
    default_customer_id: s(incoming.default_customer_id, cur.default_customer_id),
    last_event_at: cur.last_event_at || '', last_event_count: cur.last_event_count || 0
  };
}

function _whatsappIntakeGetConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  return { config: WhatsappIntake.getConfig(), status: WhatsappIntake.status() };
}
function _whatsappIntakeSaveConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var incoming = (params && params.config) ? params.config : (params || {});
  var next = _whatsappIntakeMerge_(WhatsappIntake.getConfig(), incoming);
  var secrets = {
    verify_token:   (params && params.verify_token   !== undefined) ? String(params.verify_token)   : undefined,
    webhook_secret: (params && params.webhook_secret !== undefined) ? String(params.webhook_secret) : undefined,
    access_token:   (params && params.access_token   !== undefined) ? String(params.access_token)   : undefined
  };
  WhatsappIntake.saveConfig(next, secrets);
  Audit.log({ actor: ctx.session.userId, action: 'WHATSAPP_INTAKE_CONFIG_SAVE', entity: 'integration_config',
    entityId: WhatsappIntake.CONFIG_KEY, metadata: { enabled: next.enabled, phone_number_id: next.phone_number_id,
      verify_token_changed: (secrets.verify_token !== undefined && secrets.verify_token !== ''),
      webhook_secret_changed: (secrets.webhook_secret !== undefined && secrets.webhook_secret !== '') } });
  return { config: WhatsappIntake.getConfig(), status: WhatsappIntake.status() };
}
function _whatsappIntakeTestWebhook_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  return WhatsappIntake.testWebhook();
}

(function _registerIntake_() {
  register({ service: 'emailIntake',    action: 'getConfig',   permission: 'order.manage', handler: _emailIntakeGetConfig_ });
  register({ service: 'emailIntake',    action: 'saveConfig',  permission: 'order.manage', handler: _emailIntakeSaveConfig_ });
  register({ service: 'emailIntake',    action: 'connect',     permission: 'order.manage', handler: _emailIntakeConnect_ });
  register({ service: 'emailIntake',    action: 'scanNow',     permission: 'order.manage', handler: _emailIntakeScanNow_ });
  register({ service: 'whatsappIntake', action: 'getConfig',   permission: 'order.manage', handler: _whatsappIntakeGetConfig_ });
  register({ service: 'whatsappIntake', action: 'saveConfig',  permission: 'order.manage', handler: _whatsappIntakeSaveConfig_ });
  register({ service: 'whatsappIntake', action: 'testWebhook', permission: 'order.manage', handler: _whatsappIntakeTestWebhook_ });
})();
