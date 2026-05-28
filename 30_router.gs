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
