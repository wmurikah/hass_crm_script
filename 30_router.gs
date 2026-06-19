/**
 * 30_router.gs  —  Hass CMS rebuild foundation
 *
 * Web entry points for the new architecture.
 *
 * NOTE: During Stage 1–9 build these definitions co-exist with Code.gs.
 *       Because filenames starting with digits sort before letters, Code.gs
 *       loads after this file and its doGet/doPost declarations win, keeping
 *       the old system live.  At Stage 10 cutover Code.gs is deleted and
 *       these become the active entry points.
 *
 * doGet  routes by ?page=  (login | staff | portal | mfa-enrol | mfa-verify)
 * doPost reads JSON body, resolves session, binds audit context, calls dispatch.
 *
 * Public endpoints (no session required) per blueprint §5.1:
 *   auth.login
 *   auth.signup
 *   auth.requestPasswordReset
 *   auth.verifyOtp
 */

var _PUBLIC_ENDPOINTS_ = [
  'auth.login',
  'auth.signup',
  'auth.requestPasswordReset',
  'auth.verifyOtp',
];

// ── Page map ──────────────────────────────────────────────────────────────────

var _PAGE_TEMPLATES_ = {
  'login':      'Login',
  'staff':      'Staffdashboard',
  'portal':     'Customerportal',
  'mfa-enrol':  'MfaEnroll',
  'mfa-verify': 'MfaVerify',
};

// ── doGet ─────────────────────────────────────────────────────────────────────

function doGet(e) {
  var params       = (e && e.parameter) || {};
  var page         = String(params.page || 'login').toLowerCase().trim();
  var templateName = _PAGE_TEMPLATES_[page] || 'Login';

  try {
    var tmpl = HtmlService.createTemplateFromFile(templateName);
    // Provide a default so templates that reference sessionToken (e.g.
    // Staffdashboard) never throw a ReferenceError during evaluate().
    tmpl.sessionToken = String(params.token || '');
    tmpl.userEmail    = '';
    // Default so MFA templates that reference challengeId never throw during
    // evaluate() when reached via a direct doGet (the real flow injects it via
    // _renderPage_ / getMfaEnrollPage).
    tmpl.challengeId  = String(params.challengeId || '');
    return tmpl
      .evaluate()
      .setTitle(ENV.APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      // Allow this published web app to be embedded in a third-party iframe
      // (the GitHub Pages banner-crop wrapper). Without ALLOWALL the default
      // X-Frame-Options blocks rendering inside any cross-origin frame.
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    Log.error({ service: 'router', action: 'doGet', msg: err.message,
                data: { page: page } });
    return HtmlService
      .createHtmlOutput('<p>Page not available.</p>')
      .setTitle(ENV.APP_NAME)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

// ── doPost ────────────────────────────────────────────────────────────────────

function doPost(e) {
  // ── Optional inbound integration webhook (Oracle PO/SO/LA only) ──────────────
  // The ONE deliberate doPost data path, gated by a shared secret. It activates
  // ONLY when the request explicitly carries hook=oracle_approvals (query param
  // or body field) and writes solely to the po_approvals / so_approvals tables.
  // Every other request falls straight through to the unchanged processRequest
  // path, so app traffic and dispatcher gating are completely unaffected.
  try {
    var rawBody = e && e.postData ? e.postData.contents : '';
    var hookParam = (e && e.parameter && e.parameter.hook) || '';
    var bodyObj = null;
    if (rawBody) { try { bodyObj = JSON.parse(rawBody); } catch (_) {} }
    var isHook = (hookParam === 'oracle_approvals') || (bodyObj && bodyObj.hook === 'oracle_approvals');
    if (isHook && typeof OracleApprovalsConnector !== 'undefined') {
      var hookResult = OracleApprovalsConnector.ingestWebhook(bodyObj || {});
      return ContentService.createTextOutput(JSON.stringify(hookResult)).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (hookErr) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: { code: 'WEBHOOK_ERROR', message: hookErr.message } }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var result = processRequest(e && e.postData ? e.postData.contents : '{}');
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _routerJson_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── google.script.run page loaders (GAS-safe navigation) ────────────────────────
//
// GAS web apps run inside a sandboxed iframe where window.location / window.top
// navigation is blocked (it silently lands on about:blank). The only way to swap
// pages after a user action is to fetch the rendered HTML through
// google.script.run and replace the document on the client via
// document.open()/write()/close(). These functions return that HTML.
//
// IMPORTANT: the page files contain templating scriptlets (<?= ?> / <?!= ?>),
// so they MUST be rendered with createTemplateFromFile(...).evaluate(), not
// createHtmlOutputFromFile(...), which would leave the scriptlets unevaluated.

/** Render a page template to an HTML string, injecting common variables. */
function _renderPage_(templateName, vars) {
  var tmpl = HtmlService.createTemplateFromFile(templateName);
  tmpl.sessionToken = (vars && vars.sessionToken) || '';
  tmpl.userEmail    = (vars && vars.userEmail)    || '';
  // The MFA enrol/verify pages need the challenge minted at login (the partial
  // pre-MFA token). Inject it so the page can pass it back to the server; other
  // pages simply ignore the unused value.
  tmpl.challengeId  = (vars && vars.challengeId)  || '';
  return tmpl.evaluate().getContent();
}

/** Returns the login page HTML (used after logout / session expiry). */
function getLoginPage() {
  return _renderPage_('Login', {});
}

/** Returns the MFA verification page HTML (used when login requires MFA). */
function getMfaVerifyPage(challengeId) {
  return _renderPage_('MfaVerify', { challengeId: challengeId || '' });
}

/** Returns the MFA enrolment page HTML (first-time MFA setup at login). */
function getMfaEnrollPage(challengeId) {
  return _renderPage_('MfaEnroll', { challengeId: challengeId || '' });
}

/**
 * The "Session expired" interstitial shown when getStaffDashboardPage() is
 * called with an invalid/expired token.
 *
 * GAS-safe "Log in again": window.location / window.top navigation is blocked
 * inside the sandboxed iframe, so a plain <a href target="_top"> link silently
 * fails and the user is stuck on this page (the reported loop). Instead the
 * button (1) clears the stale persisted token — otherwise the Login page would
 * immediately auto-swap back to getStaffDashboardPage() with the same dead
 * token and re-render this page — then (2) fetches the rendered login form via
 * google.script.run.getLoginPage() and replaces the document. It NEVER calls
 * the dashboard route again.
 */
function _sessionExpiredPage_() {
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="font-family:sans-serif;padding:40px">',
    '<p>Session expired. ',
    '<a href="#" id="hassLoginAgain">Log in again</a>.</p>',
    '<script>',
    '(function(){',
    '  var link=document.getElementById("hassLoginAgain");',
    '  link.addEventListener("click",function(ev){',
    '    ev.preventDefault();',
    '    link.textContent="Loading login…";',
    // Drop the dead token so the login page does not bounce straight back here.
    '    try{sessionStorage.removeItem("hass_token");}catch(e){}',
    '    try{localStorage.removeItem("hass_token");}catch(e){}',
    '    google.script.run',
    '      .withSuccessHandler(function(html){document.open();document.write(html);document.close();})',
    '      .withFailureHandler(function(){link.textContent="Log in again";link.href="#";})',
    '      .getLoginPage();',
    '  });',
    '})();',
    '<\/script>',
    '</body></html>'
  ].join('');
}

/**
 * Returns the staff dashboard HTML for a valid session token.
 * Invalid/expired tokens get a small error page (never a blank document).
 */
function getStaffDashboardPage(token) {
  try {
    var session = Session.validate(token);
    if (!session) {
      return _sessionExpiredPage_();
    }
    return _renderPage_('Staffdashboard', {
      sessionToken: token,
      userEmail:    session.userId || session.user_id || ''
    });
  } catch (e) {
    return '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">'
      + '<p>Error loading dashboard: ' + (e && e.message ? e.message : e) + '</p>'
      + '</body></html>';
  }
}

/** Invalidate the session server-side; always returns true so the client reloads. */
function logoutUser(token) {
  try { Session.invalidate(token); } catch (e) {}
  return true;
}

/** Include helper for templates: <?!= include('css_theme') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
