/**
 * 40_svc_bundle.gs  -  Hass CMS  (performance: request batching)
 *
 * One action, bundle.batch, that runs several service.action calls in a SINGLE
 * google.script.run round-trip. Network round-trips are the dominant cost, so a
 * page that needs five reads pays one trip, not five.
 *
 * This is a pure transport optimization. Each sub-call is run through the SAME
 * dispatch() path as a normal call, so session validation, RBAC and every
 * handler behave EXACTLY as if the client had made the calls separately. The
 * bundle adds no business logic and can do nothing the client could not already
 * do one call at a time. The dispatcher itself is NOT modified.
 *
 *   params.calls : [ { service, action, params }, ... ]   (max 12)
 *   returns      : { results: [ {ok:true,data} | {ok:false,error}, ... ] }
 *                  aligned 1:1 with calls, in order.
 */

var _BUNDLE_MAX_CALLS_ = 12;

function _bundleBatch_(ctx, params) {
  var calls = (params && params.calls) || [];
  if (!_isArray_(calls)) throw new Errors.Validation('bundle.batch requires a calls array.');
  if (calls.length === 0) return { results: [] };
  if (calls.length > _BUNDLE_MAX_CALLS_) {
    throw new Errors.Validation('Too many calls in one bundle (max ' + _BUNDLE_MAX_CALLS_ + ').');
  }

  // The token that authenticated THIS bundle call. We hand it to each sub-call
  // so dispatch() re-runs the identical session + permission gate per call.
  var token = (ctx && ctx.sessionToken) ||
              (params && params.sessionToken) ||
              (ctx && ctx.session && (ctx.session.token)) || null;

  var results = calls.map(function (c) {
    c = c || {};
    var sub = {
      service: String(c.service || ''),
      action:  String(c.action  || ''),
      params:  (c.params && typeof c.params === 'object') ? c.params : {}
    };
    if (!sub.service || !sub.action) {
      return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Each call needs a service and action.' } };
    }
    try {
      // Reuse the real dispatcher: same gating, same handlers, same response shape.
      return dispatch({ sessionToken: token }, sub);
    } catch (e) {
      return { ok: false, error: { code: (e && e.code) || 'HANDLER_ERROR', message: (e && e.message) || 'Bundle sub-call failed.' } };
    }
  });

  return { results: results };
}

// Local Array.isArray shim (kept self-contained; V8 has Array.isArray but this
// avoids any load-order assumptions about shared utils).
function _isArray_(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

// ── Registration ───────────────────────────────────────────────────────────────
// permission:null means "session required, no extra permission for the bundle
// envelope itself". Every sub-call is still fully permission-gated by dispatch().

(function _registerBundle_() {
  register({ service: 'bundle', action: 'batch', permission: null, handler: _bundleBatch_ });
})();
