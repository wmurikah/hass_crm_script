/**
 * 20_config.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * global Config = { get(key), getNumber(key,def), getBool(key,def),
 *                   getJson(key,def), set(key,value,country) }
 *
 * Rows with a country_code value override global (empty country_code) rows.
 * Cached via AppCache (10_cache.gs).
 */

var Config = (function () {

  var _TTL_ = 300; // seconds

  function _cacheKey_(key, country) {
    return 'cfg:' + key + (country ? ':' + country : '');
  }

  function _fetch_(key, country) {
    var cKey = _cacheKey_(key, country);
    return AppCache.getOrSet(cKey, _TTL_, function () {
      var rows;
      if (country) {
        rows = TursoClient.select(
          'SELECT config_value FROM config WHERE config_key = ? AND country_code = ? LIMIT 1',
          [key, country]
        );
        if (rows.length) return rows[0].config_value;
      }
      // Global (no country scope)
      rows = TursoClient.select(
        "SELECT config_value FROM config WHERE config_key = ? AND (country_code IS NULL OR country_code = '') LIMIT 1",
        [key]
      );
      return rows.length ? rows[0].config_value : null;
    });
  }

  function get(key, country) {
    return _fetch_(key, country || '');
  }

  function getNumber(key, def) {
    var v = get(key);
    if (v === null || v === undefined || v === '') return (def !== undefined ? def : 0);
    var n = Number(v);
    return isNaN(n) ? (def !== undefined ? def : 0) : n;
  }

  function getBool(key, def) {
    var v = get(key);
    if (v === null || v === undefined || v === '') return (def !== undefined ? def : false);
    return String(v).trim().toLowerCase() === 'true' || String(v).trim() === '1';
  }

  function getJson(key, def) {
    var v = get(key);
    if (v === null || v === undefined) return (def !== undefined ? def : null);
    return jsonParse(v, def !== undefined ? def : null);
  }

  function set(key, value, country) {
    var countryCode = country || '';
    AppCache.invalidate(_cacheKey_(key, countryCode));
    // Upsert: delete existing row then insert
    TursoClient.write(
      'DELETE FROM config WHERE config_key = ? AND (country_code = ? OR (country_code IS NULL AND ? = \'\'))',
      [key, countryCode, countryCode]
    );
    TursoClient.write(
      'INSERT INTO config (config_key, config_value, country_code, updated_by, updated_at) VALUES (?,?,?,?,?)',
      [key, String(value), countryCode, 'SYSTEM', nowIso()]
    );
  }

  return { get: get, getNumber: getNumber, getBool: getBool, getJson: getJson, set: set };

})();
