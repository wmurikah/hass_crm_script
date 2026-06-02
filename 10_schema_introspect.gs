/**
 * 10_schema_introspect.gs  —  Hass CMS rebuild
 *
 * Lightweight runtime schema introspection over Turso (libSQL).
 *
 * Some physical tables expose columns whose exact names differ from what the
 * historical service code assumed (e.g. price_list's status column, the
 * knowledge_* label columns). Rather than hard-code a guess, services discover
 * the real column at execution time via PRAGMA table_info and adapt their SQL.
 *
 * Results are memoised for the lifetime of a single GAS invocation.
 *
 *   SchemaIntrospect.columns(table)            → ['col1', 'col2', ...]
 *   SchemaIntrospect.has(table, column)        → boolean
 *   SchemaIntrospect.pick(table, candidates[]) → first existing column name|null
 */

var SchemaIntrospect = (function () {

  var _cache = {};

  function columns(table) {
    if (_cache[table]) return _cache[table];
    var cols = [];
    try {
      var rows = TursoClient.select('PRAGMA table_info(' + table + ')');
      cols = rows.map(function (r) { return String(r.name); });
    } catch (e) {
      try { Logger.log('[SchemaIntrospect] columns(' + table + ') failed: ' + e.message); } catch (_) {}
    }
    _cache[table] = cols;
    return cols;
  }

  function has(table, column) {
    var lc = String(column).toLowerCase();
    return columns(table).some(function (c) { return c.toLowerCase() === lc; });
  }

  /**
   * Return the first candidate (case-insensitive) that actually exists as a
   * column on the table, preserving the real on-disk spelling. null if none.
   */
  function pick(table, candidates) {
    var cols = columns(table);
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < cols.length; j++) {
        if (cols[j].toLowerCase() === String(candidates[i]).toLowerCase()) {
          return cols[j];
        }
      }
    }
    return null;
  }

  return { columns: columns, has: has, pick: pick };

})();
