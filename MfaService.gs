// ================================================================
// HASS PETROLEUM CMS - MfaService.gs
// G-008: TOTP-based multi-factor authentication for privileged roles.
//
// Public API
//   MFA_REQUIRED_ROLES                     - centralised role list (also
//                                            re-exported from AuthService).
//   userRequiresMfa(userId)                - true if user holds any role
//                                            in MFA_REQUIRED_ROLES.
//   generateSecret()                       - random Base32 TOTP secret
//   verifyCode(secret, userCode)           - RFC 6238 verify, +/- 1 step
//   provisioningUri(email, secret, issuer) - otpauth:// URI
//   provisioningQrUrl(uri)                 - Google Charts QR image URL
//
//   createMfaChallenge(userId, userType, role, mode)
//   getMfaChallenge(challengeToken)
//   consumeMfaChallenge(challengeToken)
//   incrementChallengeFailure(challengeToken)
//
// All MFA secrets are stored Base32 (no padding). The TOTP implementation
// uses HMAC-SHA1 with a 30s step and 6-digit codes (Google Authenticator,
// Authy, 1Password compatible).
// ================================================================

var MFA_REQUIRED_ROLES = [
  'SUPER_ADMIN',
  'CEO', 'CFO', 'RMD',
  'INTERNAL_AUDITOR',
  'FINANCE_MANAGER',
];

// User IDs explicitly exempt from MFA (e.g. test/dummy accounts).
// Add to Script Property MFA_EXEMPT_IDS as a comma-separated list,
// or hard-code IDs here for permanent exemptions.
var MFA_EXEMPT_USER_IDS = [
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890', // peryne.danois@dummy.com
];

var MFA_TOTP_STEP_SECONDS_     = 30;
var MFA_TOTP_DIGITS_           = 6;
var MFA_TOTP_WINDOW_           = 1;            // +/- 1 step tolerance
var MFA_CHALLENGE_TTL_MINUTES_ = 5;
var MFA_CHALLENGE_MAX_FAILS_   = 5;
var MFA_CHALLENGE_PREFIX_      = 'MFA_CHL_';

// ----------------------------------------------------------------
// Role check
// ----------------------------------------------------------------

function userRequiresMfa(userId) {
  if (!userId) return false;

  // Check hard-coded exempt list.
  if (MFA_EXEMPT_USER_IDS.indexOf(userId) !== -1) return false;

  // Check Script Property exempt list (comma-separated user IDs).
  try {
    var exemptProp = PropertiesService.getScriptProperties().getProperty('MFA_EXEMPT_IDS') || '';
    var exemptIds  = exemptProp.split(',').map(function(s) { return s.trim(); });
    if (exemptIds.indexOf(userId) !== -1) return false;
  } catch(e) {}

  try {
    var rows = tursoSelect(
      'SELECT role_code FROM user_roles WHERE user_id = ?', [userId]
    );
    for (var i = 0; i < rows.length; i++) {
      if (MFA_REQUIRED_ROLES.indexOf(String(rows[i].role_code || '').toUpperCase()) !== -1) {
        return true;
      }
    }
  } catch(e) {
    Logger.log('[MfaService] userRequiresMfa user_roles lookup failed: ' + e.message);
  }
  // Fall back to legacy users.role string when user_roles is empty.
  try {
    var u = findRow('Users', 'user_id', userId);
    if (u && MFA_REQUIRED_ROLES.indexOf(String(u.role || '').toUpperCase()) !== -1) {
      return true;
    }
  } catch(e) {}
  return false;
}

// ----------------------------------------------------------------
// Base32 (RFC 4648) - no padding
// ----------------------------------------------------------------

var _MFA_B32_ALPHABET_ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function _mfaBase32Encode_(bytes) {
  var out = '';
  var bits = 0, value = 0;
  for (var i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += _MFA_B32_ALPHABET_.charAt((value >>> bits) & 31);
    }
  }
  if (bits > 0) out += _MFA_B32_ALPHABET_.charAt((value << (5 - bits)) & 31);
  return out;
}

function _mfaBase32Decode_(s) {
  var clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  var bytes = [];
  var bits = 0, value = 0;
  for (var i = 0; i < clean.length; i++) {
    var idx = _MFA_B32_ALPHABET_.indexOf(clean.charAt(i));
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return bytes;
}

// ----------------------------------------------------------------
// TOTP (RFC 6238)
// ----------------------------------------------------------------

function generateSecret() {
  // 20 random bytes -> 32 Base32 chars (160-bit, RFC-recommended).
  var bytes = [];
  for (var i = 0; i < 20; i++) bytes.push(Math.floor(Math.random() * 256));
  return _mfaBase32Encode_(bytes);
}

function _mfaCounterBytes_(counter) {
  // 8-byte big-endian. JS bitwise ops are 32-bit, so split.
  var hi = Math.floor(counter / 0x100000000);
  var lo = counter & 0xffffffff;
  return [
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  ];
}

function _mfaHotp_(secretBytes, counter) {
  var msg = _mfaCounterBytes_(counter);
  var key = Utilities.newBlob(secretBytes).getBytes();
  var sigBytes = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_1, msg, key
  );
  // Sigs come as signed bytes; mask before use.
  var sig = sigBytes.map(function(b) { return b & 0xff; });
  var offset = sig[sig.length - 1] & 0x0f;
  var bin =
    ((sig[offset]     & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) <<  8) |
     (sig[offset + 3] & 0xff);
  var mod = Math.pow(10, MFA_TOTP_DIGITS_);
  var otp = String(bin % mod);
  while (otp.length < MFA_TOTP_DIGITS_) otp = '0' + otp;
  return otp;
}

function verifyCode(secret, userCode) {
  if (!secret || !userCode) return false;
  var clean = String(userCode).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  var keyBytes = _mfaBase32Decode_(secret);
  if (!keyBytes.length) return false;
  var step = Math.floor(Date.now() / 1000 / MFA_TOTP_STEP_SECONDS_);
  for (var w = -MFA_TOTP_WINDOW_; w <= MFA_TOTP_WINDOW_; w++) {
    if (_mfaHotp_(keyBytes, step + w) === clean) return true;
  }
  return false;
}

function provisioningUri(email, secret, issuer) {
  var iss = encodeURIComponent(issuer || 'Hass Petroleum');
  var label = encodeURIComponent((issuer || 'Hass Petroleum') + ':' + (email || 'user'));
  return 'otpauth://totp/' + label +
    '?secret=' + encodeURIComponent(String(secret || '')) +
    '&issuer=' + iss +
    '&algorithm=SHA1' +
    '&digits=' + MFA_TOTP_DIGITS_ +
    '&period=' + MFA_TOTP_STEP_SECONDS_;
}

function provisioningQrUrl(uri) {
  return 'https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=' +
    encodeURIComponent(uri || '');
}

// ----------------------------------------------------------------
// Challenge tokens
//
// After a user passes password validation but still owes MFA, we hand out
// a short-lived challenge token. The token is not a session and grants no
// access on its own - it only authorises completing the MFA step for that
// one user.
//
// Stored in PropertiesService (per-script, server-only). Each entry:
//   { user_id, user_type, role, mode: 'enroll'|'verify',
//     pending_secret: <base32 or ''>, fails: <int>, expires_at: <ISO> }
// ----------------------------------------------------------------

function _mfaChallengeKey_(token) { return MFA_CHALLENGE_PREFIX_ + token; }

function createMfaChallenge(userId, userType, role, mode) {
  var token   = Utilities.getUuid().replace(/-/g, '') + Date.now().toString(36);
  var expires = new Date(Date.now() + MFA_CHALLENGE_TTL_MINUTES_ * 60000).toISOString();
  var entry = {
    user_id:        String(userId  || ''),
    user_type:      String(userType || 'STAFF'),
    role:           String(role    || ''),
    mode:           mode === 'enroll' ? 'enroll' : 'verify',
    pending_secret: '',
    fails:          0,
    expires_at:     expires,
  };
  PropertiesService.getScriptProperties()
    .setProperty(_mfaChallengeKey_(token), JSON.stringify(entry));
  return token;
}

function getMfaChallenge(token) {
  if (!token) return null;
  var raw = PropertiesService.getScriptProperties().getProperty(_mfaChallengeKey_(token));
  if (!raw) return null;
  try {
    var entry = JSON.parse(raw);
    if (new Date(entry.expires_at) < new Date()) {
      consumeMfaChallenge(token);
      return null;
    }
    return entry;
  } catch(e) {
    return null;
  }
}

function _saveMfaChallenge_(token, entry) {
  PropertiesService.getScriptProperties()
    .setProperty(_mfaChallengeKey_(token), JSON.stringify(entry));
}

function consumeMfaChallenge(token) {
  if (!token) return;
  PropertiesService.getScriptProperties().deleteProperty(_mfaChallengeKey_(token));
}

function incrementChallengeFailure(token) {
  var entry = getMfaChallenge(token);
  if (!entry) return null;
  entry.fails = (parseInt(entry.fails, 10) || 0) + 1;
  if (entry.fails >= MFA_CHALLENGE_MAX_FAILS_) {
    consumeMfaChallenge(token);
    return { exhausted: true, fails: entry.fails };
  }
  _saveMfaChallenge_(token, entry);
  return { exhausted: false, fails: entry.fails };
}

function setMfaChallengePendingSecret(token, secret) {
  var entry = getMfaChallenge(token);
  if (!entry) return false;
  entry.pending_secret = String(secret || '');
  _saveMfaChallenge_(token, entry);
  return true;
}
