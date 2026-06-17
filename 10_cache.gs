/**
 * 10_cache.gs  —  Hass CMS rebuild foundation
 *
 * Thin wrapper around CacheService.getScriptCache().
 * Used by 20_rbac and 20_config (Stage 2) for hot reads of reference data.
 *
 * Public API (namespace object AppCache):
 *   getOrSet(key, ttlSec, loader)    read-through; loader called on miss
 *   invalidate(key)                  remove a single key
 *   invalidateAll(keys)              remove a list of keys
 */

var AppCache = {

  /**
   * Return the cached value for `key`, or call `loader()`, cache its result,
   * and return it.  If the serialised value exceeds CacheService limits the
   * result is returned uncached (no error thrown).
   *
   * @param {string}   key
   * @param {number}   ttlSec   cache TTL in seconds (max 21600)
   * @param {Function} loader   () => any  — called on cache miss
   * @returns {*}
   */
  getOrSet: function (key, ttlSec, loader) {
    var cache  = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached !== null) {
      return jsonParse(cached, null);
    }
    var value = loader();
    try {
      cache.put(key, jsonStringify(value), ttlSec || 300);
    } catch (_) {
      // Value too large for CacheService — returned without caching.
    }
    return value;
  },

  /**
   * Remove a single cached key.
   * @param {string} key
   */
  invalidate: function (key) {
    CacheService.getScriptCache().remove(key);
  },

  /**
   * Remove multiple cached keys in one call.
   * @param {string[]} keys
   */
  invalidateAll: function (keys) {
    if (keys && keys.length) {
      CacheService.getScriptCache().removeAll(keys);
    }
  },
};

/**
 * AggCache  -  server-side cache for precomputed aggregates and reference data.
 *
 * It serves two of the performance layers:
 *   - Layer 6 (reference data): cache rarely-changing data and invalidate it the
 *     moment its admin write happens.
 *   - Layer 7 (heavy aggregates): cache the dashboard / approval-leaderboard
 *     blobs (computed from many rows) so views read a small cached result instead
 *     of grinding the aggregation on every page view, while staying fresh on the
 *     writes that affect them.
 *
 * Invalidation uses a GENERATION token per namespace rather than enumerating
 * keys (CacheService has no wildcard delete). Every cached key embeds the current
 * generation; bumping the generation makes all old keys unreachable at once, so
 * one bump invalidates an entire namespace across every scope.
 *
 * Correctness: a namespace's entries are pure functions of their signature (e.g.
 * the country scope), never of the calling user, so two users with the same scope
 * safely share one entry. RBAC is still enforced by each handler BEFORE it
 * consults the cache, so the cache never widens what a user may see.
 *
 * Public API (namespace object AggCache):
 *   getOrSet(ns, sig, ttlSec, loader)   read-through within the current generation
 *   set(ns, sig, value, ttlSec)         write a precomputed value (used by warmers)
 *   bump(ns)                            invalidate the whole namespace
 *   onAudit(action)                     bump 'dash' for any data-changing audit event
 */
var AggCache = (function () {

  var _GEN_TTL_ = 21600;   // 6h (CacheService max); the generation token is tiny

  function _cache()       { return CacheService.getScriptCache(); }
  function _genKey(ns)    { return 'agg1:gen:' + ns; }
  function _dataKey(ns, sig) { return 'agg1:' + ns + ':' + _gen(ns) + ':' + sig; }

  function _gen(ns) {
    var c = _cache();
    var g = null;
    try { g = c.get(_genKey(ns)); } catch (_) {}
    if (!g) {
      g = String(Date.now());
      try { c.put(_genKey(ns), g, _GEN_TTL_); } catch (_) {}
    }
    return g;
  }

  function bump(ns) {
    try {
      _cache().put(_genKey(ns), String(Date.now()) + '.' + Math.floor(Math.random() * 1e6), _GEN_TTL_);
    } catch (_) {}
  }

  function getOrSet(ns, sig, ttlSec, loader) {
    return AppCache.getOrSet(_dataKey(ns, sig), ttlSec, loader);
  }

  function set(ns, sig, value, ttlSec) {
    try { _cache().put(_dataKey(ns, sig), jsonStringify(value), ttlSec || 120); } catch (_) {}
  }

  // Auth / identity events do not change dashboard data, so they do not bump the
  // dashboard blobs (keeps the cache useful across logins). Everything else that
  // is audited is a data mutation and invalidates the dashboard aggregates.
  var _NO_DASH_BUMP_ = {
    LOGIN: 1, LOGOUT: 1, LOGIN_FAILED: 1, MFA_CHALLENGE_ISSUED: 1, MFA_LOGIN: 1,
    MFA_ENROLLED: 1, PERMISSION_DENIED: 1, PASSWORD_RESET_REQUESTED: 1,
    SIGNUP_REQUESTED: 1, PASSWORD_CHANGED: 1
  };
  function onAudit(action) {
    try {
      var a = String(action || '').toUpperCase();
      if (a && !_NO_DASH_BUMP_[a]) bump('dash');
    } catch (_) {}
  }

  return { getOrSet: getOrSet, set: set, bump: bump, onAudit: onAudit };
})();
