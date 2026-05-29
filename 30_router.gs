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
    return tmpl
      .evaluate()
      .setTitle(ENV.APP_NAME)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    Log.error({ service: 'router', action: 'doGet', msg: err.message,
                data: { page: page } });
    return HtmlService
      .createHtmlOutput('<p>Page not available.</p>')
      .setTitle(ENV.APP_NAME);
  }
}

// ── doPost ────────────────────────────────────────────────────────────────────

function doPost(e) {
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
 * Returns the staff dashboard HTML for a valid session token.
 * Invalid/expired tokens get a small error page (never a blank document).
 */
function getStaffDashboardPage(token) {
  try {
    var session = Session.validate(token);
    if (!session) {
      var url = ScriptApp.getService().getUrl();
      return '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">'
        + '<p>Session expired. '
        + '<a href="' + url + '" target="_top">Log in again</a>.</p>'
        + '</body></html>';
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
