/**
 * HASS PETROLEUM CMS - SETTINGS SERVICE
 * Version: 3.0.0
 *
 * Integration settings management - Config table in Turso.
 * All reads/writes go to Turso. Backup actions delegated to BackupService.
 */

function handleSettingsRequest(params) {
  try {
    var action = params.action;
    switch (action) {
      case 'getSettings':           return getSettings();
      case 'saveSettings':          return saveSettings(params.settings);
      case 'testOracleConnection':  return testOracleConnection();
      case 'testWhatsApp':          return testWhatsApp();
      case 'testTeams':             return testTeams();
      case 'testZoom':              return testZoom();
      case 'testTwilio':            return testTwilio();
      case 'testEmail':             return testEmail();
      // Backup actions
      case 'getBackupStatus':       return getBackupStatus();
      case 'runFullBackup':         return runFullBackup();
      case 'runIncremental':        return runIncrementalBackup();
      case 'installTrigger':        return installBackupTrigger();
      case 'removeTrigger':         return removeBackupTrigger();
      // OneDrive / SharePoint backup destination
      case 'getOneDriveStatus':     return getOneDriveStatus();
      case 'startOneDriveLogin':    return startOneDriveLogin();
      case 'disconnectOneDrive':    return disconnectOneDrive();
      case 'listOneDriveFolders':   return listOneDriveFolders(params.parentId);
      case 'setOneDriveFolder':     return setOneDriveFolder(params.folderId, params.folderName);
      case 'createOneDriveFolder':  return createOneDriveFolder(params.folderName, params.parentId);
      default:
        return { success: false, error: 'Unknown settings action: ' + action };
    }
  } catch(e) {
    Logger.log('[SettingsService] error: ' + e.message);
    return { success: false, error: 'Settings service error: ' + e.message };
  }
}

/** Password-type config keys that should be masked on read */
var ENCRYPTED_KEYS = [
  'ORACLE_PASSWORD', 'WA_TOKEN', 'TEAMS_CLIENT_SECRET',
  'ZOOM_CLIENT_SECRET', 'ZOOM_WEBHOOK_SECRET', 'TWILIO_TOKEN',
  'MS_GRAPH_SECRET',
];

/**
 * Reads Config from Turso, returns values with passwords masked.
 */
function getSettings() {
  var rows     = getSheetData('Config');
  var settings = {};

  rows.forEach(function(row) {
    var key = String(row.config_key   || '').trim();
    var val = String(row.config_value || '');
    if (!key) return;

    if (ENCRYPTED_KEYS.indexOf(key) > -1 && val.length > 4) {
      settings[key] = '****' + val.slice(-4);
    } else if (ENCRYPTED_KEYS.indexOf(key) > -1 && val.length > 0) {
      settings[key] = '****';
    } else {
      settings[key] = val;
    }
  });

  return { success: true, settings: settings };
}

/**
 * Saves settings to Config table in Turso - upserts key-value pairs.
 */
function saveSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    return { success: false, error: 'No settings provided' };
  }

  var now  = new Date().toISOString();
  var keys = Object.keys(settings);

  keys.forEach(function(key) {
    var value = settings[key];
    // Skip masked values (user didn't change the password)
    if (typeof value === 'string' && value.indexOf('****') === 0) return;

    var isEncrypted = ENCRYPTED_KEYS.indexOf(key) > -1;
    var existing    = findRow('Config', 'config_key', key);

    if (existing) {
      updateRow('Config', 'config_key', key, {
        config_value: value,
        is_encrypted: isEncrypted,
        updated_at:   now,
      });
    } else {
      appendRow('Config', {
        config_key:   key,
        config_value: value,
        value_type:   'STRING',
        is_encrypted: isEncrypted,
        updated_at:   now,
      });
    }
  });

  return { success: true, message: 'Settings saved' };
}

/**
 * Helper: reads multiple config keys from Turso Config table.
 */
function getConfigValues(keys) {
  var rows   = getSheetData('Config');
  var result = {};
  rows.forEach(function(row) {
    var k = String(row.config_key || '').trim();
    if (keys.indexOf(k) > -1) {
      result[k] = String(row.config_value || '');
    }
  });
  return result;
}

// ============================================================================
// CONNECTION TESTS
// ============================================================================

function testOracleConnection() {
  var config = getConfigValues(['ORACLE_HOST', 'ORACLE_USER', 'ORACLE_PASSWORD']);
  if (!config.ORACLE_HOST) return { success: false, message: 'Oracle Host URL not configured' };

  try {
    var start   = Date.now();
    var url     = config.ORACLE_HOST.replace(/\/$/, '') + '/ping';
    var options = {
      method:                   'get',
      headers:                  { 'Authorization': 'Basic ' + Utilities.base64Encode(config.ORACLE_USER + ':' + config.ORACLE_PASSWORD) },
      muteHttpExceptions:       true,
      validateHttpsCertificates: false,
    };
    var response = UrlFetchApp.fetch(url, options);
    var elapsed  = Date.now() - start;
    var code     = response.getResponseCode();
    if (code >= 200 && code < 400) {
      return { success: true, message: 'Connected successfully', responseTime: elapsed + 'ms' };
    }
    return { success: false, message: 'HTTP ' + code + ': ' + response.getContentText().substring(0, 200), responseTime: elapsed + 'ms' };
  } catch(e) {
    return { success: false, message: 'Connection failed: ' + e.message };
  }
}

function testWhatsApp() {
  var config = getConfigValues(['WA_PHONE_ID', 'WA_TOKEN']);
  if (!config.WA_PHONE_ID || !config.WA_TOKEN) return { success: false, message: 'WhatsApp credentials not configured' };

  try {
    var url      = 'https://graph.facebook.com/v18.0/' + config.WA_PHONE_ID + '/messages';
    var response = UrlFetchApp.fetch(url, {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + config.WA_TOKEN },
      payload:            JSON.stringify({ messaging_product: 'whatsapp', to: '254700000000', type: 'text', text: { body: 'Hass Petroleum CMS - Test message' } }),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    return code >= 200 && code < 300
      ? { success: true,  message: 'WhatsApp API responded OK' }
      : { success: false, message: 'HTTP ' + code + ': ' + response.getContentText().substring(0, 200) };
  } catch(e) {
    return { success: false, message: 'WhatsApp test failed: ' + e.message };
  }
}

function testTeams() {
  var config = getConfigValues(['TEAMS_WEBHOOK_URL']);
  if (!config.TEAMS_WEBHOOK_URL) return { success: false, message: 'Teams Webhook URL not configured' };

  try {
    var response = UrlFetchApp.fetch(config.TEAMS_WEBHOOK_URL, {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify({ '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: 'Hass CMS Test', themeColor: '1A237E', title: 'Hass Petroleum CMS - Test Notification', text: 'This is a test notification from the Hass CMS Settings panel.' }),
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    return code >= 200 && code < 300
      ? { success: true,  message: 'Teams notification sent' }
      : { success: false, message: 'HTTP ' + code };
  } catch(e) {
    return { success: false, message: 'Teams test failed: ' + e.message };
  }
}

function testZoom() {
  var config = getConfigValues(['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']);
  if (!config.ZOOM_CLIENT_ID || !config.ZOOM_CLIENT_SECRET) {
    return { success: false, message: 'Zoom credentials not configured' };
  }

  try {
    var tokenResp = UrlFetchApp.fetch('https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + config.ZOOM_ACCOUNT_ID, {
      method:             'post',
      headers:            { 'Authorization': 'Basic ' + Utilities.base64Encode(config.ZOOM_CLIENT_ID + ':' + config.ZOOM_CLIENT_SECRET) },
      muteHttpExceptions: true,
    });
    if (tokenResp.getResponseCode() !== 200) {
      return { success: false, message: 'OAuth failed: HTTP ' + tokenResp.getResponseCode() };
    }
    var token    = JSON.parse(tokenResp.getContentText()).access_token;
    var meetResp = UrlFetchApp.fetch('https://api.zoom.us/v2/users/me/meetings', {
      method:             'post',
      contentType:        'application/json',
      headers:            { 'Authorization': 'Bearer ' + token },
      payload:            JSON.stringify({ topic: 'Hass CMS Test', type: 1 }),
      muteHttpExceptions: true,
    });
    var code = meetResp.getResponseCode();
    return code >= 200 && code < 300
      ? { success: true,  message: 'Zoom API connected - test meeting created' }
      : { success: false, message: 'Meeting creation failed: HTTP ' + code };
  } catch(e) {
    return { success: false, message: 'Zoom test failed: ' + e.message };
  }
}

function testTwilio() {
  var config = getConfigValues(['TWILIO_SID', 'TWILIO_TOKEN']);
  if (!config.TWILIO_SID || !config.TWILIO_TOKEN) {
    return { success: false, message: 'Twilio credentials not configured' };
  }

  try {
    var url      = 'https://api.twilio.com/2010-04-01/Accounts/' + config.TWILIO_SID + '.json';
    var response = UrlFetchApp.fetch(url, {
      method:             'get',
      headers:            { 'Authorization': 'Basic ' + Utilities.base64Encode(config.TWILIO_SID + ':' + config.TWILIO_TOKEN) },
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code === 200) {
      var body = JSON.parse(response.getContentText());
      return { success: true, message: 'Connected - Account: ' + (body.friendly_name || body.sid) };
    }
    return { success: false, message: 'HTTP ' + code + ': Authentication failed' };
  } catch(e) {
    return { success: false, message: 'Twilio test failed: ' + e.message };
  }
}

// ============================================================================
// ONEDRIVE / SHAREPOINT BACKUP DESTINATION
// ============================================================================

var ONEDRIVE_KEYS_ = [
  'ONEDRIVE_CLIENT_ID', 'ONEDRIVE_CLIENT_SECRET', 'ONEDRIVE_TENANT_ID',
  'ONEDRIVE_REFRESH_TOKEN', 'ONEDRIVE_ACCOUNT_EMAIL',
  'ONEDRIVE_FOLDER_ID', 'ONEDRIVE_FOLDER_PATH',
];

function getOneDriveStatus() {
  var c = getConfigValues(ONEDRIVE_KEYS_);
  var connected = !!(c.ONEDRIVE_REFRESH_TOKEN && c.ONEDRIVE_ACCOUNT_EMAIL);
  return {
    success: true,
    connected: connected,
    account_email: c.ONEDRIVE_ACCOUNT_EMAIL || '',
    folder_path:   c.ONEDRIVE_FOLDER_PATH   || '',
    folder_id:     c.ONEDRIVE_FOLDER_ID     || '',
  };
}

function startOneDriveLogin() {
  var c = getConfigValues(['ONEDRIVE_CLIENT_ID', 'ONEDRIVE_TENANT_ID']);
  if (!c.ONEDRIVE_CLIENT_ID) {
    return { success: false, error: 'Set ONEDRIVE_CLIENT_ID and ONEDRIVE_TENANT_ID in Config first.' };
  }
  var tenant = c.ONEDRIVE_TENANT_ID || 'common';
  var redirect = ScriptApp.getService().getUrl() + '?onedrive_callback=1';
  var scope = encodeURIComponent('offline_access Files.ReadWrite Sites.ReadWrite.All User.Read');
  var url = 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/authorize'
    + '?client_id=' + encodeURIComponent(c.ONEDRIVE_CLIENT_ID)
    + '&response_type=code'
    + '&redirect_uri=' + encodeURIComponent(redirect)
    + '&response_mode=query'
    + '&scope=' + scope;
  return { success: true, auth_url: url };
}

function disconnectOneDrive() {
  saveSettings({
    ONEDRIVE_REFRESH_TOKEN: '',
    ONEDRIVE_ACCOUNT_EMAIL: '',
    ONEDRIVE_FOLDER_ID:     '',
    ONEDRIVE_FOLDER_PATH:   '',
  });
  return { success: true, message: 'OneDrive disconnected.' };
}

function getOneDriveAccessToken_() {
  var c = getConfigValues(['ONEDRIVE_CLIENT_ID','ONEDRIVE_CLIENT_SECRET','ONEDRIVE_TENANT_ID','ONEDRIVE_REFRESH_TOKEN']);
  if (!c.ONEDRIVE_REFRESH_TOKEN) throw new Error('OneDrive not connected. Sign in first.');
  var tenant = c.ONEDRIVE_TENANT_ID || 'common';
  var resp = UrlFetchApp.fetch('https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/token', {
    method: 'post',
    payload: {
      client_id:     c.ONEDRIVE_CLIENT_ID,
      client_secret: c.ONEDRIVE_CLIENT_SECRET,
      refresh_token: c.ONEDRIVE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
      scope:         'offline_access Files.ReadWrite Sites.ReadWrite.All User.Read',
    },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('OneDrive token refresh failed: HTTP ' + resp.getResponseCode());
  }
  var body = JSON.parse(resp.getContentText());
  if (body.refresh_token && body.refresh_token !== c.ONEDRIVE_REFRESH_TOKEN) {
    saveSettings({ ONEDRIVE_REFRESH_TOKEN: body.refresh_token });
  }
  return body.access_token;
}

function listOneDriveFolders(parentId) {
  try {
    var token = getOneDriveAccessToken_();
    var url = parentId
      ? 'https://graph.microsoft.com/v1.0/me/drive/items/' + parentId + '/children?$filter=folder ne null&$top=200'
      : 'https://graph.microsoft.com/v1.0/me/drive/root/children?$filter=folder ne null&$top=200';
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      return { success: false, error: 'Graph API HTTP ' + resp.getResponseCode() };
    }
    var body = JSON.parse(resp.getContentText());
    var folders = (body.value || []).filter(function(it){ return it.folder; }).map(function(it){
      return { id: it.id, name: it.name, child_count: (it.folder && it.folder.childCount) || 0 };
    });
    return { success: true, folders: folders };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function setOneDriveFolder(folderId, folderName) {
  if (!folderId) return { success: false, error: 'No folder selected' };
  saveSettings({
    ONEDRIVE_FOLDER_ID:   folderId,
    ONEDRIVE_FOLDER_PATH: folderName || folderId,
  });
  return { success: true };
}

function createOneDriveFolder(folderName, parentId) {
  try {
    if (!folderName) return { success: false, error: 'Folder name required' };
    var token = getOneDriveAccessToken_();
    var url = parentId
      ? 'https://graph.microsoft.com/v1.0/me/drive/items/' + parentId + '/children'
      : 'https://graph.microsoft.com/v1.0/me/drive/root/children';
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
      return { success: false, error: 'Create failed: HTTP ' + resp.getResponseCode() };
    }
    var body = JSON.parse(resp.getContentText());
    saveSettings({
      ONEDRIVE_FOLDER_ID:   body.id,
      ONEDRIVE_FOLDER_PATH: body.name,
    });
    return { success: true, folder_id: body.id, folder_name: body.name };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

function testEmail() {
  try {
    var email = Session.getActiveUser().getEmail();
    if (!email) return { success: false, message: 'Could not determine your email address' };
    MailApp.sendEmail({
      to:       email,
      subject:  'Hass Petroleum CMS - Email Test',
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;">'
        + '<h2 style="color:#1A237E;">Email Test Successful</h2>'
        + '<p>This confirms that email sending is working correctly from the Hass Petroleum CMS.</p>'
        + '<p style="color:#64748b;font-size:12px;">Sent at: ' + new Date().toISOString() + '</p>'
        + '</div>',
    });
    return { success: true, message: 'Test email sent to ' + email };
  } catch(e) {
    return { success: false, message: 'Email test failed: ' + e.message };
  }
}
