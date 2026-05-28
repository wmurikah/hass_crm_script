/**
 * 20_audit.gs  —  Hass CMS rebuild  (Stage 2 crosscut)
 *
 * global Audit = { log({actor, action, entity, entityId, before, after, ip, ua, metadata}) }
 *
 * Writes one row to audit_log. Values whose key matches
 * /password|hash|secret|token|mfa/i are replaced with '***'.
 */

var Audit = (function () {

  var _MASK_RE_ = /password|hash|secret|token|mfa/i;

  function _mask_(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    var out = {};
    Object.keys(obj).forEach(function (k) {
      if (_MASK_RE_.test(k)) {
        out[k] = '***';
      } else if (obj[k] !== null && typeof obj[k] === 'object') {
        out[k] = _mask_(obj[k]);
      } else {
        out[k] = obj[k];
      }
    });
    return out;
  }

  function _actorType_(actor) {
    if (/^(USR-|CTX-)/.test(actor)) return 'STAFF';
    return 'SYSTEM';
  }

  function log(entry) {
    try {
      entry = entry || {};
      var actor = String(entry.actor || '');

      Repo.create('audit_log', {
        log_id:           uuidv4(),
        entity_type:      String(entry.entity   || ''),
        entity_id:        String(entry.entityId || ''),
        action:           String(entry.action   || ''),
        actor_type:       _actorType_(actor),
        actor_id:         actor,
        actor_email:      '',
        actor_ip:         String(entry.ip       || ''),
        actor_user_agent: String(entry.ua       || ''),
        before_json:      entry.before != null ? jsonStringify(_mask_(entry.before)) : null,
        after_json:       entry.after  != null ? jsonStringify(_mask_(entry.after))  : null,
        metadata:         jsonStringify(_mask_(entry.metadata || {})),
        country_code:     String(entry.countryCode || ''),
        created_at:       nowIso(),
      });
    } catch (e) {
      Log.error({ service: 'Audit', action: 'log', msg: e.message });
    }
  }

  return { log: log };

})();
