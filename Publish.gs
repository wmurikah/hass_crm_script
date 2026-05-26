/**
 * Publish.gs
 * One-click publisher for the Hass CMS web app.
 *
 * Creates a new version from the current project content and points the
 * EXISTING deployment at it, so the /exec URL never changes.
 *
 * USE:
 *   1. Pull the latest code into the editor with the GitHub Assistant extension.
 *   2. Run publishToLiveUrl().
 *   3. The same /exec URL now serves the code you just pulled.
 *
 * ONE-TIME PREREQUISITES:
 *   1. Enable the Apps Script API for your account:
 *        https://script.google.com/home/usersettings  (toggle it ON)
 *   2. Add these scopes to appsscript.json, then run once to consent:
 *        "oauthScopes": [
 *          "https://www.googleapis.com/auth/script.projects",
 *          "https://www.googleapis.com/auth/script.deployments",
 *          "https://www.googleapis.com/auth/script.external_request"
 *        ]
 *   3. Set SCRIPT_ID below to this project's Script ID
 *        (Project Settings, IDs, "Script ID").
 *
 * The DEPLOYMENT_ID below is taken from your live /exec URL and must not change.
 */

// ---- Configuration ----
var SCRIPT_ID = '1Wxq9M7FtPwiEBG6oYY8JZ-QejD6ZPBLvGXHhNMGdIaEXLQ4XxCAXekbk';
var DEPLOYMENT_ID = 'AKfycbzaUVMghqie8EmgLvIMl-fa_5YeFDGurxjTA2QN5hhkCbOsKUN5MaaQRjq9VjMTj9LI';
var MANIFEST_FILE_NAME = 'appsscript';
// ------------------------

function publishToLiveUrl() {
  if (SCRIPT_ID === 'PASTE_YOUR_SCRIPT_ID_HERE') {
    throw new Error('Set SCRIPT_ID first (Project Settings, IDs, Script ID).');
  }

  var token = ScriptApp.getOAuthToken();
  var base = 'https://script.googleapis.com/v1/projects/' + SCRIPT_ID;
  var stamp = Utilities.formatDate(new Date(), 'Etc/UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var headers = { Authorization: 'Bearer ' + token };

  // 1) Snapshot current project content (HEAD) into a new version.
  var versionResp = UrlFetchApp.fetch(base + '/versions', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    muteHttpExceptions: true,
    payload: JSON.stringify({ description: 'Release ' + stamp })
  });
  if (versionResp.getResponseCode() >= 300) {
    throw new Error('Version create failed: ' +
      versionResp.getResponseCode() + ' ' + versionResp.getContentText());
  }
  var versionNumber = JSON.parse(versionResp.getContentText()).versionNumber;
  Logger.log('Created version %s', versionNumber);

  // 2) Point the EXISTING deployment at the new version. The URL stays the same.
  var deployResp = UrlFetchApp.fetch(base + '/deployments/' + DEPLOYMENT_ID, {
    method: 'put',
    contentType: 'application/json',
    headers: headers,
    muteHttpExceptions: true,
    payload: JSON.stringify({
      deploymentConfig: {
        scriptId: SCRIPT_ID,
        versionNumber: versionNumber,
        manifestFileName: MANIFEST_FILE_NAME,
        description: 'Release ' + stamp
      }
    })
  });
  if (deployResp.getResponseCode() >= 300) {
    throw new Error('Deployment update failed: ' +
      deployResp.getResponseCode() + ' ' + deployResp.getContentText());
  }

  // 3) Confirm the live URL is unchanged.
  var result = JSON.parse(deployResp.getContentText());
  var entryPoints = result.entryPoints || [];
  var webApp = null;
  for (var i = 0; i < entryPoints.length; i++) {
    if (entryPoints[i].entryPointType === 'WEB_APP') { webApp = entryPoints[i]; break; }
  }
  var url = (webApp && webApp.webApp) ? webApp.webApp.url : '(no web app entry point found)';
  Logger.log('Deployment %s now serving version %s', DEPLOYMENT_ID, versionNumber);
  Logger.log('Live URL: %s', url);
  return url;
}
