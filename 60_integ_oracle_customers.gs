/**
 * 60_integ_oracle_customers.gs  -  Hass CMS  (Oracle customer master integration)
 *
 * Pulls customer master data from Oracle (credit limit, balance/exposure,
 * on-hold status) into a READ-ONLY local mirror (oracle_customers), keyed by the
 * mapped Oracle customer identifier and tagged source = 'ORACLE'. The app never
 * writes back to Oracle; the only writer of the mirror is this sync.
 *
 * Reachability (stated honestly): Apps Script runs in Google's cloud, so it can
 * only reach Oracle if Oracle exposes a network-reachable HTTP endpoint, e.g.
 * Oracle REST Data Services (ORDS) or another REST gateway, with credentials. If
 * Oracle EBS sits on-premise behind a firewall, point base_url at an exposed
 * endpoint or a small on-network bridge that forwards queries. The ONE pluggable
 * function is fetchEntity(); swap its body for a bridge without touching the
 * rest. When no endpoint is configured the integration reports "not connected"
 * and never fabricates data.
 *
 * Config (connection + mapping) lives in the config table (Config.*); the single
 * secret (token / password / api key) lives in Script Properties, never in the
 * config row.
 *
 * Public:
 *   OracleCustomers.getConfig()                  -> stored config (no secret)
 *   OracleCustomers.saveConfig(cfg, secret)      -> persist; secret to Script Props
 *   OracleCustomers.hasSecret()                  -> boolean
 *   OracleCustomers.isConfigured()               -> enough to attempt a pull
 *   OracleCustomers.status()                     -> connection + last sync + counts
 *   OracleCustomers.testConnection(cfg, secret)  -> { ok, status, message, columns, sample }
 *   OracleCustomers.fetchEntity(key, cfg, secret)-> Array<rawRow>   (THE pluggable point)
 *   OracleCustomers.syncNow(actor)               -> { connected, count, ... }
 *   OracleCustomers.scheduledSync(actor)         -> sync only if enabled and due
 *   OracleCustomers.forCustomer(customerRow)     -> mirror row | null  (read-only)
 *   OracleCustomers.mirrorCount()                -> integer
 */

var OracleCustomers = (function () {

  var CONFIG_KEY = 'ORACLE_CUSTOMER_INTEGRATION';   // config table key (non-secret)
  var SECRET_KEY = 'ORACLE_CUSTOMER_SECRET';        // Script Property key (secret)
  var T_MIRROR   = 'oracle_customers';
  var MAX_ROWS   = 20000;   // safety cap per sync
  var PAGE_SIZE  = 500;     // ORDS-style pagination page size
  var MAX_PAGES  = 60;
  var HTTP_TIMEOUT_NOTE = '';

  // ── Defaults / shape ────────────────────────────────────────────────────────
  function _defaults_() {
    return {
      enabled:     false,
      source_type: '',                 // informational: 'ORDS' | 'REST' | 'BRIDGE'
      base_url:    '',                 // base URL / endpoint
      auth_type:   'none',             // 'none' | 'token' | 'basic' | 'apikey'
      username:    '',                 // for basic auth
      api_key_header: 'apikey',        // header name for apikey auth
      schedule:    'manual',           // 'manual' | 'hourly' | 'daily'
      customers: {
        object: '',                    // Oracle table/view/endpoint path for customers
        fields: {                      // mapping: app field -> source column (no hard-coded names)
          customer_id:    '',
          account_number: '',
          name:           '',
          credit_limit:   '',
          balance:        '',
          on_hold:        '',
          currency_code:  ''
        },
        on_hold_true_values: 'Y,YES,TRUE,1,HOLD,ON HOLD,ON_HOLD'
      },
      last_sync_at:     '',
      last_sync_count:  0,
      last_sync_status: '',
      last_sync_error:  ''
    };
  }

  // Merge of stored config over defaults so new keys always exist. Builds fresh
  // objects (never aliases the stored nested objects) so reads stay correct.
  function getConfig() {
    var stored = {};
    try { stored = Config.getJson(CONFIG_KEY, {}) || {}; } catch (_) {}
    var d = _defaults_();
    var c = {};
    Object.keys(d).forEach(function (k) {
      if (k === 'customers') return;   // nested mapping built separately below
      c[k] = (stored[k] !== undefined) ? stored[k] : d[k];
    });
    // Nested customers mapping: capture stored values first, then build fresh.
    var dc = d.customers, sc = stored.customers || {}, scFields = sc.fields || {};
    c.customers = {
      object: (sc.object !== undefined) ? sc.object : dc.object,
      on_hold_true_values: (sc.on_hold_true_values !== undefined && sc.on_hold_true_values !== '')
        ? sc.on_hold_true_values : dc.on_hold_true_values,
      fields: {}
    };
    Object.keys(dc.fields).forEach(function (f) {
      c.customers.fields[f] = (scFields[f] !== undefined) ? scFields[f] : '';
    });
    // A secret must NEVER live in the config row. Strip if a legacy row carried one.
    delete c.secret; delete c.password; delete c.token; delete c.api_key;
    return c;
  }

  function _secret_() {
    try { return PropertiesService.getScriptProperties().getProperty(SECRET_KEY) || ''; } catch (_) { return ''; }
  }
  function hasSecret() { return !!_secret_(); }

  function saveConfig(cfg, secret) {
    cfg = cfg || {};
    // Defensive: never persist a secret into the config row.
    delete cfg.secret; delete cfg.password; delete cfg.token; delete cfg.api_key;
    try { Config.set(CONFIG_KEY, jsonStringify(cfg)); }
    catch (e) { throw new Errors.Integration('Could not save Oracle settings: ' + e.message); }
    // Only touch the secret when a non-empty new value is supplied; '' leaves it.
    if (secret !== undefined && secret !== null && String(secret) !== '') {
      try { PropertiesService.getScriptProperties().setProperty(SECRET_KEY, String(secret)); }
      catch (e) { throw new Errors.Integration('Could not save Oracle secret: ' + e.message); }
    }
    return getConfig();
  }

  function clearSecret() {
    try { PropertiesService.getScriptProperties().deleteProperty(SECRET_KEY); } catch (_) {}
  }

  // "Configured" = enough to attempt a pull: enabled, an endpoint, a mapped
  // source object, and at least the identifier column mapped.
  function isConfigured() {
    var c = getConfig();
    return !!(c.enabled && c.base_url && c.customers && c.customers.object &&
              c.customers.fields && c.customers.fields.customer_id);
  }

  // ── HTTP plumbing ───────────────────────────────────────────────────────────
  function _join_(base, path) {
    var b = String(base || '').replace(/\/+$/, '');
    var p = String(path || '').replace(/^\/+/, '');
    return p ? (b + '/' + p) : b;
  }
  function _authHeaders_(cfg, secret) {
    var h = { 'Accept': 'application/json' };
    var t = String(cfg.auth_type || 'none');
    if (t === 'token') {
      if (secret) h['Authorization'] = 'Bearer ' + secret;
    } else if (t === 'basic') {
      var raw = String(cfg.username || '') + ':' + String(secret || '');
      h['Authorization'] = 'Basic ' + Utilities.base64Encode(raw);
    } else if (t === 'apikey') {
      var name = String(cfg.api_key_header || 'apikey') || 'apikey';
      if (secret) h[name] = secret;
    }
    return h;
  }
  // Pull rows from one ORDS/REST response body. Accepts {items:[...]} (ORDS) or a
  // bare array; returns { rows:[...], hasMore:boolean }.
  function _rowsFromBody_(text) {
    var body = jsonParse(text, null);
    if (Array.isArray(body)) return { rows: body, hasMore: false };
    if (body && Array.isArray(body.items)) return { rows: body.items, hasMore: !!body.hasMore };
    if (body && Array.isArray(body.rows)) return { rows: body.rows, hasMore: !!body.hasMore };
    if (body && Array.isArray(body.value)) return { rows: body.value, hasMore: !!(body['@odata.nextLink']) };
    if (body && typeof body === 'object') return { rows: [body], hasMore: false };
    return { rows: [], hasMore: false };
  }

  /**
   * fetchEntity(entityKey, cfg, secret) -> Array<rawRow>
   *
   * THE SINGLE PLUGGABLE POINT. It performs a real HTTP GET against the mapped
   * Oracle object using ORDS-style pagination and returns the raw source rows.
   * To use an on-network bridge instead of ORDS, replace ONLY this function's
   * body (keep the signature and the "not connected" honesty); nothing else in
   * the app changes. It NEVER fabricates data: with no endpoint it throws.
   */
  function fetchEntity(entityKey, cfg, secret) {
    cfg = cfg || getConfig();
    if (secret === undefined) secret = _secret_();
    if (!cfg.base_url) {
      throw new Errors.Integration(
        'Oracle is not connected. No endpoint is configured. Set the base URL (an ORDS or REST ' +
        'gateway, or an on-network bridge) in Settings > Oracle integration. Apps Script cannot ' +
        'reach an on-premise Oracle EBS directly.'
      );
    }
    var ent = cfg[entityKey] || {};
    if (!ent.object) throw new Errors.Integration('No source table or view is mapped for ' + entityKey + '.');

    var headers = _authHeaders_(cfg, secret);
    var url0 = _join_(cfg.base_url, ent.object);
    var out = [];
    var offset = 0;
    for (var page = 0; page < MAX_PAGES && out.length < MAX_ROWS; page++) {
      var sep = url0.indexOf('?') === -1 ? '?' : '&';
      var url = url0 + sep + 'limit=' + PAGE_SIZE + '&offset=' + offset;
      var resp = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true });
      var code = resp.getResponseCode();
      var text = resp.getContentText();
      if (code < 200 || code >= 300) {
        throw new Errors.Integration('Oracle request failed: HTTP ' + code + ' ' + String(text || '').substring(0, 300));
      }
      var parsed = _rowsFromBody_(text);
      out = out.concat(parsed.rows || []);
      if (!parsed.hasMore || !(parsed.rows && parsed.rows.length)) break;
      offset += PAGE_SIZE;
    }
    return out.slice(0, MAX_ROWS);
  }

  /**
   * testConnection: attempt a single small fetch and report success or the exact
   * error. On success it also returns the columns it could see on the first row
   * (so the mapping UI can offer a pick list) and a redacted sample.
   */
  function testConnection(cfg, secret) {
    cfg = cfg || getConfig();
    if (secret === undefined || secret === '') secret = _secret_();
    if (!cfg.base_url) {
      return { ok: false, status: 0, message: 'Not connected: no endpoint configured.', columns: [], sample: null };
    }
    var ent = cfg.customers || {};
    if (!ent.object) {
      return { ok: false, status: 0, message: 'Enter the Oracle customers table or view name first.', columns: [], sample: null };
    }
    try {
      var headers = _authHeaders_(cfg, secret);
      var sep = _join_(cfg.base_url, ent.object).indexOf('?') === -1 ? '?' : '&';
      var url = _join_(cfg.base_url, ent.object) + sep + 'limit=1&offset=0';
      var resp = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true });
      var code = resp.getResponseCode();
      var text = resp.getContentText();
      if (code < 200 || code >= 300) {
        return { ok: false, status: code, message: 'HTTP ' + code + ': ' + String(text || '').substring(0, 300), columns: [], sample: null };
      }
      var parsed = _rowsFromBody_(text);
      var first = (parsed.rows && parsed.rows[0]) || null;
      var columns = first && typeof first === 'object' ? Object.keys(first) : [];
      return {
        ok: true, status: code,
        message: 'Connected. ' + (columns.length ? ('Saw ' + columns.length + ' source columns.') : 'No rows returned, but the endpoint responded.'),
        columns: columns,
        sample: first ? _redactSample_(first) : null
      };
    } catch (e) {
      return { ok: false, status: 0, message: String(e && e.message ? e.message : e), columns: [], sample: null };
    }
  }
  // Shorten long values in the sample so the UI preview stays small and never
  // shows an entire record.
  function _redactSample_(row) {
    var out = {};
    Object.keys(row).slice(0, 30).forEach(function (k) {
      var v = row[k];
      out[k] = (v == null) ? null : String(v).substring(0, 40);
    });
    return out;
  }

  // ── Mapping + mirror upsert ─────────────────────────────────────────────────
  function _ensureMirror_() {
    try {
      TursoClient.write(
        'CREATE TABLE IF NOT EXISTS ' + T_MIRROR + ' (' +
        'oracle_customer_id TEXT PRIMARY KEY, account_number TEXT, name TEXT, ' +
        'credit_limit REAL, balance REAL, on_hold INTEGER DEFAULT 0, hold_status TEXT, ' +
        'currency_code TEXT, source TEXT DEFAULT \'ORACLE\', raw_json TEXT, synced_at TEXT, sync_batch_id TEXT)', []
      );
      try { TursoClient.write('CREATE INDEX IF NOT EXISTS idx_oracle_customers_account ON ' + T_MIRROR + '(account_number)', []); } catch (_) {}
    } catch (e) {
      throw new Errors.Integration('Could not prepare the Oracle mirror table: ' + e.message);
    }
  }

  function _num_(v) { if (v == null || v === '') return null; var n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }
  function _str_(v) { return v == null ? '' : String(v).trim(); }

  // Interpret the mapped on-hold value against the admin's "true" list.
  function _holdFlag_(raw, trueValues) {
    if (raw == null || raw === '') return 0;
    var s = String(raw).trim().toUpperCase();
    var list = String(trueValues || '').split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean);
    if (!list.length) list = ['Y', 'YES', 'TRUE', '1', 'HOLD', 'ON HOLD', 'ON_HOLD'];
    return list.indexOf(s) !== -1 ? 1 : 0;
  }

  function _mapRow_(raw, mapping) {
    var f = mapping.fields || {};
    function pick(field) { var col = f[field]; return (col && raw[col] !== undefined) ? raw[col] : null; }
    var id = _str_(pick('customer_id'));
    if (!id) return null;   // no identifier -> cannot key the mirror
    var holdRaw = pick('on_hold');
    return {
      oracle_customer_id: id,
      account_number:     _str_(pick('account_number')) || id,   // default to the id when unmapped
      name:               _str_(pick('name')),
      credit_limit:       _num_(pick('credit_limit')),
      balance:            _num_(pick('balance')),
      on_hold:            _holdFlag_(holdRaw, mapping.on_hold_true_values),
      hold_status:        holdRaw == null ? '' : String(holdRaw),
      currency_code:      _str_(pick('currency_code')),
      raw_json:           jsonStringify(raw)
    };
  }

  function _upsert_(rows, batchId) {
    if (!rows.length) return 0;
    var now = nowIso();
    var stmts = rows.map(function (m) {
      return {
        sql: 'INSERT INTO ' + T_MIRROR + ' (oracle_customer_id, account_number, name, credit_limit, balance, ' +
             'on_hold, hold_status, currency_code, source, raw_json, synced_at, sync_batch_id) ' +
             'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ' +
             'ON CONFLICT(oracle_customer_id) DO UPDATE SET account_number=excluded.account_number, ' +
             'name=excluded.name, credit_limit=excluded.credit_limit, balance=excluded.balance, ' +
             'on_hold=excluded.on_hold, hold_status=excluded.hold_status, currency_code=excluded.currency_code, ' +
             'source=excluded.source, raw_json=excluded.raw_json, synced_at=excluded.synced_at, ' +
             'sync_batch_id=excluded.sync_batch_id',
        args: [m.oracle_customer_id, m.account_number, m.name, m.credit_limit, m.balance,
               m.on_hold, m.hold_status, m.currency_code, 'ORACLE', m.raw_json, now, batchId]
      };
    });
    // Write in chunks so a large pull does not exceed one Turso batch.
    var FLUSH = 80, written = 0;
    for (var i = 0; i < stmts.length; i += FLUSH) {
      TursoClient.batch(stmts.slice(i, i + FLUSH));
      written += Math.min(FLUSH, stmts.length - i);
    }
    return written;
  }

  function _logInteg_(action, status, reqSummary, respSummary, err) {
    try {
      TursoClient.write(
        'INSERT INTO integration_log (log_id,integration,action,status,request_summary,response_summary,error_message,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [Utilities.getUuid(), 'oracle_customers', action, status,
         String(reqSummary || '').substring(0, 500), String(respSummary || '').substring(0, 500),
         (err || null), nowIso()]
      );
    } catch (_) {}
  }

  // ── Sync ──────────────────────────────────────────────────────────────────
  function syncNow(actor) {
    var cfg = getConfig();
    if (!isConfigured()) {
      _logInteg_('sync', 'SKIPPED', '', '', 'not connected / not enabled');
      return { connected: false, ok: false, count: 0, message: 'Not connected. Configure and enable the Oracle integration first.' };
    }
    _ensureMirror_();
    var batchId = genId('ORCUST');
    var raws;
    try {
      raws = fetchEntity('customers', cfg, _secret_());
    } catch (e) {
      var msg = String(e && e.message ? e.message : e);
      _logInteg_('sync', 'FAILED', cfg.customers.object, '', msg);
      _saveSyncResult_(cfg, 'FAILED', 0, msg);
      throw new Errors.Integration(msg);
    }
    var mapped = [];
    (raws || []).forEach(function (r) { var m = _mapRow_(r, cfg.customers); if (m) mapped.push(m); });
    var written = _upsert_(mapped, batchId);
    _logInteg_('sync', 'SUCCESS', cfg.customers.object, 'fetched=' + (raws ? raws.length : 0) + ' upserted=' + written, null);
    _saveSyncResult_(cfg, 'SUCCESS', written, '');
    return {
      connected: true, ok: true, count: written, fetched: (raws ? raws.length : 0),
      last_sync_at: nowIso(), status: 'SUCCESS', batch_id: batchId
    };
  }

  function _saveSyncResult_(cfg, status, count, err) {
    try {
      cfg.last_sync_at = nowIso();
      cfg.last_sync_status = status;
      if (status === 'SUCCESS') { cfg.last_sync_count = count; cfg.last_sync_error = ''; }
      else { cfg.last_sync_error = String(err || '').substring(0, 300); }
      Config.set(CONFIG_KEY, jsonStringify(cfg));
    } catch (_) {}
  }

  // Scheduled entry: only sync when enabled AND the configured cadence is due.
  function scheduledSync(actor) {
    var cfg = getConfig();
    if (!cfg.enabled || !isConfigured()) return { connected: false, ran: false };
    var sched = String(cfg.schedule || 'manual');
    if (sched === 'manual') return { connected: true, ran: false, reason: 'manual' };
    var lastMs = cfg.last_sync_at ? Date.parse(cfg.last_sync_at) : 0;
    var ageMin = lastMs ? (Date.now() - lastMs) / 60000 : Infinity;
    var dueMin = (sched === 'daily') ? (20 * 60) : 50;   // daily ~ once/day; hourly ~ once/hour
    if (ageMin < dueMin) return { connected: true, ran: false, reason: 'not due' };
    var res = syncNow(actor || 'SYSTEM');
    res.ran = true;
    return res;
  }

  // ── Read-only surface for the customer screen ───────────────────────────────
  function mirrorCount() {
    try {
      var r = TursoClient.select('SELECT COUNT(*) AS n FROM ' + T_MIRROR, []);
      return (r.length && r[0].n != null) ? (parseInt(r[0].n, 10) || 0) : 0;
    } catch (_) { return 0; }   // table may not exist yet
  }

  // Find the mirror row for a local customer. The Oracle customer identifier is
  // matched against the local account_number (the shared business key); the
  // mirror also stores account_number for a direct match. Read-only; never
  // mutated by the app.
  function forCustomer(customerRow) {
    if (!customerRow) return null;
    var acct = _str_(customerRow.account_number);
    if (!acct) return null;
    try {
      var rows = TursoClient.select(
        'SELECT oracle_customer_id, account_number, name, credit_limit, balance, on_hold, hold_status, currency_code, synced_at ' +
        'FROM ' + T_MIRROR + ' WHERE oracle_customer_id = ? OR account_number = ? LIMIT 1', [acct, acct]);
      if (!rows.length) return null;
      var m = rows[0];
      return {
        oracle_customer_id: m.oracle_customer_id,
        name:          m.name || '',
        credit_limit:  m.credit_limit == null ? null : Number(m.credit_limit),
        balance:       m.balance == null ? null : Number(m.balance),
        on_hold:       (parseInt(m.on_hold, 10) === 1),
        hold_status:   m.hold_status || '',
        currency_code: m.currency_code || '',
        synced_at:     m.synced_at || '',
        source:        'ORACLE',
        read_only:     true
      };
    } catch (_) { return null; }   // mirror not present -> simply no Oracle data
  }

  // Connection + last-sync + counts, for the settings panel.
  function status() {
    var c = getConfig();
    return {
      enabled:          !!c.enabled,
      connected:        isConfigured(),
      has_secret:       hasSecret(),
      base_url:         c.base_url || '',
      source_type:      c.source_type || '',
      auth_type:        c.auth_type || 'none',
      schedule:         c.schedule || 'manual',
      last_sync_at:     c.last_sync_at || '',
      last_sync_count:  c.last_sync_count || 0,
      last_sync_status: c.last_sync_status || '',
      last_sync_error:  c.last_sync_error || '',
      mirror_count:     mirrorCount()
    };
  }

  return {
    CONFIG_KEY: CONFIG_KEY, SECRET_KEY: SECRET_KEY,
    getConfig: getConfig, saveConfig: saveConfig, hasSecret: hasSecret, clearSecret: clearSecret,
    isConfigured: isConfigured, status: status, testConnection: testConnection,
    fetchEntity: fetchEntity, syncNow: syncNow, scheduledSync: scheduledSync,
    forCustomer: forCustomer, mirrorCount: mirrorCount
  };
})();
