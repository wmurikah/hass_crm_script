/**
 * 01_logger.gs  —  Hass CMS rebuild foundation
 *
 * Structured logger wrapping the GAS built-in Logger.log.
 * Each log line is a JSON object with consistent fields:
 *
 *   { ts, level, service, action, actor, durationMs?, msg, data? }
 *
 * Usage:
 *   Log.info({ service: 'orders', action: 'create', actor: userId, msg: 'Order created' });
 *   Log.error({ service: 'turso', action: 'select', msg: err.message });
 */

var _LOG_LEVEL_RANK_ = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function _logShouldEmit_(level) {
  var threshold = _LOG_LEVEL_RANK_[ENV.LOG_LEVEL];
  if (threshold === undefined) threshold = _LOG_LEVEL_RANK_.INFO;
  return (_LOG_LEVEL_RANK_[level] || 0) >= threshold;
}

var Log = {
  _emit: function (level, entry) {
    if (!_logShouldEmit_(level)) return;
    var line = {
      ts:      nowIso(),
      level:   level,
      service: entry.service    || '',
      action:  entry.action     || '',
      actor:   entry.actor      || '',
      msg:     entry.msg || entry.message || '',
    };
    if (entry.durationMs !== undefined) line.durationMs = entry.durationMs;
    if (entry.data       !== undefined) line.data       = entry.data;
    Logger.log(JSON.stringify(line));
  },

  debug: function (entry) { this._emit('DEBUG', entry); },
  info:  function (entry) { this._emit('INFO',  entry); },
  warn:  function (entry) { this._emit('WARN',  entry); },
  error: function (entry) { this._emit('ERROR', entry); },
};
