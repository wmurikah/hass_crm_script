/**
 * 10_repo.gs  —  Hass CMS rebuild foundation
 *
 * Generic repository built on top of TursoClient.
 * Resolves the physical table name from TABLES and the PK column from PK
 * (both defined in 00_constants.gs).
 *
 * All table arguments accept the logical key (TABLES key) or the raw table name.
 *
 * Public API (namespace object Repo):
 *   findById(table, id)
 *   findOne(table, where)
 *   findMany(table, where, opts)
 *   create(table, row)
 *   update(table, id, patch)
 *   softDelete(table, id)   → sets is_active=0 / status='INACTIVE'
 *   count(table, where)
 */

// ── Internal helpers ──────────────────────────────────────────────────────────

function _repoTable_(table) {
  return TABLES[table] || table;
}

function _repoPk_(table) {
  var physTable = _repoTable_(table);
  var pkCol = PK[physTable] || PK[table];
  if (!pkCol) throw new Errors.AppError('No PK registered for table: ' + table, 'CONFIG_ERROR');
  return pkCol;
}

/**
 * Build a WHERE clause and positional args array from a plain object.
 * All conditions are ANDed with equality checks.
 */
function _repoWhere_(where) {
  var keys = Object.keys(where || {});
  if (!keys.length) return { clause: '', args: [] };
  var parts = keys.map(function (k) { return k + ' = ?'; });
  return {
    clause: 'WHERE ' + parts.join(' AND '),
    args:   keys.map(function (k) { return where[k]; }),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

var Repo = {

  /**
   * Look up a single row by primary key.
   * @returns {Object|null}
   */
  findById: function (table, id) {
    var t     = _repoTable_(table);
    var pkCol = _repoPk_(table);
    var rows  = TursoClient.select('SELECT * FROM ' + t + ' WHERE ' + pkCol + ' = ? LIMIT 1', [id]);
    return rows.length ? rows[0] : null;
  },

  /**
   * Return the first row matching all equality conditions in `where`.
   * @returns {Object|null}
   */
  findOne: function (table, where) {
    var t  = _repoTable_(table);
    var w  = _repoWhere_(where);
    var sql = 'SELECT * FROM ' + t + (w.clause ? ' ' + w.clause : '') + ' LIMIT 1';
    var rows = TursoClient.select(sql, w.args);
    return rows.length ? rows[0] : null;
  },

  /**
   * Return all rows matching `where`.
   * @param {Object}  [where]   equality conditions
   * @param {Object}  [opts]    { limit, offset, orderBy, orderDir }
   * @returns {Object[]}
   */
  findMany: function (table, where, opts) {
    var t  = _repoTable_(table);
    var w  = _repoWhere_(where);
    var o  = opts || {};

    var sql = 'SELECT * FROM ' + t;
    if (w.clause)   sql += ' ' + w.clause;
    if (o.orderBy)  sql += ' ORDER BY ' + o.orderBy + (o.orderDir === 'DESC' ? ' DESC' : ' ASC');
    if (o.limit)    sql += ' LIMIT '  + parseInt(o.limit,  10);
    if (o.offset)   sql += ' OFFSET ' + parseInt(o.offset, 10);

    return TursoClient.select(sql, w.args);
  },

  /**
   * Insert a row and return the write metadata.
   * @param {Object} row  plain column→value object
   * @returns {{ lastInsertId, rowsAffected }}
   */
  create: function (table, row) {
    var t    = _repoTable_(table);
    var keys = Object.keys(row);
    if (!keys.length) throw new Errors.Validation('create: no columns provided for ' + t);
    var cols   = keys.join(', ');
    var places = keys.map(function () { return '?'; }).join(', ');
    var args   = keys.map(function (k) { return row[k]; });
    return TursoClient.write('INSERT INTO ' + t + ' (' + cols + ') VALUES (' + places + ')', args);
  },

  /**
   * Update columns in `patch` for the row identified by `id`.
   * @param {Object} patch  column→value pairs to SET
   * @returns {{ lastInsertId, rowsAffected }}
   */
  update: function (table, id, patch) {
    var t     = _repoTable_(table);
    var pkCol = _repoPk_(table);
    var keys  = Object.keys(patch).filter(function (k) { return k !== pkCol; });
    if (!keys.length) throw new Errors.Validation('update: no columns to update for ' + t);
    var sets = keys.map(function (k) { return k + ' = ?'; }).join(', ');
    var args = keys.map(function (k) { return patch[k]; });
    args.push(id);
    return TursoClient.write('UPDATE ' + t + ' SET ' + sets + ' WHERE ' + pkCol + ' = ?', args);
  },

  /**
   * Soft-delete a row by setting is_active=0 and updated_at to now.
   * For tables that track lifecycle via a status column, use update() instead.
   * @returns {{ lastInsertId, rowsAffected }}
   */
  softDelete: function (table, id) {
    var t     = _repoTable_(table);
    var pkCol = _repoPk_(table);
    return TursoClient.write(
      'UPDATE ' + t + ' SET is_active = 0, updated_at = ? WHERE ' + pkCol + ' = ?',
      [nowIso(), id]
    );
  },

  /**
   * Count rows matching `where`.
   * @returns {number}
   */
  count: function (table, where) {
    var t    = _repoTable_(table);
    var w    = _repoWhere_(where);
    var sql  = 'SELECT COUNT(*) AS n FROM ' + t + (w.clause ? ' ' + w.clause : '');
    var rows = TursoClient.select(sql, w.args);
    return rows.length ? (parseInt(rows[0].n, 10) || 0) : 0;
  },
};
