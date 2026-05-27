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

// ── Permission gate (Stage 1 stub) ────────────────────────────────────────────

function _dispatchPermit_(ctx, permission) {
  // Stage 3 replaces this with: return RBAC.userHasPermission(ctx.actor, permission)
  return true;
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

  if (!_dispatchPermit_(ctx, spec.permission)) {
    return {
      ok:    false,
      error: { code: 'PERMISSION_DENIED', message: 'Missing permission: ' + spec.permission },
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
