/**
 * 40_svc_oracle.gs  -  Hass CMS  (Oracle customer integration: admin actions)
 *
 * Dispatcher actions for the user-friendly Oracle integration. All gated by
 * 'order.manage' (the admin permission used by the other integration/config
 * screens). Connection + column mapping are configured here; secrets go to
 * Script Properties via the connector and are never returned to the client.
 *
 *   oracle.getConfig        -> stored connection + mapping (no secret) + status
 *   oracle.saveConfig       -> persist connection + mapping (+ optional secret)
 *   oracle.testConnection   -> test the endpoint, return success or exact error
 *   oracle.syncNow          -> pull customers into the read-only mirror now
 *
 * The scheduled pull is runOracleCustomerSync() in 50_jobs.gs (trigger set).
 */

// Build a clean config object from client input over the current config. Only
// known, non-secret fields are accepted; server-managed sync result fields and
// any secret are ignored, so the client can never write a secret into the row.
function _oracleMergeConfig_(cur, incoming) {
  incoming = incoming || {};
  cur = cur || {};
  function s(v, d) { return (v !== undefined && v !== null) ? String(v) : (d || ''); }
  var curCust = cur.customers || {};
  var inCust  = incoming.customers || {};
  var curF = curCust.fields || {};
  var inF  = inCust.fields || {};
  var FIELD_KEYS = ['customer_id', 'account_number', 'name', 'credit_limit', 'balance', 'on_hold', 'currency_code'];
  var fields = {};
  FIELD_KEYS.forEach(function (k) {
    fields[k] = (inF[k] !== undefined) ? s(inF[k]) : s(curF[k]);
  });
  return {
    enabled:        (incoming.enabled !== undefined) ? !!incoming.enabled : !!cur.enabled,
    source_type:    s(incoming.source_type, cur.source_type),
    base_url:       s(incoming.base_url, cur.base_url).replace(/\s+$/, ''),
    auth_type:      s(incoming.auth_type, cur.auth_type || 'none') || 'none',
    username:       s(incoming.username, cur.username),
    api_key_header: s(incoming.api_key_header, cur.api_key_header || 'apikey') || 'apikey',
    schedule:       s(incoming.schedule, cur.schedule || 'manual') || 'manual',
    customers: {
      object: s(inCust.object, curCust.object),
      fields: fields,
      on_hold_true_values: s(inCust.on_hold_true_values, curCust.on_hold_true_values)
    },
    // Preserve server-managed last-sync fields (never client-controlled).
    last_sync_at:     cur.last_sync_at || '',
    last_sync_count:  cur.last_sync_count || 0,
    last_sync_status: cur.last_sync_status || '',
    last_sync_error:  cur.last_sync_error || ''
  };
}

function _oracleGetConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  // getConfig() already strips any secret; status() carries has_secret as a flag.
  return { config: OracleCustomers.getConfig(), status: OracleCustomers.status() };
}

function _oracleSaveConfig_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var incoming = (params && params.config) ? params.config : params || {};
  var next = _oracleMergeConfig_(OracleCustomers.getConfig(), incoming);
  // secret: undefined or '' leaves the stored secret untouched; a value updates it.
  var secret = (params && params.secret !== undefined) ? String(params.secret) : undefined;
  OracleCustomers.saveConfig(next, secret);
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_CUSTOMER_CONFIG_SAVE',
    entity: 'integration_config', entityId: OracleCustomers.CONFIG_KEY,
    metadata: {
      enabled: next.enabled, base_url: next.base_url, auth_type: next.auth_type,
      schedule: next.schedule, object: next.customers.object,
      secret_changed: (secret !== undefined && secret !== '')
    }
  });
  return { config: OracleCustomers.getConfig(), status: OracleCustomers.status() };
}

function _oracleTestConnection_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var draft = (params && params.config)
    ? _oracleMergeConfig_(OracleCustomers.getConfig(), params.config)
    : OracleCustomers.getConfig();
  // Use a freshly typed secret if supplied; otherwise the connector falls back
  // to the stored secret.
  var secret = (params && params.secret !== undefined && params.secret !== '') ? String(params.secret) : undefined;
  var res = OracleCustomers.testConnection(draft, secret);
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_CUSTOMER_TEST',
    entity: 'integration_config', entityId: OracleCustomers.CONFIG_KEY,
    metadata: { ok: !!res.ok, status: res.status }
  });
  return res;
}

function _oracleSyncNow_(ctx, params) {
  Rbac.requirePermission(ctx.session, 'order.manage');
  var res = OracleCustomers.syncNow(ctx.session.userId);
  Audit.log({
    actor: ctx.session.userId, action: 'ORACLE_CUSTOMER_SYNC',
    entity: 'oracle_customers', entityId: (res && res.batch_id) || 'manual',
    metadata: { connected: !!(res && res.connected), count: (res && res.count) || 0, status: (res && res.status) || '' }
  });
  return res;
}

(function _registerOracle_() {
  register({ service: 'oracle', action: 'getConfig',      permission: 'order.manage', handler: _oracleGetConfig_ });
  register({ service: 'oracle', action: 'saveConfig',     permission: 'order.manage', handler: _oracleSaveConfig_ });
  register({ service: 'oracle', action: 'testConnection', permission: 'order.manage', handler: _oracleTestConnection_ });
  register({ service: 'oracle', action: 'syncNow',        permission: 'order.manage', handler: _oracleSyncNow_ });
})();
