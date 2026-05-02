// ================================================================
// HASS PETROLEUM CMS - LoginDiagnostics.gs
//
// Standalone diagnostics for the login → dashboard pipeline.
// Run each function from the Apps Script editor and inspect the
// Execution Log (View → Logs) to identify the failure point.
// ================================================================

/**
 * DIAGNOSTIC 1 - Full pipeline test.
 * Exercises login → token issue → checkSession → dashboard render.
 * Replace email/password with a known-good staff credential.
 */
function testFullLoginPipeline() {
  Logger.log('=== FULL LOGIN PIPELINE TEST ===');

  var loginResult = handleAuthRequest({
    action: 'login',
    email: 'catherine.mutua@dummy.com',
    password: 'Catherine@Hass2026',
  });
  Logger.log('STEP 1 Login: ' + JSON.stringify(loginResult));
  if (!loginResult.success) { Logger.log('FAIL at Step 1'); return; }

  var rawToken = loginResult.token;
  Logger.log('Raw token: ' + rawToken);
  Logger.log('Token length: ' + rawToken.length);

  var simulatedUrl = ScriptApp.getService().getUrl() + '?token=' + rawToken;
  Logger.log('STEP 2 URL would be: ' + simulatedUrl.substring(0, 80) + '...');

  var sessionResult = checkSession({ token: rawToken });
  Logger.log('STEP 3 checkSession: ' + JSON.stringify(sessionResult));
  if (!sessionResult.valid) { Logger.log('FAIL at Step 3 - checkSession invalid'); return; }

  try {
    var page = serveStaffDashboard(sessionResult, rawToken);
    var content = page.getContent();
    Logger.log('STEP 4 Dashboard HTML length: ' + content.length + ' chars');
    Logger.log('STEP 4 First 200 chars: ' + content.substring(0, 200));
    if (content.length < 100) {
      Logger.log('FAIL at Step 4 - HTML output is too short (template error?)');
    } else if (content.indexOf('SESSION') === -1) {
      Logger.log('FAIL at Step 4 - rendered HTML does not contain SESSION marker');
    } else {
      Logger.log('STEP 4 PASS');
    }
  } catch(e) {
    Logger.log('FAIL at Step 4 - EXCEPTION: ' + e.message + '\n' + e.stack);
  }

  Logger.log('=== PIPELINE TEST COMPLETE ===');
}

/**
 * DIAGNOSTIC 2 - checkSession isolation.
 * Writes a fresh session, immediately reads it back via checkSession.
 * Confirms hashing on insert matches hashing on lookup.
 */
function testCheckSessionIsolated() {
  var rawToken = Utilities.getUuid() + Date.now().toString(36);

  var rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, rawToken, Utilities.Charset.UTF_8
  );
  var tokenHash = rawHash.map(function(b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');

  var sessionId = generateUUID();
  var now = new Date().toISOString();
  var expires = new Date(Date.now() + 8 * 3600000).toISOString();

  tursoWrite(
    'INSERT INTO sessions (session_id,user_id,user_type,role,token_hash,' +
    'is_active,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [sessionId, 'USR008', 'STAFF', 'SUPER_ADMIN', tokenHash, 1, expires, now, now]
  );
  Logger.log('Session written. token_hash: ' + tokenHash);

  var result = checkSession({ token: rawToken });
  Logger.log('checkSession result: ' + JSON.stringify(result));

  if (result.valid) {
    Logger.log('SUCCESS - checkSession works correctly');
  } else {
    Logger.log('FAIL - checkSession cannot find or validate the session');
    Logger.log('Either hashing differs between INSERT and lookup, or column name is wrong');
  }
}

/**
 * DIAGNOSTIC 3 - Template render test.
 * Renders Staffdashboard.html with a synthetic session and checks the output.
 * Useful when you suspect the template itself.
 */
function testDashboardTemplate() {
  var fakeSession = {
    valid: true,
    userId: 'USR008',
    userType: 'STAFF',
    role: 'SUPER_ADMIN',
  };
  var fakeToken = 'test-token-123';

  try {
    var page = serveStaffDashboard(fakeSession, fakeToken);
    var html = page.getContent();
    Logger.log('Template rendered OK. Length: ' + html.length);
    Logger.log('Contains SESSION literal: ' + (html.indexOf('var SESSION') > -1));
    Logger.log('Contains test token: ' + (html.indexOf(fakeToken) > -1));
    Logger.log('First 500 chars: ' + html.substring(0, 500));
  } catch(e) {
    Logger.log('TEMPLATE ERROR: ' + e.message + '\n' + e.stack);
  }
}
