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
