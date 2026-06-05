/**
 * Project A — wrapper / deployment shell for Hass CMS.
 * ----------------------------------------------------
 * This project holds NO business logic. ALL CMS code lives in Project B,
 * which is added to THIS project as a library bound to HEAD (Development
 * mode) under the identifier `HassCMS`. Because the binding is HEAD, editing
 * and *saving* Project B makes the very next request to THIS deployment run
 * the new code — no version bump, no redeploy, no change to the /exec URL.
 *
 * WHY THIS FILE IS NOT JUST doGet/doPost  (important — do not "simplify"):
 *   `google.script.run.<fn>()` calls from the client HTML are dispatched to
 *   TOP-LEVEL functions of the DEPLOYED project (this one), NOT to library
 *   functions. A library symbol like `HassCMS.processRequest` is invisible to
 *   google.script.run. So every function the browser invokes via
 *   google.script.run MUST be re-declared here as a thin pass-through.
 *
 *   The Hass CMS client currently calls these globals:
 *     processRequest          (the ENTIRE JSON API — every API.call() goes here)
 *     getLoginPage
 *     getStaffDashboardPage
 *     getMfaEnrollPage
 *     getMfaVerifyPage
 *   `logoutUser` is re-exported too, defensively (it is a public server fn).
 *
 *   If you ever add a NEW google.script.run target in Project B's HTML, you
 *   MUST add a matching pass-through here AND re-deploy Project A is NOT
 *   required — wait: re-exports are code in Project A, so adding one here is
 *   an edit to A. With HEAD-mode libraries the EXISTING deployment keeps
 *   pointing at A's code; new top-level functions in A are picked up live the
 *   same way (A is the head-development deployment), so saving A is enough.
 *   Keep the client's google.script.run surface stable to avoid this.
 */

// ── Web entry points ────────────────────────────────────────────────────────

function doGet(e) {
  var out = HassCMS.doGet(e);

  // GOAL 2 — banner crop. setXFrameOptionsMode must be applied to the FINAL
  // HtmlOutput that THIS project returns, AFTER the library has built it.
  // (The library's doGet returns the HtmlOutput object; we mutate it here so
  // the deployment, not the library, owns the framing decision.) ALLOWALL lets
  // the GAS user-html frame render inside the cross-origin GitHub Pages parent,
  // which is what makes the iframe-crop possible at all.
  if (out && typeof out.setXFrameOptionsMode === 'function') {
    out.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return out;
}

function doPost(e) {
  // doPost returns ContentService JSON; XFrameOptionsMode does not apply.
  return HassCMS.doPost(e);
}

// ── google.script.run re-exports ────────────────────────────────────────────
// These resolve in THIS project (where google.script.run looks), each simply
// forwarding to the HEAD-mode library.

function processRequest(req)           { return HassCMS.processRequest(req); }
function getLoginPage()                { return HassCMS.getLoginPage(); }
function getStaffDashboardPage(token)  { return HassCMS.getStaffDashboardPage(token); }
function getMfaEnrollPage(challengeId) { return HassCMS.getMfaEnrollPage(challengeId); }
function getMfaVerifyPage(challengeId) { return HassCMS.getMfaVerifyPage(challengeId); }
function logoutUser(token)             { return HassCMS.logoutUser(token); }
