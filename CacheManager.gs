/**
 * HASS PETROLEUM CMS — CACHE MANAGER
 * Version: 1.0.0
 *
 * Multi-tier caching for Google Apps Script.
 *
 * TIER    SERVICE                     LIMIT        TTL
 * ─────────────────────────────────────────────────────
 *  L1     CacheService.getScriptCache  100 KB/key   300 s (dynamic)
 *                                                   3600 s (static)
 *         Large datasets chunked at 80 KB/key
 *         Cleared on every write via cacheInvalidate()
 *
 *  L2     PropertiesService (script)   9 KB/key     3600 s (in envelope)
 *         Static reference data only (Countries, Products, Config…)
 *         Promoted to L1 on read
 *
 * STATIC sheets (longer TTL): Countries, Segments, Products, Depots,
 *   SLAConfig, Config, Teams, KnowledgeCategories
 *
 * All cache keys are namespaced: 'hass_cms_{sheet}_{suffix}'
 */

var CACHE_NS           = 'hass_cms_';
var CACHE_TTL_DYNAMIC  = 300;    // 5 min — tickets, orders, notifications …
var CACHE_TTL_STATIC   = 3600;   // 1 h  — products, countries, config …
var CACHE_CHUNK_BYTES  = 80000;  // 80 KB per chunk (100 KB hard limit)

var STATIC_SHEETS_ = [
  'Countries', 'Segments', 'Products', 'Depots',
  'SLAConfig', 'Config', 'Teams', 'KnowledgeCategories',
];

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Returns sheet data from the cache, loading from the sheet on a miss.
 * Stores the result in L1 (and L2 for static sheets).
 *
 * Replaces the bare getSheetData() call everywhere a read-only view is needed.
 *
 * @param {string}    sheetName
 * @param {Function}  [loader]  - optional override; defaults to getSheetData(sheetName)
 * @returns {Object[]}
 */
function cachedGet(sheetName, loader) {
  // L1 hit
  var l1 = readL1_(sheetName);
  if (l1 !== null) return l1;

  // L2 hit (static sheets only)
  if (isStaticSheet_(sheetName)) {
    var l2 = readL2_(sheetName);
    if (l2 !== null) {
      writeL1_(sheetName, l2);
      return l2;
    }
  }

  // Load from sheet
  var data = loader ? loader() : getSheetData(sheetName);
  var ttl  = isStaticSheet_(sheetName) ? CACHE_TTL_STATIC : CACHE_TTL_DYNAMIC;

  writeL1_(sheetName, data, ttl);
  if (isStaticSheet_(sheetName)) writeL2_(sheetName, data);

  return data;
}

/**
 * Invalidates all cache entries (L1 + L2) for a sheet.
 * Must be called after any write to that sheet.
 *
 * @param {string} sheetName
 */
function cacheInvalidate(sheetName) {
  clearL1_(sheetName);
  clearL2_(sheetName);
}

/**
 * Invalidates cache for multiple sheets at once.
 *
 * @param {string[]} sheetNames
 */
function cacheInvalidateAll(sheetNames) {
  for (var i = 0; i < sheetNames.length; i++) {
    cacheInvalidate(sheetNames[i]);
  }
}

// ============================================================================
// SINGLE-VALUE CACHE  (counters, metadata, lightweight settings)
// ============================================================================

/**
 * Gets a single cached value, calling loader() on a miss.
 *
 * @param {string}   key
 * @param {Function} [loader]   - called on miss; return value is cached
 * @param {number}   [ttl=300]  - seconds
 * @returns {*}
 */
function cacheGetValue(key, loader, ttl) {
  var cache = CacheService.getScriptCache();
  var ns    = CACHE_NS + 'v_' + key;
  var raw   = cache.get(ns);

  if (raw !== null) {
    try { return JSON.parse(raw); } catch(e) { return raw; }
  }

  var value = loader ? loader() : null;
  if (value !== null && value !== undefined) {
    try { cache.put(ns, JSON.stringify(value), ttl || CACHE_TTL_DYNAMIC); } catch(e) {}
  }
  return value;
}

/**
 * Stores a single cached value.
 *
 * @param {string} key
 * @param {*}      value
 * @param {number} [ttl=300]
 */
function cacheSetValue(key, value, ttl) {
  try {
    CacheService.getScriptCache()
      .put(CACHE_NS + 'v_' + key, JSON.stringify(value), ttl || CACHE_TTL_DYNAMIC);
  } catch(e) {
    Logger.log('[CacheManager] cacheSetValue error: ' + e.message);
  }
}

/**
 * Deletes a single cached value.
 *
 * @param {string} key
 */
function cacheDeleteValue(key) {
  CacheService.getScriptCache().remove(CACHE_NS + 'v_' + key);
}

// ============================================================================
// L1 — CacheService (chunked for large payloads)
// ============================================================================

function readL1_(sheetName) {
  var cache   = CacheService.getScriptCache();
  var metaKey = cacheKey_(sheetName, 'meta');
  var meta    = cache.get(metaKey);

  if (!meta) {
    // Single-chunk (small dataset) or not cached
    var raw = cache.get(cacheKey_(sheetName));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch(e) { return null; }
  }

  try {
    var m = JSON.parse(meta);

    if (!m.chunks || m.chunks === 1) {
      var raw2 = cache.get(cacheKey_(sheetName));
      return raw2 ? JSON.parse(raw2) : null;
    }

    // Multi-chunk: fetch all parts and reassemble
    var chunkKeys = [];
    for (var i = 0; i < m.chunks; i++) chunkKeys.push(cacheKey_(sheetName, 'c' + i));
    var parts = cache.getAll(chunkKeys);

    var json = '';
    for (var j = 0; j < m.chunks; j++) {
      var part = parts[cacheKey_(sheetName, 'c' + j)];
      if (!part) return null; // a chunk expired before the others
      json += part;
    }
    return JSON.parse(json);
  } catch(e) {
    return null;
  }
}

function writeL1_(sheetName, data, ttl) {
  ttl = ttl || CACHE_TTL_DYNAMIC;
  var cache = CacheService.getScriptCache();

  try {
    var json = JSON.stringify(data);

    if (json.length <= CACHE_CHUNK_BYTES) {
      // Fits in a single key
      cache.put(cacheKey_(sheetName), json, ttl);
      return;
    }

    // Split into chunks and store with a metadata key
    var chunks = [];
    for (var i = 0; i < json.length; i += CACHE_CHUNK_BYTES) {
      chunks.push(json.substring(i, i + CACHE_CHUNK_BYTES));
    }
    var puts = {};
    for (var c = 0; c < chunks.length; c++) {
      puts[cacheKey_(sheetName, 'c' + c)] = chunks[c];
    }
    puts[cacheKey_(sheetName, 'meta')] = JSON.stringify({ chunks: chunks.length });
    cache.putAll(puts, ttl);
  } catch(e) {
    Logger.log('[CacheManager] writeL1_ error (' + sheetName + '): ' + e.message);
  }
}

function clearL1_(sheetName) {
  var cache   = CacheService.getScriptCache();
  var metaKey = cacheKey_(sheetName, 'meta');
  var meta    = cache.get(metaKey);

  var toRemove = [cacheKey_(sheetName), metaKey];

  if (meta) {
    try {
      var m = JSON.parse(meta);
      for (var i = 0; i < (m.chunks || 0); i++) toRemove.push(cacheKey_(sheetName, 'c' + i));
    } catch(e) {}
  }
  cache.removeAll(toRemove);
}

// ============================================================================
// L2 — PropertiesService (persistent, small payloads)
// ============================================================================

function readL2_(sheetName) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(cacheKey_(sheetName, 'l2'));
    if (!raw) return null;
    var env = JSON.parse(raw);
    if (env.expires && Date.now() > env.expires) {
      PropertiesService.getScriptProperties().deleteProperty(cacheKey_(sheetName, 'l2'));
      return null;
    }
    return env.data;
  } catch(e) {
    return null;
  }
}

function writeL2_(sheetName, data) {
  try {
    var payload = JSON.stringify({ data: data, expires: Date.now() + CACHE_TTL_STATIC * 1000 });
    if (payload.length > 9000) return; // PropertiesService per-key limit
    PropertiesService.getScriptProperties().setProperty(cacheKey_(sheetName, 'l2'), payload);
  } catch(e) {
    Logger.log('[CacheManager] writeL2_ error (' + sheetName + '): ' + e.message);
  }
}

function clearL2_(sheetName) {
  try {
    PropertiesService.getScriptProperties().deleteProperty(cacheKey_(sheetName, 'l2'));
  } catch(e) {}
}

// ============================================================================
// HELPERS
// ============================================================================

function cacheKey_(sheetName, suffix) {
  return CACHE_NS + sheetName + (suffix ? '_' + suffix : '');
}

function isStaticSheet_(sheetName) {
  return STATIC_SHEETS_.indexOf(sheetName) !== -1;
}
