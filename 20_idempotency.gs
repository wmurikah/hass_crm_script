/**
 * 20_idempotency.gs  -  Hass CMS  (responsiveness redo, Part 4)
 *
 * Additive write idempotency. When a write carries an optional `idempotencyKey`
 * param, the first call runs and its result is remembered briefly; an identical
 * key for the same user (a double-clicked submit/approve/generate, a retry, a
 * second tab) returns the ORIGINAL result instead of executing the handler a
 * second time.
 *
 * This is purely additive and backward compatible:
 *   - No key on the params  -> the handler runs exactly as before.
 *   - Feature flag off       -> the handler runs exactly as before.
 *   - The first call's result and side effects are unchanged; only a duplicate
 *     is short-circuited, so a double-clicked write cannot create a second
 *     order / payment / invoice / approval (and cannot re-send its emails).
 *   - Errors are NOT remembered, so a failed write can still be retried.
 *
 * IMPORTANT (the #165 lesson): this module is consulted from ONE place, the
 * dispatcher (30_dispatcher.gs `_invokeHandler`), at REQUEST time, behind a
 * `typeof Idempotency` guard. It is never applied at register() time, so it can
 * never throw during file load and take an action's registration down with it.
 *
 * Keys are recorded briefly in CacheService, namespaced by user id so one user's
 * key can never collide with another's.
 */
var Idempotency = (function () {

  var TTL_SEC = 600;     // remember a completed key for ~10 minutes
  var LOCK_MS = 5000;    // best-effort serialise genuinely concurrent duplicates

  function _cacheKey(userId, key) { return 'idem1:' + userId + ':' + key; }

  function _userOf(ctx) {
    return (ctx && ctx.session && (ctx.session.user_id || ctx.session.userId)) || 'anon';
  }

  function _read(cache, ck) {
    try {
      var raw = cache.get(ck);
      if (!raw) return null;
      return { hit: true, value: JSON.parse(raw).v };
    } catch (e) { return null; }
  }
  function _store(cache, ck, value) {
    // A result too large for CacheService (or not serialisable) is simply not
    // remembered: correctness over a duplicate degrades, it never throws.
    try { cache.put(ck, JSON.stringify({ v: value }), TTL_SEC); } catch (e) {}
  }

  /**
   * Run fn() at most once per (user, idempotencyKey). Returns fn()'s result, or
   * the remembered result of the first identical call. With no key, runs fn()
   * straight through (exactly today's behaviour).
   *
   * @param {Object}   ctx     dispatcher context (carries ctx.session)
   * @param {Object}   params  request params (may carry params.idempotencyKey)
   * @param {Function} fn      () => result   the real work
   */
  function guard(ctx, params, fn) {
    var key = params && params.idempotencyKey;
    if (!key || typeof key !== 'string') return fn();   // additive: no key, normal behaviour

    var userId = _userOf(ctx);
    var ck     = _cacheKey(userId, key);

    var cache;
    try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
    if (!cache) return fn();   // no cache available: degrade to running normally

    // Fast path: an identical write already completed.
    var hit = _read(cache, ck);
    if (hit && hit.hit) return hit.value;

    // Serialise a genuinely concurrent duplicate so the second waits and reads
    // the first's result rather than executing in parallel. Best-effort: if the
    // lock cannot be taken we still proceed (the client also coalesces concurrent
    // identical calls, so this is only a backstop).
    var lock = null;
    try { lock = LockService.getScriptLock(); lock.waitLock(LOCK_MS); } catch (e) { lock = null; }
    try {
      hit = _read(cache, ck);
      if (hit && hit.hit) return hit.value;
      var result = fn();         // a throw here propagates and is NOT cached
      _store(cache, ck, result);
      return result;
    } finally {
      if (lock) { try { lock.releaseLock(); } catch (e) {} }
    }
  }

  /**
   * Sugar: wrap a (ctx, params) handler so it is idempotent when a key is sent.
   * Provided for completeness; this codebase calls guard() from the dispatcher
   * rather than wrapping handlers at register() time (see the #165 lesson above).
   */
  function wrap(fn) {
    return function (ctx, params) {
      return guard(ctx, params, function () { return fn(ctx, params); });
    };
  }

  return { guard: guard, wrap: wrap };
})();
