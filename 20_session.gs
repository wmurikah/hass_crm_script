/**
 * 20_session.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * global Session = { create(userId,userType,role,ip,ua,countryCode),
 *                    validate(token),
 *                    invalidate(token),
 *                    invalidateAllForUser(userId,userType) }
 *
 * All state lives in the sessions table.
 * token_hash = SHA-256 hex of the raw bearer token.
 * Idle timeout from Config(SESSION.IDLE_TIMEOUT_MIN), default 30.
 * Concurrent cap from Config(SESSION.MAX_CONCURRENT), default 5.
 */

var Session = (function () {

  function _sha256Hex_(str) {
    var raw = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8
    );
    return raw.map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    }).join('');
  }

  function _idleTimeoutMin_() {
    return Config.getNumber('SESSION.IDLE_TIMEOUT_MIN', 30);
  }

  function _maxConcurrent_() {
    return Config.getNumber('SESSION.MAX_CONCURRENT', 5);
  }

  function create(userId, userType, role, ip, ua, countryCode) {
    var rawToken  = uuidv4() + Date.now().toString(36);
    var tokenHash = _sha256Hex_(rawToken);
    var sessionId = uuidv4();
    var now       = nowIso();
    var idleMin   = _idleTimeoutMin_();
    var expiresAt = addMinutes(new Date(), idleMin * 2).toISOString(); // hard expiry = 2× idle

    // Enforce concurrent session cap: invalidate oldest sessions over limit.
    try {
      var max = _maxConcurrent_();
      var active = TursoClient.select(
        'SELECT session_id FROM sessions WHERE user_id = ? AND user_type = ? AND is_active = 1 ' +
        'AND expires_at > ? ORDER BY created_at ASC',
        [userId, userType, now]
      );
      if (active.length >= max) {
        var toKill = active.slice(0, active.length - max + 1);
        toKill.forEach(function (s) {
          try {
            TursoClient.write(
              'UPDATE sessions SET is_active = 0 WHERE session_id = ?',
              [s.session_id]
            );
          } catch (_) {}
        });
      }
    } catch (e) {
      Log.warn({ service: 'Session', action: 'create', msg: 'cap check: ' + e.message });
    }

    TursoClient.write(
      'INSERT INTO sessions ' +
      '(session_id, user_type, user_id, token_hash, ip_address, user_agent, ' +
      'country_code, role, is_active, expires_at, idle_timeout_minutes, ' +
      'last_activity_at, created_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,1,?,?,datetime(\'now\'),datetime(\'now\'))',
      [sessionId, userType, userId, tokenHash, ip || '', ua || '',
       countryCode || '', role, expiresAt, idleMin]
    );
    return { token: rawToken, session_id: sessionId };
  }

  function validate(token) {
    if (!token) return null;
    var tokenHash = _sha256Hex_(token);
    var now       = new Date();
    var nowStr    = now.toISOString();

    var rows = TursoClient.select(
      'SELECT * FROM sessions WHERE token_hash = ? AND is_active = 1 AND expires_at > ? LIMIT 1',
      [tokenHash, nowStr]
    );
    if (!rows.length) return null;
    var sess = rows[0];

    // Idle timeout check.
    var idleMs = now - new Date(sess.last_activity_at || sess.created_at);
    var idleLimit = _idleTimeoutMin_() * 60000;
    if (idleMs > idleLimit) {
      TursoClient.write(
        'UPDATE sessions SET is_active = 0 WHERE session_id = ?',
        [sess.session_id]
      );
      return null;
    }

    // Touch last_activity_at.
    try {
      TursoClient.write(
        "UPDATE sessions SET last_activity_at = datetime('now') WHERE session_id = ?",
        [sess.session_id]
      );
    } catch (_) {}

    return {
      sessionId:   sess.session_id,
      userId:      sess.user_id,
      userType:    sess.user_type,
      role:        sess.role,
      countryCode: sess.country_code  || '',
      ip:          sess.ip_address    || '',
      ua:          sess.user_agent    || '',
    };
  }

  function invalidate(token) {
    if (!token) return;
    var tokenHash = _sha256Hex_(token);
    TursoClient.write(
      'UPDATE sessions SET is_active = 0 WHERE token_hash = ?',
      [tokenHash]
    );
  }

  function invalidateAllForUser(userId, userType) {
    if (!userId) return;
    var sql  = 'UPDATE sessions SET is_active = 0 WHERE user_id = ?';
    var args = [userId];
    if (userType) { sql += ' AND user_type = ?'; args.push(userType); }
    TursoClient.write(sql, args);
  }

  return {
    create:               create,
    validate:             validate,
    invalidate:           invalidate,
    invalidateAllForUser: invalidateAllForUser,
  };

})();

// ── resolveSession_ used by 30_router.gs ─────────────────────────────────────

/**
 * Resolve a bearer token to a session object.
 * Returns null if the token is missing, expired, or idle-timed-out.
 */
function resolveSession_(token) {
  if (!token) return null;
  var sess = Session.validate(token);
  if (!sess) return null;
  // Shape expected by 30_router.gs: { userId, userType, role }
  return sess;
}
