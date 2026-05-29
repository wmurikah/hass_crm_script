/**
 * 20_password.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * global Password = { hash(plain), verify(plain,stored),
 *                     validatePolicy(plain,userId,userType),
 *                     historyCheck(userId,userType,plain) }
 *
 * Stored format: pbkdf2$1000$<salt-base64>$<hash-base64>
 * Algorithm: PBKDF2-HMAC-SHA-256, 1 000 iterations, 16-byte salt, 32-byte DK.
 *
 * NOTE: SHA-256 is used ONLY for token hashing (20_session.gs).
 *       Password paths NEVER use raw SHA-256.
 */

var Password = (function () {

  // ── PBKDF2-HMAC-SHA-256 ──────────────────────────────────────────────────

  function _hmac256_(keyBytes, msgBytes) {
    // Both arguments are signed-byte arrays (-128..127) as GAS expects.
    return Utilities.computeHmacSignature(
      Utilities.MacAlgorithm.HMAC_SHA_256, msgBytes, keyBytes
    );
  }

  function _strToSignedBytes_(str) {
    return Utilities.newBlob(str, 'UTF-8').getBytes();
  }

  function _pbkdf2_(passwordStr, saltSignedBytes, iterations, dkLen) {
    var pwBytes = _strToSignedBytes_(passwordStr);
    var hLen    = 32; // SHA-256 output bytes
    var blocks  = Math.ceil(dkLen / hLen);
    var dk      = [];

    for (var i = 1; i <= blocks; i++) {
      // saltBlock = salt || INT(i) in big-endian
      var saltBlock = saltSignedBytes.concat([
        _signed_((i >>> 24) & 0xff),
        _signed_((i >>> 16) & 0xff),
        _signed_((i >>>  8) & 0xff),
        _signed_( i         & 0xff),
      ]);

      var U = _hmac256_(pwBytes, saltBlock);
      var T = U.slice();

      for (var j = 1; j < iterations; j++) {
        U = _hmac256_(pwBytes, U);
        for (var k = 0; k < hLen; k++) {
          T[k] = _signed_((T[k] & 0xff) ^ (U[k] & 0xff));
        }
      }

      dk = dk.concat(T);
    }

    return dk.slice(0, dkLen);
  }

  function _signed_(b) { return b > 127 ? b - 256 : b; }

  // ── Public API ────────────────────────────────────────────────────────────

  function hash(plain) {
    if (!plain) throw new Errors.Validation('Password cannot be empty.');
    // 16 random bytes, converted to signed range for GAS.
    var saltUnsigned = [];
    for (var i = 0; i < 16; i++) saltUnsigned.push(Math.floor(Math.random() * 256));
    var saltSigned = saltUnsigned.map(_signed_);

    var dk     = _pbkdf2_(plain, saltSigned, 1000, 32);
    var saltB64 = Utilities.base64Encode(saltSigned);
    var hashB64 = Utilities.base64Encode(dk);
    return 'pbkdf2$1000$' + saltB64 + '$' + hashB64;
  }

  function verify(plain, stored) {
    if (!plain || !stored) return false;
    var parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    var iterations = parseInt(parts[1], 10);
    var saltSigned;
    var storedHash;
    try {
      saltSigned  = Utilities.base64Decode(parts[2]); // returns signed bytes
      storedHash  = parts[3];
    } catch (_) {
      return false;
    }
    var dk     = _pbkdf2_(plain, saltSigned, iterations, 32);
    var hashB64 = Utilities.base64Encode(dk);
    // Constant-time comparison via XOR (simple; same-length strings guaranteed).
    if (hashB64.length !== storedHash.length) return false;
    var diff = 0;
    for (var i = 0; i < hashB64.length; i++) {
      diff |= hashB64.charCodeAt(i) ^ storedHash.charCodeAt(i);
    }
    return diff === 0;
  }

  function validatePolicy(plain, userId, userType) {
    if (!plain || typeof plain !== 'string') {
      throw new Errors.Validation('Password is required.');
    }
    var minLen = Config.getNumber('PASSWORD.MIN_LENGTH', 12);
    if (plain.length < minLen) {
      throw new Errors.Validation('Password must be at least ' + minLen + ' characters.');
    }
    var reqUpper   = Config.getBool('PASSWORD.REQUIRE_UPPER',   true);
    var reqLower   = Config.getBool('PASSWORD.REQUIRE_LOWER',   true);
    var reqDigit   = Config.getBool('PASSWORD.REQUIRE_DIGIT',   true);
    var reqSpecial = Config.getBool('PASSWORD.REQUIRE_SPECIAL', true);
    if (reqUpper   && !/[A-Z]/.test(plain))       throw new Errors.Validation('Password must contain at least one uppercase letter.');
    if (reqLower   && !/[a-z]/.test(plain))       throw new Errors.Validation('Password must contain at least one lowercase letter.');
    if (reqDigit   && !/[0-9]/.test(plain))       throw new Errors.Validation('Password must contain at least one digit.');
    if (reqSpecial && !/[^A-Za-z0-9]/.test(plain)) throw new Errors.Validation('Password must contain at least one special character.');

    if (userId) {
      historyCheck(userId, userType, plain);
    }
    return true;
  }

  function historyCheck(userId, userType, plain) {
    var n = Config.getNumber('PASSWORD.HISTORY_N', 5);
    if (!n || !userId) return;
    var rows = TursoClient.select(
      'SELECT password_hash FROM password_history WHERE user_id = ? AND user_type = ? ' +
      'ORDER BY created_at DESC LIMIT ?',
      [userId, userType || 'STAFF', n]
    );
    for (var i = 0; i < rows.length; i++) {
      if (verify(plain, rows[i].password_hash)) {
        throw new Errors.Validation(
          'You cannot reuse one of your last ' + n + ' passwords.'
        );
      }
    }
  }

  return { hash: hash, verify: verify, validatePolicy: validatePolicy, historyCheck: historyCheck };

})();
