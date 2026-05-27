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
  var body    = jsonParse((e && e.postData && e.postData.contents) || '{}', {});
  var token   = body.token   || (e && e.parameter && e.parameter.token) || '';
  var service = String(body.service || '');
  var action  = String(body.action  || '');
  var params  = body.params  || body;
  var key     = service + '.' + action;

  // Bind a minimal audit context; actor is filled in after session resolution.
  var ctx = { token: token, actor: null, session: null };

  // Session gate: public endpoints bypass; everything else requires a valid session.
  if (_PUBLIC_ENDPOINTS_.indexOf(key) === -1) {
    var session = resolveSession_(token);
    if (!session) {
      return _routerJson_({
        ok:    false,
        error: { code: 'UNAUTHENTICATED', message: 'A valid session is required.' },
      });
    }
    ctx.actor   = session.userId;
    ctx.session = session;
  }

  var result = dispatch(ctx, { service: service, action: action, params: params });
  return _routerJson_(result);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _routerJson_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
