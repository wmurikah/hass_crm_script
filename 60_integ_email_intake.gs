/**
 * 60_integ_email_intake.gs  -  Hass CMS  (Channel A: Outlook email intake)
 *
 * Periodically scans a support mailbox through Microsoft Graph and turns new
 * messages into tickets via the shared Intake pipeline. It reuses EmailInteg's
 * Microsoft Graph app credentials (the same app that already sends mail); the
 * one-time "sign in" is the Azure admin consent that grants the app Mail.Read,
 * after which the app can read the chosen mailbox. The Connect action returns
 * that consent URL and verifies access.
 *
 * No mailbox WRITE is needed: reprocessing is prevented by a receivedDateTime
 * checkpoint plus the shared (channel, external_id) dedup on the Graph message id.
 *
 * Config (config table): { enabled, mailbox, folder, frequency_minutes,
 *   notify_email, use_llm, keyword_rules, default_customer_id, checkpoint,
 *   last_scan_at, last_scan_count, last_scan_status, last_scan_error }
 * Secrets: reuses the existing GRAPH_* Script Properties (no new secret).
 */

var EmailIntake = (function () {

  var CONFIG_KEY = 'EMAIL_INTAKE_CONFIG';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var MAX_PER_SCAN = 50;

  function _defaults_() {
    return {
      enabled: false, mailbox: '', folder: 'inbox', frequency_minutes: 15,
      notify_email: '', use_llm: false, keyword_rules: [], default_customer_id: '',
      checkpoint: '', last_scan_at: '', last_scan_count: 0, last_scan_status: '', last_scan_error: ''
    };
  }
  function getConfig() {
    var stored = {};
    try { stored = Config.getJson(CONFIG_KEY, {}) || {}; } catch (_) {}
    var d = _defaults_(), c = {};
    Object.keys(d).forEach(function (k) { c[k] = (stored[k] !== undefined) ? stored[k] : d[k]; });
    if (!Array.isArray(c.keyword_rules)) c.keyword_rules = [];
    return c;
  }
  function saveConfig(cfg) {
    try { Config.set(CONFIG_KEY, jsonStringify(cfg || {})); }
    catch (e) { throw new Errors.Integration('Could not save email intake settings: ' + e.message); }
    return getConfig();
  }
  function _save_(cfg) { try { Config.set(CONFIG_KEY, jsonStringify(cfg)); } catch (_) {} }

  function graphConfigured() {
    try {
      var p = PropertiesService.getScriptProperties();
      return !!(p.getProperty('GRAPH_TENANT_ID') && p.getProperty('GRAPH_CLIENT_ID') && p.getProperty('GRAPH_CLIENT_SECRET'));
    } catch (_) { return false; }
  }
  function isConfigured() { var c = getConfig(); return !!(c.enabled && c.mailbox && graphConfigured()); }

  // The Microsoft admin-consent (sign-in) URL for granting the app mailbox read.
  function consentUrl() {
    var p = PropertiesService.getScriptProperties();
    var tenant = p.getProperty('GRAPH_TENANT_ID') || 'common';
    var clientId = p.getProperty('GRAPH_CLIENT_ID') || '';
    if (!clientId) return '';
    var redirect = '';
    try { redirect = ScriptApp.getService().getUrl() || ''; } catch (_) {}
    return 'https://login.microsoftonline.com/' + encodeURIComponent(tenant) + '/adminconsent' +
           '?client_id=' + encodeURIComponent(clientId) +
           (redirect ? ('&redirect_uri=' + encodeURIComponent(redirect)) : '');
  }

  function _folderSegment_(folder) {
    var f = String(folder || 'inbox').trim();
    var WELL_KNOWN = ['inbox', 'archive', 'drafts', 'sentitems', 'deleteditems', 'junkemail'];
    if (WELL_KNOWN.indexOf(f.toLowerCase()) !== -1) return 'mailFolders/' + f.toLowerCase();
    // Otherwise resolve a display name to its id.
    return null;   // caller resolves by display name
  }

  function _resolveFolderId_(mailbox, folder, token) {
    var seg = _folderSegment_(folder);
    if (seg) return seg;   // well-known name usable directly
    var url = GRAPH + '/users/' + encodeURIComponent(mailbox) + "/mailFolders?$top=100&$select=id,displayName";
    var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return 'mailFolders/inbox';
    var items = (jsonParse(resp.getContentText(), {}) || {}).value || [];
    var want = String(folder).trim().toLowerCase();
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].displayName || '').toLowerCase() === want) return 'mailFolders/' + items[i].id;
    }
    return 'mailFolders/inbox';
  }

  // Verify Graph can read the mailbox (1 message). Returns { ok, status, message }.
  function testAccess(cfg) {
    cfg = cfg || getConfig();
    if (!graphConfigured()) return { ok: false, status: 0, message: 'Microsoft Graph is not configured (GRAPH_* Script Properties).' };
    if (!cfg.mailbox) return { ok: false, status: 0, message: 'Enter the support mailbox address first.' };
    var token = null;
    try { token = EmailInteg.graphToken(); } catch (_) {}
    if (!token) return { ok: false, status: 0, message: 'Could not obtain a Graph token. Check the app credentials and admin consent.' };
    try {
      var seg = _resolveFolderId_(cfg.mailbox, cfg.folder, token);
      var url = GRAPH + '/users/' + encodeURIComponent(cfg.mailbox) + '/' + seg + '/messages?$top=1&$select=id,subject';
      var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, muteHttpExceptions: true });
      var code = resp.getResponseCode();
      if (code < 200 || code >= 300) {
        return { ok: false, status: code, message: 'HTTP ' + code + ': ' + String(resp.getContentText() || '').substring(0, 300) };
      }
      return { ok: true, status: code, message: 'Connected. The mailbox is readable.' };
    } catch (e) {
      return { ok: false, status: 0, message: String(e && e.message ? e.message : e) };
    }
  }

  // Read new messages since the checkpoint and run each through the pipeline.
  function scanNow(actor) {
    var cfg = getConfig();
    if (!cfg.enabled || !cfg.mailbox) return { ran: false, connected: false, message: 'Email intake is not enabled / no mailbox set.' };
    if (!graphConfigured()) return { ran: false, connected: false, message: 'Microsoft Graph is not configured.' };
    var token = null;
    try { token = EmailInteg.graphToken(); } catch (_) {}
    if (!token) { _finish_(cfg, 'FAILED', 0, 'No Graph token'); return { ran: true, connected: false, count: 0, message: 'Could not obtain a Graph token.' }; }

    try { Intake.ensureTable(); } catch (_) {}

    var seg = _resolveFolderId_(cfg.mailbox, cfg.folder, token);
    var base = GRAPH + '/users/' + encodeURIComponent(cfg.mailbox) + '/' + seg +
      "/messages?$top=25&$orderby=receivedDateTime%20asc&$select=id,subject,from,receivedDateTime,bodyPreview,body";
    if (cfg.checkpoint) base += '&$filter=' + encodeURIComponent('receivedDateTime gt ' + cfg.checkpoint);

    var processed = 0, created = 0, maxTs = cfg.checkpoint || '';
    var url = base, guard = 0;
    try {
      while (url && processed < MAX_PER_SCAN && guard < 20) {
        guard++;
        var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, muteHttpExceptions: true });
        var code = resp.getResponseCode();
        if (code < 200 || code >= 300) {
          _finish_(cfg, 'FAILED', created, 'HTTP ' + code + ' ' + String(resp.getContentText() || '').substring(0, 200));
          return { ran: true, connected: false, count: created, message: 'Graph read failed: HTTP ' + code };
        }
        var body = jsonParse(resp.getContentText(), {}) || {};
        var items = body.value || [];
        for (var i = 0; i < items.length && processed < MAX_PER_SCAN; i++) {
          var m = items[i];
          processed++;
          var ts = m.receivedDateTime || '';
          if (ts && (!maxTs || ts > maxTs)) maxTs = ts;
          var fromAddr = (m.from && m.from.emailAddress) || {};
          var msg = {
            channel: 'EMAIL',
            external_id: m.id,
            from: fromAddr.address || '',
            from_name: fromAddr.name || '',
            subject: m.subject || '',
            body: (m.body && m.body.content ? _stripHtml_(m.body.content) : (m.bodyPreview || '')),
            received_at: ts
          };
          try {
            var res = Intake.process(msg, cfg);
            if (res && !res.deduped) created++;
          } catch (_) { /* a single message failure must not abort the scan */ }
        }
        url = body['@odata.nextLink'] || '';
      }
      // Advance the checkpoint so the next scan does not reprocess these.
      if (maxTs) cfg.checkpoint = maxTs;
      _finish_(cfg, 'SUCCESS', created, '');
      return { ran: true, connected: true, count: created, scanned: processed, checkpoint: cfg.checkpoint };
    } catch (e) {
      _finish_(cfg, 'FAILED', created, String(e && e.message ? e.message : e));
      throw new Errors.Integration(String(e && e.message ? e.message : e));
    }
  }

  function _finish_(cfg, status, count, err) {
    cfg.last_scan_at = nowIso();
    cfg.last_scan_status = status;
    cfg.last_scan_count = count;
    cfg.last_scan_error = status === 'SUCCESS' ? '' : String(err || '').substring(0, 300);
    _save_(cfg);
  }

  function _stripHtml_(html) {
    return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
  }

  // Scheduled entry: scan only when enabled, configured, and the chosen
  // frequency is due (the trigger fires more often than any single mailbox needs).
  function scheduledScan(actor) {
    var cfg = getConfig();
    if (!cfg.enabled || !cfg.mailbox || !graphConfigured()) return { ran: false, reason: 'not configured' };
    var lastMs = cfg.last_scan_at ? Date.parse(cfg.last_scan_at) : 0;
    var freq = Math.max(5, parseInt(cfg.frequency_minutes, 10) || 15);
    if (lastMs && (Date.now() - lastMs) < (freq * 60000 - 30000)) return { ran: false, reason: 'not due' };
    return scanNow(actor || 'SYSTEM');
  }

  function status() {
    var c = getConfig();
    return {
      enabled: !!c.enabled, mailbox: c.mailbox || '', folder: c.folder || 'inbox',
      frequency_minutes: c.frequency_minutes || 15, graph_configured: graphConfigured(),
      connected: isConfigured(), last_scan_at: c.last_scan_at || '', last_scan_count: c.last_scan_count || 0,
      last_scan_status: c.last_scan_status || '', last_scan_error: c.last_scan_error || '', checkpoint: c.checkpoint || ''
    };
  }

  return {
    CONFIG_KEY: CONFIG_KEY, getConfig: getConfig, saveConfig: saveConfig, status: status,
    isConfigured: isConfigured, graphConfigured: graphConfigured, consentUrl: consentUrl,
    testAccess: testAccess, scanNow: scanNow, scheduledScan: scheduledScan
  };
})();
