/**
 * 30_dispatcher.gs  —  Hass CMS rebuild
 * Route table, register(), dispatch(), processRequest().
 */

var _PUBLIC_ACTIONS_ = [
  'auth.login', 'auth.signup', 'auth.verifyAccount',
  'auth.requestPasswordReset', 'auth.verifyOtp',
  'auth.setNewPassword', 'system.health', 'system.ping',
  // MFA mid-login actions (gated by a valid challengeId, the partial pre-MFA
  // token). Kept in sync with the auth-service copy of this list.
  'auth.mfaEnroll', 'auth.mfaVerifyEnroll',
  'auth.mfaEnrollStart', 'auth.mfaEnrollVerify', 'auth.mfaVerify'
];

var _registry_ = {};

function register(opts) {
  // Load-order guard: GAS executes top-level statements in file load order.
  // If a service file calls register() before this file's `var _registry_ = {};`
  // has executed, _registry_ would be undefined and the assignment below would
  // throw. Lazily initialize it here so registration can NEVER throw.
  if (typeof _registry_ === 'undefined' || _registry_ === null) {
    _registry_ = {};
  }
  var key = opts.service + '.' + opts.action;
  _registry_[key] = opts;
  Logger.log('[dispatcher] registered ' + key);
}

function dispatch(ctx, req) {
  var service = req.service || '';
  var action  = req.action  || '';
  var params  = req.params  || {};
  var key     = service + '.' + action;

  var isPublic = _PUBLIC_ACTIONS_.indexOf(key) !== -1;

  if (!isPublic) {
    var rawToken = null;
    if (params && typeof params.sessionToken === 'string' && params.sessionToken.length > 0) {
      rawToken = params.sessionToken;
    } else if (ctx && typeof ctx.sessionToken === 'string' && ctx.sessionToken.length > 0) {
      rawToken = ctx.sessionToken;
    }
    if (rawToken === null) {
      return { ok: false, error: { code: 'NO_SESSION', message: 'Authentication required.' } };
    }
    var session = Session.validate(rawToken);
    if (!session) {
      return { ok: false, error: { code: 'SESSION_INVALID', message: 'Session expired or invalid.' } };
    }
    ctx.session = session;
  }

  var reg = _registry_[key];
  if (!reg) {
    return { ok: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action: ' + key } };
  }

  if (reg.permission && ctx.session) {
    // Session.validate may return snake_case (user_id) or camelCase (userId).
    // Try both before concluding the actor is unknown.
    var actorId = ctx.session.user_id || ctx.session.userId || '';
    if (!Rbac.userHasPermission(actorId, reg.permission)) {
      try {
        Audit.log({
          actor:    actorId,
          action:   'PERMISSION_DENIED',
          entity:   service,
          entityId: action,
          metadata: { required: reg.permission }
        });
      } catch (_) {}
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Permission denied.' } };
    }
  }

  try {
    var result = reg.handler(ctx, params);
    return { ok: true, data: result };
  } catch (e) {
    Logger.log('[dispatcher] handler error: ' + e.message + (e.stack ? '\n' + e.stack : ''));
    return { ok: false, error: { code: (e.code || 'HANDLER_ERROR'), message: e.message } };
  }
}

function processRequest(requestBody) {
  try {
    var body    = (typeof requestBody === 'string') ? JSON.parse(requestBody) : requestBody;
    var service = body.service || '';
    var action  = body.action  || '';
    var params  = body.params  || {};
    var ctx     = { sessionToken: body.sessionToken || params.sessionToken || null };
    return dispatch(ctx, { service: service, action: action, params: params });
  } catch (e) {
    Logger.log('[processRequest] error: ' + e.message + '\n' + (e.stack || ''));
    return { ok: false, error: { code: (e.code || 'INTERNAL_ERROR'), message: e.message || 'Unexpected error.' } };
  }
}
