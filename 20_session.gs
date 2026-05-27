/**
 * 20_session.gs  —  Hass CMS rebuild foundation  (Stage 1 stub)
 *
 * Session resolution stub used by 30_router.gs.
 * Always returns null — every non-public request appears unauthenticated.
 *
 * Replaced by full implementation in Stage 2 (auth + session layer).
 */

/**
 * Resolve a bearer token to a session object.
 * @param {string} token
 * @returns {Object|null}  null means invalid / expired / missing
 */
function resolveSession_(token) {
  // Stage 2 will query:
  //   SELECT * FROM sessions WHERE session_id = ? AND expires_at > ? AND is_active = 1
  return null;
}
