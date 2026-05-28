/**
 * 20_mfa.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * global Mfa = { isRequiredFor(userType, userId),
 *                enrolStart(userType, userId),
 *                enrolVerify(challengeId, code),
 *                verify(challengeId, code) }
 *
 * TOTP RFC 6238 (HMAC-SHA-1, 30s step, 6 digits).
 * Challenges stored in the mfa_challenges table (not PropertiesService).
 * pending_secret lives only on the challenge row until enrolVerify succeeds.
 */

var Mfa = (function () {

  var _STEP_   = 30;
  var _DIGITS_ = 6;
  var _WINDOW_ = 1;  // ±1 step tolerance
  var _TTL_MIN_ = 5;
  var _MAX_FAILS_ = 5;

  // ── Table bootstrap ────────────────────────────────────────────────────────

  var _tableReady_ = false;

  function _ensureTable_() {
    if (_tableReady_) return;
    TursoClient.write(
      'CREATE TABLE IF NOT EXISTS mfa_challenges (' +
      ' challenge_id TEXT PRIMARY KEY,' +
      ' user_id TEXT NOT NULL,' +
      ' user_type TEXT NOT NULL,' +
      ' mode TEXT NOT NULL,' +
      ' pending_secret TEXT,' +
      ' fails INTEGER DEFAULT 0,' +
      ' expires_at TEXT NOT NULL,' +
      ' used INTEGER DEFAULT 0,' +
      ' created_at TEXT NOT NULL' +
      ')'
    );
    _tableReady_ = true;
  }

  // ── Base32 (RFC 4648, no padding) ──────────────────────────────────────────

  var _B32_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function _b32Encode_(signedBytes) {
    var bytes = signedBytes.map(function (b) { return b & 0xff; });
    var out = '', bits = 0, value = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += _B32_.charAt((value >>> bits) & 31);
      }
    }
    if (bits > 0) out += _B32_.charAt((value << (5 - bits)) & 31);
    return out;
  }

  function _b32Decode_(s) {
    var clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    var bytes = [], bits = 0, value = 0;
    for (var i = 0; i < clean.length; i++) {
      var idx = _B32_.indexOf(clean.charAt(i));
      if (idx < 0) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push(((value >>> bits) & 0xff) > 127 ? ((value >>> bits) & 0xff) - 256 : (value >>> bits) & 0xff);
      }
    }
    return bytes;
  }

  // ── TOTP ───────────────────────────────────────────────────────────────────

  function _generateSecret_() {
    var bytes = [];
    for (var i = 0; i < 20; i++) {
      var b = Math.floor(Math.random() * 256);
      bytes.push(b > 127 ? b - 256 : b);
    }
    return _b32Encode_(bytes);
  }

  function _counterBytes_(counter) {
    var hi = Math.floor(counter / 0x100000000);
    var lo = counter >>> 0;
    function s(b) { return b > 127 ? b - 256 : b; }
    return [
      s((hi >>> 24) & 0xff), s((hi >>> 16) & 0xff), s((hi >>> 8) & 0xff), s(hi & 0xff),
      s((lo >>> 24) & 0xff), s((lo >>> 16) & 0xff), s((lo >>> 8) & 0xff), s(lo & 0xff),
    ];
  }

  function _hotp_(secretBytes, counter) {
    var msg = _counterBytes_(counter);
    var sig = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, msg, secretBytes);
    var s   = sig.map(function (b) { return b & 0xff; });
    var off = s[s.length - 1] & 0x0f;
    var bin = ((s[off] & 0x7f) << 24) | ((s[off+1] & 0xff) << 16) |
              ((s[off+2] & 0xff) << 8)  |  (s[off+3] & 0xff);
    var mod = Math.pow(10, _DIGITS_);
    var otp = String(bin % mod);
    while (otp.length < _DIGITS_) otp = '0' + otp;
    return otp;
  }

  function _verifyCode_(secret, userCode) {
    if (!secret || !userCode) return false;
    var clean = String(userCode).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    var keyBytes = _b32Decode_(secret);
    if (!keyBytes.length) return false;
    var step = Math.floor(Date.now() / 1000 / _STEP_);
    for (var w = -_WINDOW_; w <= _WINDOW_; w++) {
      if (_hotp_(keyBytes, step + w) === clean) return true;
    }
    return false;
  }

  function _provisioningUri_(email, secret, issuer) {
    var iss   = encodeURIComponent(issuer || 'Hass Petroleum');
    var label = encodeURIComponent((issuer || 'Hass Petroleum') + ':' + (email || 'user'));
    return 'otpauth://totp/' + label +
      '?secret='    + encodeURIComponent(String(secret || '')) +
      '&issuer='    + iss +
      '&algorithm=SHA1' +
      '&digits='    + _DIGITS_ +
      '&period='    + _STEP_;
  }

  // ── Challenge helpers ──────────────────────────────────────────────────────

  function _createChallenge_(userId, userType, mode) {
    _ensureTable_();
    var id      = uuidv4();
    var expires = addMinutes(new Date(), _TTL_MIN_).toISOString();
    TursoClient.write(
      'INSERT INTO mfa_challenges (challenge_id,user_id,user_type,mode,pending_secret,fails,expires_at,used,created_at) ' +
      'VALUES (?,?,?,?,?,0,?,0,?)',
      [id, userId, userType, mode, null, expires, nowIso()]
    );
    return id;
  }

  function _getChallenge_(challengeId) {
    _ensureTable_();
    var rows = TursoClient.select(
      'SELECT * FROM mfa_challenges WHERE challenge_id = ? AND used = 0 AND expires_at > ? LIMIT 1',
      [challengeId, nowIso()]
    );
    return rows.length ? rows[0] : null;
  }

  function _markUsed_(challengeId) {
    TursoClient.write(
      'UPDATE mfa_challenges SET used = 1 WHERE challenge_id = ?', [challengeId]
    );
  }

  function _bumpFails_(challengeId) {
    var row = _getChallenge_(challengeId);
    if (!row) return { exhausted: true };
    var fails = (parseInt(row.fails, 10) || 0) + 1;
    if (fails >= _MAX_FAILS_) {
      _markUsed_(challengeId);
      return { exhausted: true, fails: fails };
    }
    TursoClient.write(
      'UPDATE mfa_challenges SET fails = ? WHERE challenge_id = ?', [fails, challengeId]
    );
    return { exhausted: false, fails: fails };
  }

  function _getUserMfaSecret_(userId, userType) {
    var table  = (userType === 'CUSTOMER') ? 'contacts' : 'users';
    var idCol  = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';
    var rows   = TursoClient.select(
      'SELECT mfa_secret FROM ' + table + ' WHERE ' + idCol + ' = ? LIMIT 1', [userId]
    );
    return (rows.length && rows[0].mfa_secret) ? rows[0].mfa_secret : null;
  }

  function _setUserMfaSecret_(userId, userType, secret) {
    var table = (userType === 'CUSTOMER') ? 'contacts' : 'users';
    var idCol = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';
    TursoClient.write(
      'UPDATE ' + table + ' SET mfa_secret = ?, mfa_enabled = 1, updated_at = ? WHERE ' + idCol + ' = ?',
      [secret, nowIso(), userId]
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function isRequiredFor(userType, userId) {
    if (!Config.getBool('MFA.ENFORCED', false)) return false;
    if (userType === 'CUSTOMER') return false; // portal users exempt unless config says otherwise

    // Check per-role.
    var roleRows = TursoClient.select(
      'SELECT role_code FROM user_roles WHERE user_id = ?', [userId]
    );
    for (var i = 0; i < roleRows.length; i++) {
      if (Rbac.isMfaRequiredForRole(roleRows[i].role_code)) return true;
    }
    // Legacy fallback: check users.role column.
    var uRows = TursoClient.select('SELECT role FROM users WHERE user_id = ? LIMIT 1', [userId]);
    if (uRows.length && Rbac.isMfaRequiredForRole(uRows[0].role)) return true;
    return false;
  }

  function enrolStart(userType, userId) {
    var challengeId = _createChallenge_(userId, userType, 'enroll');
    var secret      = _generateSecret_();
    // Store pending_secret on the challenge row.
    TursoClient.write(
      'UPDATE mfa_challenges SET pending_secret = ? WHERE challenge_id = ?',
      [secret, challengeId]
    );
    // Resolve email for the provisioning URI.
    var table  = (userType === 'CUSTOMER') ? 'contacts' : 'users';
    var idCol  = (userType === 'CUSTOMER') ? 'contact_id' : 'user_id';
    var uRows  = TursoClient.select('SELECT email FROM ' + table + ' WHERE ' + idCol + ' = ? LIMIT 1', [userId]);
    var email  = uRows.length ? (uRows[0].email || '') : '';
    var uri    = _provisioningUri_(email, secret, 'Hass Petroleum');
    return { challenge_id: challengeId, provisioning_uri: uri };
  }

  function enrolVerify(challengeId, code) {
    var ch = _getChallenge_(challengeId);
    if (!ch) throw new Errors.Validation('MFA challenge expired or not found.');
    if (ch.mode !== 'enroll') throw new Errors.Validation('Challenge mode mismatch.');
    if (!ch.pending_secret)   throw new Errors.Validation('Start enrolment first.');

    if (!_verifyCode_(ch.pending_secret, code)) {
      var bump = _bumpFails_(challengeId);
      if (bump.exhausted) throw new Errors.Validation('Too many invalid attempts. Please sign in again.');
      throw new Errors.Validation('Invalid code. Try again.');
    }

    _setUserMfaSecret_(ch.user_id, ch.user_type, ch.pending_secret);
    _markUsed_(challengeId);
    return { ok: true, userId: ch.user_id, userType: ch.user_type };
  }

  // Creates a verify-mode challenge (used by auth.login when mfa_secret exists).
  function startVerify(userType, userId) {
    return _createChallenge_(userId, userType, 'verify');
  }

  function verify(challengeId, code) {
    var ch = _getChallenge_(challengeId);
    if (!ch) throw new Errors.Validation('MFA challenge expired or not found.');
    if (ch.mode !== 'verify') throw new Errors.Validation('Challenge mode mismatch.');

    var secret = _getUserMfaSecret_(ch.user_id, ch.user_type);
    if (!secret) throw new Errors.Validation('MFA is not active on this account.');

    if (!_verifyCode_(secret, code)) {
      var bump = _bumpFails_(challengeId);
      if (bump.exhausted) throw new Errors.Validation('Too many invalid attempts. Please sign in again.');
      throw new Errors.Validation('Invalid code. Try again.');
    }

    _markUsed_(challengeId);
    return { ok: true, userId: ch.user_id, userType: ch.user_type };
  }

  return {
    isRequiredFor: isRequiredFor,
    enrolStart:    enrolStart,
    enrolVerify:   enrolVerify,
    startVerify:   startVerify,
    verify:        verify,
  };

})();
