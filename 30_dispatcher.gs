/**
 * 30_dispatcher.gs  —  Hass CMS rebuild foundation
 *
 * Service/action registry and dispatcher.
 *
 *   register(spec)                    register a handler
 *   dispatch(ctx, call)               resolve and invoke; gate permissions
 *
 * spec shape:  { service, action, permission, handler }
 * ctx  shape:  { actor, session, token }    (populated by 30_router.gs)
 * call shape:  { service, action, params }
 *
 * Permission gate: Stage 1 stub always grants. Real RBAC wired in Stage 3.
 *
 * On unknown service/action returns:
 *   { ok: false, error: { code: 'UNKNOWN_ACTION', message: '...' } }
 */

var _handlers_ = {};

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register a handler for a service+action pair.
 * @param {{ service:string, action:string, permission:string, handler:Function }} spec
 */
function register(spec) {
  var key = spec.service + '.' + spec.action;
  _handlers_[key] = spec;
  Log.debug({ service: 'dispatcher', action: 'register', msg: 'registered ' + key });
}

// ── Public actions (no session required) ─────────────────────────────────────

var _DISPATCH_PUBLIC_ = [
  'auth.login', 'auth.signup', 'auth.verifyAccount',
  'auth.requestPasswordReset', 'auth.verifyOtp', 'auth.setNewPassword',
];

// ── Permission gate ───────────────────────────────────────────────────────────

function _dispatchPermit_(ctx, spec) {
  var key = (spec.service || '') + '.' + (spec.action || '');
  if (_DISPATCH_PUBLIC_.indexOf(key) !== -1) return true; // public bypass
  if (!spec.permission) return true;                       // no permission declared
  if (!ctx || !ctx.session || !ctx.session.userId) {
    // Caller had no session – should have been caught in the router, but guard here.
    return false;
  }
  return Rbac.userHasPermission(ctx.session.userId, spec.permission);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

/**
 * Resolve and invoke the handler for `call.service` + `call.action`.
 * @param {Object} ctx   request context from router
 * @param {{ service:string, action:string, params:Object }} call
 * @returns {{ ok:boolean, data?:*, error?:{code:string, message:string} }}
 */
function dispatch(ctx, call) {
  var key  = (call.service || '') + '.' + (call.action || '');
  var spec = _handlers_[key];

  if (!spec) {
    return {
      ok:    false,
      error: {
        code:    'UNKNOWN_ACTION',
        message: 'No handler registered for service="' + call.service +
                 '" action="' + call.action + '"',
      },
    };
  }

  if (!_dispatchPermit_(ctx, spec)) {
    var permMsg = 'Missing permission: ' + spec.permission;
    try {
      Audit.log({
        actor:    ctx && ctx.actor || '',
        action:   'PERMISSION_DENIED',
        entity:   spec.service,
        entityId: spec.action,
        ip:       ctx && ctx.ip || '',
        ua:       ctx && ctx.ua || '',
        metadata: { service: spec.service, action: spec.action, permission: spec.permission },
      });
    } catch (_) {}
    return {
      ok:    false,
      error: { code: 'PERMISSION_DENIED', message: permMsg },
    };
  }

  try {
    var result = spec.handler(ctx, call.params || {});
    return { ok: true, data: result };
  } catch (e) {
    if (e instanceof Errors.PermissionDenied) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    if (e instanceof Errors.NotFound) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    if (e instanceof Errors.Validation) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    if (e instanceof Errors.AppError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    Log.error({
      service: call.service,
      action:  call.action,
      actor:   ctx && ctx.actor,
      msg:     e.message || String(e),
    });
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } };
  }
}
