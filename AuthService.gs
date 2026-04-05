/**
 * AuthService.gs
 * Hass Petroleum CMS Authentication Service
 *
 * Handles staff (Google SSO) and customer (email/password) authentication,
 * session management, password resets, and OAuth callbacks.
 *
 * Dependencies: DatabaseSetup.gs / DatabaseService.gs
 *   - getById, findRow, appendRow, updateRow, findWhere, logAudit, clearSheetCache
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var AUTH_SESSION_EXPIRY_HOURS = 24;
var AUTH_MAX_FAILED_ATTEMPTS = 5;
var AUTH_LOCKOUT_MINUTES = 30;
var AUTH_ALLOWED_DOMAINS = ['hasspetroleum.com', 'hassgroup.com'];
var AUTH_GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

// ---------------------------------------------------------------------------
// Main Router
// ---------------------------------------------------------------------------

/**
 * Routes an incoming authentication request to the appropriate handler.
 *
 * @param {Object} params - Must include an `action` property.
 * @returns {Object} Standardised response {success, data/error}.
 */
function handleAuthRequest(params) {
  try {
    if (!params || !params.action) {
      return { success: false, error: 'Missing required parameter: action' };
    }

    switch (params.action) {
      case 'staffLogin':
        return staffLogin(params);
      case 'customerLogin':
        return customerLogin(params);
      case 'customerRegister':
        return customerRegister(params);
      case 'validateSession':
        return validateSession(params);
      case 'logout':
        return logout(params);
      case 'changePassword':
        return changePassword(params);
      case 'resetPassword':
        return resetPasswordRequest(params);
      case 'confirmReset':
        return confirmPasswordReset(params);
      case 'oauthCallback':
        return handleOAuthCallback(params);
      default:
        return { success: false, error: 'Unknown auth action: ' + params.action };
    }
  } catch (e) {
    Logger.log('[AuthService] handleAuthRequest error: ' + e.message);
    return { success: false, error: 'Authentication service error: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Staff Login (Google SSO)
// ---------------------------------------------------------------------------

/**
 * Authenticates a staff member via a Google ID token.
 *
 * Flow:
 *  1. Verify the token against Google's tokeninfo endpoint.
 *  2. Ensure the email domain is in the allow-list.
 *  3. Look up the user in the Users collection.
 *  4. Create and return a session.
 *
 * @param {Object} params - { token: string }
 * @returns {Object} { success, data: { session, user } } or error.
 */
function staffLogin(params) {
  try {
    if (!params.token) {
      return { success: false, error: 'Google ID token is required' };
    }

    // 1. Verify token with Google
    var response = UrlFetchApp.fetch(AUTH_GOOGLE_TOKENINFO_URL + params.token, {
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      return { success: false, error: 'Invalid or expired Google token' };
    }

    var tokenPayload = JSON.parse(response.getContentText());
    var email = (tokenPayload.email || '').toLowerCase().trim();

    if (!email) {
      return { success: false, error: 'Token does not contain an email address' };
    }

    // 2. Domain check
    if (!isAllowedDomain(email)) {
      return { success: false, error: 'Email domain is not authorised for staff access' };
    }

    // 3. Look up user record
    var user = findRow('Users', 'email', email);
    if (!user) {
      return { success: false, error: 'No staff account found for this email. Contact an administrator.' };
    }

    if (user.status === 'inactive' || user.status === 'suspended') {
      return { success: false, error: 'Account is ' + user.status + '. Contact an administrator.' };
    }

    // 4. Create session
    var session = createSession('staff', user.id, {
      email: email,
      name: tokenPayload.name || user.name,
      role: user.role,
      picture: tokenPayload.picture || ''
    });

    // Update last login timestamp
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Users', 'id', user.id, { last_login: new Date().toISOString() });
    } finally {
      lock.releaseLock();
    }

    logAudit('staff_login', 'Users', user.id, null, { email: email });

    return {
      success: true,
      data: {
        session: session,
        user: {
          id: user.id,
          name: user.name || tokenPayload.name,
          email: email,
          role: user.role,
          picture: tokenPayload.picture || ''
        }
      }
    };
  } catch (e) {
    Logger.log('[AuthService] staffLogin error: ' + e.message);
    return { success: false, error: 'Staff login failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Customer Login (email / password)
// ---------------------------------------------------------------------------

/**
 * Authenticates a customer using email and password with rate-limiting.
 *
 * @param {Object} params - { email: string, password: string }
 * @returns {Object} { success, data: { session, contact } } or error.
 */
function customerLogin(params) {
  try {
    if (!params.email || !params.password) {
      return { success: false, error: 'Email and password are required' };
    }

    var email = params.email.toLowerCase().trim();

    var contact = findRow('Contacts', 'email', email);
    if (!contact) {
      return { success: false, error: 'Invalid email or password' };
    }

    // Rate-limit check
    var rateLimitResult = checkRateLimit(contact.id);
    if (!rateLimitResult.allowed) {
      return {
        success: false,
        error: 'Account temporarily locked due to too many failed attempts. Please try again after ' +
               rateLimitResult.minutes_remaining + ' minutes.'
      };
    }

    // Verify password
    var hashedInput = hashPassword(params.password);
    if (hashedInput !== contact.password_hash) {
      incrementFailedAttempts(contact.id);
      return { success: false, error: 'Invalid email or password' };
    }

    // Successful — reset failed attempts
    resetFailedAttempts(contact.id);

    // Check account status
    if (contact.status === 'inactive' || contact.status === 'suspended') {
      return { success: false, error: 'Account is ' + contact.status + '. Please contact support.' };
    }

    // Create session
    var session = createSession('customer', contact.id, {
      email: email,
      name: contact.name || contact.first_name || '',
      contact_type: contact.contact_type || 'individual'
    });

    // Update last login
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Contacts', 'id', contact.id, { last_login: new Date().toISOString() });
    } finally {
      lock.releaseLock();
    }

    logAudit('customer_login', 'Contacts', contact.id, null, { email: email });

    return {
      success: true,
      data: {
        session: session,
        contact: {
          id: contact.id,
          name: contact.name || ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim(),
          email: email,
          contact_type: contact.contact_type || 'individual'
        }
      }
    };
  } catch (e) {
    Logger.log('[AuthService] customerLogin error: ' + e.message);
    return { success: false, error: 'Customer login failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Customer Registration
// ---------------------------------------------------------------------------

/**
 * Registers a new customer account.
 *
 * @param {Object} params - { email, password, name, phone, ... }
 * @returns {Object} { success, data: { contact } } or error.
 */
function customerRegister(params) {
  try {
    if (!params.email || !params.password) {
      return { success: false, error: 'Email and password are required' };
    }

    if (params.password.length < 8) {
      return { success: false, error: 'Password must be at least 8 characters' };
    }

    var email = params.email.toLowerCase().trim();

    // Check for existing account
    var existing = findRow('Contacts', 'email', email);
    if (existing) {
      return { success: false, error: 'An account with this email already exists' };
    }

    var now = new Date().toISOString();
    var contactData = {
      id: Utilities.getUuid(),
      email: email,
      password_hash: hashPassword(params.password),
      name: params.name || '',
      first_name: params.first_name || '',
      last_name: params.last_name || '',
      phone: params.phone || '',
      contact_type: params.contact_type || 'individual',
      status: 'active',
      failed_login_attempts: 0,
      locked_until: '',
      created_at: now,
      updated_at: now
    };

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      appendRow('Contacts', contactData);
    } finally {
      lock.releaseLock();
    }

    logAudit('customer_register', 'Contacts', contactData.id, null, { email: email });

    return {
      success: true,
      data: {
        contact: {
          id: contactData.id,
          email: email,
          name: contactData.name || ((contactData.first_name || '') + ' ' + (contactData.last_name || '')).trim(),
          contact_type: contactData.contact_type
        }
      }
    };
  } catch (e) {
    Logger.log('[AuthService] customerRegister error: ' + e.message);
    return { success: false, error: 'Registration failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Session Validation
// ---------------------------------------------------------------------------

/**
 * Validates an existing session token.
 *
 * Checks that the session exists, is active, and has not expired (24 h).
 * On success the last_activity timestamp is refreshed.
 *
 * @param {Object} params - { session_id: string }
 * @returns {Object} { success, data: { session } } or error.
 */
function validateSession(params) {
  try {
    if (!params.session_id) {
      return { success: false, error: 'Session ID is required' };
    }

    var session = findRow('Sessions', 'session_id', params.session_id);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    if (!session.is_active || session.is_active === 'false' || session.is_active === false) {
      return { success: false, error: 'Session is no longer active' };
    }

    // Expiry check (24 hours)
    var createdAt = new Date(session.created_at);
    var now = new Date();
    var hoursElapsed = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);

    if (hoursElapsed > AUTH_SESSION_EXPIRY_HOURS) {
      // Mark expired
      var lock = LockService.getScriptLock();
      try {
        lock.waitLock(30000);
        updateRow('Sessions', 'session_id', params.session_id, {
          is_active: false,
          expired_at: now.toISOString()
        });
      } finally {
        lock.releaseLock();
      }
      return { success: false, error: 'Session has expired. Please log in again.' };
    }

    // Refresh last_activity
    var lock2 = LockService.getScriptLock();
    try {
      lock2.waitLock(30000);
      updateRow('Sessions', 'session_id', params.session_id, {
        last_activity: now.toISOString()
      });
    } finally {
      lock2.releaseLock();
    }

    return {
      success: true,
      data: {
        session: {
          session_id: session.session_id,
          user_type: session.user_type,
          user_id: session.user_id,
          metadata: session.metadata ? (typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata) : {},
          created_at: session.created_at,
          last_activity: now.toISOString()
        }
      }
    };
  } catch (e) {
    Logger.log('[AuthService] validateSession error: ' + e.message);
    return { success: false, error: 'Session validation failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Ends a session by marking it inactive.
 *
 * @param {Object} params - { session_id: string }
 * @returns {Object} { success: true } or error.
 */
function logout(params) {
  try {
    if (!params.session_id) {
      return { success: false, error: 'Session ID is required' };
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Sessions', 'session_id', params.session_id, {
        is_active: false,
        logged_out_at: new Date().toISOString()
      });
    } finally {
      lock.releaseLock();
    }

    logAudit('logout', 'Sessions', params.session_id, null, null);

    return { success: true, data: { message: 'Logged out successfully' } };
  } catch (e) {
    Logger.log('[AuthService] logout error: ' + e.message);
    return { success: false, error: 'Logout failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Change Password
// ---------------------------------------------------------------------------

/**
 * Changes a customer's password after verifying the current one.
 *
 * @param {Object} params - { contact_id, old_password, new_password }
 * @returns {Object} { success: true } or error.
 */
function changePassword(params) {
  try {
    if (!params.contact_id || !params.old_password || !params.new_password) {
      return { success: false, error: 'Contact ID, old password, and new password are required' };
    }

    if (params.new_password.length < 8) {
      return { success: false, error: 'New password must be at least 8 characters' };
    }

    if (params.old_password === params.new_password) {
      return { success: false, error: 'New password must differ from the current password' };
    }

    var contact = getById('Contacts', params.contact_id);
    if (!contact) {
      return { success: false, error: 'Contact not found' };
    }

    // Verify old password
    var oldHash = hashPassword(params.old_password);
    if (oldHash !== contact.password_hash) {
      return { success: false, error: 'Current password is incorrect' };
    }

    var newHash = hashPassword(params.new_password);

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Contacts', 'id', params.contact_id, {
        password_hash: newHash,
        updated_at: new Date().toISOString()
      });
    } finally {
      lock.releaseLock();
    }

    logAudit('change_password', 'Contacts', params.contact_id, null, null);

    return { success: true, data: { message: 'Password changed successfully' } };
  } catch (e) {
    Logger.log('[AuthService] changePassword error: ' + e.message);
    return { success: false, error: 'Password change failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Password Reset Request
// ---------------------------------------------------------------------------

/**
 * Generates a password-reset token and stores it on the contact record.
 *
 * @param {Object} params - { email: string }
 * @returns {Object} { success, data: { message, reset_token } } or error.
 */
function resetPasswordRequest(params) {
  try {
    if (!params.email) {
      return { success: false, error: 'Email is required' };
    }

    var email = params.email.toLowerCase().trim();
    var contact = findRow('Contacts', 'email', email);

    // Always return success to avoid email enumeration
    if (!contact) {
      return {
        success: true,
        data: { message: 'If that email exists, a reset link has been sent.' }
      };
    }

    var resetToken = Utilities.getUuid();
    var expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // 1-hour token validity

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Contacts', 'id', contact.id, {
        reset_token: resetToken,
        reset_token_expires: expiresAt.toISOString(),
        updated_at: new Date().toISOString()
      });
    } finally {
      lock.releaseLock();
    }

    logAudit('reset_password_request', 'Contacts', contact.id, null, { email: email });

    return {
      success: true,
      data: {
        message: 'If that email exists, a reset link has been sent.',
        reset_token: resetToken // consumed by the caller (e.g. email service)
      }
    };
  } catch (e) {
    Logger.log('[AuthService] resetPasswordRequest error: ' + e.message);
    return { success: false, error: 'Password reset request failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Confirm Password Reset
// ---------------------------------------------------------------------------

/**
 * Validates a reset token and sets the new password.
 *
 * @param {Object} params - { reset_token, new_password }
 * @returns {Object} { success: true } or error.
 */
function confirmPasswordReset(params) {
  try {
    if (!params.reset_token || !params.new_password) {
      return { success: false, error: 'Reset token and new password are required' };
    }

    if (params.new_password.length < 8) {
      return { success: false, error: 'Password must be at least 8 characters' };
    }

    var contact = findRow('Contacts', 'reset_token', params.reset_token);
    if (!contact) {
      return { success: false, error: 'Invalid or expired reset token' };
    }

    // Check token expiry
    if (contact.reset_token_expires) {
      var expiresAt = new Date(contact.reset_token_expires);
      if (new Date() > expiresAt) {
        return { success: false, error: 'Reset token has expired. Please request a new one.' };
      }
    }

    var newHash = hashPassword(params.new_password);

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Contacts', 'id', contact.id, {
        password_hash: newHash,
        reset_token: '',
        reset_token_expires: '',
        failed_login_attempts: 0,
        locked_until: '',
        updated_at: new Date().toISOString()
      });
    } finally {
      lock.releaseLock();
    }

    logAudit('confirm_password_reset', 'Contacts', contact.id, null, null);

    return { success: true, data: { message: 'Password has been reset successfully' } };
  } catch (e) {
    Logger.log('[AuthService] confirmPasswordReset error: ' + e.message);
    return { success: false, error: 'Password reset confirmation failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// OAuth Callback (Google / Microsoft for customer portal)
// ---------------------------------------------------------------------------

/**
 * Handles the OAuth callback for Google or Microsoft identity providers.
 *
 * If the customer already exists the session is created; otherwise a new
 * contact record is provisioned automatically.
 *
 * @param {Object} params - { provider: 'google'|'microsoft', code, redirect_uri }
 * @returns {Object} { success, data: { session, contact } } or error.
 */
function handleOAuthCallback(params) {
  try {
    if (!params.provider || !params.code) {
      return { success: false, error: 'OAuth provider and authorisation code are required' };
    }

    var provider = params.provider.toLowerCase();
    var userInfo;

    if (provider === 'google') {
      userInfo = _exchangeGoogleOAuthCode(params.code, params.redirect_uri);
    } else if (provider === 'microsoft') {
      userInfo = _exchangeMicrosoftOAuthCode(params.code, params.redirect_uri);
    } else {
      return { success: false, error: 'Unsupported OAuth provider: ' + provider };
    }

    if (!userInfo || !userInfo.email) {
      return { success: false, error: 'Could not retrieve user information from ' + provider };
    }

    var email = userInfo.email.toLowerCase().trim();

    // Find or create contact
    var contact = findRow('Contacts', 'email', email);
    var isNewAccount = false;

    if (!contact) {
      isNewAccount = true;
      var now = new Date().toISOString();
      var contactData = {
        id: Utilities.getUuid(),
        email: email,
        name: userInfo.name || '',
        first_name: userInfo.given_name || '',
        last_name: userInfo.family_name || '',
        password_hash: '',
        contact_type: 'individual',
        oauth_provider: provider,
        oauth_id: userInfo.sub || userInfo.id || '',
        status: 'active',
        failed_login_attempts: 0,
        locked_until: '',
        created_at: now,
        updated_at: now
      };

      var lock = LockService.getScriptLock();
      try {
        lock.waitLock(30000);
        appendRow('Contacts', contactData);
      } finally {
        lock.releaseLock();
      }

      contact = contactData;
    }

    if (contact.status === 'inactive' || contact.status === 'suspended') {
      return { success: false, error: 'Account is ' + contact.status + '. Please contact support.' };
    }

    // Create session
    var session = createSession('customer', contact.id, {
      email: email,
      name: contact.name || userInfo.name || '',
      contact_type: contact.contact_type || 'individual',
      oauth_provider: provider
    });

    // Update last login and OAuth details
    var lock2 = LockService.getScriptLock();
    try {
      lock2.waitLock(30000);
      updateRow('Contacts', 'id', contact.id, {
        last_login: new Date().toISOString(),
        oauth_provider: provider,
        oauth_id: userInfo.sub || userInfo.id || contact.oauth_id || ''
      });
    } finally {
      lock2.releaseLock();
    }

    logAudit('oauth_login', 'Contacts', contact.id, null, {
      email: email,
      provider: provider,
      new_account: isNewAccount
    });

    return {
      success: true,
      data: {
        session: session,
        contact: {
          id: contact.id,
          name: contact.name || userInfo.name || '',
          email: email,
          contact_type: contact.contact_type || 'individual',
          is_new_account: isNewAccount
        }
      }
    };
  } catch (e) {
    Logger.log('[AuthService] handleOAuthCallback error: ' + e.message);
    return { success: false, error: 'OAuth authentication failed: ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Internal OAuth Helpers
// ---------------------------------------------------------------------------

/**
 * Exchanges a Google authorisation code for user profile information.
 * @private
 */
function _exchangeGoogleOAuthCode(code, redirectUri) {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('GOOGLE_OAUTH_CLIENT_ID');
  var clientSecret = props.getProperty('GOOGLE_OAUTH_CLIENT_SECRET');

  var tokenResponse = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri || '',
      grant_type: 'authorization_code'
    },
    muteHttpExceptions: true
  });

  if (tokenResponse.getResponseCode() !== 200) {
    Logger.log('[AuthService] Google token exchange failed: ' + tokenResponse.getContentText());
    return null;
  }

  var tokens = JSON.parse(tokenResponse.getContentText());

  var userInfoResponse = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
    muteHttpExceptions: true
  });

  if (userInfoResponse.getResponseCode() !== 200) {
    Logger.log('[AuthService] Google userinfo fetch failed: ' + userInfoResponse.getContentText());
    return null;
  }

  return JSON.parse(userInfoResponse.getContentText());
}

/**
 * Exchanges a Microsoft authorisation code for user profile information.
 * @private
 */
function _exchangeMicrosoftOAuthCode(code, redirectUri) {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('MICROSOFT_OAUTH_CLIENT_ID');
  var clientSecret = props.getProperty('MICROSOFT_OAUTH_CLIENT_SECRET');
  var tenantId = props.getProperty('MICROSOFT_OAUTH_TENANT_ID') || 'common';

  var tokenResponse = UrlFetchApp.fetch(
    'https://login.microsoftonline.com/' + tenantId + '/oauth2/v2.0/token',
    {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: {
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri || '',
        grant_type: 'authorization_code',
        scope: 'openid profile email'
      },
      muteHttpExceptions: true
    }
  );

  if (tokenResponse.getResponseCode() !== 200) {
    Logger.log('[AuthService] Microsoft token exchange failed: ' + tokenResponse.getContentText());
    return null;
  }

  var tokens = JSON.parse(tokenResponse.getContentText());

  var userInfoResponse = UrlFetchApp.fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
    muteHttpExceptions: true
  });

  if (userInfoResponse.getResponseCode() !== 200) {
    Logger.log('[AuthService] Microsoft userinfo fetch failed: ' + userInfoResponse.getContentText());
    return null;
  }

  var profile = JSON.parse(userInfoResponse.getContentText());
  return {
    email: profile.mail || profile.userPrincipalName || '',
    name: profile.displayName || '',
    given_name: profile.givenName || '',
    family_name: profile.surname || '',
    id: profile.id || ''
  };
}

// ---------------------------------------------------------------------------
// Helper: Hash Password
// ---------------------------------------------------------------------------

/**
 * Produces a SHA-256 hex digest of the given password string.
 *
 * @param {string} password - Plain-text password.
 * @returns {string} Lowercase hex-encoded hash.
 */
function hashPassword(password) {
  var rawBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password);
  var hex = '';
  for (var i = 0; i < rawBytes.length; i++) {
    var b = rawBytes[i];
    if (b < 0) {
      b += 256;
    }
    var hexByte = b.toString(16);
    if (hexByte.length === 1) {
      hexByte = '0' + hexByte;
    }
    hex += hexByte;
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Helper: Generate Session Token
// ---------------------------------------------------------------------------

/**
 * Generates a universally unique session token.
 *
 * @returns {string} UUID v4 string.
 */
function generateSessionToken() {
  return Utilities.getUuid();
}

// ---------------------------------------------------------------------------
// Helper: Create Session
// ---------------------------------------------------------------------------

/**
 * Creates a new session record in the Sessions collection.
 *
 * @param {string} userType - 'staff' or 'customer'.
 * @param {string} userId   - The user/contact ID.
 * @param {Object} metadata - Arbitrary metadata to store with the session.
 * @returns {Object} The session object { session_id, user_type, user_id, ... }.
 */
function createSession(userType, userId, metadata) {
  var now = new Date().toISOString();
  var sessionData = {
    session_id: generateSessionToken(),
    user_type: userType,
    user_id: userId,
    metadata: JSON.stringify(metadata || {}),
    is_active: true,
    created_at: now,
    last_activity: now
  };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    appendRow('Sessions', sessionData);
  } finally {
    lock.releaseLock();
  }

  return {
    session_id: sessionData.session_id,
    user_type: sessionData.user_type,
    user_id: sessionData.user_id,
    metadata: metadata || {},
    created_at: sessionData.created_at
  };
}

// ---------------------------------------------------------------------------
// Helper: Rate Limiting
// ---------------------------------------------------------------------------

/**
 * Checks whether a contact is currently rate-limited.
 *
 * @param {string} contactId
 * @returns {Object} { allowed: boolean, minutes_remaining: number }
 */
function checkRateLimit(contactId) {
  try {
    var contact = getById('Contacts', contactId);
    if (!contact) {
      return { allowed: true, minutes_remaining: 0 };
    }

    var failedAttempts = parseInt(contact.failed_login_attempts, 10) || 0;

    if (failedAttempts < AUTH_MAX_FAILED_ATTEMPTS) {
      return { allowed: true, minutes_remaining: 0 };
    }

    // Account has hit the limit — check lockout window
    if (contact.locked_until) {
      var lockedUntil = new Date(contact.locked_until);
      var now = new Date();
      if (now < lockedUntil) {
        var remaining = Math.ceil((lockedUntil.getTime() - now.getTime()) / (1000 * 60));
        return { allowed: false, minutes_remaining: remaining };
      }
    }

    // Lockout has expired — allow and reset
    resetFailedAttempts(contactId);
    return { allowed: true, minutes_remaining: 0 };
  } catch (e) {
    Logger.log('[AuthService] checkRateLimit error: ' + e.message);
    // Fail open so the user is not permanently locked out by a bug
    return { allowed: true, minutes_remaining: 0 };
  }
}

/**
 * Increments the failed login counter and, when the limit is reached,
 * sets the locked_until timestamp.
 *
 * @param {string} contactId
 */
function incrementFailedAttempts(contactId) {
  try {
    var contact = getById('Contacts', contactId);
    if (!contact) {
      return;
    }

    var failedAttempts = (parseInt(contact.failed_login_attempts, 10) || 0) + 1;
    var updates = {
      failed_login_attempts: failedAttempts,
      updated_at: new Date().toISOString()
    };

    if (failedAttempts >= AUTH_MAX_FAILED_ATTEMPTS) {
      var lockedUntil = new Date();
      lockedUntil.setMinutes(lockedUntil.getMinutes() + AUTH_LOCKOUT_MINUTES);
      updates.locked_until = lockedUntil.toISOString();
    }

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Contacts', 'id', contactId, updates);
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('[AuthService] incrementFailedAttempts error: ' + e.message);
  }
}

/**
 * Resets the failed-attempt counter and clears any lockout timestamp.
 *
 * @param {string} contactId
 */
function resetFailedAttempts(contactId) {
  try {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
      updateRow('Contacts', 'id', contactId, {
        failed_login_attempts: 0,
        locked_until: '',
        updated_at: new Date().toISOString()
      });
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('[AuthService] resetFailedAttempts error: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Helper: Domain Allow-List
// ---------------------------------------------------------------------------

/**
 * Checks whether the given email belongs to one of the allowed staff domains.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isAllowedDomain(email) {
  if (!email || email.indexOf('@') === -1) {
    return false;
  }
  var domain = email.split('@')[1].toLowerCase();
  for (var i = 0; i < AUTH_ALLOWED_DOMAINS.length; i++) {
    if (domain === AUTH_ALLOWED_DOMAINS[i]) {
      return true;
    }
  }
  return false;
}
